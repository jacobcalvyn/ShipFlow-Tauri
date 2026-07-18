import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, safeStorage } from "electron";
import type { ApiServiceStatus, ServiceConfig } from "../../src/types";
import type { ManagedServiceConnection } from "./workspace-host";
import { appLogger } from "./app-logger";
import { probeExternalApiAuth } from "./external-api-policy";
import { buildServiceIpcEndpoint, requestServiceIpc } from "./service-ipc";

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

function createToken() {
  return `sf_${randomBytes(24).toString("hex")}`;
}

function protectSecret(value: string) {
  if (!value || !safeStorage.isEncryptionAvailable()) {
    return value;
  }
  return `${ENCRYPTED_SECRET_PREFIX}${safeStorage.encryptString(value).toString("base64")}`;
}

function revealSecret(value: string | undefined) {
  if (!value?.startsWith(ENCRYPTED_SECRET_PREFIX)) {
    return value?.trim() ?? "";
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

function serviceIpcIdentity() {
  return createHash("sha256")
    .update(app.getPath("userData"))
    .digest("hex")
    .slice(0, 20);
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

async function persistConfig(config: PersistedAgentConfig) {
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
  #startPromise: Promise<ManagedServiceConnection> | null = null;
  #child: ChildProcess | null = null;
  #shutdownPromise: Promise<void> | null = null;
  #isShuttingDown = false;
  readonly #ipcRuntimeDirectory = serviceIpcRuntimeDirectory();
  readonly #ipcEndpoint = createServiceIpcEndpoint(
    randomBytes(16).toString("hex"),
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

  async connection() {
    if (this.#isShuttingDown) {
      throw new Error("ShipFlow Service is shutting down.");
    }
    if (this.#startPromise) {
      return this.#startPromise;
    }
    await this.#prepareIpcRuntime();
    this.#startPromise = this.#ensureStarted();
    try {
      return await this.#startPromise;
    } finally {
      this.#startPromise = null;
    }
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
      await this.#stopManagedService(previous, true);
      next.processId = null;
    }
    await persistConfig(next);
    this.#config = next;
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
    this.#shutdownPromise = (async () => {
      await this.#startPromise?.catch(() => undefined);
      const config = await this.loadConfig();
      await this.#stopManagedService(config, false);
      config.processId = null;
      await persistConfig(config);
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
    try {
      await readManagedServiceStatus(config, this.#ipcEndpoint);
      return connectionFor(config, this.#ipcEndpoint);
    } catch {
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
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    appLogger.info("ServiceAgent", `Started managed Service process pid=${child.pid ?? "unknown"}.`);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      appLogger.info("Service", chunk);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      appLogger.info("Service", chunk);
    });
    config.processId = child.pid ?? null;
    await persistConfig(config);
    child.once("exit", (code, signal) => {
      if (this.#child !== child) {
        return;
      }
      this.#child = null;
      const currentConfig = this.#config;
      if (currentConfig && currentConfig.processId === child.pid) {
        currentConfig.processId = null;
        void persistConfig(currentConfig).catch((error) => {
          appLogger.error("ServiceAgent", `Unable to persist Service exit state: ${String(error)}`);
        });
      }
      const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      appLogger.info("ServiceAgent", `Managed Service exited with ${detail}.`);
    });

    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      try {
        await readManagedServiceStatus(config, this.#ipcEndpoint, 750);
        return connectionFor(config, this.#ipcEndpoint);
      } catch {
        // Continue until the bounded startup deadline.
      }
    }
    throw new Error(
      "ShipFlow Service did not become ready on its native IPC endpoint.",
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
      if (legacyServiceWasReachable && (!this.#child || this.#child.killed)) {
        const message =
          "A ShipFlow Service without the managed IPC endpoint is still running. Stop that process before restarting Service settings.";
        if (requireStopped) {
          throw new Error(message);
        }
        appLogger.warn("ServiceAgent", message);
        return;
      }
    }

    if (managedServiceWasReachable) {
      try {
        await requestManagedService(
          config,
          this.#ipcEndpoint,
          "service.shutdown",
          {},
          3_000,
        );
      } catch (error) {
        if (!this.#child || this.#child.killed) {
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
        this.#child.kill();
      }

      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        try {
          await readManagedServiceStatus(config, this.#ipcEndpoint, 500);
        } catch {
          break;
        }
      }
    }

    if (this.#child && !this.#child.killed) {
      this.#child.kill();
    }
    this.#child = null;
    config.processId = null;
  }
}
