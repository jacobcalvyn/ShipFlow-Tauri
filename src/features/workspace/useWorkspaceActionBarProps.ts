import { ComponentProps } from "react";
import { SheetActionBar } from "../sheet/components/SheetActionBar";

type UseWorkspaceActionBarPropsOptions = {
  loadedCount: ComponentProps<typeof SheetActionBar>["loadedCount"];
  totalShipmentCount: ComponentProps<typeof SheetActionBar>["totalShipmentCount"];
  loadingCount: ComponentProps<typeof SheetActionBar>["loadingCount"];
  retrackableRowsCount: number;
  retryFailedRowsCount: number;
  deleteAllArmed: boolean;
  exportableRowsCount: number;
  activeFilterCount: ComponentProps<typeof SheetActionBar>["activeFilterCount"];
  selectedRowCount: number;
  deleteSelectedArmed: boolean;
  ignoredHiddenFilterCount: ComponentProps<typeof SheetActionBar>["ignoredHiddenFilterCount"];
  columnShortcuts: ComponentProps<typeof SheetActionBar>["columnShortcuts"];
  retrackAllRows: ComponentProps<typeof SheetActionBar>["onRetrackAll"];
  retryFailedRows: ComponentProps<typeof SheetActionBar>["onRetryFailedRows"];
  exportCsv: ComponentProps<typeof SheetActionBar>["onExportCsv"];
  copyAllTrackingIds: ComponentProps<typeof SheetActionBar>["onCopyAllIds"];
  deleteAllRows: ComponentProps<typeof SheetActionBar>["onDeleteAllRows"];
  clearSelection: ComponentProps<typeof SheetActionBar>["onClearSelection"];
  transferSelectedIdsToNewSheet: ComponentProps<typeof SheetActionBar>["onTransferSelectedIdsToNewSheet"];
  appendTargetSheets: ComponentProps<typeof SheetActionBar>["targetSheetOptions"];
  transferSelectedIdsToExistingSheet: ComponentProps<typeof SheetActionBar>["onTransferSelectedIdsToSheet"];
  clearAllFilters: ComponentProps<typeof SheetActionBar>["onClearFilter"];
  copySelectedTrackingIds: ComponentProps<typeof SheetActionBar>["onCopySelectedIds"];
  deleteSelectedRows: ComponentProps<typeof SheetActionBar>["onDeleteSelectedRows"];
  clearHiddenFilters: ComponentProps<typeof SheetActionBar>["onClearHiddenFilters"];
  scrollToColumn: ComponentProps<typeof SheetActionBar>["onScrollToColumn"];
  beginSelectedIdsDrag: NonNullable<ComponentProps<typeof SheetActionBar>["onStartSelectedIdsDrag"]>;
  endSelectedIdsDrag: NonNullable<ComponentProps<typeof SheetActionBar>["onEndSelectedIdsDrag"]>;
};

export function useWorkspaceActionBarProps({
  loadedCount,
  totalShipmentCount,
  loadingCount,
  retrackableRowsCount,
  retryFailedRowsCount,
  deleteAllArmed,
  exportableRowsCount,
  activeFilterCount,
  selectedRowCount,
  deleteSelectedArmed,
  ignoredHiddenFilterCount,
  columnShortcuts,
  retrackAllRows,
  retryFailedRows,
  exportCsv,
  copyAllTrackingIds,
  deleteAllRows,
  clearSelection,
  transferSelectedIdsToNewSheet,
  appendTargetSheets,
  transferSelectedIdsToExistingSheet,
  clearAllFilters,
  copySelectedTrackingIds,
  deleteSelectedRows,
  clearHiddenFilters,
  scrollToColumn,
  beginSelectedIdsDrag,
  endSelectedIdsDrag,
}: UseWorkspaceActionBarPropsOptions): ComponentProps<typeof SheetActionBar> {
  return {
    loadedCount,
    totalShipmentCount,
    loadingCount,
    retrackableRowsCount,
    retryFailedRowsCount,
    deleteAllArmed,
    exportableRowsCount,
    activeFilterCount,
    selectedRowCount,
    deleteSelectedArmed,
    ignoredHiddenFilterCount,
    columnShortcuts,
    onRetrackAll: retrackAllRows,
    onRetryFailedRows: retryFailedRows,
    onExportCsv: exportCsv,
    onCopyAllIds: copyAllTrackingIds,
    onDeleteAllRows: deleteAllRows,
    onClearSelection: clearSelection,
    onTransferSelectedIdsToNewSheet: transferSelectedIdsToNewSheet,
    targetSheetOptions: appendTargetSheets,
    onTransferSelectedIdsToSheet: transferSelectedIdsToExistingSheet,
    onClearFilter: clearAllFilters,
    onCopySelectedIds: copySelectedTrackingIds,
    onDeleteSelectedRows: deleteSelectedRows,
    onClearHiddenFilters: clearHiddenFilters,
    onScrollToColumn: scrollToColumn,
    onStartSelectedIdsDrag: beginSelectedIdsDrag,
    onEndSelectedIdsDrag: endSelectedIdsDrag,
  };
}
