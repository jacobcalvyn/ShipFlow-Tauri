import { Dispatch, MutableRefObject, SetStateAction, useCallback } from "react";
import { writeClipboardText } from "../clipboard";
import { COLUMNS } from "../sheet/columns";
import { SheetState } from "../sheet/types";
import { useTrackingRuntimeController } from "../tracking/useTrackingRuntimeController";
import { useSelectionTransferController } from "./useSelectionTransferController";
import { useWorkspaceCommandsController } from "./useWorkspaceCommandsController";
import { WorkspaceState } from "./types";

type Notice = {
  tone: "success" | "error" | "info";
  message: string;
};

type UseWorkspaceRuntimeCommandsControllerOptions = {
  activeSheet: SheetState;
  activeSheetId: string;
  workspaceTabs: Array<{ id: string; name: string }>;
  workspaceRef: MutableRefObject<WorkspaceState>;
  setWorkspaceState: Dispatch<SetStateAction<WorkspaceState>>;
  updateActiveSheet: (updater: (sheetState: SheetState) => SheetState) => void;
  updateSheet: (sheetId: string, updater: (sheetState: SheetState) => SheetState) => void;
  setHoveredColumn: Dispatch<SetStateAction<number | null>>;
  deleteAllTimeoutRef: MutableRefObject<number | null>;
  deleteAllArmedSheetIdRef: MutableRefObject<string | null>;
  deleteSelectedTimeoutRef: MutableRefObject<number | null>;
  deleteSelectedArmedSheetIdRef: MutableRefObject<string | null>;
  deleteSelectedArmedSheetId: string | null;
  setDeleteSelectedArmedSheetId: Dispatch<SetStateAction<string | null>>;
  armDeleteAll: () => void;
  disarmDeleteAll: () => void;
  armDeleteSelected: () => void;
  disarmDeleteSelected: () => void;
  sheetScrollRef: MutableRefObject<HTMLDivElement | null>;
  sheetScrollPositionsRef: MutableRefObject<Map<string, { left: number; top: number }>>;
  highlightedColumnTimeoutRef: MutableRefObject<number | null>;
  highlightedColumnSheetIdRef: MutableRefObject<string | null>;
  allTrackingIds: string[];
  exportableRows: SheetState["rows"];
  retrackableRows: Array<{ key: string; value: string }>;
  retryFailedEntries: Array<{ key: string; value: string }>;
  selectedTrackingIds: string[];
  selectedVisibleRowKeys: string[];
  visibleColumns: ReadonlyArray<(typeof COLUMNS)[number]>;
  visibleColumnPathSet: Set<string>;
  showNotice: (notice: Notice) => void;
};

