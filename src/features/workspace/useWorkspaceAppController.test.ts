import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceAppController } from "./useWorkspaceAppController";

const mocks = vi.hoisted(() => ({
  useWorkspaceStateControllerMock: vi.fn(),
  useWorkspaceShellSurfaceControllerMock: vi.fn(),
  useWorkspaceDeleteArmControllerMock: vi.fn(),
  useWorkspaceSheetViewModelMock: vi.fn(),
  useWorkspaceInteractionRefsMock: vi.fn(),
  useWorkspaceInteractionRuntimeControllerMock: vi.fn(),
  useWorkspaceShellViewControllerMock: vi.fn(),
  listEngineSheetsMock: vi.fn(),
}));

vi.mock("../workspace-engine/client", () => ({
  listEngineSheets: mocks.listEngineSheetsMock,
}));

vi.mock("./useWorkspaceStateController", () => ({
  useWorkspaceStateController: mocks.useWorkspaceStateControllerMock,
}));

vi.mock("./useWorkspaceShellSurfaceController", () => ({
  useWorkspaceShellSurfaceController:
    mocks.useWorkspaceShellSurfaceControllerMock,
}));

vi.mock("./useWorkspaceDeleteArmController", () => ({
  useWorkspaceDeleteArmController: mocks.useWorkspaceDeleteArmControllerMock,
}));

vi.mock("./useWorkspaceSheetViewModel", () => ({
  useWorkspaceSheetViewModel: mocks.useWorkspaceSheetViewModelMock,
}));

vi.mock("./useWorkspaceInteractionRefs", () => ({
  useWorkspaceInteractionRefs: mocks.useWorkspaceInteractionRefsMock,
}));

vi.mock("./useWorkspaceInteractionRuntimeController", () => ({
  useWorkspaceInteractionRuntimeController:
    mocks.useWorkspaceInteractionRuntimeControllerMock,
}));

vi.mock("./useWorkspaceShellViewController", () => ({
  useWorkspaceShellViewController: mocks.useWorkspaceShellViewControllerMock,
}));

