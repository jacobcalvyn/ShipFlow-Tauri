import { Dispatch, MutableRefObject, SetStateAction } from "react";
import { COLUMNS } from "../sheet/columns";
import { SheetState } from "../sheet/types";
import { useWorkspaceTableInteractionController } from "./useWorkspaceTableInteractionController";
import { useWorkspaceTableShellController } from "./useWorkspaceTableShellController";

type Notice = {
  tone: "success" | "error" | "info";
  message: string;
};

type ResizeState = {
  path: string;
  startX: number;
  startWidth: number;
} | null;

type UseWorkspaceTableControllersOptions = {
  activeSheet: SheetState;
  activeSheetId: string;
  updateActiveSheet: (updater: (sheetState: SheetState) => SheetState) => void;
  updateSheet: (sheetId: string, updater: (sheetState: SheetState) => SheetState) => void;
  resizeStateRef: MutableRefObject<ResizeState>;
  sheetScrollRef: MutableRefObject<HTMLDivElement | null>;
  sheetScrollPositionsRef: MutableRefObject<Map<string, { left: number; top: number }>>;
  columnMenuRefs: MutableRefObject<Map<string, HTMLDivElement | null>>;
  highlightedColumnTimeoutRef: MutableRefObject<number | null>;
  highlightedColumnSheetIdRef: MutableRefObject<string | null>;
  visibleSelectableKeys: string[];
  selectedVisibleRowKeys: string[];
  selectedTrackingIds: string[];
  visibleColumnPathSet: Set<string>;
  effectiveColumnWidths: Record<string, number>;
  pinnedColumnSet: Set<string>;
  allVisibleSelected: boolean;
  fetchRow: Parameters<typeof useWorkspaceTableInteractionController>[0]["fetchRow"];
  copySelectedTrackingIds: Parameters<typeof useWorkspaceTableShellController>[0]["copySelectedTrackingIds"];
  showNotice: (notice: Notice) => void;
};

export function useWorkspaceTableControllers({
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
  visibleSelectableKeys,
  selectedVisibleRowKeys,
  selectedTrackingIds,
  visibleColumnPathSet,
  effectiveColumnWidths,
  pinnedColumnSet,
  allVisibleSelected,
  fetchRow,
  copySelectedTrackingIds,
  showNotice,
}: UseWorkspaceTableControllersOptions) {
  const {
    closeColumnMenu,
    handleColumnMenuRef,
    handleSheetScroll,
    scrollToColumn,
    toggleColumnMenu,
    toggleColumnVisibility,
    togglePinnedColumn,
  } = useWorkspaceTableShellController({
    activeSheetId,
    activeSheetOpenColumnMenuPath: activeSheet.openColumnMenuPath,
    activeSheetSelectionFollowsVisibleRows: activeSheet.selectionFollowsVisibleRows,
    hiddenColumnPaths: activeSheet.hiddenColumnPaths,
    pinnedColumnPaths: activeSheet.pinnedColumnPaths,
    visibleSelectableKeys,
    selectedVisibleRowKeys,
    selectedTrackingIds,
    visibleColumnPathSet,
    effectiveColumnWidths,
    pinnedColumnSet,
    sheetScrollRef,
    sheetScrollPositionsRef,
    columnMenuRefs,
    highlightedColumnTimeoutRef,
    highlightedColumnSheetIdRef,
    updateActiveSheet,
    updateSheet,
    copySelectedTrackingIds,
  });

  const {
    clearColumnValueFilter,
    getColumnSortDirection,
    handleFilterChange,
    handleResizeStart,
    handleTrackingInputKeyDown,
    openSourceLink,
    setColumnSort,
    toggleColumnValueFilter,
    toggleRowSelection,
    toggleVisibleSelection,
  } = useWorkspaceTableInteractionController({
    activeSheet,
    allVisibleSelected,
    visibleSelectableKeys,
    resizeStateRef,
    sheetScrollRef,
    updateActiveSheet,
    fetchRow,
    showNotice,
  });

  return {
    closeColumnMenu,
    handleColumnMenuRef,
    handleSheetScroll,
    scrollToColumn,
    toggleColumnMenu,
    toggleColumnVisibility,
    togglePinnedColumn,
    clearColumnValueFilter,
    getColumnSortDirection,
    handleFilterChange,
    handleResizeStart,
    handleTrackingInputKeyDown,
    openSourceLink,
    setColumnSort,
    toggleColumnValueFilter,
    toggleRowSelection,
    toggleVisibleSelection,
  };
}
