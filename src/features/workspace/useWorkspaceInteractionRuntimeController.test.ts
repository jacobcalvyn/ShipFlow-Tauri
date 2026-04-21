import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceInteractionRuntimeController } from "./useWorkspaceInteractionRuntimeController";

const mocks = vi.hoisted(() => ({
  useWorkspaceRuntimeCommandsControllerMock: vi.fn(),
  useWorkspaceTableControllersMock: vi.fn(),
}));

vi.mock("./useWorkspaceRuntimeCommandsController", () => ({
  useWorkspaceRuntimeCommandsController:
    mocks.useWorkspaceRuntimeCommandsControllerMock,
}));

vi.mock("./useWorkspaceTableControllers", () => ({
  useWorkspaceTableControllers: mocks.useWorkspaceTableControllersMock,
}));

describe("useWorkspaceInteractionRuntimeController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("wires runtime commands and table controllers together", () => {
    const activeSheet = {
      deleteAllArmed: false,
      openColumnMenuPath: "status",
      selectionFollowsVisibleRows: false,
      hiddenColumnPaths: [],
      pinnedColumnPaths: [],
    };
    const options = {
      activeSheet: activeSheet as never,
      activeSheetId: "sheet-1",
      workspaceTabs: [{ id: "sheet-1", name: "Sheet 1" }],
      workspaceRef: { current: {} } as never,
      setWorkspaceState: vi.fn(),
      updateActiveSheet: vi.fn(),
      updateSheet: vi.fn(),
      setHoveredColumn: vi.fn(),
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
      resizeStateRef: { current: null },
      sheetScrollRef: { current: null },
      sheetScrollPositionsRef: { current: new Map() },
      columnMenuRefs: { current: new Map() },
      highlightedColumnTimeoutRef: { current: null },
      highlightedColumnSheetIdRef: { current: null },
      allTrackingIds: ["ID-1"],
      exportableRows: [],
      retrackableRows: [],
      retryFailedEntries: [],
      selectedTrackingIds: ["ID-1"],
      selectedVisibleRowKeys: ["row-1"],
      visibleColumns: [],
      visibleColumnPathSet: new Set(["status"]),
      visibleSelectableKeys: ["row-1"],
      effectiveColumnWidths: { status: 120 },
      pinnedColumnSet: new Set(["trackingId"]),
      allVisibleSelected: false,
      showNotice: vi.fn(),
    };
    const runtimeCommands = {
      fetchRow: vi.fn(),
      copySelectedTrackingIds: vi.fn(),
      createSheet: vi.fn(),
    };
    const tableControllers = {
      handleSheetScroll: vi.fn(),
      toggleColumnMenu: vi.fn(),
    };

    mocks.useWorkspaceRuntimeCommandsControllerMock.mockReturnValue(
      runtimeCommands
    );
    mocks.useWorkspaceTableControllersMock.mockReturnValue(tableControllers);

    const { result } = renderHook(() =>
      useWorkspaceInteractionRuntimeController(options as never)
    );

    expect(mocks.useWorkspaceRuntimeCommandsControllerMock).toHaveBeenCalledWith({
      activeSheet,
      activeSheetId: options.activeSheetId,
      workspaceTabs: options.workspaceTabs,
      workspaceRef: options.workspaceRef,
      setWorkspaceState: options.setWorkspaceState,
      setHoveredColumn: options.setHoveredColumn,
      updateActiveSheet: options.updateActiveSheet,
      updateSheet: options.updateSheet,
      deleteAllTimeoutRef: options.deleteAllTimeoutRef,
      deleteAllArmedSheetIdRef: options.deleteAllArmedSheetIdRef,
      deleteSelectedTimeoutRef: options.deleteSelectedTimeoutRef,
      deleteSelectedArmedSheetIdRef: options.deleteSelectedArmedSheetIdRef,
      deleteSelectedArmedSheetId: options.deleteSelectedArmedSheetId,
      setDeleteSelectedArmedSheetId: options.setDeleteSelectedArmedSheetId,
      armDeleteAll: options.armDeleteAll,
      disarmDeleteAll: options.disarmDeleteAll,
      armDeleteSelected: options.armDeleteSelected,
      disarmDeleteSelected: options.disarmDeleteSelected,
      sheetScrollRef: options.sheetScrollRef,
      sheetScrollPositionsRef: options.sheetScrollPositionsRef,
      highlightedColumnTimeoutRef: options.highlightedColumnTimeoutRef,
      highlightedColumnSheetIdRef: options.highlightedColumnSheetIdRef,
      allTrackingIds: options.allTrackingIds,
      exportableRows: options.exportableRows,
      retrackableRows: options.retrackableRows,
      retryFailedEntries: options.retryFailedEntries,
      selectedTrackingIds: options.selectedTrackingIds,
      selectedVisibleRowKeys: options.selectedVisibleRowKeys,
      visibleColumns: options.visibleColumns,
      visibleColumnPathSet: options.visibleColumnPathSet,
      showNotice: options.showNotice,
    });
    expect(mocks.useWorkspaceTableControllersMock).toHaveBeenCalledWith({
      activeSheet,
      activeSheetId: options.activeSheetId,
      updateActiveSheet: options.updateActiveSheet,
      updateSheet: options.updateSheet,
      resizeStateRef: options.resizeStateRef,
      sheetScrollRef: options.sheetScrollRef,
      sheetScrollPositionsRef: options.sheetScrollPositionsRef,
      columnMenuRefs: options.columnMenuRefs,
      highlightedColumnTimeoutRef: options.highlightedColumnTimeoutRef,
      highlightedColumnSheetIdRef: options.highlightedColumnSheetIdRef,
      visibleSelectableKeys: options.visibleSelectableKeys,
      selectedVisibleRowKeys: options.selectedVisibleRowKeys,
      selectedTrackingIds: options.selectedTrackingIds,
      visibleColumnPathSet: options.visibleColumnPathSet,
      effectiveColumnWidths: options.effectiveColumnWidths,
      pinnedColumnSet: options.pinnedColumnSet,
      allVisibleSelected: options.allVisibleSelected,
      fetchRow: runtimeCommands.fetchRow,
      copySelectedTrackingIds: runtimeCommands.copySelectedTrackingIds,
      showNotice: options.showNotice,
    });
    expect(result.current).toEqual({
      ...runtimeCommands,
      ...tableControllers,
    });
  });
});
