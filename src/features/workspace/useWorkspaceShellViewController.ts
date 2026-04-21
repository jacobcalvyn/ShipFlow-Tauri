import { ComponentProps } from "react";
import { WorkspaceShellView } from "./components/WorkspaceShellView";
import { useWorkspaceActionBarProps } from "./useWorkspaceActionBarProps";
import { useWorkspaceDeleteArmController } from "./useWorkspaceDeleteArmController";
import { useWorkspaceDocumentDialogsProps } from "./useWorkspaceDocumentDialogsProps";
import { useWorkspaceInteractionRefs } from "./useWorkspaceInteractionRefs";
import { useWorkspaceInteractionRuntimeController } from "./useWorkspaceInteractionRuntimeController";
import { useWorkspaceSheetViewModel } from "./useWorkspaceSheetViewModel";
import { useWorkspaceShellSurfaceController } from "./useWorkspaceShellSurfaceController";
import { useWorkspaceStateController } from "./useWorkspaceStateController";
import { useWorkspaceTableProps } from "./useWorkspaceTableProps";
import { useWorkspaceTabsProps } from "./useWorkspaceTabsProps";

type UseWorkspaceShellViewControllerOptions = {
  activeSheet: ReturnType<typeof useWorkspaceStateController>["activeSheet"];
  activeSheetId: ReturnType<typeof useWorkspaceStateController>["activeSheetId"];
  workspaceTabs: ReturnType<typeof useWorkspaceStateController>["workspaceTabs"];
  surface: ReturnType<typeof useWorkspaceShellSurfaceController>;
  deleteArm: ReturnType<typeof useWorkspaceDeleteArmController>;
  sheetViewModel: ReturnType<typeof useWorkspaceSheetViewModel>;
  interactionRefs: ReturnType<typeof useWorkspaceInteractionRefs>;
  interactionRuntime: ReturnType<typeof useWorkspaceInteractionRuntimeController>;
};

export function useWorkspaceShellViewController({
  activeSheet,
  activeSheetId,
  workspaceTabs,
  surface,
  deleteArm,
  sheetViewModel,
  interactionRefs,
  interactionRuntime,
}: UseWorkspaceShellViewControllerOptions): ComponentProps<
  typeof WorkspaceShellView
