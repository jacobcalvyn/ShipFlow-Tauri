import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceRuntimeCommandsController } from "./useWorkspaceRuntimeCommandsController";

const mocks = vi.hoisted(() => ({
  useTrackingRuntimeControllerMock: vi.fn(),
  useSelectionTransferControllerMock: vi.fn(),
  useWorkspaceCommandsControllerMock: vi.fn(),
}));

vi.mock("../tracking/useTrackingRuntimeController", () => ({
  useTrackingRuntimeController: mocks.useTrackingRuntimeControllerMock,
}));

vi.mock("./useSelectionTransferController", () => ({
  useSelectionTransferController: mocks.useSelectionTransferControllerMock,
}));

vi.mock("./useWorkspaceCommandsController", () => ({
  useWorkspaceCommandsController: mocks.useWorkspaceCommandsControllerMock,
}));

describe("useWorkspaceRuntimeCommandsController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("wires tracking runtime, selection transfer, and workspace commands", () => {
    const activeSheet = { deleteAllArmed: false };
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
      sheetScrollRef: { current: null },
      sheetScrollPositionsRef: { current: new Map() },
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
      showNotice: vi.fn(),
    };
    const trackingRuntime = {
      abortRowTrackingWork: vi.fn(),
      clearTrackingCell: vi.fn(),
      fetchRow: vi.fn(),
      forgetSheetTrackingRuntime: vi.fn(),
      handleTrackingInputBlur: vi.fn(),
      handleTrackingInputChange: vi.fn(),
      handleTrackingInputPaste: vi.fn(),
      invalidateSheetTrackingWork: vi.fn(),
      runBulkPasteFetches: vi.fn(),
    };
    const selectionTransfer = {
      appendTargetSheets: [{ id: "sheet-2", name: "Sheet 2" }],
      beginSelectedIdsDrag: vi.fn(),
      dropSelectedIdsToExistingSheet: vi.fn(),
      dropSelectedIdsToNewSheet: vi.fn(),
      endSelectedIdsDrag: vi.fn(),
      isSheetTransferDragActive: true,
      transferSelectedIdsToExistingSheet: vi.fn(),
      transferSelectedIdsToNewSheet: vi.fn(),
    };
    const workspaceCommands = {
      activateSheet: vi.fn(),
      clearAllFilters: vi.fn(),
      clearHiddenFilters: vi.fn(),
      clearSelection: vi.fn(),
      copyAllTrackingIds: vi.fn(),
      copySelectedTrackingIds: vi.fn(),
      copyTrackingId: vi.fn(),
      createSheet: vi.fn(),
      deleteActiveSheet: vi.fn(),
      deleteAllRows: vi.fn(),
      deleteSelectedRows: vi.fn(),
      duplicateSheet: vi.fn(),
      exportCsv: vi.fn(),
      renameActiveSheet: vi.fn(),
      retrackAllRows: vi.fn(),
      retryFailedRows: vi.fn(),
    };

    mocks.useTrackingRuntimeControllerMock.mockReturnValue(trackingRuntime);
    mocks.useSelectionTransferControllerMock.mockReturnValue(selectionTransfer);
    mocks.useWorkspaceCommandsControllerMock.mockReturnValue(workspaceCommands);

    const { result } = renderHook(() =>
      useWorkspaceRuntimeCommandsController(options as never)
    );

    expect(mocks.useTrackingRuntimeControllerMock).toHaveBeenCalledWith({
      workspaceRef: options.workspaceRef,
      updateSheet: options.updateSheet,
      disarmDeleteAll: options.disarmDeleteAll,
    });
    expect(mocks.useSelectionTransferControllerMock).toHaveBeenCalledWith({
      activeSheetId: options.activeSheetId,
      workspaceTabs: options.workspaceTabs,
      selectedTrackingIds: options.selectedTrackingIds,
      selectedVisibleRowKeys: options.selectedVisibleRowKeys,
      workspaceRef: options.workspaceRef,
      setWorkspaceState: options.setWorkspaceState,
      setHoveredColumn: options.setHoveredColumn,
      disarmDeleteAll: options.disarmDeleteAll,
      disarmDeleteSelected: options.disarmDeleteSelected,
      abortRowTrackingWork: trackingRuntime.abortRowTrackingWork,
      runBulkPasteFetches: trackingRuntime.runBulkPasteFetches,
      showNotice: options.showNotice,
    });
    expect(mocks.useWorkspaceCommandsControllerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        activeSheetId: options.activeSheetId,
        activeSheetDeleteAllArmed: activeSheet.deleteAllArmed,
        allTrackingIds: options.allTrackingIds,
        copyText: expect.any(Function),
        showNotice: options.showNotice,
        focusFirstTrackingInput: expect.any(Function),
        abortRowTrackingWork: trackingRuntime.abortRowTrackingWork,
        invalidateSheetTrackingWork: trackingRuntime.invalidateSheetTrackingWork,
        forgetSheetTrackingRuntime: trackingRuntime.forgetSheetTrackingRuntime,
        runBulkPasteFetches: trackingRuntime.runBulkPasteFetches,
      })
    );
    expect(result.current).toEqual({
      clearTrackingCell: trackingRuntime.clearTrackingCell,
      fetchRow: trackingRuntime.fetchRow,
      handleTrackingInputBlur: trackingRuntime.handleTrackingInputBlur,
      handleTrackingInputChange: trackingRuntime.handleTrackingInputChange,
      handleTrackingInputPaste: trackingRuntime.handleTrackingInputPaste,
      invalidateSheetTrackingWork: trackingRuntime.invalidateSheetTrackingWork,
      runBulkPasteFetches: trackingRuntime.runBulkPasteFetches,
      ...selectionTransfer,
      ...workspaceCommands,
    });
  });
});
