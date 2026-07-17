import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

const require = createRequire(import.meta.url);
const developmentElectronPath = require("electron") as string;

type SmokeRuntime = {
  application: ElectronApplication;
  environment: NodeJS.ProcessEnv;
  executablePath: string;
  executableArguments: string[];
  rootDirectory: string;
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

async function startSuite(): Promise<SmokeRuntime> {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "shipflow-electron-smoke-"));
  const userDataDirectory = path.join(rootDirectory, "desktop");
  const serviceStateDirectory = path.join(rootDirectory, "service");
  const servicePort = await reservePort();
  const publicToken = "sf_electron_smoke_public";
  const internalToken = "sf_electron_smoke_internal";
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

  const packagedExecutable = process.env.SHIPFLOW_ELECTRON_EXECUTABLE?.trim();
  const executablePath = packagedExecutable || developmentElectronPath;
  const executableArguments = packagedExecutable
    ? ["--password-store=basic"]
    : [path.resolve("out/main/index.js"), "--password-store=basic"];
  const environment = {
    ...process.env,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    SHIPFLOW_USER_DATA_DIR: userDataDirectory,
    SHIPFLOW_SERVICE_AGENT_STATE_DIR: serviceStateDirectory,
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
    rootDirectory,
    servicePort,
    publicToken,
    internalToken,
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

async function closeApplication(application: ElectronApplication) {
  const process = application.process();
  const exited = new Promise<void>((resolve) => process.once("exit", () => resolve()));
  await application.evaluate(({ app }) => app.quit()).catch(() => undefined);
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
  if (process.exitCode === null && !process.killed) {
    process.kill("SIGKILL");
  }
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  await application.close().catch(() => undefined);
}

test("Electron suite owns Desktop, integrated Service settings, and single-instance lifecycle", async ({}, testInfo) => {
  const runtime = await startSuite();
  try {
    const workspace = await runtime.application.firstWindow();
    await expect(workspace).toHaveTitle(/ShipFlow Desktop/);
    await expect(workspace.getByRole("tab", { name: "Workspace" })).toBeVisible();
    await expect
      .poll(() => workspace.evaluate(() => Boolean(window.shipflow)))
      .toBe(true);

    await expect
      .poll(() =>
        workspace.evaluate(async () => {
          return window.shipflow?.invoke<{
            status: string;
            port: number | null;
          }>("get_api_service_status");
        }),
      )
      .toMatchObject({ status: "running", port: runtime.servicePort });

    const windowCountBeforeSettings = runtime.application.windows().length;
    await workspace.getByRole("button", { name: "Setting" }).click();
    await workspace.getByRole("tab", { name: "Sumber Lacak" }).click();
    await expect(workspace.getByRole("heading", { name: "Sumber Lacak" })).toBeVisible();
    await expect(workspace.getByRole("tab", { name: "API Publik" })).toBeVisible();
    await expect(workspace.locator("body")).not.toContainText(runtime.internalToken);
    expect(runtime.application.windows().length).toBe(windowCountBeforeSettings);
    await expect
      .poll(() =>
        workspace.getByRole("tab", { name: "Workspace" }).evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const topElement = document.elementFromPoint(
            bounds.left + bounds.width / 2,
            bounds.top + bounds.height / 2,
          );
          return Boolean(topElement?.closest(".settings-modal-backdrop"));
        }),
      )
      .toBe(true);
    const settingsScreenshotPath = testInfo.outputPath(
      "integrated-service-settings.png",
    );
    await workspace.screenshot({ path: settingsScreenshotPath });
    await testInfo.attach("integrated-service-settings", {
      path: settingsScreenshotPath,
      contentType: "image/png",
    });

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
  } finally {
    await closeApplication(runtime.application);
    await rm(runtime.rootDirectory, { recursive: true, force: true });
  }
});
