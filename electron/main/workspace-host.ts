import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { appLogger } from "./app-logger";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  onEvent?: (event: unknown) => void;
  timeout: NodeJS.Timeout;
};

type RpcMessage =
  | {
      kind: "ready";
      protocolVersion: number;
      product: string;
      processId: number;
    }
  | {
      kind: "response";
      protocolVersion: number;
      id: string;
      result: unknown;
    }
  | {
      kind: "error";
      protocolVersion: number;
      id: string;
      error: { code: string; message: string };
    }
  | {
      kind: "event";
      protocolVersion: number;
      id: string;
      event: unknown;
    };

export type ManagedServiceConnection = {
  ipcEndpoint: string;
  internalToken: string;
};

const PROTOCOL_VERSION = 1;
const STARTUP_TIMEOUT_MS = 10_000;
const QUICK_REQUEST_TIMEOUT_MS = 30_000;
const LONG_REQUEST_TIMEOUT_MS = 30 * 60_000;
const MAX_REQUEST_TIMEOUT_MS = 2 * 60 * 60_000;

function requestTimeoutMs(method: string, params: unknown) {
  if (method === "workspace.refresh_tracking_with_progress") {
    const rowCount =
      params && typeof params === "object" && Array.isArray((params as { rowIds?: unknown }).rowIds)
        ? (params as { rowIds: unknown[] }).rowIds.length
        : 1;
    return Math.min(
      MAX_REQUEST_TIMEOUT_MS,
      Math.max(2 * 60_000, Math.ceil(rowCount / 5) * 45_000 + 30_000),
    );
  }
  if (
    method === "workspace.run_import_job_with_progress" ||
    method === "workspace.retry_import_job_with_progress"
  ) {
    return MAX_REQUEST_TIMEOUT_MS;
  }
  if (
    method === "workspace.command" &&
    params &&
    typeof params === "object" &&
    (params as { command?: unknown }).command === "preview_import_source"
  ) {
    return LONG_REQUEST_TIMEOUT_MS;
  }
  return QUICK_REQUEST_TIMEOUT_MS;
}

function executableName(baseName: string) {
  return process.platform === "win32" ? `${baseName}.exe` : baseName;
}

async function firstExistingPath(candidates: string[]) {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next platform-specific development or packaged path.
    }
  }
  throw new Error(`Native executable was not found: ${candidates.join(", ")}`);
}

export async function resolveWorkspaceHostPath() {
  const name = executableName("shipflow-workspace-host");
  const override = process.env.SHIPFLOW_WORKSPACE_HOST_PATH?.trim();
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

export function workspaceDatabasePath(windowLabel: string) {
  const engineRoot = path.join(app.getPath("userData"), "workspace-engine");
  if (windowLabel === "main") {
    return path.join(engineRoot, "workspace.sqlite3");
  }
  return path.join(engineRoot, "windows", windowLabel, "workspace.sqlite3");
}

export class WorkspaceHostClient {
  readonly #windowLabel: string;
  readonly #serviceConnection: ManagedServiceConnection;
  readonly #pending = new Map<string, PendingRequest>();
  #child: ChildProcessWithoutNullStreams | null = null;
  #readyPromise: Promise<void> | null = null;
  #requestSequence = 0;

  constructor(windowLabel: string, serviceConnection: ManagedServiceConnection) {
    this.#windowLabel = windowLabel;
    this.#serviceConnection = serviceConnection;
  }

  async start() {
    if (this.#readyPromise) {
      return this.#readyPromise;
    }
    this.#readyPromise = this.#spawnAndWaitUntilReady();
    try {
      await this.#readyPromise;
    } catch (error) {
      this.#readyPromise = null;
      throw error;
    }
  }

  async request<T>(
    method: string,
    params: unknown,
    onEvent?: (event: unknown) => void,
  ): Promise<T> {
    await this.start();
    const child = this.#child;
    if (!child || child.killed || !child.stdin.writable) {
      throw new Error("ShipFlow Workspace Host is not available.");
    }

    this.#requestSequence += 1;
    const id = `${this.#windowLabel}-${this.#requestSequence}`;
    const timeoutMs = requestTimeoutMs(method, params);
    const response = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new Error(
            `ShipFlow Workspace Host request ${method} timed out after ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        onEvent,
        timeout,
      });
    });
    const payload = `${JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        id,
        method,
        params,
      })}\n`;
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(payload, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    }).catch((error) => {
      const pending = this.#pending.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.#pending.delete(id);
        pending.reject(
          new Error(`Unable to write Workspace Host request ${method}: ${String(error)}`),
        );
      }
    });
    return response;
  }

  stop() {
    const child = this.#child;
    this.#child = null;
    this.#readyPromise = null;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("ShipFlow Workspace Host stopped."));
    }
    this.#pending.clear();
    if (child && !child.killed) {
      child.kill();
    }
  }

  async #spawnAndWaitUntilReady() {
    const executable = await resolveWorkspaceHostPath();
    const database = workspaceDatabasePath(this.#windowLabel);
    await mkdir(path.dirname(database), { recursive: true });
    const child = spawn(
      executable,
      ["--database", database, "--service-ipc", this.#serviceConnection.ipcEndpoint],
      {
        env: {
          ...process.env,
          SHIPFLOW_INTERNAL_SERVICE_TOKEN: this.#serviceConnection.internalToken,
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    this.#child = child;
    appLogger.info(
      "WorkspaceHost",
      `Started workspace host window=${this.#windowLabel} pid=${child.pid ?? "unknown"}.`,
    );

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      appLogger.warn(`WorkspaceHost:${this.#windowLabel}`, chunk);
    });
    child.once("exit", (code, signal) => {
      if (this.#child === child) {
        this.#child = null;
        this.#readyPromise = null;
      }
      const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      appLogger.info(
        "WorkspaceHost",
        `Workspace host window=${this.#windowLabel} exited with ${detail}.`,
      );
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(`ShipFlow Workspace Host exited with ${detail}.`));
      }
      this.#pending.clear();
    });

    const lines = createInterface({ input: child.stdout });
    let readyResolve: (() => void) | null = null;
    let readyReject: ((error: Error) => void) | null = null;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const timeout = setTimeout(() => {
      readyReject?.(new Error("ShipFlow Workspace Host startup timed out."));
      child.kill();
    }, STARTUP_TIMEOUT_MS);

    lines.on("line", (line) => {
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch (error) {
        appLogger.error(
          `WorkspaceHost:${this.#windowLabel}`,
          `Invalid JSON: ${String(error)}`,
        );
        return;
      }

      if (message.protocolVersion !== PROTOCOL_VERSION) {
        readyReject?.(
          new Error(
            `Workspace Host protocol mismatch: ${message.protocolVersion} != ${PROTOCOL_VERSION}.`,
          ),
        );
        child.kill();
        return;
      }
      if (message.kind === "ready") {
        clearTimeout(timeout);
        readyResolve?.();
        readyResolve = null;
        readyReject = null;
        return;
      }
      if (message.kind === "event") {
        this.#pending.get(message.id)?.onEvent?.(message.event);
        return;
      }
      const pending = this.#pending.get(message.id);
      if (!pending) {
        return;
      }
      this.#pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.kind === "response") {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
      }
    });

    child.once("error", (error) => {
      clearTimeout(timeout);
      readyReject?.(error);
    });
    await ready;
  }
}
