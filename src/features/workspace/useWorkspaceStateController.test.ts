import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { createSheetInWorkspace } from "./actions";
import { useWorkspaceStateController } from "./useWorkspaceStateController";

describe("useWorkspaceStateController", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("updates workspaceRef synchronously across rapid sequential mutations", () => {
    const { result } = renderHook(() => useWorkspaceStateController());

    act(() => {
      const firstWorkspace = createSheetInWorkspace(
        result.current.workspaceRef.current
      );
      result.current.setWorkspaceState(firstWorkspace);

      const secondWorkspace = createSheetInWorkspace(
        result.current.workspaceRef.current
      );
      result.current.setWorkspaceState(secondWorkspace);
    });

    expect(result.current.workspaceState.sheetOrder).toHaveLength(3);
    expect(result.current.workspaceRef.current).toBe(
      result.current.workspaceState
    );
  });
});
