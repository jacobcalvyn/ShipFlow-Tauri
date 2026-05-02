import { beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceConfig } from "../types";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

describe("backend command boundary", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("keeps service config DTO keys stable", () => {
    const config = {
      version: 1,
      desktopConnectionMode: "custom",
      desktopServiceUrl: "http://127.0.0.1:18422",
      desktopServiceAuthToken: "desktop-token",
      enabled: true,
      mode: "local",
      port: 18422,
      authToken: "service-token",
      trackingSource: "default",
      externalApiBaseUrl: "",
      externalApiAuthToken: "",
      allowInsecureExternalApiHttp: false,
      keepRunningInTray: true,
      lastUpdatedAt: "2026-05-02T00:00:00.000Z",
    } satisfies ServiceConfig;

    expect(Object.keys(config).sort()).toEqual([
      "allowInsecureExternalApiHttp",
      "authToken",
      "desktopConnectionMode",
      "desktopServiceAuthToken",
      "desktopServiceUrl",
      "enabled",
      "externalApiAuthToken",
      "externalApiBaseUrl",
      "keepRunningInTray",
      "lastUpdatedAt",
      "mode",
      "port",
      "trackingSource",
      "version",
    ]);
  });

  it("routes typed wrappers to stable Tauri command names", async () => {
    invokeMock.mockResolvedValueOnce({ status: "running" });
    const { getApiServiceStatus } = await import("./commands");

    await getApiServiceStatus();

    expect(invokeMock).toHaveBeenCalledWith("get_api_service_status");
  });
});
