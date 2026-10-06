import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

const require = createRequire(import.meta.url);
const developmentElectronPath = require("electron") as string;
const execFileAsync = promisify(execFile);

type SmokeRuntime = {
  application: ElectronApplication;
  environment: NodeJS.ProcessEnv;
  executablePath: string;
  executableArguments: string[];
  logFilePath: string;
  serviceLogFilePath: string;
  rootDirectory: string;
  serviceStateDirectory: string;
  servicePort: number;
  publicToken: string;
  internalToken: string;
};

async function reservePort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Unable to reserve an Electron smoke-test port.");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("The second ShipFlow Desktop instance did not exit."));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function openServiceSettingsWindow(runtime: SmokeRuntime) {
  const serviceSettingsWindowPromise =
    runtime.application.waitForEvent("window");

  if (process.platform === "linux") {
    await runtime.application.evaluate(
      ({ Menu }, menuItemId) => {
        const menuItem = Menu.getApplicationMenu()?.getMenuItemById(menuItemId);
        if (!menuItem) {
          throw new Error(
            `Application menu item ${menuItemId} is not available.`,
          );
        }
        menuItem.click();
      },
      "shipflow-service-settings",
    );
  } else {
    const serviceSettingsLaunch = spawn(
      runtime.executablePath,
      [...runtime.executableArguments, "--service-settings"],
      {
        env: runtime.environment,
        stdio: "ignore",
      },
    );
    await waitForExit(serviceSettingsLaunch, 10_000);
  }

  return serviceSettingsWindowPromise;
}

function processIdIsAlive(processId: number) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessIdExit(processId: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIdIsAlive(processId)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !processIdIsAlive(processId);
}

async function terminateProcessTree(processId: number, label: string) {
  if (!processIdIsAlive(processId)) {
    return true;
  }

  console.warn(
    `[ShipFlowSmokeCleanup] forcing ${label} process tree pid=${processId}`,
  );
  if (process.platform === "win32") {
    await execFileAsync(
      "taskkill",
      ["/PID", String(processId), "/T", "/F"],
      { windowsHide: true },
    ).catch((error) => {
      if (processIdIsAlive(processId)) {
        console.warn(
          `[ShipFlowSmokeCleanup] taskkill failed for ${label} pid=${processId}: ${String(error)}`,
        );
      }
    });
  } else {
    try {
      process.kill(processId, "SIGTERM");
    } catch {
      // The process may have exited between the liveness check and signal.
    }
    if (!(await waitForProcessIdExit(processId, 2_000))) {
      try {
        process.kill(processId, "SIGKILL");
      } catch {
        // The process may have exited between the liveness check and signal.
      }
    }
  }

  return waitForProcessIdExit(processId, 5_000);
}

async function settleWithin(task: Promise<unknown>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
  });
  const settled = task.then(
    () => true,
    () => true,
  );
  const result = await Promise.race([settled, timedOut]);
  if (timeout) {
    clearTimeout(timeout);
  }
  return result;
}

