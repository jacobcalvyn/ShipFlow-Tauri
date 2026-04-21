import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceShellSurfaceController } from "./useWorkspaceShellSurfaceController";

const mocks = vi.hoisted(() => ({
  useFrontendRuntimeLoggingMock: vi.fn(),
  useWorkspaceActionNoticeControllerMock: vi.fn(),
  useWorkspaceDocumentControllerMock: vi.fn(),
  useWorkspaceServiceSurfaceControllerMock: vi.fn(),
  useWorkspaceShellSettingsSurfaceControllerMock: vi.fn(),
}));

vi.mock("../useFrontendRuntimeLogging", () => ({
  useFrontendRuntimeLogging: mocks.useFrontendRuntimeLoggingMock,
}));

vi.mock("./useWorkspaceActionNoticeController", () => ({
  useWorkspaceActionNoticeController: mocks.useWorkspaceActionNoticeControllerMock,
}));

vi.mock("./useWorkspaceDocumentController", () => ({
  useWorkspaceDocumentController: mocks.useWorkspaceDocumentControllerMock,
}));

vi.mock("./useWorkspaceServiceSurfaceController", () => ({
  useWorkspaceServiceSurfaceController:
    mocks.useWorkspaceServiceSurfaceControllerMock,
}));

vi.mock("./useWorkspaceShellSettingsSurfaceController", () => ({
  useWorkspaceShellSettingsSurfaceController:
    mocks.useWorkspaceShellSettingsSurfaceControllerMock,
}));

describe("useWorkspaceShellSurfaceController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("composes notice, document, service, and shell surface controllers", () => {
    const showActionNotice = vi.fn();
    const actionNotices = [{ tone: "info", message: "Ready" }];
    const document = { createNewWorkspaceDocument: vi.fn(), documentMeta: { name: "Doc" } };
    const service = { effectiveServiceConfig: { enabled: false }, openShipFlowServiceApp: vi.fn() };
    const shellSettings = { effectiveDisplayScale: "small", confirmSettings: vi.fn() };
    const workspaceState = { sheets: [], activeSheetId: "sheet-1" };
    const setWorkspaceState = vi.fn();

    mocks.useWorkspaceActionNoticeControllerMock.mockReturnValue({
      actionNotices,
      showActionNotice,
    });
    mocks.useWorkspaceDocumentControllerMock.mockReturnValue(document);
    mocks.useWorkspaceServiceSurfaceControllerMock.mockReturnValue(service);
    mocks.useWorkspaceShellSettingsSurfaceControllerMock.mockReturnValue(
      shellSettings
    );

    const { result } = renderHook(() =>
      useWorkspaceShellSurfaceController({
        workspaceState: workspaceState as never,
        setWorkspaceState: setWorkspaceState as never,
      })
    );

    expect(mocks.useWorkspaceDocumentControllerMock).toHaveBeenCalledWith({
      workspaceState,
      setWorkspaceState,
      showNotice: showActionNotice,
    });
    expect(mocks.useWorkspaceServiceSurfaceControllerMock).toHaveBeenCalledWith({
      showNotice: showActionNotice,
    });
    expect(
      mocks.useWorkspaceShellSettingsSurfaceControllerMock
    ).toHaveBeenCalledWith({
      document,
      service,
    });
    expect(mocks.useFrontendRuntimeLoggingMock).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual({
      actionNotices,
      showActionNotice,
      ...document,
      ...service,
      ...shellSettings,
    });
  });
});