export function useWorkspaceRuntimeCommandsController({
  activeSheet,
  activeSheetId,
  workspaceTabs,
  workspaceRef,
  setWorkspaceState,
  updateActiveSheet,
  updateSheet,
  setHoveredColumn,
  deleteAllTimeoutRef,
  deleteAllArmedSheetIdRef,
  deleteSelectedTimeoutRef,
  deleteSelectedArmedSheetIdRef,
  deleteSelectedArmedSheetId,
  setDeleteSelectedArmedSheetId,
  armDeleteAll,
  disarmDeleteAll,
  armDeleteSelected,
  disarmDeleteSelected,
  sheetScrollRef,
  sheetScrollPositionsRef,
  highlightedColumnTimeoutRef,
  highlightedColumnSheetIdRef,
  allTrackingIds,
  exportableRows,
  retrackableRows,
  retryFailedEntries,
  selectedTrackingIds,
  selectedVisibleRowKeys,
  visibleColumns,
  visibleColumnPathSet,
  showNotice,
}: UseWorkspaceRuntimeCommandsControllerOptions) {
  const {
    abortRowTrackingWork,
    clearTrackingCell,
    fetchRow,
    forgetSheetTrackingRuntime,
    handleTrackingInputBlur,
    handleTrackingInputChange,
    handleTrackingInputPaste,
    invalidateSheetTrackingWork,
    runBulkPasteFetches,
  } = useTrackingRuntimeController({
    workspaceRef,
    updateSheet,
    disarmDeleteAll,
  });

  const focusFirstTrackingInput = useCallback(() => {
    window.requestAnimationFrame(() => {
      const firstInput =
        sheetScrollRef.current?.querySelector<HTMLInputElement>(
          "tbody .tracking-cell .sheet-input"
        ) ?? null;

      firstInput?.focus();
    });
  }, [sheetScrollRef]);

  const {
    appendTargetSheets,
    beginSelectedIdsDrag,
    dropSelectedIdsToExistingSheet,
    dropSelectedIdsToNewSheet,
    endSelectedIdsDrag,
    isSheetTransferDragActive,
    transferSelectedIdsToExistingSheet,
    transferSelectedIdsToNewSheet,
  } = useSelectionTransferController({
    activeSheetId,
    workspaceTabs,
    selectedTrackingIds,
    selectedVisibleRowKeys,
    workspaceRef,
    setWorkspaceState,
    setHoveredColumn,
    disarmDeleteAll,
    disarmDeleteSelected,
    abortRowTrackingWork,
    runBulkPasteFetches,
    showNotice,
  });

  const {
    activateSheet,
    clearAllFilters,
    clearHiddenFilters,
    clearSelection,
    copyAllTrackingIds,
    copySelectedTrackingIds,
    copyTrackingId,
    createSheet,
    deleteActiveSheet,
    deleteAllRows,
    deleteSelectedRows,
    duplicateSheet,
    exportCsv,
    renameActiveSheet,
    retrackAllRows,
    retryFailedRows,
  } = useWorkspaceCommandsController({
    activeSheetId,
    activeSheetDeleteAllArmed: activeSheet.deleteAllArmed,
    allTrackingIds,
    exportableRows,
    retrackableRows,
    retryFailedEntries,
    selectedTrackingIds,
    selectedVisibleRowKeys,
    deleteSelectedArmedSheetId,
    visibleColumns,
    visibleColumnPathSet,
    workspaceRef,
    sheetScrollPositionsRef,
    highlightedColumnTimeoutRef,
    highlightedColumnSheetIdRef,
    deleteAllTimeoutRef,
    deleteAllArmedSheetIdRef,
    deleteSelectedTimeoutRef,
    deleteSelectedArmedSheetIdRef,
    setDeleteSelectedArmedSheetId,
    setWorkspaceState,
    setHoveredColumn,
    updateActiveSheet,
    copyText: writeClipboardText,
    showNotice,
    armDeleteAll,
    disarmDeleteAll,
    armDeleteSelected,
    disarmDeleteSelected,
    focusFirstTrackingInput,
    abortRowTrackingWork,
    invalidateSheetTrackingWork,
    forgetSheetTrackingRuntime,
    runBulkPasteFetches,
  });

  return {
    clearTrackingCell,
    fetchRow,
    handleTrackingInputBlur,
    handleTrackingInputChange,
    handleTrackingInputPaste,
    appendTargetSheets,
    beginSelectedIdsDrag,
    dropSelectedIdsToExistingSheet,
    dropSelectedIdsToNewSheet,
    endSelectedIdsDrag,
    isSheetTransferDragActive,
    transferSelectedIdsToExistingSheet,
    transferSelectedIdsToNewSheet,
    activateSheet,
    clearAllFilters,
    clearHiddenFilters,
    clearSelection,
    copyAllTrackingIds,
    copySelectedTrackingIds,
    copyTrackingId,
    createSheet,
    deleteActiveSheet,
    deleteAllRows,
    deleteSelectedRows,
    duplicateSheet,
    exportCsv,
    invalidateSheetTrackingWork,
    renameActiveSheet,
    retrackAllRows,
    retryFailedRows,
    runBulkPasteFetches,
  };
}
