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
      startAtLogin: true,
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
      "startAtLogin",
      "trackingSource",
      "version",
    ]);
  });

  it("routes typed wrappers to stable Tauri command names", async () => {
    invokeMock.mockResolvedValueOnce({ status: "running" });
    const { checkAppUpdate, getApiServiceStatus, getReleaseHealth, installAppUpdate } =
      await import("./commands");

    await getApiServiceStatus();
    await checkAppUpdate();
    await installAppUpdate();
    await getReleaseHealth();

    expect(invokeMock).toHaveBeenNthCalledWith(1, "get_api_service_status");
    expect(invokeMock).toHaveBeenNthCalledWith(2, "check_app_update");
    expect(invokeMock).toHaveBeenNthCalledWith(3, "install_app_update");
    expect(invokeMock).toHaveBeenNthCalledWith(4, "get_release_health");
  });
});