describe("useWorkspaceAppController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listEngineSheetsMock.mockResolvedValue({
      type: "sheets",
      payload: [],
    });
  });

  it("orchestrates workspace composition and returns shell view props", () => {
    const state = {
      workspaceState: { activeSheetId: "sheet-1" },
      setWorkspaceState: vi.fn((updater) => {
        if (typeof updater === "function") {
          return updater(state.workspaceState);
        }

        return updater;
      }),
      activeSheet: { id: "sheet-1" },
      activeSheetId: "sheet-1",
      workspaceTabs: [{ id: "sheet-1", name: "Sheet 1" }],
      workspaceRef: { current: {} },
      updateActiveSheet: vi.fn(),
      updateSheet: vi.fn(),
    };
    const surface = {
      showActionNotice: vi.fn(),
      actionNotices: [],
      workspaceEngineSyncGeneration: 7,
    };
    const deleteArm = {
      deleteAllTimeoutRef: { current: null },
      deleteAllArmedSheetIdRef: { current: null },
      deleteSelectedTimeoutRef: { current: null },
      deleteSelectedArmedSheetIdRef: { current: null },
      deleteSelectedArmedSheetId: null,
      setDeleteSelectedArmedSheetId: vi.fn(),
      armDeleteAll: vi.fn(),
      disarmDeleteAll: vi.fn(),
      armDeleteSelected: vi.fn(),
      disarmDeleteSelected: vi.fn(),
    };
    const sheetViewModel = {
      allTrackingIds: ["ID-1"],
      exportableTableRows: [],
      rustExportRowsQuery: null,
      retrackableRows: [],
      retryFailedEntries: [],
      selectedEngineRowIds: ["engine-row-1"],
      selectedTrackingIds: ["ID-1"],
      selectedVisibleRowKeys: ["row-1"],
      visibleColumns: [],
      visibleColumnPathSet: new Set(["status"]),
      visibleSelectableKeys: ["row-1"],
      effectiveColumnWidths: { status: 120 },
      pinnedColumnSet: new Set(["trackingId"]),
      allVisibleSelected: false,
    };
    const interactionRefs = {
      setHoveredColumn: vi.fn(),
      resizeStateRef: { current: null },
      sheetScrollRef: { current: null },
      sheetScrollPositionsRef: { current: new Map() },
      columnMenuRefs: { current: new Map() },
      highlightedColumnTimeoutRef: { current: null },
      highlightedColumnSheetIdRef: { current: null },
      hoveredColumn: null,
    };
    const interactionRuntime = { createSheet: vi.fn() };
    const shellViewProps = {
      actionNotices: [],
      displayScale: "small",
      sheetTabsProps: {} as never,
      sheetActionBarProps: {} as never,
      sheetTableProps: {} as never,
      documentDialogsProps: {} as never,
    };

    mocks.useWorkspaceStateControllerMock.mockReturnValue(state);
    mocks.useWorkspaceShellSurfaceControllerMock.mockReturnValue(surface);
    mocks.useWorkspaceDeleteArmControllerMock.mockReturnValue(deleteArm);
    mocks.useWorkspaceSheetViewModelMock.mockReturnValue(sheetViewModel);
    mocks.useWorkspaceInteractionRefsMock.mockReturnValue(interactionRefs);
    mocks.useWorkspaceInteractionRuntimeControllerMock.mockReturnValue(
      interactionRuntime
    );
    mocks.useWorkspaceShellViewControllerMock.mockReturnValue(shellViewProps);

    const { result } = renderHook(() => useWorkspaceAppController());

    expect(mocks.useWorkspaceShellSurfaceControllerMock).toHaveBeenCalledWith({
      workspaceState: state.workspaceState,
      setWorkspaceState: state.setWorkspaceState,
    });
    expect(mocks.useWorkspaceDeleteArmControllerMock).toHaveBeenCalledWith({
      activeSheetId: state.activeSheetId,
      updateSheet: state.updateSheet,
    });
    expect(mocks.useWorkspaceSheetViewModelMock).toHaveBeenCalledWith(
      state.activeSheet,
      state.activeSheetId,
      surface.workspaceEngineSyncGeneration,
      0
    );
    expect(
      mocks.useWorkspaceInteractionRuntimeControllerMock
    ).toHaveBeenCalledWith({
      activeSheet: state.activeSheet,
      activeSheetId: state.activeSheetId,
      workspaceTabs: state.workspaceTabs,
      workspaceRef: state.workspaceRef,
      setWorkspaceState: state.setWorkspaceState,
      updateActiveSheet: state.updateActiveSheet,
      updateSheet: state.updateSheet,
      setHoveredColumn: interactionRefs.setHoveredColumn,
      deleteAllTimeoutRef: deleteArm.deleteAllTimeoutRef,
      deleteAllArmedSheetIdRef: deleteArm.deleteAllArmedSheetIdRef,
      deleteSelectedTimeoutRef: deleteArm.deleteSelectedTimeoutRef,
      deleteSelectedArmedSheetIdRef: deleteArm.deleteSelectedArmedSheetIdRef,
      deleteSelectedArmedSheetId: deleteArm.deleteSelectedArmedSheetId,
      setDeleteSelectedArmedSheetId: deleteArm.setDeleteSelectedArmedSheetId,
      armDeleteAll: deleteArm.armDeleteAll,
      disarmDeleteAll: deleteArm.disarmDeleteAll,
      armDeleteSelected: deleteArm.armDeleteSelected,
      disarmDeleteSelected: deleteArm.disarmDeleteSelected,
      resizeStateRef: interactionRefs.resizeStateRef,
      sheetScrollRef: interactionRefs.sheetScrollRef,
      sheetScrollPositionsRef: interactionRefs.sheetScrollPositionsRef,
      columnMenuRefs: interactionRefs.columnMenuRefs,
      highlightedColumnTimeoutRef: interactionRefs.highlightedColumnTimeoutRef,
      highlightedColumnSheetIdRef: interactionRefs.highlightedColumnSheetIdRef,
      allTrackingIds: sheetViewModel.allTrackingIds,
      exportableTableRows: sheetViewModel.exportableTableRows,
      rustExportRowsQuery: sheetViewModel.rustExportRowsQuery,
      retrackableRows: sheetViewModel.retrackableRows,
      retryFailedEntries: sheetViewModel.retryFailedEntries,
      selectedEngineRowIds: sheetViewModel.selectedEngineRowIds,
      selectedTrackingIds: sheetViewModel.selectedTrackingIds,
      selectedVisibleRowKeys: sheetViewModel.selectedVisibleRowKeys,
      visibleColumns: sheetViewModel.visibleColumns,
      visibleColumnPathSet: sheetViewModel.visibleColumnPathSet,
      visibleSelectableKeys: sheetViewModel.visibleSelectableKeys,
      effectiveColumnWidths: sheetViewModel.effectiveColumnWidths,
      pinnedColumnSet: sheetViewModel.pinnedColumnSet,
      allVisibleSelected: sheetViewModel.allVisibleSelected,
      showNotice: surface.showActionNotice,
      onWorkspaceEngineMutation: expect.any(Function),
    });
    expect(mocks.useWorkspaceShellViewControllerMock).toHaveBeenCalledWith({
      activeSheet: state.activeSheet,
      activeSheetId: state.activeSheetId,
      workspaceTabs: state.workspaceTabs,
      updateActiveSheet: state.updateActiveSheet,
      surface,
      deleteArm,
      sheetViewModel,
      interactionRefs,
      interactionRuntime,
    });
    expect(result.current).toEqual(shellViewProps);
  });
});
