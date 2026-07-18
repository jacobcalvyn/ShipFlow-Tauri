import { describe, expect, it } from "vitest";
import { buildServiceIpcEndpoint } from "./service-ipc";

describe("service IPC endpoint", () => {
  it("uses a short Unix socket path", () => {
    expect(
      buildServiceIpcEndpoint(
        "darwin",
        "abc-123",
        "0123456789abcdef0123456789abcdef",
        "/private/tmp/shipflow-user",
      ),
    ).toBe(
      "/private/tmp/shipflow-user/shipflow-0123456789abcdef0123456789abcdef.sock",
    );
  });

  it("uses the Windows named pipe namespace", () => {
    expect(
      buildServiceIpcEndpoint("win32", "abc-123", "0123456789abcdef0123456789abcdef"),
    ).toBe(
      "\\\\.\\pipe\\shipflow-abc-123-0123456789abcdef0123456789abcdef",
    );
  });

  it("rejects Unix socket paths that exceed the portable platform limit", () => {
    expect(() =>
      buildServiceIpcEndpoint(
        "darwin",
        "abc-123",
        "0123456789abcdef0123456789abcdef",
        `/tmp/${"nested-".repeat(12)}`,
      ),
    ).toThrow("exceeds the safe socket path limit");
  });
});