async function startSuite(): Promise<SmokeRuntime> {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "shipflow-electron-smoke-"));
  const userDataDirectory = path.join(rootDirectory, "desktop");
  const serviceStateDirectory = path.join(rootDirectory, "service");
  const servicePort = await reservePort();
  const publicToken = "sf_electron_smoke_public";
  const internalToken = "sf_electron_smoke_internal";
  const logFilePath = path.join(rootDirectory, "shipflow-desktop.log");
  const serviceLogFilePath = path.join(rootDirectory, "shipflow-service.log");
  await mkdir(serviceStateDirectory, { recursive: true });
  await writeFile(
    path.join(serviceStateDirectory, "agent-config.json"),
    `${JSON.stringify(
      {
        version: 2,
        enabled: true,
        mode: "local",
        port: servicePort,
        publicApiToken: publicToken,
        internalToken,
        trackingSource: "default",
        externalApiBaseUrl: "",
        externalApiAuthToken: "",
        allowInsecureExternalApiHttp: false,
        keepRunningInTray: false,
        startAtLogin: false,
        lastUpdatedAt: new Date().toISOString(),
        processId: null,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const executablePath = developmentElectronPath;
  const executableArguments = [
    path.resolve("out/main/index.js"),
    "--password-store=basic",
  ];
  const environment = {
    ...process.env,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    SHIPFLOW_USER_DATA_DIR: userDataDirectory,
    SHIPFLOW_SERVICE_AGENT_STATE_DIR: serviceStateDirectory,
    SHIPFLOW_LOG_FILE: logFilePath,
    SHIPFLOW_SERVICE_LOG_FILE: serviceLogFilePath,
    SHIPFLOW_CONTACT_STORE_PATH: path.join(rootDirectory, "contacts.sqlite3"),
  };
  const application = await electron.launch({
    executablePath,
    args: executableArguments,
    env: environment,
  });

  return {
    application,
    environment,
    executablePath,
    executableArguments,
    logFilePath,
    serviceLogFilePath,
    rootDirectory,
    serviceStateDirectory,
    servicePort,
    publicToken,
    internalToken,
  };
}

async function readManagedServicePid(serviceStateDirectory: string) {
  const config = JSON.parse(
    await readFile(path.join(serviceStateDirectory, "agent-config.json"), "utf8"),
  ) as { processId?: unknown };
  return typeof config.processId === "number" ? config.processId : null;
}

async function readServiceStatus(runtime: SmokeRuntime) {
  const response = await fetch(
    `http://127.0.0.1:${runtime.servicePort}/v1/status`,
  );
  if (!response.ok) {
    return null;
  }

  const body = (await response.json()) as {
    data?: { service?: unknown; port?: unknown };
  };
  return {
    status:
      typeof body.data?.service === "string" ? body.data.service : null,
    port: typeof body.data?.port === "number" ? body.data.port : null,
  };
}

async function findWindowWithHeading(
  application: ElectronApplication,
  heading: string,
): Promise<Page> {
  await expect
    .poll(async () => {
      const matches = await Promise.all(
        application
          .windows()
          .map((window) => window.getByRole("heading", { name: heading }).count()),
      );
      return matches.reduce((total, count) => total + count, 0);
    })
    .toBe(1);
  const windows = application.windows();
  for (const window of windows) {
    if ((await window.getByRole("heading", { name: heading }).count()) > 0) {
      return window;
    }
  }
  throw new Error(`Electron window with heading ${heading} was not found.`);
}

async function dragFieldToZone(
  page: Page,
  fieldLabel: string,
  zoneLabel: string,
) {
  const source = page.getByRole("listitem", { name: `Field ${fieldLabel}` });
  const target = page.getByRole("list", { name: `${zoneLabel} aktif` });

  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  await expect(source).toBeVisible();
  await expect(target).toBeVisible();

  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) {
    throw new Error(
      `Cannot drag ${fieldLabel}; source or target box is unavailable.`,
    );
  }

  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2,
    sourceBox.y + sourceBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2 + 8,
    sourceBox.y + sourceBox.height / 2 + 8,
  );
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + targetBox.height / 2,
    { steps: 12 },
  );
  await expect(
    target
      .locator(".analytics-selected-drop-preview")
      .filter({ hasText: fieldLabel }),
  ).toBeVisible();
  await page.mouse.up();

  await expect(
    page.getByRole("listitem", { name: `${zoneLabel} ${fieldLabel}` }),
  ).toBeVisible();
}

async function closeApplication(runtime: SmokeRuntime) {
  const applicationProcess = runtime.application.process();
  const desktopProcessId = applicationProcess.pid;
  const serviceProcessId = await readManagedServicePid(
    runtime.serviceStateDirectory,
  ).catch(() => null);
  await Promise.all(
    runtime.application.windows().map((window) =>
      window
        .evaluate(async () => {
          await window.shipflow?.invoke("set_current_window_document_state", {
            documentName: "Electron smoke workspace",
            isDirty: false,
          });
        })
        .catch(() => undefined),
    ),
  );
  const closeTask = runtime.application.close();
  const closedGracefully = await settleWithin(closeTask, 20_000);

  if (!closedGracefully || processIdIsAlive(desktopProcessId)) {
    await terminateProcessTree(desktopProcessId, "Desktop");
  }
  if (
    serviceProcessId !== null &&
    !(await waitForProcessIdExit(serviceProcessId, 5_000))
  ) {
    await terminateProcessTree(serviceProcessId, "Service");
  }

  const closeSettled = closedGracefully || (await settleWithin(closeTask, 5_000));
  const desktopStopped = await waitForProcessIdExit(desktopProcessId, 2_000);
  const serviceStopped =
    serviceProcessId === null ||
    (await waitForProcessIdExit(serviceProcessId, 2_000));

  console.info(
    `[ShipFlowSmokeCleanup] complete closeSettled=${closeSettled} desktopPid=${desktopProcessId} desktopStopped=${desktopStopped} servicePid=${serviceProcessId ?? "none"} serviceStopped=${serviceStopped}`,
  );
  if (!closeSettled || !desktopStopped || !serviceStopped) {
    throw new Error(
      `Electron smoke cleanup incomplete: closeSettled=${closeSettled}, desktopStopped=${desktopStopped}, serviceStopped=${serviceStopped}.`,
    );
  }
}

