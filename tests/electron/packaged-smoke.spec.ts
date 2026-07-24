import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  expect,
  test,
} from "@playwright/test";
import {
  terminateChildProcess,
  waitForChildProcessExit,
} from "../../electron/main/child-process-lifecycle";

type PackagedRuntime = {
  desktopProcess: ChildProcess;
  environment: NodeJS.ProcessEnv;
  executablePath: string;
  logFilePath: string;
  serviceLogFilePath: string;
  processOutput: {
    stderr: string;
    stdout: string;
  };
  rootDirectory: string;
  serviceStateDirectory: string;
  servicePort: number;
  publicToken: string;
};

const PROCESS_OUTPUT_LIMIT_BYTES = 256 * 1024;
const PACKAGED_EXECUTABLE_PATH =
  process.env.SHIPFLOW_ELECTRON_EXECUTABLE?.trim();

test.skip(
  !PACKAGED_EXECUTABLE_PATH,
  "Packaged smoke requires SHIPFLOW_ELECTRON_EXECUTABLE.",
);

function appendProcessOutput(
  output: PackagedRuntime["processOutput"],
  stream: keyof PackagedRuntime["processOutput"],
  chunk: Buffer | string,
) {
  const nextValue = `${output[stream]}${chunk.toString()}`;
  output[stream] = nextValue.slice(-PROCESS_OUTPUT_LIMIT_BYTES);
}

function captureProcessOutput(
  desktopProcess: ChildProcess,
  processOutput: PackagedRuntime["processOutput"],
) {
  desktopProcess.stdout?.on("data", (chunk: Buffer) => {
    appendProcessOutput(processOutput, "stdout", chunk);
  });
  desktopProcess.stderr?.on("data", (chunk: Buffer) => {
    appendProcessOutput(processOutput, "stderr", chunk);
  });
}

async function reservePort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Unable to reserve a packaged smoke-test port.");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function readManagedServicePid(serviceStateDirectory: string) {
  const config = JSON.parse(
    await readFile(path.join(serviceStateDirectory, "agent-config.json"), "utf8"),
  ) as { processId?: unknown };
  return typeof config.processId === "number" ? config.processId : null;
}

