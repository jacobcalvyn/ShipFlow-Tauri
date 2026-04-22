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
  importSourceModalKind: ComponentProps<typeof SheetActionBar>["importSourceModalKind"];
  importSourceDrafts: ComponentProps<typeof SheetActionBar>["importSourceDrafts"];
  importSourceLookupStates: ComponentProps<typeof SheetActionBar>["importSourceLookupStates"];
  openImportSourceModal: ComponentProps<typeof SheetActionBar>["onOpenImportSourceModal"];
  closeImportSourceModal: ComponentProps<typeof SheetActionBar>["onCloseImportSourceModal"];
  setImportSourceDraft: ComponentProps<typeof SheetActionBar>["onSetImportSourceDraft"];
  importBagTrackingIds: ComponentProps<typeof SheetActionBar>["onImportBagTrackingIds"];
  importManifestTrackingIds: ComponentProps<typeof SheetActionBar>["onImportManifestTrackingIds"];
  runImportSourceLookup: ComponentProps<typeof SheetActionBar>["onRunImportSourceLookup"];
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
  importSourceModalKind,
  importSourceDrafts,
  importSourceLookupStates,
  openImportSourceModal,
  closeImportSourceModal,
  setImportSourceDraft,
  importBagTrackingIds,
  importManifestTrackingIds,
  runImportSourceLookup,
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
    importSourceModalKind,
    importSourceDrafts,
    importSourceLookupStates,
    onOpenImportSourceModal: openImportSourceModal,
    onCloseImportSourceModal: closeImportSourceModal,
    onSetImportSourceDraft: setImportSourceDraft,
    onImportBagTrackingIds: importBagTrackingIds,
    onImportManifestTrackingIds: importManifestTrackingIds,
    onRunImportSourceLookup: runImportSourceLookup,
    onStartSelectedIdsDrag: beginSelectedIdsDrag,
    onEndSelectedIdsDrag: endSelectedIdsDrag,
  };
}