test("Electron suite owns Desktop, isolated Service settings, and single-instance lifecycle", async ({}, testInfo) => {
  const runtime = await startSuite();
  try {
    const workspace = await runtime.application.firstWindow();
    await expect(workspace).toHaveTitle(/ShipFlow Desktop/);
    await expect(workspace.getByRole("tab", { name: "Workspace" })).toBeVisible();
    await expect
      .poll(() => workspace.evaluate(() => Boolean(window.shipflow)))
      .toBe(true);

    await expect
      .poll(() => readServiceStatus(runtime).catch(() => null))
      .toMatchObject({ status: "running", port: runtime.servicePort });

    await workspace.getByRole("tab", { name: "Pivot/Grafik" }).click();
    await expect(
      workspace.getByLabel("Panel Aksi Pivot Grafik"),
    ).toBeVisible();
    await expect(
      workspace.getByLabel("Panel Utama Pivot Grafik"),
    ).toBeVisible();
    await expect(workspace.getByLabel("Mode Pivot Grafik")).toHaveValue(
      "pivot",
    );
    await dragFieldToZone(workspace, "Jenis Layanan", "Row");
    await dragFieldToZone(workspace, "Status Akhir", "Column");
    await dragFieldToZone(workspace, "Nomor Kiriman", "Value");
    await expect(
      workspace.getByLabel("Mode Value Nomor Kiriman"),
    ).toBeVisible();
    await expect(
      workspace.getByRole("region", { name: "Tabel Pivot" }),
    ).toBeVisible();
    await workspace.getByLabel("Mode Pivot Grafik").selectOption("bar");
    await expect(
      workspace.getByRole("region", { name: "Grafik Pivot" }),
    ).toBeVisible();
    await workspace.getByLabel("Mode Pivot Grafik").selectOption("donut");
    await expect(
      workspace.getByRole("region", { name: "Grafik Pivot" }),
    ).toBeVisible();
    await workspace.getByRole("tab", { name: "Workspace" }).click();

    const windowCountBeforeSettings = runtime.application.windows().length;
    await workspace.getByRole("button", { name: "Setting" }).click();
    await expect(workspace.getByRole("heading", { name: "Ukuran Tampilan" })).toBeVisible();
    await expect(workspace.getByRole("tab", { name: "Sumber Lacak" })).toHaveCount(0);
    await expect(workspace.locator(".app-runtime-fallback")).toHaveCount(0);
    await expect(workspace.locator("body")).not.toContainText(runtime.internalToken);
    expect(runtime.application.windows().length).toBe(windowCountBeforeSettings);
    await workspace.getByRole("button", { name: "Tutup" }).click();

    const serviceSettings = await openServiceSettingsWindow(runtime);
    let serviceSettingsCrashCount = 0;
    serviceSettings.on("crash", () => {
      serviceSettingsCrashCount += 1;
    });
    await serviceSettings.waitForLoadState("domcontentloaded");
    await expect(
      serviceSettings.getByRole("heading", { name: "ShipFlow Service" }),
    ).toHaveCount(0);
    await expect(
      serviceSettings.getByRole("heading", { name: "Umum" }),
    ).toBeVisible();
    await serviceSettings.getByRole("tab", { name: "Sumber Lacak" }).click();
    await expect(
      serviceSettings.getByRole("heading", { name: "Sumber Lacak" }),
    ).toBeVisible();
    await serviceSettings.getByRole("tab", { name: "API Publik" }).click();
    await expect(
      serviceSettings.getByRole("heading", { name: "API Publik" }),
    ).toBeVisible();
    await serviceSettings.getByRole("tab", { name: "Docker", exact: true }).click();
    await expect(serviceSettings.getByRole("heading", { name: "Docker API" })).toBeVisible();
    if (process.platform !== "win32") {
      await expect(serviceSettings.getByRole("button", { name: "Deploy / Redeploy" })).toHaveCount(0);
      await expect(serviceSettings.getByText("Tersedia di Windows", { exact: true })).toBeVisible();
      await expect(serviceSettings.getByLabel("Port host", { exact: true })).toHaveCount(0);
      await expect(serviceSettings.getByText("Belum sinkron", { exact: true })).toHaveCount(0);
      await expect(serviceSettings.getByText("Belum terverifikasi", { exact: true })).toHaveCount(0);
    }
    if (process.env.SHIPFLOW_EXPECT_DOCKER === "1") {
      await expect(serviceSettings.getByText("Terhubung", { exact: true })).toBeVisible();
      await serviceSettings.screenshot({ path: testInfo.outputPath("docker-detection.png") });
    }
    await serviceSettings.getByRole("tab", { name: "API Publik" }).click();
    await serviceSettings.waitForTimeout(5_000);
    expect(serviceSettingsCrashCount).toBe(0);
    await expect(
      serviceSettings.getByRole("heading", { name: "API Publik" }),
    ).toBeVisible();
    await expect(serviceSettings.locator(".app-runtime-fallback")).toHaveCount(0);
    await expect(serviceSettings.locator("body")).not.toContainText(
      runtime.internalToken,
    );
    expect(runtime.application.windows().length).toBe(
      windowCountBeforeSettings + 1,
    );
    // Only replace the OS integration in this isolated Electron test process.
    // Saving fixture settings must never change the user's login items.
    await runtime.application.evaluate(({ app }) => {
      app.setLoginItemSettings = () => undefined;
    });
    await workspace.evaluate(async () => {
      const scope = await window.shipflow!.requestWorkspace<{ documentGeneration: number }>("workspace.document_generation", {});
      return window.shipflow!.requestWorkspace("workspace.command", { ...scope, command: "list_sheets" });
    });
    const hostLogBeforePreferences = await readFile(runtime.logFilePath, "utf8");
    const hostStopsBefore = hostLogBeforePreferences.match(/workspace_host_stop_requested/g)?.length ?? 0;
    const hostStartsBefore = hostLogBeforePreferences.match(/workspace_host_started/g)?.length ?? 0;
    expect(hostStartsBefore).toBeGreaterThan(0);
    for (const keepRunningInTray of [true, false]) {
      await serviceSettings.evaluate(async (tray) => {
        const config = await window.shipflow!.invoke<import("../../src/types").ServiceConfig>("load_saved_api_service_config");
        await window.shipflow!.invoke("configure_api_service", { config: { ...config, keepRunningInTray: tray } });
      }, keepRunningInTray);
      await workspace.evaluate(async () => {
      const scope = await window.shipflow!.requestWorkspace<{ documentGeneration: number }>("workspace.document_generation", {});
      return window.shipflow!.requestWorkspace("workspace.command", { ...scope, command: "list_sheets" });
    });
    }
    await expect.poll(async () => (await readFile(runtime.logFilePath, "utf8")).match(/service_config_saved/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    const hostLogAfterPreferences = await readFile(runtime.logFilePath, "utf8");
    expect(hostLogAfterPreferences.match(/workspace_host_stop_requested/g)?.length ?? 0).toBe(hostStopsBefore);
    expect(hostLogAfterPreferences.match(/workspace_host_started/g)?.length ?? 0).toBe(hostStartsBefore);
    const settingsScreenshotPath = testInfo.outputPath(
      "isolated-service-settings.png",
    );
    await serviceSettings.screenshot({ path: settingsScreenshotPath });
    await testInfo.attach("isolated-service-settings", {
      path: settingsScreenshotPath,
      contentType: "image/png",
    });
    await serviceSettings.getByRole("button", { name: "Tutup" }).click();
    await expect
      .poll(() => runtime.application.windows().length)
      .toBe(windowCountBeforeSettings);

    const windowCountBeforeSecondLaunch = runtime.application.windows().length;
    const secondInstance = spawn(
      runtime.executablePath,
      [...runtime.executableArguments, "--background"],
      {
        env: runtime.environment,
        stdio: "ignore",
      },
    );
    await waitForExit(secondInstance, 10_000);
    await expect
      .poll(() => runtime.application.windows().length)
      .toBe(windowCountBeforeSecondLaunch);

    const publicAuthResponse = await fetch(
      `http://127.0.0.1:${runtime.servicePort}/v1/auth/check`,
      { headers: { Authorization: `Bearer ${runtime.publicToken}` } },
    );
    expect(publicAuthResponse.ok).toBe(true);

    // Exercise the private staging transport with a document above the 16 MiB
    // NDJSON frame limit. Query one row to keep the response independently small.
    const largeRestore = await workspace.evaluate(async () => {
      const scope = await window.shipflow!.requestWorkspace<{ documentGeneration: number }>("workspace.document_generation", {});
      const padding = "x".repeat(16 * 1024);
      const restored = await window.shipflow!.requestWorkspace<{ documentGeneration: number }>("workspace.command", {
        ...scope,
        command: "restore_workspace",
        payload: {
          sheets: [{
            sheetId: "large-document",
            name: "Large document",
            position: 0,
            rows: Array.from({ length: 1200 }, (_, position) => ({
              rowId: `large-${position}`,
              position,
              displayTrackingId: `P${position}`,
              shipment: {
                url: "https://example.test/track",
                detail: { shipment_header: { nomor_kiriman: `P${position}` } },
                status_akhir: { status: "DELIVERED" },
                history: [{ description: padding }],
              },
            })),
          }],
        },
      });
      const result = await window.shipflow!.requestWorkspace<{
        payload: { totalCount: number; rows: { statusJson: { status: string }; historyJson: { history: { description: string }[] } }[] };
      }>("workspace.command", {
        documentGeneration: restored.documentGeneration,
        command: "query_sheet_rows",
        payload: { query: { sheetId: "large-document", offset: 1199, limit: 1, filters: [], valueFilters: [], sort: [] } },
      });
      return {
        totalCount: result.payload.totalCount,
        status: result.payload.rows[0].statusJson.status,
        historyBytes: result.payload.rows[0].historyJson.history[0].description.length,
      };
    });
    expect(largeRestore).toEqual({ totalCount: 1200, status: "DELIVERED", historyBytes: 16 * 1024 });
    const stagingFiles = await readdir(path.join(runtime.rootDirectory, "desktop", "workspace-engine"));
    expect(stagingFiles.filter((name) => name.startsWith("workspace-restore-"))).toEqual([]);
    const privateRestoreError = await workspace.evaluate(async () => {
      try {
        await window.shipflow!.requestWorkspace("workspace.restore_file" as "workspace.command", { fileName: "workspace-restore-00000000-0000-0000-0000-000000000001.json" });
        return null;
      } catch (error) {
        return String(error);
      }
    });
    expect(privateRestoreError).toContain("Unsupported Workspace Engine method");

    const originalServicePid = await readManagedServicePid(
      runtime.serviceStateDirectory,
    );
    expect(originalServicePid).toBeGreaterThan(0);
    process.kill(originalServicePid!, "SIGKILL");

    await expect
      .poll(
        async () => {
          const replacementPid = await readManagedServicePid(
            runtime.serviceStateDirectory,
          ).catch(() => null);
          const status = await readServiceStatus(runtime).catch(() => null);
          return {
            replaced:
              replacementPid !== null && replacementPid !== originalServicePid,
            status: status?.status ?? null,
            port: status?.port ?? null,
          };
        },
        { timeout: 20_000 },
      )
      .toEqual({
        replaced: true,
        status: "running",
        port: runtime.servicePort,
      });
  } finally {
    let cleanupError: unknown;
    try {
      await closeApplication(runtime);
    } catch (error) {
      cleanupError = error;
    }
    const runtimeLog = await readFile(runtime.logFilePath).catch(() => null);
    if (runtimeLog) {
      await testInfo.attach("shipflow-desktop-runtime-log", {
        body: runtimeLog,
        contentType: "text/plain",
      });
    }
    const serviceLog = await readFile(runtime.serviceLogFilePath).catch(() => null);
    if (serviceLog) {
      await testInfo.attach("shipflow-service-runtime-log", {
        body: serviceLog,
        contentType: "text/plain",
      });
    }
    try {
      await rm(runtime.rootDirectory, {
        recursive: true,
        force: true,
        maxRetries: process.platform === "win32" ? 20 : 3,
        retryDelay: 250,
      });
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError) {
      throw cleanupError;
    }
  }
});

test("Docker configuration exposes advanced fields only when expanded", async ({}, testInfo) => {
  const runtime = await startSuite();
  try {
    const workspace = await runtime.application.firstWindow();
    await expect(workspace.getByRole("tab", { name: "Workspace" })).toBeVisible();
    const { DEFAULT_DOCKER_CONFIG } = await import("../../src/backend/docker-contract");
    // Exercise the supported-platform form without enabling Docker mutations.
    await runtime.application.evaluate(({ ipcMain }, config) => {
      const channel = "shipflow:invoke";
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers;
      const handler = handlers.get(channel);
      if (!handler) throw new Error("Missing command IPC handler.");
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (event, command, args) => {
        if (command === "docker_service_status") return {
          supported: true, dockerReady: true, bundleReady: true, phase: "stopped", busy: false, error: null,
          installedRelease: "ui-fixture", runningRelease: null, synchronized: false, apiReady: false,
          storageHealthy: false, configPending: true, config, externalTokenConfigured: false,
          endpoint: null, metrics: null, activeRequests: null, queuedRequests: null,
        };
        if (command.startsWith("docker_service_")) throw new Error("Docker mutations are forbidden in this UI fixture.");
        return handler(event, command, args);
      });
    }, DEFAULT_DOCKER_CONFIG);
    const settings = await openServiceSettingsWindow(runtime);
    await settings.getByRole("tab", { name: "Docker", exact: true }).click();
    await expect(settings.getByLabel("Port host", { exact: true })).toBeVisible();
    await expect(settings.getByLabel("Akses API")).toBeVisible();
    await expect(settings.getByLabel("Memori container (MiB)")).toBeHidden();
    await expect(settings.getByLabel("Sumber lacak Docker")).toBeHidden();
    await settings.screenshot({ path: testInfo.outputPath("docker-basic-settings.png") });
    await settings.getByText("Pengaturan lanjutan", { exact: true }).click();
    await expect(settings.getByLabel("Memori container (MiB)")).toBeVisible();
    await settings.getByLabel("Sumber lacak Docker").selectOption("externalApi");
    await expect(settings.getByLabel("URL API eksternal Docker")).toBeVisible();
    await expect(settings.getByLabel("Lookup paralel total")).toBeHidden();
    await settings.getByText("Performa dan cache", { exact: true }).click();
    await expect(settings.getByLabel("Lookup paralel total")).toBeVisible();
    await settings.getByText("Pengaturan lanjutan", { exact: true }).click();
    await expect(settings.getByLabel("URL API eksternal Docker")).toBeHidden();
  } finally {
    await closeApplication(runtime);
    await rm(runtime.rootDirectory, { recursive: true, force: true });
  }
});

test("Service settings keeps the unsaved-workspace quit dialog accessible", async ({}, testInfo) => {
  const runtime = await startSuite();
  const desktopPid = runtime.application.process().pid;
  try {
    const workspace = await runtime.application.firstWindow();
    await expect(workspace.getByRole("tab", { name: "Workspace" })).toBeVisible();
    await expect.poll(() => readServiceStatus(runtime).catch(() => null))
      .toMatchObject({ status: "running" });
    const nativeWorkspace = await runtime.application.browserWindow(workspace);
    const expectDirtyWorkspace = () => expect.poll(() =>
      nativeWorkspace.evaluate((window) => window.getTitle())).toMatch(/^\*/);
    await workspace.getByRole("tab", { name: "Pivot/Grafik" }).click();
    await expectDirtyWorkspace();
    const servicePid = await readManagedServicePid(runtime.serviceStateDirectory);
    expect(servicePid).not.toBeNull();

    const settings = await openServiceSettingsWindow(runtime);
    await settings.getByRole("tab", { name: "API Publik" }).click();
    await settings.getByLabel("Port", { exact: true }).fill("19422");

    const requestQuit = () => runtime.application.evaluate(({ Menu }) => {
      const quit = Menu.getApplicationMenu()?.items
        .flatMap((item) => item.submenu?.items ?? [])
        .find((item) => item.label === "Keluar ShipFlow");
      if (!quit) throw new Error("Quit menu item is unavailable.");
      quit.click();
    });
    await requestQuit();
    const confirmation = workspace.getByRole("dialog", { name: "Tutup Dokumen" });
    await expect(confirmation).toBeVisible();
    // DOM visibility alone misses native sheets that prevent any user input.
    expect(await nativeWorkspace.evaluate((window) => window.getChildWindows()
      .filter((child) => child.isModal() && child.isVisible()).length)).toBe(0);
    await expect.poll(() => nativeWorkspace.evaluate((window) => window.isFocused())).toBe(true);
    await workspace.screenshot({ path: testInfo.outputPath("accessible-quit-confirmation.png") });

    await confirmation.getByRole("button", { name: "Batal", exact: true }).click();
    await expect(confirmation).toBeHidden();
    await expectDirtyWorkspace();
    await expect(settings.getByLabel("Port", { exact: true })).toHaveValue("19422");

    // Closing the settings window must leave the dirty workspace intact.
    const nativeSettings = await runtime.application.browserWindow(settings);
    await nativeSettings.evaluate((window) => window.close());
    await expect.poll(() => settings.isClosed()).toBe(true);
    await expectDirtyWorkspace();
    await openServiceSettingsWindow(runtime);

    const savedPath = path.join(runtime.rootDirectory, "Saved-before-quit.shipflow");
    await runtime.application.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, savedPath);
    await requestQuit();
    await expect(confirmation).toBeVisible();
    const exited = runtime.application.waitForEvent("close");
    await confirmation.getByRole("button", { name: "Simpan & Tutup", exact: true }).click();
    await exited;
    const saved = JSON.parse(await readFile(savedPath, "utf8"));
    expect(saved.workspace.sheetsById["default-sheet"].activeMode).toBe("analytics");
    expect(await waitForProcessIdExit(servicePid!, 5_000)).toBe(true);
    const log = await readFile(runtime.logFilePath, "utf8");
    expect(log).toContain("event=native_shutdown_completed");
    expect(log).toContain("event=app_exit");
  } finally {
    if (processIdIsAlive(desktopPid)) {
      await closeApplication(runtime);
    }
    await rm(runtime.rootDirectory, { recursive: true, force: true });
  }
});

