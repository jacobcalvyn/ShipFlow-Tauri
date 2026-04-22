import { Dispatch, MutableRefObject, SetStateAction } from "react";
import { COLUMNS } from "../sheet/columns";
import { SheetState } from "../sheet/types";
import { useWorkspaceRuntimeCommandsController } from "./useWorkspaceRuntimeCommandsController";
import { useWorkspaceTableControllers } from "./useWorkspaceTableControllers";
import { WorkspaceState } from "./types";

type Notice = {
  tone: "success" | "error" | "info";
  message: string;
};

type ResizeState = {
  path: string;
  startX: number;
  startWidth: number;
} | null;

type UseWorkspaceInteractionRuntimeControllerOptions = {
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
  resizeStateRef: MutableRefObject<ResizeState>;
  sheetScrollRef: MutableRefObject<HTMLDivElement | null>;
  sheetScrollPositionsRef: MutableRefObject<Map<string, { left: number; top: number }>>;
  columnMenuRefs: MutableRefObject<Map<string, HTMLDivElement | null>>;
  highlightedColumnTimeoutRef: MutableRefObject<number | null>;
  highlightedColumnSheetIdRef: MutableRefObject<string | null>;
  activeFilterCount: number;
  allTrackingIds: string[];
  exportableRows: SheetState["rows"];
  retrackableRows: Array<{ key: string; value: string }>;
  retryFailedEntries: Array<{ key: string; value: string }>;
  selectedTrackingIds: string[];
  selectedVisibleRowKeys: string[];
  visibleColumns: ReadonlyArray<(typeof COLUMNS)[number]>;
  visibleColumnPathSet: Set<string>;
  visibleSelectableKeys: string[];
  effectiveColumnWidths: Record<string, number>;
  pinnedColumnSet: Set<string>;
  allVisibleSelected: boolean;
  showNotice: (notice: Notice) => void;
};

export function useWorkspaceInteractionRuntimeController({
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
  resizeStateRef,
  sheetScrollRef,
  sheetScrollPositionsRef,
  columnMenuRefs,
  highlightedColumnTimeoutRef,
  highlightedColumnSheetIdRef,
  activeFilterCount,
  allTrackingIds,
  exportableRows,
  retrackableRows,
  retryFailedEntries,
  selectedTrackingIds,
  selectedVisibleRowKeys,
  visibleColumns,
  visibleColumnPathSet,
  visibleSelectableKeys,
  effectiveColumnWidths,
  pinnedColumnSet,
  allVisibleSelected,
  showNotice,
}: UseWorkspaceInteractionRuntimeControllerOptions) {
  const runtimeCommands = useWorkspaceRuntimeCommandsController({
    activeSheet,
    activeSheetId,
    workspaceTabs,
    workspaceRef,
    setWorkspaceState,
    setHoveredColumn,
    updateActiveSheet,
    updateSheet,
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
  });

  const tableControllers = useWorkspaceTableControllers({
    activeSheet,
    activeSheetId,
    updateActiveSheet,
    updateSheet,
    resizeStateRef,
    sheetScrollRef,
    sheetScrollPositionsRef,
    columnMenuRefs,
    highlightedColumnTimeoutRef,
    highlightedColumnSheetIdRef,
    hasActiveFilters: activeFilterCount > 0,
    visibleSelectableKeys,
    selectedVisibleRowKeys,
    selectedTrackingIds,
    visibleColumnPathSet,
    effectiveColumnWidths,
    pinnedColumnSet,
    allVisibleSelected,
    fetchRow: runtimeCommands.fetchRow,
    copySelectedTrackingIds: runtimeCommands.copySelectedTrackingIds,
    showNotice,
  });

  return {
    ...runtimeCommands,
    ...tableControllers,
  };
}