function processIdIsAlive(processId: number) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function startPackagedSuite(): Promise<PackagedRuntime> {
  const executablePath = PACKAGED_EXECUTABLE_PATH!;
  const rootDirectory = await mkdtemp(
    path.join(os.tmpdir(), "shipflow-electron-package-smoke-"),
  );
  const userDataDirectory = path.join(rootDirectory, "desktop");
  const serviceStateDirectory = path.join(rootDirectory, "service");
  const logFilePath = path.join(rootDirectory, "shipflow-desktop.log");
  const serviceLogFilePath = path.join(rootDirectory, "shipflow-service.log");
  const servicePort = await reservePort();
  const publicToken = "sf_electron_package_smoke_public";
  const internalToken = "sf_electron_package_smoke_internal";
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
  const environment = {
    ...process.env,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    SHIPFLOW_USER_DATA_DIR: userDataDirectory,
    SHIPFLOW_SERVICE_AGENT_STATE_DIR: serviceStateDirectory,
    SHIPFLOW_LOG_FILE: logFilePath,
    SHIPFLOW_SERVICE_LOG_FILE: serviceLogFilePath,
    SHIPFLOW_NATIVE_LOG_MAX_BYTES: "1024",
    SHIPFLOW_ELECTRON_PACKAGE_SMOKE: "1",
    SHIPFLOW_LOOKUP_STORE_PATH: path.join(
      serviceStateDirectory,
      "lookup-store.sqlite3",
    ),
    SHIPFLOW_CONTACT_STORE_PATH: path.join(
      serviceStateDirectory,
      "contact-store.sqlite3",
    ),
  };
  const desktopProcess = spawn(
    executablePath,
    ["--password-store=basic"],
    {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const processOutput = {
    stderr: "",
    stdout: "",
  };
  captureProcessOutput(desktopProcess, processOutput);
  return {
    desktopProcess,
    environment,
    executablePath,
    logFilePath,
    serviceLogFilePath,
    processOutput,
    rootDirectory,
    serviceStateDirectory,
    servicePort,
    publicToken,
  };
}

async function closePackagedSuite(runtime: PackagedRuntime) {
  await terminateChildProcess(runtime.desktopProcess);
  const servicePid = await readManagedServicePid(runtime.serviceStateDirectory).catch(
    () => null,
  );
  if (servicePid) {
    try {
      process.kill(servicePid, "SIGKILL");
    } catch {
      // The Service may already have stopped with the Desktop process.
    }
  }
  await rm(runtime.rootDirectory, { recursive: true, force: true });
}

test("packaged Electron suite loads its renderer and owns the native Service lifecycle", async ({}, testInfo) => {
  const runtime = await startPackagedSuite();
  try {
    await expect
      .poll(async () => {
        const log = await readFile(runtime.logFilePath, "utf8").catch(() => "");
        const runtimeOutput = [
          log,
          runtime.processOutput.stdout,
          runtime.processOutput.stderr,
        ].join("\n");
        return {
          rendererMounted: runtimeOutput.includes("[Frontend] App mounted."),
          workspaceHostStarted: runtimeOutput.includes(
            "[WorkspaceHost] Started workspace host window=main",
          ),
        };
      })
      .toEqual({
        rendererMounted: true,
        workspaceHostStarted: true,
      });
    await expect
      .poll(async () => {
        const response = await fetch(
          `http://127.0.0.1:${runtime.servicePort}/v1/auth/check`,
          { headers: { Authorization: `Bearer ${runtime.publicToken}` } },
        ).catch(() => null);
        return response?.ok ?? false;
      })
      .toBe(true);

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
          const response = await fetch(
            `http://127.0.0.1:${runtime.servicePort}/v1/auth/check`,
            { headers: { Authorization: `Bearer ${runtime.publicToken}` } },
          ).catch(() => null);
          return {
            replaced:
              replacementPid !== null && replacementPid !== originalServicePid,
            reachable: response?.ok ?? false,
          };
        },
        { timeout: 20_000 },
      )
      .toEqual({
        replaced: true,
        reachable: true,
      });

    const secondInstance = spawn(
      runtime.executablePath,
      ["--background", "--password-store=basic"],
      { env: runtime.environment, stdio: "ignore" },
    );
    expect(await waitForChildProcessExit(secondInstance, 10_000)).toBe(true);

    const servicePidBeforeDesktopCrash = await readManagedServicePid(
      runtime.serviceStateDirectory,
    );
    expect(servicePidBeforeDesktopCrash).toBeGreaterThan(0);
    runtime.desktopProcess.kill("SIGKILL");
    expect(await waitForChildProcessExit(runtime.desktopProcess, 10_000)).toBe(
      true,
    );

    runtime.desktopProcess = spawn(
      runtime.executablePath,
      ["--password-store=basic"],
      {
        env: runtime.environment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    captureProcessOutput(runtime.desktopProcess, runtime.processOutput);
    await expect
      .poll(
        async () => {
          const replacementPid = await readManagedServicePid(
            runtime.serviceStateDirectory,
          ).catch(() => null);
          const response = await fetch(
            `http://127.0.0.1:${runtime.servicePort}/v1/auth/check`,
            { headers: { Authorization: `Bearer ${runtime.publicToken}` } },
          ).catch(() => null);
          const log = await readFile(runtime.logFilePath, "utf8").catch(() => "");
          const orphanRecovered =
            log.includes("event=orphan_service_detected") &&
            log.includes("event=orphan_service_stopped");
          const replaced =
            replacementPid !== null &&
            replacementPid !== servicePidBeforeDesktopCrash;
          const reachable = response?.ok ?? false;
          if (!replaced) {
            return "waiting-for-replacement";
          }
          if (!reachable) {
            return "waiting-for-service";
          }
          if (orphanRecovered) {
            return "orphan-recovered";
          }
          if (!processIdIsAlive(servicePidBeforeDesktopCrash!)) {
            return "service-exited-with-desktop";
          }
          return "orphan-still-running";
        },
        { timeout: 20_000 },
      )
      .toMatch(/^(orphan-recovered|service-exited-with-desktop)$/);
  } finally {
    const log = await readFile(runtime.logFilePath, "utf8").catch(() => "");
    const serviceLog = await readFile(runtime.serviceLogFilePath, "utf8").catch(
      () => "",
    );
    const serviceLogBackup = await readFile(
      `${runtime.serviceLogFilePath}.1`,
      "utf8",
    ).catch(() => "");
    const serviceLogBytes = await stat(runtime.serviceLogFilePath)
      .then((metadata) => metadata.size)
      .catch(() => 0);
    const audit = spawnSync(
      process.execPath,
      [
        path.resolve("scripts/audit-runtime-log.mjs"),
        "--fail-on=high",
        runtime.logFilePath,
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
      },
    );
    await testInfo.attach("packaged-runtime-log", {
      body: Buffer.from(
        [
          "=== FILE LOG ===",
          log || "No packaged runtime log was written.",
          "=== STDOUT ===",
          runtime.processOutput.stdout || "No stdout was captured.",
          "=== STDERR ===",
          runtime.processOutput.stderr || "No stderr was captured.",
          "=== SERVICE LOG ===",
          serviceLog || "No Service log was written.",
          "=== SERVICE LOG BACKUP ===",
          serviceLogBackup || "No rotated Service log was written.",
        ].join("\n"),
      ),
      contentType: "text/plain",
    });
    await testInfo.attach("packaged-runtime-audit", {
      body: Buffer.from(
        [audit.stdout || "No audit output.", audit.stderr || ""].join("\n"),
      ),
      contentType: "text/plain",
    });
    await closePackagedSuite(runtime);
    expect(serviceLogBackup, "Service log did not rotate during packaged smoke.").not.toBe(
      "",
    );
    expect(serviceLogBytes).toBeLessThanOrEqual(2 * 1024);
    expect(
      audit.status,
      `Runtime log audit failed.\n${audit.stdout}\n${audit.stderr}`,
    ).toBe(0);
  }
});
