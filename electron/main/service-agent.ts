import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app, safeStorage } from "electron";
import type { ApiServiceStatus, ServiceConfig } from "../../src/types";
import type { ManagedServiceConnection } from "./workspace-host";
import { appLogger } from "./app-logger";
import {
  childProcessHasExited,
  observeChildProcessTermination,
  terminateChildProcess,
  waitForChildProcessExit,
} from "./child-process-lifecycle";
import { probeExternalApiAuth } from "./external-api-policy";
import { buildServiceIpcEndpoint, requestServiceIpc } from "./service-ipc";
import { ServiceRestartPolicy } from "./service-restart-policy";
import { SingleFlight } from "./single-flight";

type PersistedAgentConfig = {
  version: 2;
  enabled: boolean;
  mode: "local" | "lan";
  port: number;
  publicApiToken: string;
  internalToken: string;
  trackingSource: "default" | "externalApi";
  externalApiBaseUrl: string;
  externalApiAuthToken: string;
  allowInsecureExternalApiHttp: boolean;
  keepRunningInTray: boolean;
  startAtLogin: boolean;
  lastUpdatedAt: string;
  processId: number | null;
};

type LegacyTokenVault = {
  tokens?: Record<string, string>;
};

const DEFAULT_PORT = 18422;
const STARTUP_TIMEOUT_MS = 10_000;
const ENCRYPTED_SECRET_PREFIX = "encrypted:v1:";
const PACKAGE_SMOKE_TEST_ENV = "SHIPFLOW_ELECTRON_PACKAGE_SMOKE";

function createToken() {
  return `sf_${randomBytes(24).toString("hex")}`;
}

function isInsideDirectory(candidate: string, parent: string) {
  const relativePath = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function isIsolatedPackageSmoke() {
  if (process.env[PACKAGE_SMOKE_TEST_ENV] !== "1") {
    return false;
  }
  const isolatedDirectories = [
    process.env.SHIPFLOW_USER_DATA_DIR?.trim(),
    process.env.SHIPFLOW_SERVICE_AGENT_STATE_DIR?.trim(),
  ];
  return isolatedDirectories.every((directory) =>
    directory ? isInsideDirectory(directory, os.tmpdir()) : false,
  );
}

function shouldProtectPersistedSecrets() {
  return !isIsolatedPackageSmoke();
}

function protectSecret(value: string) {
  if (
    !value ||
    !shouldProtectPersistedSecrets() ||
    !safeStorage.isEncryptionAvailable()
  ) {
    return value;
  }
  return `${ENCRYPTED_SECRET_PREFIX}${safeStorage.encryptString(value).toString("base64")}`;
}

function revealSecret(value: string | undefined) {
  if (!value?.startsWith(ENCRYPTED_SECRET_PREFIX)) {
    return value?.trim() ?? "";
  }
  if (!shouldProtectPersistedSecrets()) {
    throw new Error(
      "The packaged smoke-test configuration cannot read encrypted credentials.",
    );
  }
  try {
    return safeStorage.decryptString(
      Buffer.from(value.slice(ENCRYPTED_SECRET_PREFIX.length), "base64"),
    );
  } catch (error) {
    throw new Error(`Unable to decrypt ShipFlow Service credentials: ${String(error)}`);
  }
}

function executableName(baseName: string) {
  return process.platform === "win32" ? `${baseName}.exe` : baseName;
}

function serviceStateDirectory() {
  const override = process.env.SHIPFLOW_SERVICE_AGENT_STATE_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(
    app.getPath("appData"),
    "ShipFlow Service",
    "shipflow-service-runtime",
  );
}

function agentConfigPath() {
  return path.join(serviceStateDirectory(), "agent-config.json");
}

function serviceLogFilePath() {
  const override = process.env.SHIPFLOW_SERVICE_LOG_FILE?.trim();
  return override
    ? path.resolve(override)
    : path.join(path.dirname(appLogger.filePath), "shipflow-service.log");
}

function serviceIpcIdentity() {
  return createHash("sha256")
    .update(app.getPath("userData"))
    .digest("hex")
    .slice(0, 20);
}

function serviceIpcStableNonce() {
  return createHash("sha256")
    .update(`managed-service:${serviceIpcIdentity()}`)
    .digest("hex")
    .slice(0, 32);
}

function serviceIpcRuntimeDirectory() {
  const userIdentity = process.getuid?.() ?? process.env.USERNAME ?? "user";
  const runtimeRoot = process.platform === "win32" ? "" : "/tmp";
  return path.join(
    runtimeRoot,
    `shipflow-${userIdentity}-${serviceIpcIdentity().slice(0, 8)}`,
  );
}

function createServiceIpcEndpoint(nonce: string, runtimeDirectory: string) {
  const override = process.env.SHIPFLOW_INTERNAL_IPC_ENDPOINT?.trim();
  if (override) {
    return override;
  }
  return buildServiceIpcEndpoint(
    process.platform,
    serviceIpcIdentity(),
    nonce,
    runtimeDirectory,
  );
}

async function firstExistingPath(candidates: string[]) {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to the next development or packaged binary location.
    }
  }
  throw new Error(`ShipFlow Service executable was not found: ${candidates.join(", ")}`);
}

