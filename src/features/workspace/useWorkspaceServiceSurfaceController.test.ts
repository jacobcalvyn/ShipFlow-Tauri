import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceServiceSurfaceController } from "./useWorkspaceServiceSurfaceController";

const mocks = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  useServiceSettingsControllerMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invokeMock,
}));

vi.mock("../service/useServiceSettingsController", () => ({
  useServiceSettingsController: mocks.useServiceSettingsControllerMock,
}));

describe("useWorkspaceServiceSurfaceController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("composes service settings and opens the ShipFlow Service app", async () => {
    const showNotice = vi.fn();
    const serviceSettings = {
      effectiveServiceConfig: { enabled: false },
      hasPendingServiceConfigChanges: false,
    };

    mocks.useServiceSettingsControllerMock.mockReturnValue(serviceSettings);
    mocks.invokeMock.mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useWorkspaceServiceSurfaceController({ showNotice })
    );

    expect(mocks.useServiceSettingsControllerMock).toHaveBeenCalledWith({
      copyText: expect.any(Function),
      showNotice,
    });
    expect(result.current).toEqual({
      ...serviceSettings,
      openShipFlowServiceApp: expect.any(Function),
    });

    await act(async () => {
      await result.current.openShipFlowServiceApp();
    });

    expect(mocks.invokeMock).toHaveBeenCalledWith("open_shipflow_service_app");
    expect(showNotice).not.toHaveBeenCalled();
  });

  it("shows an error notice when opening ShipFlow Service fails", async () => {
    const showNotice = vi.fn();

    mocks.useServiceSettingsControllerMock.mockReturnValue({});
    mocks.invokeMock.mockRejectedValue(new Error("boom"));

    const { result } = renderHook(() =>
      useWorkspaceServiceSurfaceController({ showNotice })
    );

    await act(async () => {
      await result.current.openShipFlowServiceApp();
    });

    expect(showNotice).toHaveBeenCalledWith({
      tone: "error",
      message: "Gagal membuka ShipFlow Service.",
    });
  });
});
