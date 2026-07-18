import path from "node:path";
import { mkdir } from "node:fs/promises";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
} from "electron";
import electronUpdater from "electron-updater";
import {
  SHIPFLOW_EVENT_CHANNEL,
  SHIPFLOW_INVOKE_CHANNEL,
  SHIPFLOW_WORKSPACE_EVENT_CHANNEL,
  SHIPFLOW_WORKSPACE_REQUEST_CHANNEL,
  type ShipFlowCommand,
  type ShipFlowWorkspaceRequest,
} from "../../src/backend/bridge-contract";
import type { WorkspaceDocumentFile } from "../../src/features/workspace/document";
import type { ServiceConfig } from "../../src/types";
import {
  canonicalWorkspaceDocumentPath,
  DocumentPathCapabilities,
} from "./document-capabilities";
import {
  listWorkspaceRecovery,
  readWorkspaceDocument,
  writeCsvExport,
  writeWorkspaceDocument,
} from "./documents";
import { appLogger, configureAppLogger } from "./app-logger";
import { resolvePodImage } from "./pod-preview";
import { ServiceAgentManager } from "./service-agent";
import { WorkspaceHostClient } from "./workspace-host";

const { autoUpdater } = electronUpdater;

type WindowKind = "workspace";
type WindowLaunchRequest = { documentPath: string | null; startFresh: boolean };
type WindowRecord = {
  window: BrowserWindow;
  label: string;
  kind: WindowKind;
  launchRequest: WindowLaunchRequest | null;
  documentPath: string | null;
  documentName: string;
  isDirty: boolean;
  closeRequestPending: boolean;
  allowClose: boolean;
  authorizedDocumentPaths: DocumentPathCapabilities;
};

const PRODUCT_NAME = "ShipFlow Desktop";
const APP_IDENTIFIER = "com.shipflow.desktop";
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*",
  "img-src 'self' data: blob: https:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
].join("; ");

app.setName(PRODUCT_NAME);
app.setPath(
  "userData",
  process.env.SHIPFLOW_USER_DATA_DIR?.trim()
    ? path.resolve(process.env.SHIPFLOW_USER_DATA_DIR.trim())
    : path.join(app.getPath("appData"), APP_IDENTIFIER),
);
app.setAppLogsPath();
configureAppLogger(path.join(app.getPath("logs"), "shipflow-desktop.log"));
app.setAppUserModelId(APP_IDENTIFIER);
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

const serviceAgent = new ServiceAgentManager();
const windowsByWebContentsId = new Map<number, WindowRecord>();
const windowsByLabel = new Map<string, WindowRecord>();
const workspaceHosts = new Map<string, WorkspaceHostClient>();
const workspaceHostStarts = new Map<string, Promise<WorkspaceHostClient>>();
const documentClaims = new Map<string, string>();
let workspaceHostGeneration = 0;
let windowSequence = 0;
let tray: Tray | null = null;
let isQuitting = false;
let quitCleanupStarted = false;
let quitCleanupComplete = false;
let nativeRuntimesShuttingDown = false;

const COMMON_COMMANDS = new Set<ShipFlowCommand>([
  "open_external_url",
  "copy_to_clipboard",
  "read_from_clipboard",
  "open_app_log",
  "log_frontend_runtime_event",
  "get_release_health",
  "check_app_update",
  "install_app_update",
  "load_saved_api_service_config",
  "copy_public_api_token",
  "get_api_service_status",
  "configure_api_service",
  "validate_tracking_source_config",
  "test_external_tracking_source",
]);
const WORKSPACE_ONLY_COMMANDS = new Set<ShipFlowCommand>([
  "resolve_pod_image",
  "pick_workspace_document_path",
  "authorize_workspace_document_path",
  "get_current_window_label",
  "set_current_window_title",
  "set_current_window_document_state",
  "claim_current_workspace_document",
  "read_workspace_document",
  "write_workspace_document",
  "export_workspace_csv",
  "list_workspace_recovery",
  "create_workspace_window",
  "take_pending_workspace_window_request",
  "resolve_window_close_request",
]);
const ALLOWED_WORKSPACE_METHODS = new Set<ShipFlowWorkspaceRequest["method"]>([
  "workspace.command",
  "workspace.run_import_job_with_progress",
  "workspace.retry_import_job_with_progress",
  "workspace.refresh_tracking_with_progress",
]);

function assertObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function requireString(args: Record<string, unknown>, key: string) {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string.`);
  }
  return value;
}

function recordForEvent(event: IpcMainInvokeEvent) {
  if (event.senderFrame !== event.sender.mainFrame) {
    throw new Error("ShipFlow IPC is only available to the main renderer frame.");
  }
  const record = windowsByWebContentsId.get(event.sender.id);
  if (!record || record.window.isDestroyed()) {
    throw new Error("ShipFlow IPC sender is not a registered application window.");
  }
  return record;
}

function emitWindowEvent<T>(record: WindowRecord, eventName: string, payload: T) {
  if (!record.window.isDestroyed()) {
    record.window.webContents.send(SHIPFLOW_EVENT_CHANNEL, eventName, payload);
  }
}

function sendMenuCommand(record: WindowRecord, command: string) {
  emitWindowEvent(record, "shipflow://app-menu-command", { command });
}

function focusedWorkspaceRecord() {
  const focused = BrowserWindow.getFocusedWindow();
  const focusedRecord = focused
    ? windowsByWebContentsId.get(focused.webContents.id)
    : undefined;
  if (focusedRecord?.kind === "workspace") {
    return focusedRecord;
  }
  return [...windowsByLabel.values()].find((record) => record.kind === "workspace");
}

function menuItem(label: string, command: string, accelerator?: string) {
  return {
    label,
    accelerator,
    click: () => {
      const record = focusedWorkspaceRecord();
      if (record) {
        sendMenuCommand(record, command);
      } else if (command === "show-settings") {
        openWorkspaceSettings("workspace");
      } else if (command === "show-service-settings") {
        openWorkspaceSettings("service");
      }
    },
  };
}

async function openAppLogFile() {
  try {
    const logPath = await appLogger.ensureFile();
    const error = await shell.openPath(logPath);
    if (error) {
      throw new Error(`Unable to open ShipFlow log file: ${error}`);
    }
    appLogger.info("Electron", "Opened the application log file.");
  } catch (error) {
    appLogger.error("Electron", error);
    dialog.showErrorBox("ShipFlow Desktop", String(error));
    throw error;
  }
}

function logFileMenuItem(): Electron.MenuItemConstructorOptions {
  return {
    label: "Open Log File",
    click: () => {
      void openAppLogFile().catch((error) => {
        appLogger.error("ElectronMenu", error);
      });
    },
  };
}

function installApplicationMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? [
          {
            label: PRODUCT_NAME,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              menuItem("Service Settings", "show-service-settings"),
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        menuItem("New", "new-document", "CmdOrCtrl+N"),
        menuItem("Open...", "open-document", "CmdOrCtrl+O"),
        { type: "separator" },
        menuItem("Save", "save-document", "CmdOrCtrl+S"),
        menuItem("Save As...", "save-document-as", "CmdOrCtrl+Shift+S"),
        { type: "separator" },
        menuItem("New Window", "new-window", "CmdOrCtrl+Shift+N"),
        menuItem("Open in New Window...", "open-document-in-new-window"),
        { type: "separator" },
        logFileMenuItem(),
        ...(process.platform === "darwin"
          ? []
          : [{ type: "separator" as const }, { role: "quit" as const }]),
      ],
    },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "View", submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }] },
    {
      label: "Help",
      submenu: [
        menuItem("Workspace Settings", "show-settings"),
        menuItem("Service Settings", "show-service-settings"),
        { type: "separator" },
        menuItem("Check for Updates", "check-for-updates"),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function trayIconPath() {
  const fileName = process.platform === "win32" ? "service-icon.ico" : "service-icon.png";
  return app.isPackaged
    ? path.join(process.resourcesPath, "icons", fileName)
    : path.join(app.getAppPath(), "assets", "icons", fileName);
}

function installTray() {
  if (tray) {
    return;
  }
  const image = nativeImage.createFromPath(trayIconPath());
  tray = new Tray(process.platform === "darwin" ? image.resize({ width: 18, height: 18 }) : image);
  tray.setToolTip(PRODUCT_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open ShipFlow Desktop", click: () => openOrFocusWorkspace() },
      { label: "Service Settings", click: () => openWorkspaceSettings("service") },
      { type: "separator" },
      {
        label: "Quit ShipFlow Desktop",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("double-click", () => openOrFocusWorkspace());
}

function rendererUrl(kind: WindowKind, label: string) {
  const url = new URL(process.env.ELECTRON_RENDERER_URL!);
  url.searchParams.set("windowKind", kind);
  url.searchParams.set("windowLabel", label);
  return url.toString();
}

async function loadRenderer(record: WindowRecord) {
  if (process.env.ELECTRON_RENDERER_URL) {
    await record.window.loadURL(rendererUrl(record.kind, record.label));
    return;
  }
  await record.window.loadFile(path.join(__dirname, "../renderer/index.html"), {
    query: { windowKind: record.kind, windowLabel: record.label },
  });
}

function createWindow(
  kind: WindowKind,
  options: { label?: string; launchRequest?: WindowLaunchRequest | null } = {},
) {
  windowSequence += 1;
  const label = options.label ?? `workspace-${windowSequence}`;
  const window = new BrowserWindow({
    title: PRODUCT_NAME,
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: "#f8fafc",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  const record: WindowRecord = {
    window,
    label,
    kind,
    launchRequest: options.launchRequest ?? null,
    documentPath: null,
    documentName: "Untitled.shipflow",
    isDirty: false,
    closeRequestPending: false,
    allowClose: false,
    authorizedDocumentPaths: new DocumentPathCapabilities(
      options.launchRequest?.documentPath
        ? [normalizeClaimPath(options.launchRequest.documentPath)]
        : [],
    ),
  };
  appLogger.info("Electron", `Creating workspace window ${label}.`);
  windowsByWebContentsId.set(window.webContents.id, record);
  windowsByLabel.set(label, record);

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.once("ready-to-show", () => {
    window.show();
    if (process.platform === "darwin") {
      app.dock?.show();
    }
  });
  window.on("close", (event) => {
    if (
      kind !== "workspace" ||
      isQuitting ||
      record.allowClose ||
      !record.isDirty
    ) {
      return;
    }
    event.preventDefault();
    if (!record.closeRequestPending) {
      record.closeRequestPending = true;
      emitWindowEvent(record, "shipflow://window-close-requested", {
        documentName: record.documentName,
      });
    }
  });
  window.on("closed", () => {
    appLogger.info("Electron", `Closed workspace window ${label}.`);
    windowsByWebContentsId.delete(window.webContents.id);
    windowsByLabel.delete(label);
    workspaceHosts.get(label)?.stop();
    workspaceHosts.delete(label);
    workspaceHostStarts.delete(label);
    if (record.documentPath && documentClaims.get(record.documentPath) === label) {
      documentClaims.delete(record.documentPath);
    }
    if (process.platform === "darwin" && BrowserWindow.getAllWindows().length === 0) {
      app.dock?.hide();
    }
  });
  void loadRenderer(record).catch((error) => {
    appLogger.error("Renderer", error);
    dialog.showErrorBox("ShipFlow Desktop", `Unable to load the renderer: ${String(error)}`);
  });
  return record;
}

function openOrFocusWorkspace() {
  const existing = [...windowsByLabel.values()].find((record) => record.kind === "workspace");
  if (existing) {
    existing.window.show();
    existing.window.focus();
    return existing;
  }
  return createWindow("workspace", { label: "main" });
}

function openWorkspaceSettings(section: "workspace" | "service") {
  const record = openOrFocusWorkspace();
  const command = section === "service" ? "show-service-settings" : "show-settings";
  if (record.window.webContents.isLoadingMainFrame()) {
    record.window.webContents.once("did-finish-load", () => sendMenuCommand(record, command));
  } else {
    sendMenuCommand(record, command);
  }
  return record;
}

function normalizeClaimPath(inputPath: string) {
  return canonicalWorkspaceDocumentPath(inputPath);
}

function authorizeDocumentPath(record: WindowRecord, inputPath: string) {
  return record.authorizedDocumentPaths.authorize(inputPath);
}

function requireAuthorizedDocumentPath(record: WindowRecord, inputPath: string) {
  return record.authorizedDocumentPaths.require(inputPath);
}

async function claimDocument(record: WindowRecord, inputPath: string | null) {
  if (!inputPath) {
    if (record.documentPath && documentClaims.get(record.documentPath) === record.label) {
      documentClaims.delete(record.documentPath);
    }
    record.documentPath = null;
    return { status: "claimed", path: null, ownerLabel: null } as const;
  }
  const normalized = requireAuthorizedDocumentPath(record, inputPath);
  const ownerLabel = documentClaims.get(normalized);
  if (ownerLabel && ownerLabel !== record.label) {
    const owner = windowsByLabel.get(ownerLabel);
    owner?.window.show();
    owner?.window.focus();
    return { status: "alreadyOpen", path: normalized, ownerLabel } as const;
  }
  if (record.documentPath && record.documentPath !== normalized) {
    documentClaims.delete(record.documentPath);
  }
  documentClaims.set(normalized, record.label);
  record.documentPath = normalized;
  return { status: "claimed", path: normalized, ownerLabel: record.label } as const;
}

async function workspaceHost(record: WindowRecord) {
  if (nativeRuntimesShuttingDown) {
    throw new Error("ShipFlow native runtimes are shutting down.");
  }
  const existingHost = workspaceHosts.get(record.label);
  if (existingHost) {
    return existingHost;
  }
  const existingStart = workspaceHostStarts.get(record.label);
  if (existingStart) {
    return existingStart;
  }
  const generation = workspaceHostGeneration;
  const start = (async () => {
    const connection = await serviceAgent.connection();
    if (
      nativeRuntimesShuttingDown ||
      generation !== workspaceHostGeneration ||
      windowsByLabel.get(record.label) !== record
    ) {
      throw new Error("ShipFlow native runtimes are shutting down.");
    }
    const host = new WorkspaceHostClient(record.label, connection);
    workspaceHosts.set(record.label, host);
    return host;
  })();
  workspaceHostStarts.set(record.label, start);
  try {
    return await start;
  } finally {
    if (workspaceHostStarts.get(record.label) === start) {
      workspaceHostStarts.delete(record.label);
    }
  }
}

function stopAllWorkspaceHosts() {
  workspaceHostGeneration += 1;
  workspaceHostStarts.clear();
  for (const host of workspaceHosts.values()) {
    host.stop();
  }
  workspaceHosts.clear();
}

async function checkForUpdates() {
  if (!app.isPackaged) {
    return {
      available: false,
      currentVersion: app.getVersion(),
      version: null,
      body: null,
      downloadUrl: null,
    };
  }
  const result = await autoUpdater.checkForUpdates();
  const info = result?.updateInfo;
  const available = Boolean(info && info.version !== app.getVersion());
  return {
    available,
    currentVersion: app.getVersion(),
    version: available ? info?.version ?? null : null,
    body: available && typeof info?.releaseNotes === "string" ? info.releaseNotes : null,
    downloadUrl: null,
  };
}

async function installUpdate() {
  const status = await checkForUpdates();
  if (!status.available) {
    return status;
  }
  await autoUpdater.downloadUpdate();
  isQuitting = true;
  await shutdownNativeRuntimes();
  quitCleanupStarted = true;
  quitCleanupComplete = true;
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return status;
}

async function shutdownNativeRuntimes() {
  nativeRuntimesShuttingDown = true;
  for (const record of windowsByLabel.values()) {
    record.allowClose = true;
  }
  stopAllWorkspaceHosts();
  await serviceAgent.shutdown();
  stopAllWorkspaceHosts();
}

async function handleCommand(
  event: IpcMainInvokeEvent,
  command: ShipFlowCommand,
  rawArgs?: Record<string, unknown>,
) {
  const record = recordForEvent(event);
  if (
    !COMMON_COMMANDS.has(command) &&
    !(record.kind === "workspace" && WORKSPACE_ONLY_COMMANDS.has(command))
  ) {
    throw new Error(`Command ${command} is not allowed for ${record.kind} windows.`);
  }
  const args = assertObject(rawArgs);
  switch (command) {
    case "resolve_pod_image":
      return resolvePodImage(requireString(args, "imageSource"));
    case "open_external_url": {
      const url = new URL(requireString(args, "url"));
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("External URL must use HTTP(S).");
      }
      await shell.openExternal(url.toString());
      return;
    }
    case "copy_to_clipboard":
      clipboard.writeText(requireString(args, "text"));
      return;
    case "read_from_clipboard":
      return clipboard.readText();
    case "open_app_log":
      return openAppLogFile();
    case "log_frontend_runtime_event":
      if (args.level === "error") {
        appLogger.error("Frontend", args.message ?? "");
      } else {
        appLogger.info("Frontend", args.message ?? "");
      }
      return;
    case "get_release_health":
      return {
        appVersion: app.getVersion(),
        targetOs: process.platform,
        targetArch: process.arch,
        packageName: "shipflow-desktop",
        productName: PRODUCT_NAME,
        appIdentifier: APP_IDENTIFIER,
        debugBuild: !app.isPackaged,
        updaterPluginReady: app.isPackaged,
      };
    case "check_app_update":
      return checkForUpdates();
    case "install_app_update":
      return installUpdate();
    case "load_saved_api_service_config":
      return serviceAgent.loadFrontendConfig();
    case "copy_public_api_token": {
      const result = await dialog.showMessageBox(record.window, {
        type: "warning",
        title: "Copy Public API Token",
        message: "Copy the ShipFlow public API token to the system clipboard?",
        detail: "Only continue when you intend to share this credential with a trusted client.",
        buttons: ["Cancel", "Copy Token"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (result.response !== 1) {
        return false;
      }
      clipboard.writeText(await serviceAgent.publicApiTokenForNativeAction());
      return true;
    }
    case "get_api_service_status":
      return serviceAgent.status();
    case "configure_api_service": {
      const status = await serviceAgent.configure(args.config as ServiceConfig);
      stopAllWorkspaceHosts();
      return status;
    }
    case "validate_tracking_source_config": {
      const config = args.config as ServiceConfig;
      if (config.trackingSource === "externalApi") {
        await serviceAgent.testExternalSource(config);
      }
      return;
    }
    case "test_external_tracking_source":
      return serviceAgent.testExternalSource(args.config as ServiceConfig);
    case "pick_workspace_document_path": {
      const mode = requireString(args, "mode");
      if (mode === "open") {
        const result = await dialog.showOpenDialog(record.window, {
          properties: ["openFile"],
          filters: [{ name: "ShipFlow Workspace", extensions: ["shipflow"] }],
        });
        const selectedPath = result.canceled ? null : result.filePaths[0] ?? null;
        return selectedPath ? authorizeDocumentPath(record, selectedPath) : null;
      }
      const result = await dialog.showSaveDialog(record.window, {
        defaultPath:
          typeof args.suggestedName === "string" ? args.suggestedName : "Untitled.shipflow",
        filters: [{ name: "ShipFlow Workspace", extensions: ["shipflow"] }],
      });
      const selectedPath = result.canceled ? null : result.filePath ?? null;
      return selectedPath ? authorizeDocumentPath(record, selectedPath) : null;
    }
    case "authorize_workspace_document_path": {
      const inputPath = requireString(args, "path");
      const normalized = normalizeClaimPath(inputPath);
      if (record.authorizedDocumentPaths.has(normalized)) {
        return normalized;
      }
      const mode = requireString(args, "mode");
      if (mode === "open") {
        const result = await dialog.showOpenDialog(record.window, {
          defaultPath: normalized,
          properties: ["openFile"],
          filters: [{ name: "ShipFlow Workspace", extensions: ["shipflow"] }],
        });
        const selectedPath = result.canceled ? null : result.filePaths[0] ?? null;
        return selectedPath ? authorizeDocumentPath(record, selectedPath) : null;
      }
      if (mode !== "save") {
        throw new Error("mode must be open or save.");
      }
      const result = await dialog.showSaveDialog(record.window, {
        defaultPath: normalized,
        filters: [{ name: "ShipFlow Workspace", extensions: ["shipflow"] }],
      });
      const selectedPath = result.canceled ? null : result.filePath ?? null;
      return selectedPath ? authorizeDocumentPath(record, selectedPath) : null;
    }
    case "get_current_window_label":
      return record.label;
    case "set_current_window_title":
      record.window.setTitle(requireString(args, "title"));
      return;
    case "set_current_window_document_state":
      record.isDirty = args.isDirty === true;
      record.documentName = requireString(args, "documentName");
      return;
    case "claim_current_workspace_document":
      return claimDocument(record, typeof args.path === "string" ? args.path : null);
    case "read_workspace_document": {
      const inputPath = requireString(args, "path");
      const claim = await claimDocument(record, inputPath);
      if (claim.status !== "claimed") {
        throw new Error(`Workspace is already open in ${claim.ownerLabel}.`);
      }
      return readWorkspaceDocument(claim.path!);
    }
    case "write_workspace_document": {
      const inputPath = requireString(args, "path");
      const claim = await claimDocument(record, inputPath);
      if (claim.status !== "claimed") {
        throw new Error(`Workspace is already open in ${claim.ownerLabel}.`);
      }
      return writeWorkspaceDocument(claim.path!, args.document as WorkspaceDocumentFile);
    }
    case "export_workspace_csv": {
      const result = await dialog.showSaveDialog(record.window, {
        defaultPath: requireString(args, "suggestedName"),
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (result.canceled || !result.filePath) {
        return null;
      }
      return writeCsvExport(
        result.filePath,
        requireString(args, "csvContent"),
        Number(args.rowCount ?? 0),
      );
    }
    case "list_workspace_recovery":
      return listWorkspaceRecovery(
        requireAuthorizedDocumentPath(record, requireString(args, "path")),
      );
    case "create_workspace_window": {
      const documentPath = typeof args.documentPath === "string" ? args.documentPath : null;
      if (documentPath) {
        const normalized = requireAuthorizedDocumentPath(record, documentPath);
        const ownerLabel = documentClaims.get(normalized);
        if (ownerLabel) {
          const owner = windowsByLabel.get(ownerLabel);
          owner?.window.show();
          owner?.window.focus();
          return { status: "alreadyOpen", path: normalized, ownerLabel };
        }
      }
      const next = createWindow("workspace", {
        launchRequest: {
          documentPath: documentPath ? normalizeClaimPath(documentPath) : null,
          startFresh: !documentPath,
        },
      });
      if (documentPath) {
        await claimDocument(next, documentPath);
      }
      return { status: "claimed", path: documentPath, ownerLabel: next.label };
    }
    case "take_pending_workspace_window_request": {
      const request = record.launchRequest;
      record.launchRequest = null;
      return request;
    }
    case "resolve_window_close_request": {
      const action = requireString(args, "action");
      record.closeRequestPending = false;
      if (action === "discard") {
        record.allowClose = true;
        record.window.close();
      }
      return;
    }
    default:
      throw new Error(`Unsupported ShipFlow command: ${command}`);
  }
}

function registerIpc() {
  ipcMain.handle(SHIPFLOW_INVOKE_CHANNEL, handleCommand);
  ipcMain.handle(
    SHIPFLOW_WORKSPACE_REQUEST_CHANNEL,
    async (event, request: ShipFlowWorkspaceRequest) => {
      if (nativeRuntimesShuttingDown) {
        throw new Error("ShipFlow native runtimes are shutting down.");
      }
      const record = recordForEvent(event);
      if (record.kind !== "workspace") {
        throw new Error("Workspace Engine is only available to workspace windows.");
      }
      if (!request || typeof request.requestId !== "string" || typeof request.method !== "string") {
        throw new Error("Invalid Workspace Engine request.");
      }
      if (!ALLOWED_WORKSPACE_METHODS.has(request.method)) {
        throw new Error(`Unsupported Workspace Engine method: ${request.method}`);
      }
      const host = await workspaceHost(record);
      return host.request(request.method, request.params, (workspaceEvent) => {
        if (!record.window.isDestroyed()) {
          record.window.webContents.send(SHIPFLOW_WORKSPACE_EVENT_CHANNEL, {
            requestId: request.requestId,
            event: workspaceEvent,
          });
        }
      });
    },
  );
}

function configureSessionSecurity() {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [CSP],
      },
    });
  });
}

function workspaceDocumentFromArgs(args: string[]) {
  return args.find((argument) => argument.toLowerCase().endsWith(".shipflow")) ?? null;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  appLogger.warn("Electron", "A second application instance was rejected.");
  app.quit();
} else {
  process.on("uncaughtExceptionMonitor", (error) =>
    appLogger.error("UncaughtException", error),
  );
  process.on("unhandledRejection", (error) => appLogger.error("UnhandledRejection", error));
  app.on("second-instance", (_event, argv) => {
    appLogger.info("Electron", "Forwarding a second-instance request to the active application.");
    const documentPath = workspaceDocumentFromArgs(argv);
    if (argv.includes("--service-settings")) {
      openWorkspaceSettings("service");
      return;
    }
    const existing = focusedWorkspaceRecord();
    if (documentPath && existing) {
      authorizeDocumentPath(existing, documentPath);
      void claimDocument(existing, documentPath).then((claim) => {
        if (claim.status === "claimed") {
          existing.launchRequest = { documentPath: claim.path, startFresh: false };
          existing.window.reload();
        }
      });
      return;
    }
    openOrFocusWorkspace();
  });

  app.whenReady().then(async () => {
    appLogger.info(
      "Electron",
      `Application ready version=${app.getVersion()} platform=${process.platform} arch=${process.arch} packaged=${app.isPackaged}.`,
    );
    configureSessionSecurity();
    registerIpc();
    installApplicationMenu();
    installTray();
    await mkdir(app.getPath("userData"), { recursive: true });
    const initialDocument = workspaceDocumentFromArgs(process.argv);
    if (process.argv.includes("--service-settings")) {
      openWorkspaceSettings("service");
    } else if (!process.argv.includes("--background")) {
      createWindow("workspace", {
        label: "main",
        launchRequest: initialDocument
          ? { documentPath: initialDocument, startFresh: false }
          : null,
      });
    }
    void serviceAgent.connection().catch((error) => {
      appLogger.error("ServiceAgent", error);
    });
  });

  app.on("activate", () => openOrFocusWorkspace());
  app.on("window-all-closed", () => {
    void serviceAgent
      .keepRunningInTray()
      .then((keepRunningInTray) => {
        if (!keepRunningInTray) {
          isQuitting = true;
          app.quit();
        }
      })
      .catch((error) => {
        appLogger.error("ServiceAgent", `Unable to read tray lifecycle setting: ${String(error)}`);
      });
  });
  app.on("before-quit", (event) => {
    isQuitting = true;
    if (quitCleanupComplete) {
      return;
    }
    event.preventDefault();
    if (quitCleanupStarted) {
      return;
    }
    quitCleanupStarted = true;
    void shutdownNativeRuntimes()
      .catch((error) => {
        appLogger.error("ServiceAgent", `Service shutdown during quit failed: ${String(error)}`);
      })
      .then(() => appLogger.flush())
      .finally(() => {
        quitCleanupComplete = true;
        app.exit(0);
      });
  });
}
