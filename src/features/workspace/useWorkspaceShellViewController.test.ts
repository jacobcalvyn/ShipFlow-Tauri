import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceShellViewController } from "./useWorkspaceShellViewController";

const COD_TOTAL_COLUMN_PATH = "detail.billing_detail.cod_info.total_cod";

const mocks = vi.hoisted(() => ({
  useWorkspaceTabsPropsMock: vi.fn(),
  useWorkspaceActionBarPropsMock: vi.fn(),
  useWorkspaceTablePropsMock: vi.fn(),
  useWorkspaceDocumentDialogsPropsMock: vi.fn(),
}));

vi.mock("./useWorkspaceTabsProps", () => ({
  useWorkspaceTabsProps: mocks.useWorkspaceTabsPropsMock,
}));

vi.mock("./useWorkspaceActionBarProps", () => ({
  useWorkspaceActionBarProps: mocks.useWorkspaceActionBarPropsMock,
}));

vi.mock("./useWorkspaceTableProps", () => ({
  useWorkspaceTableProps: mocks.useWorkspaceTablePropsMock,
}));

vi.mock("./useWorkspaceDocumentDialogsProps", () => ({
  useWorkspaceDocumentDialogsProps: mocks.useWorkspaceDocumentDialogsPropsMock,
}));

