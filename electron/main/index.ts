import path from "node:path";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import {
  app,
  BrowserWindow,
  clipboard,
  crashReporter,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  powerMonitor,
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
import { isTrustedRendererNavigation } from "./renderer-navigation";
import { ServiceAgentManager } from "./service-agent";
import { WorkspaceHostClient } from "./workspace-host";
import {
  ApplicationQuitCoordinator,
  type ApplicationQuitReason,
} from "./application-lifecycle";
import {
  applicationLaunchRequestFromArgs,
  ApplicationLaunchQueue,
  type ApplicationLaunchRequest,
} from "./launch-request-queue";
import {
  isRecoverableRendererExit,
  RendererRecoveryPolicy,
} from "./renderer-recovery";
import { buildViewMenu } from "./application-menu";
import { appUpdateStatus } from "./app-update";
import {
  inspectCrashDumps,
  summarizeProcessMetrics,
} from "./crash-diagnostics";

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
  rendererRecoveryPolicy: RendererRecoveryPolicy;
  rendererRecoveryTimer: NodeJS.Timeout | null;
  rendererFallbackActive: boolean;
  lastIpcActivity: string | null;
  lastIpcActivityAtMs: number | null;
  lastIpcActivityState: "started" | "completed" | "failed" | null;
  authorizedDocumentPaths: DocumentPathCapabilities;
};

const PRODUCT_NAME = "ShipFlow Desktop";
const APP_IDENTIFIER = "com.shipflow.desktop";
app.setName(PRODUCT_NAME);
app.setPath(
  "userData",
  process.env.SHIPFLOW_USER_DATA_DIR?.trim()
    ? path.resolve(process.env.SHIPFLOW_USER_DATA_DIR.trim())
    : path.join(app.getPath("appData"), APP_IDENTIFIER),
);
app.setAppLogsPath();
configureAppLogger(
  process.env.SHIPFLOW_LOG_FILE?.trim()
    ? path.resolve(process.env.SHIPFLOW_LOG_FILE.trim())
    : path.join(app.getPath("logs"), "shipflow-desktop.log"),
);
const crashDumpsPath = path.join(app.getPath("userData"), "Crashpad");
app.setPath("crashDumps", crashDumpsPath);
let crashReporterStarted = false;
try {
  crashReporter.start({
    compress: false,
    globalExtra: {
      appIdentifier: APP_IDENTIFIER,
      arch: process.arch,
      packaged: String(app.isPackaged),
      platform: process.platform,
    },
    ignoreSystemCrashHandler: false,
    productName: PRODUCT_NAME,
    rateLimit: false,
    uploadToServer: false,
  });
  crashReporterStarted = true;
} catch (error) {
  appLogger.error("CrashReporter", error);
}
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
let rendererIpcActivitySequence = 0;
let windowSequence = 0;
let tray: Tray | null = null;
let isQuitting = false;
let sessionSecurityConfigured = false;
let quitCleanupStarted = false;
let quitCleanupComplete = false;
let nativeRuntimesShuttingDown = false;
let runtimeDiagnosticsTimer: NodeJS.Timeout | null = null;
let updateReadyToInstall = false;

const RUNTIME_DIAGNOSTICS_INTERVAL_MS = 60_000;
const RENDERER_RECOVERY_DELAY_MS = 250;
const CRASH_DUMP_SETTLE_DELAY_MS = 1_000;