test("document replacement fences an armed delete and preserves autosaved native rows", async () => {
  const runtime = await startSuite();
  try {
    const page = await runtime.application.firstWindow();
    page.on("dialog", (dialog) => dialog.accept());
    await expect(page.getByRole("tab", { name: "Workspace" })).toBeVisible();
    const { createDefaultWorkspaceState } = await import("../../src/features/workspace/default-state");
    const { createEmptyRow } = await import("../../src/features/sheet/utils");
    const paths = [path.join(runtime.rootDirectory, "A.shipflow"), path.join(runtime.rootDirectory, "B.shipflow")];
    for (const [index, documentPath] of paths.entries()) {
      const workspace = createDefaultWorkspaceState();
      workspace.sheetsById["default-sheet"].rows = [
        { ...createEmptyRow(), key: "reused-row", trackingInput: index ? "DOCUMENT-B" : "DOCUMENT-A" },
        createEmptyRow(),
      ];
      await writeFile(documentPath, JSON.stringify({ version: 1, app: "shipflow-desktop", savedAt: new Date().toISOString(), workspace }));
    }
    const openFixture = async (documentPath: string) => {
      await runtime.application.evaluate(({ dialog }, fixture) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] });
      }, documentPath);
      await page.getByRole("button", { name: "File", exact: true }).click();
      await page.getByRole("menuitem", { name: "Buka", exact: true }).click();
    };
    await openFixture(paths[0]);
    await expect.poll(() => runtime.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())).toContain("A.shipflow");
    const oldScope = await page.evaluate(() => window.shipflow!.requestWorkspace<{ documentGeneration: number }>("workspace.document_generation", {}));
    await page.getByRole("button", { name: "File", exact: true }).click();
    await page.getByRole("checkbox", { name: "Simpan Otomatis" }).check();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Hapus Semua", exact: true }).click();
    await expect(page.getByRole("button", { name: "Konfirmasi Hapus Semua", exact: true })).toBeVisible();

    // Interpose only the isolated test process's existing IPC handler. The
    // renderer still invokes the real preload, host, database and document flow.
    await runtime.application.evaluate(({ ipcMain }) => {
      const channel = "shipflow:workspace-request";
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers;
      const handler = handlers.get(channel);
      if (!handler) throw new Error("Missing workspace IPC handler");
      const state = globalThis as unknown as { restoreEntered: boolean; releaseRestore: () => void };
      state.restoreEntered = false;
      const barrier = new Promise<void>((resolve) => { state.releaseRestore = resolve; });
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, request) => {
        if (request.params?.command === "restore_workspace") {
          state.restoreEntered = true;
          await barrier;
        }
        return handler(event, request);
      });
    });
    await openFixture(paths[1]);
    await expect.poll(() => runtime.application.evaluate(() => (globalThis as unknown as { restoreEntered: boolean }).restoreEntered)).toBe(true);
    await page.getByRole("button", { name: "Konfirmasi Hapus Semua", exact: true }).click();
    await runtime.application.evaluate(() => (globalThis as unknown as { releaseRestore: () => void }).releaseRestore());
    await expect.poll(() => runtime.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())).toContain("B.shipflow");
    const verification = await page.evaluate(async (staleScope) => {
      const staleErrors: string[] = [];
      for (const command of ["clear_sheet_rows", "delete_sheet_rows", "query_sheet_rows"]) {
        try {
          await window.shipflow!.requestWorkspace("workspace.command", {
            ...staleScope, command,
            payload: command === "query_sheet_rows"
              ? { query: { sheetId: "default-sheet", offset: 0, limit: 1000, filters: [], sort: [] } }
              : { sheetId: "default-sheet", rowIds: ["reused-row"] },
          });
        } catch (error) { staleErrors.push(String(error)); }
      }
      const scope = await window.shipflow!.requestWorkspace<{ documentGeneration: number }>("workspace.document_generation", {});
      const result = await window.shipflow!.requestWorkspace<{ payload: { totalCount: number; rows: { displayTrackingId: string }[] } }>("workspace.command", {
        ...scope, command: "query_sheet_rows", payload: { query: { sheetId: "default-sheet", offset: 0, limit: 1000, filters: [], sort: [] } },
      });
      return { staleErrors, total: result.payload.totalCount, ids: result.payload.rows.map((row) => row.displayTrackingId) };
    }, oldScope);
    expect(verification.staleErrors).toHaveLength(3);
    expect(verification.staleErrors.every((error) => error.includes("Document changed"))).toBe(true);
    expect(verification.ids).toEqual(["DOCUMENT-B"]);
    expect(verification.total).toBe(1);
    // Change persisted sheet metadata to force an autosave, then reopen the file.
    await page.getByRole("tab", { name: "Pivot/Grafik" }).click();
    await expect.poll(async () => {
      const saved = JSON.parse(await readFile(paths[1], "utf8"));
      return saved.workspace.sheetsById["default-sheet"].activeMode;
    }).toBe("analytics");
    const saved = JSON.parse(await readFile(paths[1], "utf8"));
    expect(saved.workspace.sheetsById["default-sheet"].rows.filter((row: { trackingInput: string }) => row.trackingInput).map((row: { trackingInput: string }) => row.trackingInput)).toEqual(["DOCUMENT-B"]);
    await openFixture(paths[0]);
    await expect.poll(() => runtime.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())).toContain("A.shipflow");
    await openFixture(paths[1]);
    await expect.poll(() => runtime.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())).toContain("B.shipflow");
    await page.getByRole("tab", { name: "Workspace" }).click();
    await expect(page.locator('input[value="DOCUMENT-B"]')).toBeVisible();
  } finally {
    await closeApplication(runtime);
    await rm(runtime.rootDirectory, { recursive: true, force: true });
  }
});
