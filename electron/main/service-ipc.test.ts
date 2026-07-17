import { describe, expect, it } from "vitest";
import { buildServiceIpcEndpoint } from "./service-ipc";

describe("service IPC endpoint", () => {
  it("uses a short Unix socket path", () => {
    expect(buildServiceIpcEndpoint("darwin", "abc-123")).toBe(
      "/tmp/shipflow-abc-123.sock",
    );
  });

  it("uses the Windows named pipe namespace", () => {
    expect(buildServiceIpcEndpoint("win32", "abc-123")).toBe(
      "\\\\.\\pipe\\shipflow-abc-123",
    );
  });
});
