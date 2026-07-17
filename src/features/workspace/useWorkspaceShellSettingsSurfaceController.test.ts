import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceShellSettingsSurfaceController } from "./useWorkspaceShellSettingsSurfaceController";

const mocks = vi.hoisted(() => ({
  useWorkspaceShellControllerMock: vi.fn(),
}));

vi.mock("./useWorkspaceShellController", () => ({
  useWorkspaceShellController: mocks.useWorkspaceShellControllerMock,
}));

describe("useWorkspaceShellSettingsSurfaceController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps document and service actions into shell settings controller", () => {
    const document = {
      createNewWorkspaceDocument: vi.fn(),
      openWorkspaceDocumentWithPicker: vi.fn(),
      saveCurrentWorkspaceDocument: vi.fn(),
      saveWorkspaceDocumentAs: vi.fn(),
      createNewWorkspaceWindow: vi.fn(),
      openWorkspaceInNewWindow: vi.fn(),
    };
    const service = {
      checkForAppUpdate: vi.fn(),
      installAvailableAppUpdate: vi.fn(),
      showNotice: vi.fn(),
    };
    const shellSettings = {
      effectiveDisplayScale: "small",
      confirmSettings: vi.fn(),
    };

    mocks.useWorkspaceShellControllerMock.mockReturnValue(shellSettings);

    const { result } = renderHook(() =>
      useWorkspaceShellSettingsSurfaceController({
        document: document as never,
        service: service as never,
      })
    );

    expect(mocks.useWorkspaceShellControllerMock).toHaveBeenCalledWith({
      createNewWorkspaceDocument: document.createNewWorkspaceDocument,
      openWorkspaceDocumentWithPicker: document.openWorkspaceDocumentWithPicker,
      saveCurrentWorkspaceDocument: document.saveCurrentWorkspaceDocument,
      saveWorkspaceDocumentAs: document.saveWorkspaceDocumentAs,
      createNewWorkspaceWindow: document.createNewWorkspaceWindow,
      openWorkspaceInNewWindow: document.openWorkspaceInNewWindow,
      checkForAppUpdate: service.checkForAppUpdate,
      installAvailableAppUpdate: service.installAvailableAppUpdate,
      showNotice: service.showNotice,
    });
    expect(result.current).toBe(shellSettings);
  });
});