> {
  const sheetTabsProps = useWorkspaceTabsProps({
    workspaceTabs,
    activeSheetId,
    effectiveDisplayScale: surface.effectiveDisplayScale,
    settingsOpenRequestToken: surface.settingsOpenRequestToken,
    recentDocumentItems: surface.recentDocumentItems,
    canUseAutosave: surface.canUseAutosave,
    isAutosaveActive: surface.isAutosaveActive,
    effectiveServiceConfig: surface.effectiveServiceConfig,
    apiServiceStatus: surface.apiServiceStatus,
    hasPendingServiceConfigChanges: surface.hasPendingServiceConfigChanges,
    toggleAutosave: surface.toggleAutosave,
    createNewWorkspaceDocument: surface.createNewWorkspaceDocument,
    openWorkspaceDocumentWithPicker: surface.openWorkspaceDocumentWithPicker,
    saveCurrentWorkspaceDocument: surface.saveCurrentWorkspaceDocument,
    saveWorkspaceDocumentAs: surface.saveWorkspaceDocumentAs,
    createNewWorkspaceWindow: surface.createNewWorkspaceWindow,
    openWorkspaceInNewWindow: surface.openWorkspaceInNewWindow,
    openShipFlowServiceApp: surface.openShipFlowServiceApp,
    openWorkspaceDocumentFromPath: surface.openWorkspaceDocumentFromPath,
    activateSheet: interactionRuntime.activateSheet,
    createSheet: interactionRuntime.createSheet,
    duplicateSheet: interactionRuntime.duplicateSheet,
    renameActiveSheet: interactionRuntime.renameActiveSheet,
    deleteActiveSheet: interactionRuntime.deleteActiveSheet,
    previewDisplayScale: surface.previewDisplayScale,
    previewServiceEnabled: surface.previewServiceEnabled,
    previewServiceMode: surface.previewServiceMode,
    previewServicePort: surface.previewServicePort,
    previewTrackingSource: surface.previewTrackingSource,
    previewExternalApiBaseUrl: surface.previewExternalApiBaseUrl,
    previewExternalApiAuthToken: surface.previewExternalApiAuthToken,
    previewAllowInsecureExternalApiHttp: surface.previewAllowInsecureExternalApiHttp,
    previewGenerateServiceToken: surface.previewGenerateServiceToken,
    previewRegenerateServiceToken: surface.previewRegenerateServiceToken,
    copyServiceEndpoint: surface.copyServiceEndpoint,
    copyServiceToken: surface.copyServiceToken,
    testExternalTrackingSource: surface.testExternalTrackingSource,
    confirmSettings: surface.confirmSettings,
    cancelSettingsPreview: surface.cancelSettingsPreview,
    isSheetTransferDragActive: interactionRuntime.isSheetTransferDragActive,
    dropSelectedIdsToExistingSheet: interactionRuntime.dropSelectedIdsToExistingSheet,
    dropSelectedIdsToNewSheet: interactionRuntime.dropSelectedIdsToNewSheet,
  });
  const sheetActionBarProps = useWorkspaceActionBarProps({
    loadedCount: sheetViewModel.loadedCount,
    totalShipmentCount: sheetViewModel.totalShipmentCount,
    loadingCount: sheetViewModel.loadingCount,
    retrackableRowsCount: sheetViewModel.retrackableRows.length,
    retryFailedRowsCount: sheetViewModel.retryFailedEntries.length,
    deleteAllArmed: activeSheet.deleteAllArmed,
    exportableRowsCount: sheetViewModel.exportableRows.length,
    activeFilterCount: sheetViewModel.activeFilterCount,
    selectedRowCount: sheetViewModel.selectedVisibleRowKeys.length,
    deleteSelectedArmed: deleteArm.deleteSelectedArmedSheetId === activeSheetId,
    ignoredHiddenFilterCount: sheetViewModel.ignoredHiddenFilterCount,
    columnShortcuts: sheetViewModel.columnShortcuts,
    retrackAllRows: interactionRuntime.retrackAllRows,
    retryFailedRows: interactionRuntime.retryFailedRows,
    exportCsv: interactionRuntime.exportCsv,
    copyAllTrackingIds: interactionRuntime.copyAllTrackingIds,
    deleteAllRows: interactionRuntime.deleteAllRows,
    clearSelection: interactionRuntime.clearSelection,
    transferSelectedIdsToNewSheet: interactionRuntime.transferSelectedIdsToNewSheet,
    appendTargetSheets: interactionRuntime.appendTargetSheets,
    transferSelectedIdsToExistingSheet: interactionRuntime.transferSelectedIdsToExistingSheet,
    clearAllFilters: interactionRuntime.clearAllFilters,
    copySelectedTrackingIds: interactionRuntime.copySelectedTrackingIds,
    deleteSelectedRows: interactionRuntime.deleteSelectedRows,
    clearHiddenFilters: interactionRuntime.clearHiddenFilters,
    scrollToColumn: interactionRuntime.scrollToColumn,
    beginSelectedIdsDrag: interactionRuntime.beginSelectedIdsDrag,
    endSelectedIdsDrag: interactionRuntime.endSelectedIdsDrag,
  });
  const sheetTableProps = useWorkspaceTableProps({
    activeSheetId,
    effectiveDisplayScale: surface.effectiveDisplayScale,
    displayedRows: sheetViewModel.displayedRows,
    visibleColumns: sheetViewModel.visibleColumns,
    hiddenColumns: sheetViewModel.hiddenColumns,
    effectiveColumnWidths: sheetViewModel.effectiveColumnWidths,
    pinnedColumnSet: sheetViewModel.pinnedColumnSet,
    pinnedLeftMap: sheetViewModel.pinnedLeftMap,
    hoveredColumn: interactionRefs.hoveredColumn,
    allVisibleSelected: sheetViewModel.allVisibleSelected,
    selectedRowKeySet: sheetViewModel.selectedRowKeySet,
    filters: activeSheet.filters,
    valueFilters: activeSheet.valueFilters,
    valueOptionsByPath: sheetViewModel.valueOptionsByPath,
    openColumnMenuPath: activeSheet.openColumnMenuPath,
    highlightedColumnPath: activeSheet.highlightedColumnPath,
    sheetScrollRef: interactionRefs.sheetScrollRef,
    handleSheetScroll: interactionRuntime.handleSheetScroll,
    getColumnSortDirection: interactionRuntime.getColumnSortDirection,
    setHoveredColumn: interactionRefs.setHoveredColumn,
    toggleVisibleSelection: interactionRuntime.toggleVisibleSelection,
    toggleRowSelection: interactionRuntime.toggleRowSelection,
    openSourceLink: interactionRuntime.openSourceLink,
    copyTrackingId: interactionRuntime.copyTrackingId,
    clearTrackingCell: interactionRuntime.clearTrackingCell,
    handleTrackingInputChange: interactionRuntime.handleTrackingInputChange,
    handleTrackingInputBlur: interactionRuntime.handleTrackingInputBlur,
    handleTrackingInputKeyDown: interactionRuntime.handleTrackingInputKeyDown,
    handleTrackingInputPaste: interactionRuntime.handleTrackingInputPaste,
    handleFilterChange: interactionRuntime.handleFilterChange,
    handleResizeStart: interactionRuntime.handleResizeStart,
    toggleColumnMenu: interactionRuntime.toggleColumnMenu,
    setColumnSort: interactionRuntime.setColumnSort,
    togglePinnedColumn: interactionRuntime.togglePinnedColumn,
    toggleColumnVisibility: interactionRuntime.toggleColumnVisibility,
    toggleColumnValueFilter: interactionRuntime.toggleColumnValueFilter,
    clearColumnValueFilter: interactionRuntime.clearColumnValueFilter,
    closeColumnMenu: interactionRuntime.closeColumnMenu,
    handleColumnMenuRef: interactionRuntime.handleColumnMenuRef,
  });
  const documentDialogsProps = useWorkspaceDocumentDialogsProps({
    documentDialogMode: surface.documentDialogMode,
    documentPathDraft: surface.documentPathDraft,
    pendingWindowCloseRequest: surface.pendingWindowCloseRequest,
    isResolvingWindowClose: surface.isResolvingWindowClose,
    documentMeta: surface.documentMeta,
    setDocumentPathDraft: surface.setDocumentPathDraft,
    closeDocumentDialog: surface.closeDocumentDialog,
    submitDocumentDialog: surface.submitDocumentDialog,
    cancelPendingWindowClose: surface.cancelPendingWindowClose,
    discardPendingWindowClose: surface.discardPendingWindowClose,
    saveAndCloseWindow: surface.saveAndCloseWindow,
  });

  return {
    actionNotices: surface.actionNotices,
    displayScale: surface.effectiveDisplayScale,
    sheetTabsProps,
    sheetActionBarProps,
    sheetTableProps,
    documentDialogsProps,
  };
}
