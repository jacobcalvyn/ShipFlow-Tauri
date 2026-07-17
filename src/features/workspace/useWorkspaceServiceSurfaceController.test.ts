import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceServiceSurfaceController } from "./useWorkspaceServiceSurfaceController";
import { installTestBridge } from "../../test/bridge";

const mocks = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

describe("useWorkspaceServiceSurfaceController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installTestBridge({ invoke: mocks.invokeMock });
  });

  it("exposes updater commands and the shared notice surface", () => {
    const showNotice = vi.fn();
    mocks.invokeMock.mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useWorkspaceServiceSurfaceController({ showNotice })
    );

    expect(result.current).toEqual({
      showNotice,
      checkForAppUpdate: expect.any(Function),
      installAvailableAppUpdate: expect.any(Function),
    });
  });
});