describe("useWorkspaceShellViewController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps surface, view model, refs, and interaction runtime into shell view props", () => {
    const activeSheet = {
      activeMode: "workspace",
      analytics: {
        sourceScope: "filtered_rows",
        groupByPaths: ["status_akhir.status"],
        metrics: ["count"],
        chartType: "bar",
      },
      deleteAllArmed: false,
      filters: { status: "loaded" },
      valueFilters: { courier: ["JNE"] },
      openColumnMenuPath: "status",
      highlightedColumnPath: "trackingId",
      importSourceModalKind: "bag",
      importSourceDrafts: {
        bag: "PID123",
        manifest: "",
      },
      importSourceLookupStates: {
        bag: {
          loading: false,
          rawResponse: "{\"nomor_kantung\":\"PID123\"}",
          error: "",
          trackingIds: ["P260000000001"],
        },
        manifest: {
          loading: false,
          rawResponse: "",
          error: "",
          trackingIds: [],
        },
      },
    };
    const surface = {
      actionNotices: [{ tone: "info", message: "Ready" }],
      effectiveDisplayScale: "small",
      settingsOpenRequestToken: 3,
      recentDocumentItems: [{ path: "/tmp/demo.shipflow", name: "demo.shipflow" }],
      canUseAutosave: true,
      isAutosaveActive: true,
      effectiveServiceConfig: { enabled: false },
      apiServiceStatus: { status: "stopped" },
      hasPendingServiceConfigChanges: false,
      toggleAutosave: vi.fn(),
      createNewWorkspaceDocument: vi.fn(),
      openWorkspaceDocumentWithPicker: vi.fn(),
      saveCurrentWorkspaceDocument: vi.fn(),
      saveWorkspaceDocumentAs: vi.fn(),
      createNewWorkspaceWindow: vi.fn(),
      openWorkspaceInNewWindow: vi.fn(),
      openShipFlowServiceApp: vi.fn(),
      openWorkspaceDocumentFromPath: vi.fn(),
      previewDisplayScale: vi.fn(),
      previewServiceEnabled: vi.fn(),
      previewServiceMode: vi.fn(),
      previewServicePort: vi.fn(),
      previewTrackingSource: vi.fn(),
      previewExternalApiBaseUrl: vi.fn(),
      previewExternalApiAuthToken: vi.fn(),
      previewAllowInsecureExternalApiHttp: vi.fn(),
      previewGenerateServiceToken: vi.fn(),
      previewRegenerateServiceToken: vi.fn(),
      copyServiceEndpoint: vi.fn(),
      copyServiceToken: vi.fn(),
      testExternalTrackingSource: vi.fn(),
      confirmSettings: vi.fn(),
      cancelSettingsPreview: vi.fn(),
      documentDialogMode: "saveAs",
      documentPathDraft: "/tmp/demo.shipflow",
      pendingWindowCloseRequest: { documentName: "demo.shipflow" },
      isResolvingWindowClose: false,
      documentMeta: { name: "demo.shipflow" },
      setDocumentPathDraft: vi.fn(),
      closeDocumentDialog: vi.fn(),
      submitDocumentDialog: vi.fn(),
      cancelPendingWindowClose: vi.fn(),
      discardPendingWindowClose: vi.fn(),
      saveAndCloseWindow: vi.fn(),
    };
    const deleteArm = {
      deleteSelectedArmedSheetId: "sheet-1",
    };
    const sheetViewModel = {
      loadedCount: 1,
      totalShipmentCount: 2,
      loadingCount: 0,
      retrackableRows: [{ key: "row-1", value: "A" }],
      retryFailedEntries: [{ key: "row-2", value: "B" }],
      exportableRows: [{ key: "row-1" }],
      activeFilterCount: 1,
      selectedVisibleRowKeys: ["row-1"],
      ignoredHiddenFilterCount: 0,
      columnShortcuts: [{ path: "status", label: "Status" }],
      displayedRows: [{ key: "row-1" }],
      visibleColumns: [{ path: "status" }],
      hiddenColumns: [{ path: "courier" }],
      effectiveColumnWidths: { status: 120 },
      pinnedColumnSet: new Set(["trackingId"]),
      pinnedLeftMap: new Map([["trackingId", 0]]),
      allVisibleSelected: false,
      selectedRowKeySet: new Set(["row-1"]),
      valueOptionsByPath: { courier: [{ value: "JNE", count: 1 }] },
      analyticsGroupByOptions: [
        { path: "status_akhir.status", label: "Status Akhir" },
      ],
      analyticsMetricOptions: [
        { key: "count", label: "Jumlah Kiriman", format: "number" },
        { key: COD_TOTAL_COLUMN_PATH, label: "Total COD", format: "currency" },
      ],
      analyticsSummary: {
        sourceRowCount: 1,
        loadedRowCount: 1,
        selectedRowCount: 1,
        totalCod: 0,
        totalMetricValue: 1,
        groupByPaths: ["status_akhir.status"],
        groupByLabel: "Status Akhir",
        groupByLabels: ["Status Akhir"],
        metrics: [{ key: "count", label: "Jumlah Kiriman", format: "number" }],
        primaryMetric: "count",
        primaryMetricOption: { key: "count", label: "Jumlah Kiriman", format: "number" },
        rows: [
          {
            label: "INVEHICLE",
            groupValues: ["INVEHICLE"],
            count: 1,
            codTotal: 0,
            metricValues: { count: 1, [COD_TOTAL_COLUMN_PATH]: 0 },
            metricValue: 1,
            share: 100,
          },
        ],
      },
    };
    const interactionRefs = {
      hoveredColumn: 2,
      sheetScrollRef: { current: null },
      setHoveredColumn: vi.fn(),
    };
    const interactionRuntime = {
      activateSheet: vi.fn(),
      createSheet: vi.fn(),
      duplicateSheet: vi.fn(),
      renameActiveSheet: vi.fn(),
      deleteActiveSheet: vi.fn(),
      isSheetTransferDragActive: true,
      dropSelectedIdsToExistingSheet: vi.fn(),
      dropSelectedIdsToNewSheet: vi.fn(),
      retrackAllRows: vi.fn(),
      retryFailedRows: vi.fn(),
      exportCsv: vi.fn(),
      copyAllTrackingIds: vi.fn(),
      deleteAllRows: vi.fn(),
      clearSelection: vi.fn(),
      transferSelectedIdsToNewSheet: vi.fn(),
      appendTargetSheets: [{ id: "sheet-2", name: "Sheet 2" }],
      transferSelectedIdsToExistingSheet: vi.fn(),
      clearAllFilters: vi.fn(),
      copySelectedTrackingIds: vi.fn(),
      deleteSelectedRows: vi.fn(),
      clearHiddenFilters: vi.fn(),
      scrollToColumn: vi.fn(),
      openImportSourceModal: vi.fn(),
      closeImportSourceModal: vi.fn(),
      setImportSourceDraft: vi.fn(),
      importBagTrackingIds: vi.fn(),
      importManifestTrackingIds: vi.fn(),
      runImportSourceLookup: vi.fn(),
      beginSelectedIdsDrag: vi.fn(),
      endSelectedIdsDrag: vi.fn(),
      handleSheetScroll: vi.fn(),
      getColumnSortDirection: vi.fn(),
      toggleVisibleSelection: vi.fn(),
      toggleRowSelection: vi.fn(),
      openSourceLink: vi.fn(),
      copyTrackingId: vi.fn(),
      clearTrackingCell: vi.fn(),
      handleTrackingInputChange: vi.fn(),
      handleTrackingInputBlur: vi.fn(),
      handleTrackingInputKeyDown: vi.fn(),
      handleTrackingInputPaste: vi.fn(),
      handleFilterChange: vi.fn(),
      handleResizeStart: vi.fn(),
      toggleColumnMenu: vi.fn(),
      setColumnSort: vi.fn(),
      togglePinnedColumn: vi.fn(),
      toggleColumnVisibility: vi.fn(),
      toggleColumnValueFilter: vi.fn(),
      setColumnValueFilterSelection: vi.fn(),
      clearColumnValueFilter: vi.fn(),
      closeColumnMenu: vi.fn(),
      handleColumnMenuRef: vi.fn(),
    };
    const sheetTabsProps = { id: "tabs-props" };
    const sheetActionBarProps = { id: "action-bar-props" };
    const sheetTableProps = { id: "table-props" };
    const documentDialogsProps = { id: "dialogs-props" };
    const updateActiveSheet = vi.fn();

    mocks.useWorkspaceTabsPropsMock.mockReturnValue(sheetTabsProps);
    mocks.useWorkspaceActionBarPropsMock.mockReturnValue(sheetActionBarProps);
    mocks.useWorkspaceTablePropsMock.mockReturnValue(sheetTableProps);
    mocks.useWorkspaceDocumentDialogsPropsMock.mockReturnValue(
      documentDialogsProps
    );

    const { result } = renderHook(() =>
      useWorkspaceShellViewController({
        activeSheet: activeSheet as never,
        activeSheetId: "sheet-1",
        workspaceTabs: [
          {
            id: "sheet-1",
            name: "Sheet 1",
            color: "slate",
            icon: "sheet",
            isActive: true,
          },
        ],
        updateActiveSheet,
        surface: surface as never,
        deleteArm: deleteArm as never,
        sheetViewModel: sheetViewModel as never,
        interactionRefs: interactionRefs as never,
        interactionRuntime: interactionRuntime as never,
      })
    );

    expect(mocks.useWorkspaceTabsPropsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceTabs: [
          {
            id: "sheet-1",
            name: "Sheet 1",
            color: "slate",
            icon: "sheet",
            isActive: true,
          },
        ],
        activeSheetId: "sheet-1",
        effectiveDisplayScale: surface.effectiveDisplayScale,
        recentDocumentItems: surface.recentDocumentItems,
        activateSheet: interactionRuntime.activateSheet,
        createSheet: interactionRuntime.createSheet,
      })
    );
    expect(mocks.useWorkspaceActionBarPropsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        loadedCount: sheetViewModel.loadedCount,
        deleteSelectedArmed: true,
        retrackAllRows: interactionRuntime.retrackAllRows,
        appendTargetSheets: interactionRuntime.appendTargetSheets,
        importSourceModalKind: activeSheet.importSourceModalKind,
        importSourceDrafts: activeSheet.importSourceDrafts,
        importSourceLookupStates: activeSheet.importSourceLookupStates,
        openImportSourceModal: interactionRuntime.openImportSourceModal,
        closeImportSourceModal: interactionRuntime.closeImportSourceModal,
        setImportSourceDraft: interactionRuntime.setImportSourceDraft,
        importBagTrackingIds: interactionRuntime.importBagTrackingIds,
        importManifestTrackingIds: interactionRuntime.importManifestTrackingIds,
        runImportSourceLookup: interactionRuntime.runImportSourceLookup,
      })
    );
    expect(mocks.useWorkspaceTablePropsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        activeSheetId: "sheet-1",
        displayedRows: sheetViewModel.displayedRows,
        hoveredColumn: interactionRefs.hoveredColumn,
        filters: activeSheet.filters,
        handleSheetScroll: interactionRuntime.handleSheetScroll,
        setHoveredColumn: interactionRefs.setHoveredColumn,
      })
    );
    expect(mocks.useWorkspaceDocumentDialogsPropsMock).toHaveBeenCalledWith({
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
    expect(result.current).toEqual({
      actionNotices: surface.actionNotices,
      displayScale: surface.effectiveDisplayScale,
      activeSheetMode: activeSheet.activeMode,
      sheetTabsProps,
      sheetModeSwitchProps: {
        activeMode: activeSheet.activeMode,
        onModeChange: expect.any(Function),
      },
      sheetActionBarProps,
      sheetAnalyticsViewProps: {
        analytics: activeSheet.analytics,
        groupByOptions: sheetViewModel.analyticsGroupByOptions,
        metricOptions: sheetViewModel.analyticsMetricOptions,
        summary: sheetViewModel.analyticsSummary,
        onSourceScopeChange: expect.any(Function),
        onGroupByPathsChange: expect.any(Function),
        onMetricsChange: expect.any(Function),
        onMetricAggregationChange: expect.any(Function),
        onChartTypeChange: expect.any(Function),
      },
      sheetTableProps,
      documentDialogsProps,
    });
  });
});