const quitCoordinator = new ApplicationQuitCoordinator<WindowRecord>({
  windows: () => windowsByLabel.values(),
  requestDecision: requestWindowQuitDecision,
  finalize: finalizeApplicationQuit,
});
const launchQueue = new ApplicationLaunchQueue(async (request) => {
  try {
    await handleApplicationLaunch(request);
  } catch (error) {
    appLogger.error("ElectronLaunch", error);
    dialog.showErrorBox(
      PRODUCT_NAME,
      `Unable to process the application launch request: ${String(error)}`,
    );
  }
});

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
  if (
    !record.window.isDestroyed() &&
    !record.window.webContents.isDestroyed()
  ) {
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

async function openAppLogsFolder() {
  try {
    const logPath = await appLogger.ensureFile();
    const error = await shell.openPath(path.dirname(logPath));
    if (error) {
      throw new Error(`Unable to open ShipFlow logs folder: ${error}`);
    }
    appLogger.info("Electron", "Opened the application logs folder.");
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

function logFolderMenuItem(): Electron.MenuItemConstructorOptions {
  return {
    label: "Open Logs Folder",
    click: () => {
      void openAppLogsFolder().catch((error) => {
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
        logFolderMenuItem(),
        ...(process.platform === "darwin"
          ? []
          : [{ type: "separator" as const }, { role: "quit" as const }]),
      ],
    },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    {
      label: "View",
      submenu: buildViewMenu(app.isPackaged),
    },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }] },
    {
      label: "Help",
      submenu: [
        menuItem("Workspace Settings", "show-settings"),
        menuItem("Service Settings", "show-service-settings"),
        { type: "separator" },
        menuItem("Check for Updates", "check-for-updates"),
        menuItem("Install Update", "install-app-update"),
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
        click: () => app.quit(),
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

function packagedRendererPath() {
  return path.join(__dirname, "../renderer/index.html");
}

async function loadRenderer(record: WindowRecord) {
  if (process.env.ELECTRON_RENDERER_URL) {
    await record.window.loadURL(rendererUrl(record.kind, record.label));
    return;
  }
  await record.window.loadFile(packagedRendererPath(), {
    query: { windowKind: record.kind, windowLabel: record.label },
  });
}

function scheduleRendererRecovery(record: WindowRecord) {
  if (
    isQuitting ||
    nativeRuntimesShuttingDown ||
    record.window.isDestroyed() ||
    record.window.webContents.isDestroyed() ||
    record.rendererRecoveryTimer
  ) {
    return;
  }
  if (!record.rendererRecoveryPolicy.registerAttempt()) {
    appLogger.event("ERROR", "Renderer", "renderer_recovery_exhausted", {
      windowLabel: record.label,
    });
    void showRendererRecoveryFallback(record);
    return;
  }
  appLogger.event("WARN", "Renderer", "renderer_recovery_scheduled", {
    delayMs: RENDERER_RECOVERY_DELAY_MS,
    windowLabel: record.label,
  });
  record.rendererRecoveryTimer = setTimeout(() => {
    record.rendererRecoveryTimer = null;
    if (
      isQuitting ||
      nativeRuntimesShuttingDown ||
      record.window.isDestroyed() ||
      record.window.webContents.isDestroyed()
    ) {
      return;
    }
    void loadRenderer(record)
      .then(() => {
        appLogger.event("INFO", "Renderer", "renderer_recovery_completed", {
          windowLabel: record.label,
        });
      })
      .catch((error) => {
        appLogger.error("RendererRecovery", error);
        scheduleRendererRecovery(record);
      });
  }, RENDERER_RECOVERY_DELAY_MS);
}

async function showRendererRecoveryFallback(record: WindowRecord) {
  if (record.rendererFallbackActive || record.window.isDestroyed()) {
    return;
  }
  record.rendererFallbackActive = true;
  try {
    const result = await dialog.showMessageBox(record.window, {
      buttons: ["Restart ShipFlow Desktop", "Open Logs Folder", "Close"],
      cancelId: 2,
      defaultId: 0,
      detail:
        "Automatic display recovery was stopped to avoid a crash loop. Workspace data remains managed by the local engine.",
      message: "The workspace display stopped repeatedly.",
      noLink: true,
      title: PRODUCT_NAME,
      type: "error",
    });
    appLogger.event("INFO", "Renderer", "renderer_recovery_fallback_action", {
      action:
        result.response === 0
          ? "restart"
          : result.response === 1
            ? "open_logs"
            : "close",
      windowLabel: record.label,
    });
    if (result.response === 0) {
      app.relaunch();
      await finalizeApplicationQuit("app");
    } else if (result.response === 1) {
      await openAppLogsFolder();
    }
  } catch (error) {
    appLogger.error("RendererRecovery", error);
  } finally {
    record.rendererFallbackActive = false;
  }
}

function logRendererCrashDiagnostics(record: WindowRecord) {
  const metrics = summarizeProcessMetrics(app.getAppMetrics());
  const memory = process.memoryUsage();
  appLogger.event("ERROR", "Renderer", "renderer_crash_diagnostics", {
    ...metrics,
    crashDumpsPath,
    freeSystemMemoryBytes: os.freemem(),
    gpuFeatureStatus: JSON.stringify(app.getGPUFeatureStatus()),
    lastIpcActivity: record.lastIpcActivity,
    lastIpcActivityAgeMs:
      record.lastIpcActivityAtMs === null
        ? null
        : Math.max(0, Date.now() - record.lastIpcActivityAtMs),
    lastIpcActivityState: record.lastIpcActivityState,
    mainHeapUsedBytes: memory.heapUsed,
    mainRssBytes: memory.rss,
    windowLabel: record.label,
  });
  const timer = setTimeout(() => {
    void inspectCrashDumps(crashDumpsPath)
      .then((inventory) => {
        appLogger.event("INFO", "Renderer", "renderer_crash_dump_inventory", {
          ...inventory,
          crashDumpsPath,
          windowLabel: record.label,
        });
      })
      .catch((error) => {
        appLogger.error("CrashReporter", error);
      });
  }, CRASH_DUMP_SETTLE_DELAY_MS);
  timer.unref();
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
  if (!sessionSecurityConfigured) {
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.session.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    );
    sessionSecurityConfigured = true;
  }
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
    rendererRecoveryPolicy: new RendererRecoveryPolicy(),
    rendererRecoveryTimer: null,
    rendererFallbackActive: false,
    lastIpcActivity: null,
    lastIpcActivityAtMs: null,
    lastIpcActivityState: null,
    authorizedDocumentPaths: new DocumentPathCapabilities(
      options.launchRequest?.documentPath
        ? [normalizeClaimPath(options.launchRequest.documentPath)]
        : [],
    ),
  };
  const webContentsId = window.webContents.id;
  appLogger.info("Electron", `Creating workspace window ${label}.`);
  appLogger.event("INFO", "Lifecycle", "window_created", {
    height: 860,
    webContentsId,
    width: 1280,
    windowLabel: label,
  });
  windowsByWebContentsId.set(webContentsId, record);
  windowsByLabel.set(label, record);

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (
      !isTrustedRendererNavigation(
        targetUrl,
        process.env.ELECTRON_RENDERER_URL,
        packagedRendererPath(),
      )
    ) {
      appLogger.warn("Renderer", `Blocked navigation to ${targetUrl}.`);
      event.preventDefault();
    }
  });
  window.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (isMainFrame) {
        appLogger.error(
          "Renderer",
          `Main frame failed to load ${validatedUrl}: ${errorCode} ${errorDescription}.`,
        );
      }
    },
  );
  window.webContents.on("render-process-gone", (_event, details) => {
    appLogger.event(
      "ERROR",
      "Renderer",
      "renderer_process_gone",
      {
        exitCode: details.exitCode,
        reason: details.reason,
        windowLabel: label,
      },
    );
    try {
      logRendererCrashDiagnostics(record);
    } catch (error) {
      // Diagnostics must never prevent the renderer recovery path.
      appLogger.error("CrashReporter", error);
    }
    if (isRecoverableRendererExit(details.reason)) {
      scheduleRendererRecovery(record);
    }
  });
  window.webContents.on("dom-ready", () => {
    appLogger.info("Renderer", `DOM ready for ${window.webContents.getURL()}.`);
  });
  window.webContents.on("did-finish-load", () => {
    appLogger.info("Renderer", `Finished loading ${window.webContents.getURL()}.`);
  });
  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    const logLevel = level >= 3 ? "error" : "info";
    appLogger[logLevel](
      "RendererConsole",
      `${message} (${sourceId}:${line})`,
    );
  });
  window.once("ready-to-show", () => {
    appLogger.event("INFO", "Renderer", "window_ready_to_show", {
      windowLabel: label,
    });
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
    appLogger.event("INFO", "Lifecycle", "window_closed", {
      windowLabel: label,
    });
    windowsByWebContentsId.delete(webContentsId);
    windowsByLabel.delete(label);
    quitCoordinator.remove(record);
    if (record.rendererRecoveryTimer) {
      clearTimeout(record.rendererRecoveryTimer);
      record.rendererRecoveryTimer = null;
    }
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
  appLogger.info(
    "Renderer",
    `Loading ${process.env.ELECTRON_RENDERER_URL ?? packagedRendererPath()}.`,
  );
  void loadRenderer(record)
    .then(() => {
      appLogger.info("Renderer", `loadRenderer resolved for ${label}.`);
    })
    .catch((error) => {
      appLogger.error("Renderer", error);
      dialog.showErrorBox("ShipFlow Desktop", `Unable to load the renderer: ${String(error)}`);
    });
  return record;
}

function openOrFocusWorkspace() {
  const existing = [...windowsByLabel.values()].find((record) => record.kind === "workspace");
  if (existing) {
    if (existing.window.webContents.isCrashed()) {
      scheduleRendererRecovery(existing);
    }
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
  return appUpdateStatus(result, app.getVersion());
}

async function installUpdate() {
  const status = await checkForUpdates();
  if (!status.available) {
    return status;
  }
  await autoUpdater.downloadUpdate();
  updateReadyToInstall = true;
  quitCoordinator.request("update");
  return status;
}

function requestWindowQuitDecision(record: WindowRecord) {
  if (
    record.window.isDestroyed() ||
    record.window.webContents.isDestroyed()
  ) {
    quitCoordinator.remove(record);
    return;
  }
  emitWindowEvent(record, "shipflow://window-close-requested", {
    documentName: record.documentName,
  });
  record.window.show();
  record.window.focus();
}

async function finalizeApplicationQuit(reason: ApplicationQuitReason) {
  if (isQuitting) {
    return;
  }
  isQuitting = true;
  quitCleanupStarted = true;
  stopRuntimeDiagnostics();
  appLogger.event("INFO", "Lifecycle", "native_shutdown_started_for_quit", {
    reason,
  });
  try {
    await shutdownNativeRuntimes();
  } catch (error) {
    appLogger.error(
      "ServiceAgent",
      `Service shutdown during quit failed: ${String(error)}`,
    );
  }
  appLogger.event("INFO", "Lifecycle", "app_exit", {
    code: 0,
    reason,
  });
  try {
    await appLogger.flush();
  } catch (error) {
    // A logging failure must not leave the application stuck during shutdown.
    console.error("Unable to flush ShipFlow logs during shutdown.", error);
  }
  quitCleanupComplete = true;
  if (reason === "update" && updateReadyToInstall) {
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return;
  }
  setImmediate(() => app.quit());
}

async function shutdownNativeRuntimes() {
  appLogger.event("INFO", "Lifecycle", "native_shutdown_started", {
    windowCount: windowsByLabel.size,
  });
  nativeRuntimesShuttingDown = true;
  for (const record of windowsByLabel.values()) {
    record.allowClose = true;
  }
  stopAllWorkspaceHosts();
  await serviceAgent.shutdown();
  stopAllWorkspaceHosts();
  appLogger.event("INFO", "Lifecycle", "native_shutdown_completed");
}

function logRuntimeDiagnostics(eventName = "runtime_heartbeat") {
  const memory = process.memoryUsage();
  const appMetrics = app.getAppMetrics();
  const aggregateWorkingSetKb = appMetrics.reduce(
    (total, metric) => total + (metric.memory?.workingSetSize ?? 0),
    0,
  );
  appLogger.event("INFO", "Diagnostics", eventName, {
    appProcessCount: appMetrics.length,
    aggregateWorkingSetKb,
    freeSystemMemoryBytes: os.freemem(),
    heapUsedBytes: memory.heapUsed,
    mainRssBytes: memory.rss,
    uptimeSec: Math.floor(process.uptime()),
    windowCount: windowsByLabel.size,
    workspaceHostCount: workspaceHosts.size,
  });
}

function startRuntimeDiagnostics() {
  logRuntimeDiagnostics("runtime_snapshot");
  runtimeDiagnosticsTimer = setInterval(
    () => logRuntimeDiagnostics(),
    RUNTIME_DIAGNOSTICS_INTERVAL_MS,
  );
  runtimeDiagnosticsTimer.unref();
}

function stopRuntimeDiagnostics() {
  if (runtimeDiagnosticsTimer) {
    clearInterval(runtimeDiagnosticsTimer);
    runtimeDiagnosticsTimer = null;
  }
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
      if (action !== "cancel" && action !== "discard") {
        throw new Error("action must be cancel or discard.");
      }
      record.closeRequestPending = false;
      if (quitCoordinator.resolve(record, action)) {
        return;
      }
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
  ipcMain.handle(
    SHIPFLOW_INVOKE_CHANNEL,
    async (event, command: ShipFlowCommand, args?: Record<string, unknown>) => {
      const startedAt = Date.now();
      const record = windowsByWebContentsId.get(event.sender.id);
      const windowLabel = record?.label ?? "unknown";
      const activity = `command:${String(command).slice(0, 96)}#${++rendererIpcActivitySequence}`;
      if (record) {
        record.lastIpcActivity = activity;
        record.lastIpcActivityAtMs = startedAt;
        record.lastIpcActivityState = "started";
      }
      appLogger.event("INFO", "IPC", "command_started", {
        command: String(command).slice(0, 128),
        windowLabel,
      });
      try {
        const result = await handleCommand(event, command, args);
        appLogger.event("INFO", "IPC", "command_completed", {
          command: String(command).slice(0, 128),
          durationMs: Date.now() - startedAt,
          result: "ok",
          windowLabel,
        });
        if (record?.lastIpcActivity === activity) {
          record.lastIpcActivityAtMs = Date.now();
          record.lastIpcActivityState = "completed";
        }
        return result;
      } catch (error) {
        appLogger.event("ERROR", "IPC", "command_completed", {
          command: String(command).slice(0, 128),
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          result: "error",
          windowLabel,
        });
        if (record?.lastIpcActivity === activity) {
          record.lastIpcActivityAtMs = Date.now();
          record.lastIpcActivityState = "failed";
        }
        throw error;
      }
    },
  );
  ipcMain.handle(
    SHIPFLOW_WORKSPACE_REQUEST_CHANNEL,
    async (event, request: ShipFlowWorkspaceRequest) => {
      const startedAt = Date.now();
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
      const auditRequestId = request.requestId.slice(0, 128);
      const activity = `workspace:${request.method}:${auditRequestId}`;
      record.lastIpcActivity = activity;
      record.lastIpcActivityAtMs = startedAt;
      record.lastIpcActivityState = "started";
      appLogger.event("INFO", "WorkspaceIPC", "request_started", {
        method: request.method,
        requestId: auditRequestId,
        windowLabel: record.label,
      });
      try {
        const host = await workspaceHost(record);
        const result = await host.request(
          request.method,
          request.params,
          (workspaceEvent) => {
            if (!record.window.isDestroyed()) {
              record.window.webContents.send(SHIPFLOW_WORKSPACE_EVENT_CHANNEL, {
                requestId: request.requestId,
                event: workspaceEvent,
              });
            }
          },
        );
        appLogger.event("INFO", "WorkspaceIPC", "request_completed", {
          durationMs: Date.now() - startedAt,
          method: request.method,
          requestId: auditRequestId,
          result: "ok",
          windowLabel: record.label,
        });
        if (record.lastIpcActivity === activity) {
          record.lastIpcActivityAtMs = Date.now();
          record.lastIpcActivityState = "completed";
        }
        return result;
      } catch (error) {
        appLogger.event("ERROR", "WorkspaceIPC", "request_completed", {
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          method: request.method,
          requestId: auditRequestId,
          result: "error",
          windowLabel: record.label,
        });
        if (record.lastIpcActivity === activity) {
          record.lastIpcActivityAtMs = Date.now();
          record.lastIpcActivityState = "failed";
        }
        throw error;
      }
    },
  );
}

async function openWorkspaceDocumentFromLaunch(documentPath: string) {
  const normalized = normalizeClaimPath(documentPath);
  const ownerLabel = documentClaims.get(normalized);
  if (ownerLabel) {
    const owner = windowsByLabel.get(ownerLabel);
    owner?.window.show();
    owner?.window.focus();
    return owner ?? null;
  }

  const existing = focusedWorkspaceRecord();
  if (!existing || existing.isDirty) {
    const next = createWindow("workspace", {
      label: windowsByLabel.has("main") ? undefined : "main",
      launchRequest: { documentPath: normalized, startFresh: false },
    });
    await claimDocument(next, normalized);
    return next;
  }

  authorizeDocumentPath(existing, normalized);
  const claim = await claimDocument(existing, normalized);
  if (claim.status !== "claimed") {
    return windowsByLabel.get(claim.ownerLabel ?? "") ?? existing;
  }
  existing.launchRequest = { documentPath: claim.path, startFresh: false };
  if (existing.window.webContents.isCrashed()) {
    scheduleRendererRecovery(existing);
  } else {
    existing.window.webContents.reload();
  }
  existing.window.show();
  existing.window.focus();
  return existing;
}

async function handleApplicationLaunch(request: ApplicationLaunchRequest) {
  switch (request.kind) {
    case "service-settings":
      openWorkspaceSettings("service");
      return;
    case "document":
      await openWorkspaceDocumentFromLaunch(request.documentPath);
      return;
    case "workspace":
      openOrFocusWorkspace();
      return;
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  appLogger.warn("Electron", "A second application instance was rejected.");
  appLogger.event("WARN", "Lifecycle", "secondary_instance_rejected", {
    pid: process.pid,
  });
  app.quit();
} else {
  appLogger.event("INFO", "Lifecycle", "app_launch", {
    arch: process.arch,
    chromeVersion: process.versions.chrome,
    crashDumpsPath,
    crashReporterStarted,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    osRelease: os.release(),
    packaged: app.isPackaged,
    pid: process.pid,
    platform: process.platform,
    version: app.getVersion(),
  });
  process.on("uncaughtExceptionMonitor", (error) =>
    appLogger.error("UncaughtException", error),
  );
  process.on("unhandledRejection", (error) => appLogger.error("UnhandledRejection", error));
  app.on("child-process-gone", (_event, details) => {
    appLogger.event("ERROR", "Lifecycle", "electron_child_process_gone", {
      exitCode: details.exitCode,
      name: details.name,
      reason: details.reason,
      serviceName: details.serviceName,
      type: details.type,
    });
  });
  app.on("second-instance", (_event, argv) => {
    appLogger.info("Electron", "Forwarding a second-instance request to the active application.");
    const launchRequest = applicationLaunchRequestFromArgs(argv);
    appLogger.event("INFO", "Lifecycle", "secondary_instance_forwarded", {
      hasDocument: launchRequest.kind === "document",
      opensServiceSettings: argv.includes("--service-settings"),
    });
    launchQueue.enqueue(launchRequest);
  });
  app.on("open-file", (event, documentPath) => {
    event.preventDefault();
    appLogger.event("INFO", "Lifecycle", "open_file_forwarded", {
      documentPath,
    });
    launchQueue.enqueue({ kind: "document", documentPath });
  });

  void app.whenReady().then(async () => {
    appLogger.info(
      "Electron",
      `Application ready version=${app.getVersion()} platform=${process.platform} arch=${process.arch} packaged=${app.isPackaged}.`,
    );
    appLogger.event("INFO", "Lifecycle", "app_ready", {
      arch: process.arch,
      packaged: app.isPackaged,
      platform: process.platform,
      version: app.getVersion(),
    });
    registerIpc();
    appLogger.info("Electron", "IPC handlers registered.");
    installApplicationMenu();
    appLogger.info("Electron", "Application menu installed.");
    installTray();
    appLogger.info("Electron", "Tray installed.");
    await mkdir(app.getPath("userData"), { recursive: true });
    appLogger.info("Electron", "User data directory ready.");
    powerMonitor.on("suspend", () => {
      appLogger.event("INFO", "Lifecycle", "system_suspend");
    });
    powerMonitor.on("resume", () => {
      appLogger.event("INFO", "Lifecycle", "system_resume");
      logRuntimeDiagnostics("runtime_resume_snapshot");
    });
    startRuntimeDiagnostics();
    if (process.argv.includes("--service-settings")) {
      launchQueue.enqueue({ kind: "service-settings" });
    } else if (!process.argv.includes("--background")) {
      launchQueue.enqueue(applicationLaunchRequestFromArgs(process.argv));
    }
    launchQueue.markReady();
    void serviceAgent.connection().catch((error) => {
      appLogger.error("ServiceAgent", error);
    });
  }).catch(async (error) => {
    appLogger.event("ERROR", "Lifecycle", "startup_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    appLogger.error("ElectronStartup", error);
    await appLogger.flush();
    dialog.showErrorBox("ShipFlow Desktop", `Application startup failed: ${String(error)}`);
    app.exit(1);
  });

  app.on("activate", () => {
    appLogger.event("INFO", "Lifecycle", "app_activated");
    launchQueue.enqueue({ kind: "workspace" });
  });
  app.on("window-all-closed", () => {
    appLogger.event("INFO", "Lifecycle", "all_windows_closed");
    void serviceAgent
      .keepRunningInTray()
      .then((keepRunningInTray) => {
        if (!keepRunningInTray) {
          app.quit();
        }
      })
      .catch((error) => {
        appLogger.error("ServiceAgent", `Unable to read tray lifecycle setting: ${String(error)}`);
      });
  });
  app.on("before-quit", (event) => {
    appLogger.event("INFO", "Lifecycle", "before_quit", {
      cleanupComplete: quitCleanupComplete,
      cleanupStarted: quitCleanupStarted,
      dirtyWindowCount: [...windowsByLabel.values()].filter(
        (record) => record.isDirty && !record.allowClose,
      ).length,
    });
    if (quitCleanupComplete) {
      return;
    }
    event.preventDefault();
    quitCoordinator.request("app");
  });
}
