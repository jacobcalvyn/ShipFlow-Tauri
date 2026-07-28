import { ComponentProps, useCallback } from "react";
import {
  setSheetAnalyticsChartTypeInSheet,
  setSheetAnalyticsColumnPathsInSheet,
  setSheetAnalyticsMetricAggregationInSheet,
  setSheetAnalyticsRowPathsInSheet,
  setSheetAnalyticsSourceScopeInSheet,
  setSheetAnalyticsValueMetricsInSheet,
  setSheetViewModeInSheet,
} from "../sheet/actions";
import {
  SheetAnalyticsChartType,
  SheetAnalyticsMetric,
  SheetAnalyticsMetricAggregation,
  SheetAnalyticsSourceScope,
  SheetState,
  SheetViewMode,
} from "../sheet/types";
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
  updateActiveSheet: (updater: (sheetState: SheetState) => SheetState) => void;
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
  updateActiveSheet,
  surface,
  deleteArm,
  sheetViewModel,
  interactionRefs,
  interactionRuntime,
}: UseWorkspaceShellViewControllerOptions): ComponentProps<
  typeof WorkspaceShellView
> {
  const setActiveSheetMode = useCallback(
    (mode: SheetViewMode) => {
      updateActiveSheet((current) => setSheetViewModeInSheet(current, mode));
    },
    [updateActiveSheet]
  );

  const setAnalyticsSourceScope = useCallback(
    (sourceScope: SheetAnalyticsSourceScope) => {
      updateActiveSheet((current) =>
        setSheetAnalyticsSourceScopeInSheet(current, sourceScope)
      );
    },
    [updateActiveSheet]
  );

  const setAnalyticsRowPaths = useCallback(
    (rowPaths: string[]) => {
      updateActiveSheet((current) =>
        setSheetAnalyticsRowPathsInSheet(current, rowPaths)
      );
    },
    [updateActiveSheet]
  );

  const setAnalyticsColumnPaths = useCallback(
    (columnPaths: string[]) => {
      updateActiveSheet((current) =>
        setSheetAnalyticsColumnPathsInSheet(current, columnPaths)
      );
    },
    [updateActiveSheet]
  );

  const setAnalyticsValueMetrics = useCallback(
    (valueMetrics: SheetAnalyticsMetric[]) => {
      updateActiveSheet((current) =>
        setSheetAnalyticsValueMetricsInSheet(current, valueMetrics)
      );
    },
    [updateActiveSheet]
  );

  const setAnalyticsMetricAggregation = useCallback(
    (metric: SheetAnalyticsMetric, aggregation: SheetAnalyticsMetricAggregation) => {
      updateActiveSheet((current) =>
        setSheetAnalyticsMetricAggregationInSheet(current, metric, aggregation)
      );
    },
    [updateActiveSheet]
  );

  const setAnalyticsChartType = useCallback(
    (chartType: SheetAnalyticsChartType) => {
      updateActiveSheet((current) =>
        setSheetAnalyticsChartTypeInSheet(current, chartType)
      );
    },
    [updateActiveSheet]
  );

  const sheetTabsProps = useWorkspaceTabsProps({
    workspaceTabs,
    activeSheetId,
    effectiveDisplayScale: surface.effectiveDisplayScale,
    hasPendingSettingsChanges: surface.hasPendingSettingsChanges,
    settingsOpenRequestToken: surface.settingsOpenRequestToken,
    recentDocumentItems: surface.recentDocumentItems,
    canUseAutosave: surface.canUseAutosave,
    isAutosaveActive: surface.isAutosaveActive,
    toggleAutosave: surface.toggleAutosave,
    createNewWorkspaceDocument: surface.createNewWorkspaceDocument,
    openWorkspaceDocumentWithPicker: surface.openWorkspaceDocumentWithPicker,
    saveCurrentWorkspaceDocument: surface.saveCurrentWorkspaceDocument,
    saveWorkspaceDocumentAs: surface.saveWorkspaceDocumentAs,
    createNewWorkspaceWindow: surface.createNewWorkspaceWindow,
    openWorkspaceInNewWindow: surface.openWorkspaceInNewWindow,
    openWorkspaceDocumentFromPath: surface.openWorkspaceDocumentFromPath,
    activateSheet: interactionRuntime.activateSheet,
    createSheet: interactionRuntime.createSheet,
    duplicateSheet: interactionRuntime.duplicateSheet,
    renameActiveSheet: interactionRuntime.renameActiveSheet,
    deleteActiveSheet: interactionRuntime.deleteActiveSheet,
    previewDisplayScale: surface.previewDisplayScale,
    confirmSettings: surface.confirmSettings,
    cancelSettingsPreview: surface.cancelSettingsPreview,
    isSheetTransferDragActive: interactionRuntime.isSheetTransferDragActive,
    dropSelectedIdsToExistingSheet: interactionRuntime.dropSelectedIdsToExistingSheet,
    dropSelectedIdsToNewSheet: interactionRuntime.dropSelectedIdsToNewSheet,
  });
  const rustActionRowCount = sheetViewModel.rustExportRowsQuery
    ? sheetViewModel.totalShipmentCount
    : null;
  const actionTrackingRowsCount =
    rustActionRowCount ?? sheetViewModel.retrackableRows.length;
  const exportableRowsCount =
    rustActionRowCount !== null && sheetViewModel.selectedVisibleRowKeys.length === 0
      ? rustActionRowCount
      : sheetViewModel.exportableTableRows.length;
  const sheetActionBarProps = useWorkspaceActionBarProps({
    loadedCount: sheetViewModel.loadedCount,
    totalShipmentCount: sheetViewModel.totalShipmentCount,
    loadingCount: sheetViewModel.loadingCount,
    retrackableRowsCount: actionTrackingRowsCount,
    retryFailedRowsCount: sheetViewModel.retryFailedEntries.length,
    deleteAllArmed: activeSheet.deleteAllArmed,
    exportableRowsCount,
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
    importSourceModalKind: activeSheet.importSourceModalKind,
    importSourceDrafts: activeSheet.importSourceDrafts,
    importSourceLookupStates: activeSheet.importSourceLookupStates,
    openImportSourceModal: interactionRuntime.openImportSourceModal,
    closeImportSourceModal: interactionRuntime.closeImportSourceModal,
    setImportSourceDraft: interactionRuntime.setImportSourceDraft,
    importBagTrackingIds: interactionRuntime.importBagTrackingIds,
    importManifestTrackingIds: interactionRuntime.importManifestTrackingIds,
    runImportSourceLookup: interactionRuntime.runImportSourceLookup,
    beginSelectedIdsDrag: interactionRuntime.beginSelectedIdsDrag,
    endSelectedIdsDrag: interactionRuntime.endSelectedIdsDrag,
  });
  const sheetTableProps = useWorkspaceTableProps({
    activeSheetId,
    effectiveDisplayScale: surface.effectiveDisplayScale,
    displayedTableRows: sheetViewModel.displayedTableRows,
    displayedRowWindow: sheetViewModel.displayedRowWindow,
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
    requestVisibleRowWindow: sheetViewModel.requestVisibleRowWindow,
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
    setColumnValueFilterSelection: interactionRuntime.setColumnValueFilterSelection,
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
    activeSheetMode: activeSheet.activeMode,
    sheetTabsProps,
    sheetModeSwitchProps: {
      activeMode: activeSheet.activeMode,
      onModeChange: setActiveSheetMode,
    },
    sheetActionBarProps,
    sheetAnalyticsViewProps: {
      analytics: activeSheet.analytics,
      groupByOptions: sheetViewModel.analyticsGroupByOptions,
      metricOptions: sheetViewModel.analyticsMetricOptions,
      summary: sheetViewModel.analyticsSummary,
      onSourceScopeChange: setAnalyticsSourceScope,
      onRowPathsChange: setAnalyticsRowPaths,
      onColumnPathsChange: setAnalyticsColumnPaths,
      onValueMetricsChange: setAnalyticsValueMetrics,
      onMetricAggregationChange: setAnalyticsMetricAggregation,
      onChartTypeChange: setAnalyticsChartType,
    },
    sheetTableProps,
    documentDialogsProps,
  };
}
