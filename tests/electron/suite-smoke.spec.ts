import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
    await workspace.getByRole("button", { name: "Batal" }).click();

    const serviceSettings = await openServiceSettingsWindow(runtime);
    await serviceSettings.waitForLoadState("domcontentloaded");
    await expect(
      serviceSettings.getByRole("heading", { name: "ShipFlow Service" }),
    ).toBeVisible();
    await expect(
      serviceSettings.getByRole("heading", { name: "Sumber Lacak" }),
    ).toBeVisible();
    await serviceSettings.getByRole("tab", { name: "API Publik" }).click();
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
    const settingsScreenshotPath = testInfo.outputPath(
      "isolated-service-settings.png",
    );
    await serviceSettings.screenshot({ path: settingsScreenshotPath });
    await testInfo.attach("isolated-service-settings", {
      path: settingsScreenshotPath,
      contentType: "image/png",
    });
    await serviceSettings.getByRole("button", { name: "Batal" }).click();
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
