import { beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceConfig } from "../types";
import { installTestBridge } from "../test/bridge";

const invokeMock = vi.fn();

describe("backend command boundary", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    installTestBridge({ invoke: invokeMock });
  });

  it("keeps service config DTO keys stable", () => {
    const config = {
      version: 1,
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

  it("routes typed wrappers to stable Electron command names", async () => {
    invokeMock.mockResolvedValueOnce({ status: "running" });
    const {
      checkAppUpdate,
      getApiServiceStatus,
      getReleaseHealth,
      installAppUpdate,
      openAppLog,
    } =
      await import("./commands");

    await getApiServiceStatus();
    await checkAppUpdate();
    await installAppUpdate();
    await getReleaseHealth();
    await openAppLog();

    expect(invokeMock).toHaveBeenNthCalledWith(1, "get_api_service_status", undefined);
    expect(invokeMock).toHaveBeenNthCalledWith(2, "check_app_update", undefined);
    expect(invokeMock).toHaveBeenNthCalledWith(3, "install_app_update", undefined);
    expect(invokeMock).toHaveBeenNthCalledWith(4, "get_release_health", undefined);
    expect(invokeMock).toHaveBeenNthCalledWith(5, "open_app_log", undefined);
  });
});