async function resolveServiceExecutable() {
  const name = executableName("shipflow-service");
  const override = process.env.SHIPFLOW_SERVICE_PATH?.trim();
  return firstExistingPath(
    [
      override ?? "",
      app.isPackaged ? path.join(process.resourcesPath, "native", name) : "",
      path.resolve(__dirname, "../..", "target", "debug", name),
      path.resolve(__dirname, "../..", "target", "release", name),
      path.join(app.getAppPath(), "target", "debug", name),
      path.join(app.getAppPath(), "target", "release", name),
    ].filter(Boolean),
  );
}

function isValidPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65_535;
}

function normalizeConfig(value: Partial<PersistedAgentConfig>): PersistedAgentConfig {
  return {
    version: 2,
    enabled: true,
    mode: value.mode === "lan" ? "lan" : "local",
    port: isValidPort(value.port) ? value.port : DEFAULT_PORT,
    publicApiToken: revealSecret(value.publicApiToken) || createToken(),
    internalToken: revealSecret(value.internalToken) || createToken(),
    trackingSource: value.trackingSource === "externalApi" ? "externalApi" : "default",
    externalApiBaseUrl: value.externalApiBaseUrl?.trim() ?? "",
    externalApiAuthToken: revealSecret(value.externalApiAuthToken),
    allowInsecureExternalApiHttp: value.allowInsecureExternalApiHttp ?? false,
    keepRunningInTray: value.keepRunningInTray ?? true,
    startAtLogin: value.startAtLogin ?? false,
    lastUpdatedAt: value.lastUpdatedAt?.trim() || new Date().toISOString(),
    processId: Number.isInteger(value.processId) ? Number(value.processId) : null,
  };
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readLegacyConfig(): Promise<Partial<PersistedAgentConfig>> {
  const directory = serviceStateDirectory();
  const [config, vault] = await Promise.all([
    readJsonFile<Record<string, unknown>>(path.join(directory, "config.json")),
    readJsonFile<LegacyTokenVault>(path.join(directory, "tokens.json")),
  ]);
  if (!config && !vault) {
    return {};
  }
  const tokens = vault?.tokens ?? {};
  return {
    enabled: typeof config?.enabled === "boolean" ? config.enabled : true,
    mode: config?.mode === "lan" ? "lan" : "local",
    port: isValidPort(config?.port) ? config.port : DEFAULT_PORT,
    publicApiToken:
      tokens["service.authToken"] ||
      tokens["runtime.authToken"] ||
      (typeof config?.authToken === "string" ? config.authToken : ""),
    trackingSource: config?.trackingSource === "externalApi" ? "externalApi" : "default",
    externalApiBaseUrl:
      typeof config?.externalApiBaseUrl === "string" ? config.externalApiBaseUrl : "",
    externalApiAuthToken:
      tokens["service.externalApiAuthToken"] ||
      tokens["runtime.externalApiAuthToken"] ||
      "",
    allowInsecureExternalApiHttp: config?.allowInsecureExternalApiHttp === true,
    keepRunningInTray: config?.keepRunningInTray !== false,
    startAtLogin: config?.startAtLogin === true,
    lastUpdatedAt:
      typeof config?.lastUpdatedAt === "string" ? config.lastUpdatedAt : undefined,
  };
}

let persistConfigTail: Promise<void> = Promise.resolve();

async function persistConfigImmediately(config: PersistedAgentConfig) {
  const targetPath = agentConfigPath();
  await mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  const persistedConfig = {
    ...config,
    publicApiToken: protectSecret(config.publicApiToken),
    internalToken: protectSecret(config.internalToken),
    externalApiAuthToken: protectSecret(config.externalApiAuthToken),
  };
  await writeFile(tempPath, `${JSON.stringify(persistedConfig, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  if (process.platform !== "win32") {
    await chmod(tempPath, 0o600);
  }
  const backupPath = `${targetPath}.backup`;
  await unlink(backupPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
  let movedExistingConfig = false;
  try {
    await rename(targetPath, backupPath);
    movedExistingConfig = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  try {
    await rename(tempPath, targetPath);
  } catch (error) {
    if (movedExistingConfig) {
      await rename(backupPath, targetPath).catch(() => undefined);
    }
    throw error;
  }
  if (movedExistingConfig) {
    await unlink(backupPath).catch(() => undefined);
  }
}

async function persistConfig(config: PersistedAgentConfig) {
  const snapshot = { ...config };
  const operation = persistConfigTail
    .catch(() => undefined)
    .then(() => persistConfigImmediately(snapshot));
  persistConfigTail = operation.catch(() => undefined);
  await operation;
}

function asServiceConfig(config: PersistedAgentConfig): ServiceConfig {
  return {
    version: 1,
    enabled: config.enabled,
    mode: config.mode,
    port: config.port,
    authToken: "",
    authTokenConfigured: Boolean(config.publicApiToken),
    trackingSource: config.trackingSource,
    externalApiBaseUrl: config.externalApiBaseUrl,
    externalApiAuthToken: "",
    externalApiAuthTokenConfigured: Boolean(config.externalApiAuthToken),
    allowInsecureExternalApiHttp: config.allowInsecureExternalApiHttp,
    keepRunningInTray: config.keepRunningInTray,
    startAtLogin: config.startAtLogin,
    lastUpdatedAt: config.lastUpdatedAt,
  };
}

function stoppedStatus(config: PersistedAgentConfig): ApiServiceStatus {
  return {
    status: "stopped",
    enabled: config.enabled,
    mode: config.mode,
    bindAddress: null,
    port: config.port,
    errorMessage: null,
  };
}

function connectionFor(
  config: PersistedAgentConfig,
  ipcEndpoint: string,
): ManagedServiceConnection {
  return {
    ipcEndpoint,
    internalToken: config.internalToken,
  };
}

async function requestManagedService<T>(
  config: PersistedAgentConfig,
  ipcEndpoint: string,
  method: string,
  params: unknown = {},
  timeoutMs = 2_000,
) {
  return requestServiceIpc<T>(
    ipcEndpoint,
    config.internalToken,
    method,
    params,
    timeoutMs,
  );
}

async function readManagedServiceStatus(
  config: PersistedAgentConfig,
  ipcEndpoint: string,
  timeoutMs = 2_000,
) {
  const status = await requestManagedService<{
    product?: unknown;
    service?: unknown;
    port?: unknown;
    processId?: unknown;
  }>(config, ipcEndpoint, "service.status", {}, timeoutMs);
  if (status.product !== "shipflow-service" || status.service !== "running") {
    throw new Error("The native IPC endpoint is not a running ShipFlow Service.");
  }
  if (status.port !== config.port) {
    throw new Error(
      `ShipFlow Service IPC reports port ${String(status.port)}, expected ${config.port}.`,
    );
  }
  return status;
}

async function requestService(
  config: PersistedAgentConfig,
  route: string,
  token: string | null = config.internalToken,
  timeoutMs = 2_000,
  method: "GET" | "POST" = "GET",
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`http://127.0.0.1:${config.port}${route}`, {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function isShipFlowServiceListening(config: PersistedAgentConfig) {
  const response = await requestService(config, "/v1/status", null);
  if (!response.ok) {
    return false;
  }
  const payload = (await response.json()) as { data?: { product?: unknown } };
  return payload.data?.product === "shipflow-service";
}

export class ServiceAgentManager {
  #config: PersistedAgentConfig | null = null;
  #connectionStart = new SingleFlight<ManagedServiceConnection>();
  #child: ChildProcess | null = null;
  #shutdownPromise: Promise<void> | null = null;
  #isShuttingDown = false;
  #restartTimer: NodeJS.Timeout | null = null;
  #restartCount = 0;
  readonly #restartPolicy = new ServiceRestartPolicy();
  readonly #expectedExitPids = new Set<number>();
  readonly #ipcRuntimeDirectory = serviceIpcRuntimeDirectory();
  readonly #ipcEndpoint = createServiceIpcEndpoint(
    serviceIpcStableNonce(),
    this.#ipcRuntimeDirectory,
  );

  async #prepareIpcRuntime() {
    if (process.platform === "win32" || process.env.SHIPFLOW_INTERNAL_IPC_ENDPOINT?.trim()) {
      return;
    }
    await mkdir(this.#ipcRuntimeDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.#ipcRuntimeDirectory, 0o700);
  }

  async loadConfig() {
    if (this.#config) {
      return this.#config;
    }
    const persisted = await readJsonFile<Partial<PersistedAgentConfig>>(agentConfigPath());
    const config = normalizeConfig(persisted ?? (await readLegacyConfig()));
    await persistConfig(config);
    this.#config = config;
    return config;
  }

  async loadFrontendConfig() {
    return asServiceConfig(await this.loadConfig());
  }

  async publicApiTokenForNativeAction() {
    return (await this.loadConfig()).publicApiToken;
  }

  async keepRunningInTray() {
    return (await this.loadConfig()).keepRunningInTray;
  }

  async setEnabled(enabled: boolean) {
    const current = await this.loadFrontendConfig();
    if (current.enabled === enabled) {
      if (enabled) {
        await this.connection();
      }
      return this.status();
    }
    return this.configure({
      ...current,
      enabled,
    });
  }

  async connection() {
    if (this.#isShuttingDown) {
      throw new Error("ShipFlow Service is shutting down.");
    }
    return this.#connectionStart.run(async () => {
      await this.#prepareIpcRuntime();
      appLogger.event("INFO", "ServiceAgent", "service_connection_requested", {
        hasActiveChild: Boolean(this.#child && !childProcessHasExited(this.#child)),
        restartCount: this.#restartCount,
      });
      return this.#ensureStarted();
    });
  }

  async status(): Promise<ApiServiceStatus> {
    const config = await this.loadConfig();
    if (!config.enabled) {
      return stoppedStatus(config);
    }
    try {
      await readManagedServiceStatus(config, this.#ipcEndpoint);
      return {
        status: "running",
        enabled: true,
        mode: config.mode,
        bindAddress: config.mode === "lan" ? "0.0.0.0" : "127.0.0.1",
        port: config.port,
        errorMessage: null,
      };
    } catch (error) {
      return {
        ...stoppedStatus(config),
        status: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async configure(frontendConfig: ServiceConfig) {
    const previous = await this.loadConfig();
    const next = normalizeConfig({
      ...previous,
      enabled: frontendConfig.enabled,
      mode: frontendConfig.mode,
      port: frontendConfig.port,
      publicApiToken: frontendConfig.authToken.trim() || previous.publicApiToken,
      trackingSource: frontendConfig.trackingSource,
      externalApiBaseUrl: frontendConfig.externalApiBaseUrl,
      externalApiAuthToken:
        frontendConfig.externalApiAuthToken.trim() || previous.externalApiAuthToken,
      allowInsecureExternalApiHttp: frontendConfig.allowInsecureExternalApiHttp,
      keepRunningInTray: frontendConfig.keepRunningInTray,
      startAtLogin: frontendConfig.startAtLogin,
      lastUpdatedAt: new Date().toISOString(),
      processId: previous.processId,
    });
    const requiresRestart =
      previous.enabled !== next.enabled ||
      previous.mode !== next.mode ||
      previous.port !== next.port ||
      previous.publicApiToken !== next.publicApiToken ||
      previous.internalToken !== next.internalToken ||
      previous.trackingSource !== next.trackingSource ||
      previous.externalApiBaseUrl !== next.externalApiBaseUrl ||
      previous.externalApiAuthToken !== next.externalApiAuthToken ||
      previous.allowInsecureExternalApiHttp !== next.allowInsecureExternalApiHttp;
    if (requiresRestart) {
      this.#clearScheduledRestart();
      this.#restartPolicy.reset();
      await this.#stopManagedService(previous, true);
      next.processId = null;
    }
    await persistConfig(next);
    this.#config = next;
    appLogger.event("INFO", "ServiceAgent", "service_config_saved", {
      enabled: next.enabled,
      keepRunningInTray: next.keepRunningInTray,
      mode: next.mode,
      port: next.port,
      requiresRestart,
      startAtLogin: next.startAtLogin,
      trackingSource: next.trackingSource,
    });
    app.setLoginItemSettings({
      openAtLogin: next.startAtLogin,
      args: ["--background"],
    });
    if (next.enabled) {
      await this.connection();
    }
    return this.status();
  }

  async testExternalSource(frontendConfig: ServiceConfig) {
    const requestedBaseUrl = frontendConfig.externalApiBaseUrl.trim();
    if (!requestedBaseUrl) {
      throw new Error("External API base URL is required.");
    }
    const storedConfig = await this.loadConfig();
    const externalApiAuthToken =
      frontendConfig.externalApiAuthToken.trim() || storedConfig.externalApiAuthToken;
    if (!externalApiAuthToken) {
      throw new Error("External API token is required.");
    }
    const baseUrl = await probeExternalApiAuth(
      requestedBaseUrl,
      frontendConfig.allowInsecureExternalApiHttp,
      externalApiAuthToken,
    );
    return `External ShipFlow API is reachable at ${baseUrl}.`;
  }

  async shutdown() {
    if (this.#shutdownPromise) {
      return this.#shutdownPromise;
    }
    this.#isShuttingDown = true;
    this.#clearScheduledRestart();
    this.#restartPolicy.reset();
    this.#shutdownPromise = (async () => {
      appLogger.event("INFO", "ServiceAgent", "service_shutdown_started", {
        hasActiveChild: Boolean(this.#child && !childProcessHasExited(this.#child)),
      });
      await this.#connectionStart.current?.catch(() => undefined);
      const config = await this.loadConfig();
      await this.#stopManagedService(config, false);
      config.processId = null;
      await persistConfig(config);
      appLogger.event("INFO", "ServiceAgent", "service_shutdown_completed");
    })();
    try {
      await this.#shutdownPromise;
    } finally {
      this.#shutdownPromise = null;
    }
  }

  async #ensureStarted() {
    if (this.#isShuttingDown) {
      throw new Error("ShipFlow Service is shutting down.");
    }
    const config = await this.loadConfig();
    if (!config.enabled) {
      throw new Error("ShipFlow Service is disabled.");
    }
    let managedEndpointDetected = false;
    try {
      const status = await readManagedServiceStatus(config, this.#ipcEndpoint);
      managedEndpointDetected = true;
      if (this.#child) {
        appLogger.event("INFO", "ServiceAgent", "service_reused", {
          pid: config.processId,
          port: config.port,
        });
        return connectionFor(config, this.#ipcEndpoint);
      }
      appLogger.event("WARN", "ServiceAgent", "orphan_service_detected", {
        pid:
          typeof status.processId === "number" && Number.isInteger(status.processId)
            ? status.processId
            : config.processId,
        port: config.port,
      });
      await requestManagedService(
        config,
        this.#ipcEndpoint,
        "service.shutdown",
        {},
        3_000,
      );
      const shutdownDeadline = Date.now() + 5_000;
      while (Date.now() < shutdownDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        try {
          await readManagedServiceStatus(config, this.#ipcEndpoint, 250);
        } catch {
          config.processId = null;
          await persistConfig(config);
          appLogger.event("INFO", "ServiceAgent", "orphan_service_stopped", {
            port: config.port,
          });
          break;
        }
      }
      if (config.processId !== null) {
        throw new Error(
          "The previous managed ShipFlow Service did not stop within the recovery deadline.",
        );
      }
    } catch (error) {
      if (managedEndpointDetected) {
        appLogger.event("ERROR", "ServiceAgent", "orphan_service_recovery_failed", {
          error: error instanceof Error ? error.message : String(error),
          port: config.port,
        });
        throw error;
      }
      // No managed IPC endpoint is currently available.
    }

    let existingShipFlowService = false;
    try {
      existingShipFlowService = await isShipFlowServiceListening(config);
    } catch {
      existingShipFlowService = false;
    }
    if (existingShipFlowService) {
      throw new Error(
        `Another ShipFlow Service is already listening on port ${config.port}, but its native IPC endpoint is unavailable. Stop the older instance before starting ShipFlow Desktop.`,
      );
    }

    const executable = await resolveServiceExecutable();
    if (this.#isShuttingDown) {
      throw new Error("ShipFlow Service is shutting down.");
    }
    const args = [
      config.mode === "lan" ? "--lan" : "--local",
      "--port",
      String(config.port),
    ];
    const startupStartedAt = Date.now();
    const launchId = randomBytes(8).toString("hex");
    appLogger.event("INFO", "ServiceAgent", "service_spawn_started", {
      launchId,
      mode: config.mode,
      port: config.port,
      restartCount: this.#restartCount,
    });
    const serviceLogPath = serviceLogFilePath();
    const child = spawn(executable, args, {
      detached: false,
      env: {
        ...process.env,
        SHIPFLOW_SERVICE_TOKEN: config.publicApiToken,
        SHIPFLOW_INTERNAL_SERVICE_TOKEN: config.internalToken,
        SHIPFLOW_INTERNAL_IPC_ENDPOINT: this.#ipcEndpoint,
        SHIPFLOW_EXTERNAL_API_BASE_URL:
          config.trackingSource === "externalApi" ? config.externalApiBaseUrl : "",
        SHIPFLOW_EXTERNAL_API_TOKEN:
          config.trackingSource === "externalApi" ? config.externalApiAuthToken : "",
        SHIPFLOW_ALLOW_INSECURE_HTTP: String(config.allowInsecureExternalApiHttp),
        SHIPFLOW_SERVICE_RESTART_COUNT: String(this.#restartCount),
        SHIPFLOW_NATIVE_LOG_FILE: serviceLogPath,
      },
      stdio: "ignore",
      windowsHide: true,
    });
    this.#child = child;
    config.processId = child.pid ?? null;
    let startupFailure: Error | null = null;
    const handleTermination = (detail: string) => {
      if (!startupFailure) {
        startupFailure = new Error(`ShipFlow Service exited during startup with ${detail}.`);
      }
      const processId = child.pid;
      const expectedExit =
        processId !== undefined && this.#expectedExitPids.delete(processId);
      const ownsCurrentChild = this.#child === child;
      if (ownsCurrentChild) {
        this.#child = null;
      }
      const currentConfig = this.#config;
      if (currentConfig && currentConfig.processId === processId) {
        currentConfig.processId = null;
        void persistConfig(currentConfig).catch((error) => {
          appLogger.error("ServiceAgent", `Unable to persist Service exit state: ${String(error)}`);
        });
      }
      appLogger.info("ServiceAgent", `Managed Service exited with ${detail}.`);
      appLogger.event(
        expectedExit ? "INFO" : "ERROR",
        "ServiceAgent",
        "service_process_exited",
        {
          detail,
          expected: expectedExit,
          launchId,
          pid: processId,
          uptimeMs: Date.now() - startupStartedAt,
        },
      );
      if (
        ownsCurrentChild &&
        !expectedExit &&
        !this.#isShuttingDown &&
        currentConfig?.enabled
      ) {
        this.#scheduleRestart();
      }
    };
    observeChildProcessTermination(child, (termination) => {
      handleTermination(
        termination.kind === "error"
          ? `spawn error ${String(termination.error)}`
          : termination.signal
            ? `signal ${termination.signal}`
            : `code ${termination.code ?? "unknown"}`,
      );
    });
    appLogger.info("ServiceAgent", `Started managed Service process pid=${child.pid ?? "unknown"}.`);
    appLogger.event("INFO", "ServiceAgent", "service_process_started", {
      launchId,
      pid: child.pid,
      serviceLogPath,
    });
    await persistConfig(config);

    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (startupFailure) {
        throw startupFailure;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (startupFailure) {
        throw startupFailure;
      }
      try {
        await readManagedServiceStatus(config, this.#ipcEndpoint, 750);
        appLogger.event("INFO", "ServiceAgent", "service_ready", {
          launchId,
          pid: child.pid,
          port: config.port,
          startupDurationMs: Date.now() - startupStartedAt,
        });
        return connectionFor(config, this.#ipcEndpoint);
      } catch {
        // Continue until the bounded startup deadline.
      }
    }
    let stopped = true;
    if (!childProcessHasExited(child)) {
      this.#markChildExitExpected(child);
      stopped = await terminateChildProcess(child);
    }
    if (this.#child === child) {
      this.#child = null;
    }
    if (config.processId === child.pid) {
      config.processId = null;
      await persistConfig(config);
    }
    throw new Error(
      stopped
        ? "ShipFlow Service did not become ready on its native IPC endpoint."
        : "ShipFlow Service did not become ready and its process could not be terminated.",
    );
  }

  async #stopManagedService(config: PersistedAgentConfig, requireStopped: boolean) {
    let managedServiceWasReachable = false;
    try {
      await readManagedServiceStatus(config, this.#ipcEndpoint);
      managedServiceWasReachable = true;
    } catch {
      // The managed Service is already stopped or the IPC endpoint is stale.
    }

    if (!managedServiceWasReachable) {
      let legacyServiceWasReachable = false;
      try {
        legacyServiceWasReachable = await isShipFlowServiceListening(config);
      } catch {
        legacyServiceWasReachable = false;
      }
      if (
        legacyServiceWasReachable &&
        (!this.#child || childProcessHasExited(this.#child))
      ) {
        const message =
          "A ShipFlow Service without the managed IPC endpoint is still running. Stop that process before restarting Service settings.";
        if (requireStopped) {
          throw new Error(message);
        }
        appLogger.warn("ServiceAgent", message);
        return;
      }
    }

    const child = this.#child;
    if (managedServiceWasReachable) {
      if (child) {
        this.#markChildExitExpected(child);
      }
      try {
        await requestManagedService(
          config,
          this.#ipcEndpoint,
          "service.shutdown",
          {},
          3_000,
        );
      } catch (error) {
        if (!child || childProcessHasExited(child)) {
          if (requireStopped) {
            throw new Error(
              `The existing ShipFlow Service cannot be restarted safely: ${String(error)}`,
            );
          }
          process.stderr.write(
            `[ShipFlowServiceAgent] Existing Service was left running: ${String(error)}\n`,
          );
          return;
        }
        await terminateChildProcess(child);
      }

      if (child && !childProcessHasExited(child)) {
        await waitForChildProcessExit(child, 5_000);
      }
    }

    if (child && !childProcessHasExited(child)) {
      this.#markChildExitExpected(child);
      const stopped = await terminateChildProcess(child);
      if (!stopped && requireStopped) {
        throw new Error("ShipFlow Service process could not be terminated safely.");
      }
    }
    if (this.#child === child) {
      this.#child = null;
    }
    config.processId = null;
  }

  #markChildExitExpected(child: ChildProcess) {
    const processId = child.pid;
    if (processId !== undefined) {
      this.#expectedExitPids.add(processId);
    }
  }

  #clearScheduledRestart() {
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
  }

  #scheduleRestart() {
    if (this.#restartTimer || this.#isShuttingDown) {
      return;
    }
    const decision = this.#restartPolicy.registerCrash();
    if (!decision) {
      appLogger.error(
        "ServiceAgent",
        "Managed Service restart stopped after repeated crashes within two minutes.",
      );
      appLogger.event("ERROR", "ServiceAgent", "service_restart_exhausted", {
        restartCount: this.#restartCount,
      });
      return;
    }

    appLogger.warn(
      "ServiceAgent",
      `Managed Service restart scheduled attempt=${decision.attempt} delayMs=${decision.delayMs}.`,
    );
    appLogger.event("WARN", "ServiceAgent", "service_restart_scheduled", {
      attempt: decision.attempt,
      delayMs: decision.delayMs,
      restartCount: this.#restartCount,
    });
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      void this.#restartAfterCrash(decision.attempt);
    }, decision.delayMs);
  }

  async #restartAfterCrash(attempt: number) {
    if (this.#isShuttingDown || !(await this.loadConfig()).enabled) {
      return;
    }
    const previousStart = this.#connectionStart.current;
    if (previousStart) {
      await previousStart.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (this.#isShuttingDown) {
      return;
    }

    this.#restartCount += 1;
    try {
      await this.connection();
      appLogger.info(
        "ServiceAgent",
        `Managed Service restart completed attempt=${attempt} restartCount=${this.#restartCount}.`,
      );
      appLogger.event("INFO", "ServiceAgent", "service_restart_completed", {
        attempt,
        restartCount: this.#restartCount,
      });
    } catch (error) {
      appLogger.error(
        "ServiceAgent",
        `Managed Service restart failed attempt=${attempt}: ${String(error)}`,
      );
      appLogger.event("ERROR", "ServiceAgent", "service_restart_failed", {
        attempt,
        error: error instanceof Error ? error.message : String(error),
        restartCount: this.#restartCount,
      });
      this.#scheduleRestart();
    }
  }
}
