import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

type RpcMessage =
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
    };

export function buildServiceIpcEndpoint(
  platform: NodeJS.Platform,
  identity: string,
) {
  const safeIdentity = identity.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  if (!safeIdentity) {
    throw new Error("ShipFlow IPC identity is required.");
  }
  return platform === "win32"
    ? `\\\\.\\pipe\\shipflow-${safeIdentity}`
    : `/tmp/shipflow-${safeIdentity}.sock`;
}

export async function requestServiceIpc<T>(
  endpoint: string,
  authToken: string,
  method: string,
  params: unknown = {},
  timeoutMs = 5_000,
): Promise<T> {
  const id = `electron-${process.pid}-${randomUUID()}`;
  const payload = `${JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    id,
    method,
    authToken,
    params,
  })}\n`;
  if (Buffer.byteLength(payload) > MAX_FRAME_BYTES) {
    throw new Error("ShipFlow IPC request exceeds the maximum size.");
  }

  return new Promise<T>((resolve, reject) => {
    const socket = createConnection(endpoint);
    let settled = false;
    let response = "";
    const finish = (error?: Error, value?: T) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve(value as T);
      }
    };
    const timeout = setTimeout(() => {
      finish(new Error(`ShipFlow Service IPC request ${method} timed out.`));
    }, timeoutMs);

    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(payload));
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (Buffer.byteLength(response) > MAX_FRAME_BYTES) {
        finish(new Error("ShipFlow Service IPC response exceeds the maximum size."));
        return;
      }
      const newline = response.indexOf("\n");
      if (newline < 0) {
        return;
      }
      let message: RpcMessage;
      try {
        message = JSON.parse(response.slice(0, newline)) as RpcMessage;
      } catch (error) {
        finish(new Error(`ShipFlow Service returned invalid IPC JSON: ${String(error)}`));
        return;
      }
      if (message.protocolVersion !== PROTOCOL_VERSION || message.id !== id) {
        finish(new Error("ShipFlow Service returned an invalid IPC correlation response."));
      } else if (message.kind === "error") {
        finish(new Error(`${message.error.code}: ${message.error.message}`));
      } else if (message.kind === "response") {
        finish(undefined, message.result as T);
      } else {
        finish(new Error("ShipFlow Service returned an unsupported IPC response."));
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("end", () => {
      if (!settled) {
        finish(new Error("ShipFlow Service closed IPC before returning a response."));
      }
    });
  });
}
