import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceTableControllers } from "./useWorkspaceTableControllers";

const mocks = vi.hoisted(() => ({
  useWorkspaceTableShellControllerMock: vi.fn(),
  useWorkspaceTableInteractionControllerMock: vi.fn(),
}));

vi.mock("./useWorkspaceTableShellController", () => ({
  useWorkspaceTableShellController: mocks.useWorkspaceTableShellControllerMock,
}));

vi.mock("./useWorkspaceTableInteractionController", () => ({
  useWorkspaceTableInteractionController:
    mocks.useWorkspaceTableInteractionControllerMock,
}));

describe("useWorkspaceTableControllers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("composes table shell and interaction controllers", () => {
    const activeSheet = {
      openColumnMenuPath: "status",
      selectionFollowsVisibleRows: false,
      hiddenColumnPaths: ["courier"],
      pinnedColumnPaths: ["trackingId"],
    };
    const options = {
      activeSheet: activeSheet as never,
      activeSheetId: "sheet-1",
      updateActiveSheet: vi.fn(),
      updateSheet: vi.fn(),
      resizeStateRef: { current: null },
      sheetScrollRef: { current: null },
      sheetScrollPositionsRef: { current: new Map() },
      columnMenuRefs: { current: new Map() },
      highlightedColumnTimeoutRef: { current: null },
      highlightedColumnSheetIdRef: { current: null },
      visibleSelectableKeys: ["row-1"],
      selectedVisibleRowKeys: ["row-1"],
      selectedTrackingIds: ["ID-1"],
      visibleColumnPathSet: new Set(["status"]),
      effectiveColumnWidths: { status: 120 },
      pinnedColumnSet: new Set(["trackingId"]),
      allVisibleSelected: false,
      fetchRow: vi.fn(),
      copySelectedTrackingIds: vi.fn(),
      showNotice: vi.fn(),
    };
    const shellController = {
      closeColumnMenu: vi.fn(),
      handleColumnMenuRef: vi.fn(),
      handleSheetScroll: vi.fn(),
      scrollToColumn: vi.fn(),
      toggleColumnMenu: vi.fn(),
      toggleColumnVisibility: vi.fn(),
      togglePinnedColumn: vi.fn(),
    };
    const interactionController = {
      clearColumnValueFilter: vi.fn(),
      getColumnSortDirection: vi.fn(),
      handleFilterChange: vi.fn(),
      handleResizeStart: vi.fn(),
      handleTrackingInputKeyDown: vi.fn(),
      openSourceLink: vi.fn(),
      setColumnSort: vi.fn(),
      toggleColumnValueFilter: vi.fn(),
      toggleRowSelection: vi.fn(),
      toggleVisibleSelection: vi.fn(),
    };

    mocks.useWorkspaceTableShellControllerMock.mockReturnValue(shellController);
    mocks.useWorkspaceTableInteractionControllerMock.mockReturnValue(
      interactionController
    );

    const { result } = renderHook(() =>
      useWorkspaceTableControllers(options as never)
    );

    expect(mocks.useWorkspaceTableShellControllerMock).toHaveBeenCalledWith({
      activeSheetId: options.activeSheetId,
      activeSheetOpenColumnMenuPath: activeSheet.openColumnMenuPath,
      activeSheetSelectionFollowsVisibleRows:
        activeSheet.selectionFollowsVisibleRows,
      hiddenColumnPaths: activeSheet.hiddenColumnPaths,
      pinnedColumnPaths: activeSheet.pinnedColumnPaths,
      visibleSelectableKeys: options.visibleSelectableKeys,
      selectedVisibleRowKeys: options.selectedVisibleRowKeys,
      selectedTrackingIds: options.selectedTrackingIds,
      visibleColumnPathSet: options.visibleColumnPathSet,
      effectiveColumnWidths: options.effectiveColumnWidths,
      pinnedColumnSet: options.pinnedColumnSet,
      sheetScrollRef: options.sheetScrollRef,
      sheetScrollPositionsRef: options.sheetScrollPositionsRef,
      columnMenuRefs: options.columnMenuRefs,
      highlightedColumnTimeoutRef: options.highlightedColumnTimeoutRef,
      highlightedColumnSheetIdRef: options.highlightedColumnSheetIdRef,
      updateActiveSheet: options.updateActiveSheet,
      updateSheet: options.updateSheet,
      copySelectedTrackingIds: options.copySelectedTrackingIds,
    });
    expect(mocks.useWorkspaceTableInteractionControllerMock).toHaveBeenCalledWith({
      activeSheet,
      allVisibleSelected: options.allVisibleSelected,
      visibleSelectableKeys: options.visibleSelectableKeys,
      resizeStateRef: options.resizeStateRef,
      sheetScrollRef: options.sheetScrollRef,
      updateActiveSheet: options.updateActiveSheet,
      fetchRow: options.fetchRow,
      showNotice: options.showNotice,
    });
    expect(result.current).toEqual({
      ...shellController,
      ...interactionController,
    });
  });
});
