import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getSheetAnalyticsGroupByOptions,
  getSheetAnalyticsMetricOptions,
  type SheetAnalyticsSummary,
} from "../sheet/analytics";
import {
  createEmptySheetAnalyticsSummary,
  createRustPivotQueryFromSheetAnalytics,
  createSheetAnalyticsSummaryFromRustChart,
  createSheetAnalyticsSummaryFromRustPivot,
} from "../sheet/rust-analytics-adapter";
import { createRustSheetRowsQuery } from "../sheet/rust-row-query-adapter";
import {
  createSheetTableRowsFromRustWindow,
  createSheetTableRowsFromSheetRows,
  getAllTableRowTrackingIds,
  getExportableTableRows,
  getLoadedTableRowCount,
  getLoadingTableRowCount,
  getRetrackableTableRows,
  getRetryFailedTableRowEntries,
  getSelectedTableRowEngineRowIds,
  getSelectedTableRowKeySet,
  getSelectedTableRowTrackingIds,
  getSelectedVisibleTableRowKeys,
  getTableRowTrackingColumnAutoWidth,
  getTotalTableRowTrackingCount,
  getVisibleSelectableTableRowKeys,
  type SheetTableRow,
} from "../sheet/table-row-view";
import { canUseColumnValueFilter } from "../sheet/columns";
import {
  getActiveFilterCount,
  getColumnShortcuts,
  getDisplayedRows,
  getEffectiveColumnWidths,
  getHiddenColumns,
  getIgnoredHiddenFilterCount,
  getNonEmptyRows,
  getPinnedColumnSet,
  getPinnedLeftMap,
  getValueOptionsForOpenColumn,
  getVisibleColumnPathSet,
  getVisibleColumns,
} from "../sheet/selectors";
import { ColumnDefinition, SheetState, ValueFilterOption } from "../sheet/types";
import {
  queryChart,
  queryPivot,
  querySheetFieldValues,
  querySheetRows,
  type SheetFieldValuesQuery,
  type SheetRowsQuery,
  type SheetRowWindow,
} from "../workspace-engine/client";
import {
  createEmptyRustRowWindow,
  createRustPivotFilters,
  createRustRowWindowSignature,
  createValueOptionsFromRustFieldValues,
  deleteRustDisplayedRowsCacheEntry,
  excludeCurrentFieldValueFilters,
  mergeRustRowWindowRuntimeState,
  RUST_EXPORT_ROW_WINDOW_LIMIT,
  RUST_ROW_WINDOW_LIMIT,
  RUST_VALUE_OPTIONS_LIMIT,
  setRustDisplayedRowsCacheEntry,
  type RustDisplayedRowsCacheEntry,
} from "./rust-sheet-view-model-state";

export function useWorkspaceSheetViewModel(
  activeSheet: SheetState,
  activeSheetId?: string,
  workspaceEngineSyncGeneration = 0,
  workspaceEngineCacheGeneration = workspaceEngineSyncGeneration
) {
  const legacyNonEmptyRows = useMemo(
    () => getNonEmptyRows(activeSheet.rows),
    [activeSheet.rows]
  );

  const visibleColumns = useMemo(() => getVisibleColumns(activeSheet), [activeSheet]);

  const visibleColumnPathSet = useMemo(
    () => getVisibleColumnPathSet(visibleColumns),
    [visibleColumns]
  );

  const pinnedColumnSet = useMemo(
    () => getPinnedColumnSet(activeSheet),
    [activeSheet]
  );

  const activeFilterCount = useMemo(
    () => getActiveFilterCount(activeSheet, visibleColumnPathSet),
    [activeSheet, visibleColumnPathSet]
  );

  const ignoredHiddenFilterCount = useMemo(
    () => getIgnoredHiddenFilterCount(activeSheet, activeFilterCount),
    [activeFilterCount, activeSheet]
  );

  const legacyDisplayedRows = useMemo(
    () =>
      getDisplayedRows(
        activeSheet,
        legacyNonEmptyRows,
        visibleColumns,
        activeFilterCount
      ),
    [activeFilterCount, legacyNonEmptyRows, activeSheet, visibleColumns]
  );
  const [rustDisplayedRowsByQuery, setRustDisplayedRowsByQuery] = useState<
    Record<string, RustDisplayedRowsCacheEntry>
  >({});
  const [failedRustDisplayedRowsQueryKey, setFailedRustDisplayedRowsQueryKey] =
    useState<string | null>(null);
  const [rustValueOptionsState, setRustValueOptionsState] = useState<{
    queryKey: string;
    field: string;
    options: ValueFilterOption[];
  } | null>(null);
  const [rustUnfilteredTotalCountState, setRustUnfilteredTotalCountState] =
    useState<{
      queryKey: string;
      totalCount: number;
    } | null>(null);
  const [rustRowWindowRequest, setRustRowWindowRequest] = useState<{
    baseKey: string | null;
    offset: number;
  }>({
    baseKey: null,
    offset: 0,
  });
  const clearRustDisplayedRowsQuery = useCallback((queryKey: string) => {
    setRustDisplayedRowsByQuery((current) =>
      deleteRustDisplayedRowsCacheEntry(current, queryKey)
    );
  }, []);
  const rustSheetRowsBaseQuery = useMemo(() => {
    if (!activeSheetId) {
      return null;
    }

    return createRustSheetRowsQuery({
      sheetId: activeSheetId,
      sheetState: activeSheet,
      nonEmptyRows: legacyNonEmptyRows,
      visibleColumns,
      visibleColumnPathSet,
      offset: 0,
      limit: RUST_ROW_WINDOW_LIMIT,
      allowNonWorkspaceMode:
        activeSheet.activeMode === "analytics" &&
        activeSheet.analytics.sourceScope === "selected_rows",
    });
  }, [
    activeSheet,
    activeSheetId,
    legacyNonEmptyRows,
    visibleColumnPathSet,
    visibleColumns,
  ]);
  const rustSheetRowsBaseQueryKey = useMemo(
    () => (rustSheetRowsBaseQuery ? JSON.stringify(rustSheetRowsBaseQuery) : null),
    [rustSheetRowsBaseQuery]
  );
  const rustSheetRowsQueryOffset =
    rustRowWindowRequest.baseKey === rustSheetRowsBaseQueryKey
      ? rustRowWindowRequest.offset
      : 0;
  const rustSheetRowsQuery = useMemo(
    () =>
      rustSheetRowsBaseQuery
        ? {
            ...rustSheetRowsBaseQuery,
            offset: rustSheetRowsQueryOffset,
          }
        : null,
    [rustSheetRowsBaseQuery, rustSheetRowsQueryOffset]
  );
  const rustExportRowsQuery = useMemo(
    () =>
      rustSheetRowsBaseQuery
        ? {
            ...rustSheetRowsBaseQuery,
            offset: 0,
            limit: RUST_EXPORT_ROW_WINDOW_LIMIT,
          }
        : null,
    [rustSheetRowsBaseQuery]
  );
  const rustValueOptionsQuery = useMemo<{
    query: SheetFieldValuesQuery;
    column: ColumnDefinition;
  } | null>(() => {
    if (!rustSheetRowsBaseQuery || !activeSheet.openColumnMenuPath) {
      return null;
    }

    const column = visibleColumns.find(
      (item) => item.path === activeSheet.openColumnMenuPath
    );
    if (!column || !canUseColumnValueFilter(column)) {
      return null;
    }

    const valueFilters = excludeCurrentFieldValueFilters(
      rustSheetRowsBaseQuery.valueFilters,
      activeSheet.openColumnMenuPath
    );

    return {
      column,
      query: {
        sheetId: rustSheetRowsBaseQuery.sheetId,
        field: activeSheet.openColumnMenuPath,
        filters: rustSheetRowsBaseQuery.filters,
        ...(valueFilters.length > 0 ? { valueFilters } : {}),
        limit: RUST_VALUE_OPTIONS_LIMIT,
      },
    };
  }, [activeSheet.openColumnMenuPath, rustSheetRowsBaseQuery, visibleColumns]);
  const rustValueOptionsQueryKey = useMemo(
    () =>
      rustValueOptionsQuery
        ? JSON.stringify({
            query: rustValueOptionsQuery.query,
            workspaceEngineSyncGeneration,
          })
        : null,
    [rustValueOptionsQuery, workspaceEngineSyncGeneration]
  );
  const rustSheetRowsCacheKey = useMemo(
    () => (rustSheetRowsQuery ? JSON.stringify(rustSheetRowsQuery) : null),
    [rustSheetRowsQuery]
  );
  const rustSheetRowsQueryKey = useMemo(
    () =>
      rustSheetRowsQuery
        ? JSON.stringify({
            query: rustSheetRowsQuery,
            workspaceEngineSyncGeneration,
          })
        : null,
    [rustSheetRowsQuery, workspaceEngineSyncGeneration]
  );
  const needsUnfilteredRustTotalCount =
    activeFilterCount > 0 || ignoredHiddenFilterCount > 0;
  const rustUnfilteredTotalRowsQuery = useMemo<SheetRowsQuery | null>(() => {
    if (
      !activeSheetId ||
      activeSheet.activeMode !== "workspace" ||
      !needsUnfilteredRustTotalCount
    ) {
      return null;
    }

    return {
      sheetId: activeSheetId,
      offset: 0,
      limit: 1,
      filters: [],
      sort: [],
    };
  }, [activeSheet.activeMode, activeSheetId, needsUnfilteredRustTotalCount]);
  const rustUnfilteredTotalRowsQueryKey = useMemo(
    () =>
      rustUnfilteredTotalRowsQuery
        ? JSON.stringify({
            query: rustUnfilteredTotalRowsQuery,
            workspaceEngineCacheGeneration,
          })
        : null,
    [rustUnfilteredTotalRowsQuery, workspaceEngineCacheGeneration]
  );
  const requestVisibleRowWindow = useCallback(
    (range: { startIndex: number; endIndex: number }) => {
      if (!rustSheetRowsBaseQueryKey) {
        return;
      }

      const nextOffset = Math.max(
        0,
        Math.floor(range.startIndex / RUST_ROW_WINDOW_LIMIT) * RUST_ROW_WINDOW_LIMIT
      );
      if (nextOffset === rustSheetRowsQueryOffset) {
        return;
      }

      setRustRowWindowRequest((current) =>
        current.baseKey === rustSheetRowsBaseQueryKey && current.offset === nextOffset
          ? current
          : {
              baseKey: rustSheetRowsBaseQueryKey,
              offset: nextOffset,
            }
      );
    },
    [rustSheetRowsBaseQueryKey, rustSheetRowsQueryOffset]
  );

  useEffect(() => {
    if (!rustSheetRowsQuery || !rustSheetRowsQueryKey || !rustSheetRowsCacheKey) {
      return undefined;
    }

    let cancelled = false;
    querySheetRows(rustSheetRowsQuery)
      .then((response) => {
        if (cancelled) {
          return;
        }
        if (!response?.payload) {
          setFailedRustDisplayedRowsQueryKey(rustSheetRowsCacheKey);
          clearRustDisplayedRowsQuery(rustSheetRowsCacheKey);
          return;
        }

        const responseGeneration = workspaceEngineCacheGeneration;
        setFailedRustDisplayedRowsQueryKey((current) =>
          current === rustSheetRowsCacheKey ? null : current
        );
        setRustDisplayedRowsByQuery((current) => {
          const existing = current[rustSheetRowsCacheKey];
          if (existing && existing.generation > responseGeneration) {
            return current;
          }

          const window =
            existing?.generation === responseGeneration
              ? mergeRustRowWindowRuntimeState(existing.window, response.payload)
              : response.payload;
          const signature = createRustRowWindowSignature(window);

          return existing?.signature === signature &&
            existing?.generation === responseGeneration
            ? current
            : setRustDisplayedRowsCacheEntry(current, rustSheetRowsCacheKey, {
                generation: responseGeneration,
                signature,
                window,
              });
        });
      })
      .catch(() => {
        if (!cancelled) {
          setFailedRustDisplayedRowsQueryKey(rustSheetRowsCacheKey);
          clearRustDisplayedRowsQuery(rustSheetRowsCacheKey);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    clearRustDisplayedRowsQuery,
    rustSheetRowsCacheKey,
    rustSheetRowsQueryKey,
    workspaceEngineCacheGeneration,
  ]);

  useEffect(() => {
    if (!rustUnfilteredTotalRowsQuery || !rustUnfilteredTotalRowsQueryKey) {
      setRustUnfilteredTotalCountState((current) =>
        current === null ? current : null
      );
      return undefined;
    }

    let cancelled = false;
    querySheetRows(rustUnfilteredTotalRowsQuery)
      .then((response) => {
        if (cancelled) {
          return;
        }

        setRustUnfilteredTotalCountState({
          queryKey: rustUnfilteredTotalRowsQueryKey,
          totalCount: response.payload?.totalCount ?? 0,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setRustUnfilteredTotalCountState((current) =>
            current?.queryKey === rustUnfilteredTotalRowsQueryKey ? null : current
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [rustUnfilteredTotalRowsQuery, rustUnfilteredTotalRowsQueryKey]);

  useEffect(() => {
    if (!rustValueOptionsQuery || !rustValueOptionsQueryKey) {
      setRustValueOptionsState((current) => (current === null ? current : null));
      return undefined;
    }

    let cancelled = false;
    querySheetFieldValues(rustValueOptionsQuery.query)
      .then((response) => {
        if (cancelled) {
          return;
        }

        setRustValueOptionsState({
          queryKey: rustValueOptionsQueryKey,
          field: rustValueOptionsQuery.query.field,
          options: createValueOptionsFromRustFieldValues(
            rustValueOptionsQuery.column,
            response.payload
          ),
        });
      })
      .catch(() => {
        if (!cancelled) {
          setRustValueOptionsState((current) => (current === null ? current : null));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [rustValueOptionsQuery, rustValueOptionsQueryKey]);

  const activeRustDisplayedRowsState =
    rustSheetRowsCacheKey && failedRustDisplayedRowsQueryKey !== rustSheetRowsCacheKey
      ? (rustDisplayedRowsByQuery[rustSheetRowsCacheKey] ?? null)
      : null;
  const failedRustDisplayedRowsWindow = useMemo(
    () =>
      rustSheetRowsQuery &&
      rustSheetRowsCacheKey &&
      failedRustDisplayedRowsQueryKey === rustSheetRowsCacheKey
        ? createEmptyRustRowWindow(rustSheetRowsQuery)
        : null,
    [failedRustDisplayedRowsQueryKey, rustSheetRowsCacheKey, rustSheetRowsQuery]
  );
  const pendingRustDisplayedRowsWindow = useMemo(
    () =>
      rustSheetRowsQuery &&
      !activeRustDisplayedRowsState &&
      !failedRustDisplayedRowsWindow
        ? createEmptyRustRowWindow(rustSheetRowsQuery)
        : null,
    [
      activeRustDisplayedRowsState,
      failedRustDisplayedRowsWindow,
      rustSheetRowsQuery,
    ]
  );
  const authoritativeRustDisplayedRowsWindow =
    activeRustDisplayedRowsState?.window ??
    failedRustDisplayedRowsWindow ??
    pendingRustDisplayedRowsWindow;
  const previousRustProjectedTableRowsRef = useRef<{
    windowKey: string;
    rows: SheetTableRow[];
  } | null>(null);
  const legacyDisplayedTableRows = useMemo(
    () => createSheetTableRowsFromSheetRows(legacyDisplayedRows),
    [legacyDisplayedRows]
  );
  const rustProjectedTableRows = useMemo(() => {
    if (!authoritativeRustDisplayedRowsWindow) {
      previousRustProjectedTableRowsRef.current = null;
      return null;
    }

    const windowKey = [
      authoritativeRustDisplayedRowsWindow.sheetId,
      authoritativeRustDisplayedRowsWindow.offset,
      authoritativeRustDisplayedRowsWindow.limit,
    ].join(":");
    const previousRows =
      previousRustProjectedTableRowsRef.current?.windowKey === windowKey
        ? previousRustProjectedTableRowsRef.current.rows
        : [];
    const rows = createSheetTableRowsFromRustWindow(
      authoritativeRustDisplayedRowsWindow,
      activeSheet.rows,
      previousRows
    );

    previousRustProjectedTableRowsRef.current = { windowKey, rows };
    return rows;
  }, [activeSheet.rows, authoritativeRustDisplayedRowsWindow]);
  const displayedTableRows = rustProjectedTableRows ?? legacyDisplayedTableRows;
  const displayedRowWindow = authoritativeRustDisplayedRowsWindow;

  const retrackableRows = useMemo(
    () => getRetrackableTableRows(displayedTableRows),
    [displayedTableRows]
  );

  const totalShipmentCount = useMemo(
    () => {
      const displayedCount = getTotalTableRowTrackingCount(displayedTableRows);
      const displayedTotal = displayedRowWindow
        ? Math.max(displayedRowWindow.totalCount, displayedCount)
        : displayedCount;
      const unfilteredTotal =
        rustUnfilteredTotalCountState?.queryKey === rustUnfilteredTotalRowsQueryKey
          ? rustUnfilteredTotalCountState.totalCount
          : 0;

      return Math.max(displayedTotal, unfilteredTotal, legacyNonEmptyRows.length);
    },
    [
      displayedRowWindow?.totalCount,
      displayedTableRows,
      legacyNonEmptyRows.length,
      rustUnfilteredTotalCountState,
      rustUnfilteredTotalRowsQueryKey,
    ]
  );

  const trackingColumnAutoWidth = useMemo(
    () => getTableRowTrackingColumnAutoWidth(displayedTableRows),
    [displayedTableRows]
  );

  const effectiveColumnWidths = useMemo(
    () =>
      getEffectiveColumnWidths(
        visibleColumns,
        activeSheet.columnWidths,
        trackingColumnAutoWidth
      ),
    [activeSheet.columnWidths, trackingColumnAutoWidth, visibleColumns]
  );

  const pinnedLeftMap = useMemo(
    () => getPinnedLeftMap(visibleColumns, pinnedColumnSet, effectiveColumnWidths),
    [effectiveColumnWidths, pinnedColumnSet, visibleColumns]
  );

  const legacyValueOptionsByPath = useMemo(
    () =>
      getValueOptionsForOpenColumn(
        legacyNonEmptyRows,
        visibleColumns,
        activeSheet.openColumnMenuPath
      ),
    [activeSheet.openColumnMenuPath, legacyNonEmptyRows, visibleColumns]
  );
  const valueOptionsByPath = useMemo(() => {
    if (
      rustValueOptionsState &&
      rustValueOptionsState.queryKey === rustValueOptionsQueryKey
    ) {
      return {
        [rustValueOptionsState.field]: rustValueOptionsState.options,
      };
    }

    return legacyValueOptionsByPath;
  }, [legacyValueOptionsByPath, rustValueOptionsQueryKey, rustValueOptionsState]);

  const visibleSelectableKeys = useMemo(
    () => getVisibleSelectableTableRowKeys(displayedTableRows),
    [displayedTableRows]
  );

  const selectedVisibleRowKeys = useMemo(
    () =>
      getSelectedVisibleTableRowKeys(
        displayedTableRows,
        activeSheet.selectedRowKeys,
        activeSheet.rows
      ),
    [activeSheet.rows, activeSheet.selectedRowKeys, displayedTableRows]
  );

  const selectedRowKeySet = useMemo(
    () =>
      getSelectedTableRowKeySet(
        displayedTableRows,
        activeSheet.selectedRowKeys,
        activeSheet.rows
      ),
    [activeSheet.rows, activeSheet.selectedRowKeys, displayedTableRows]
  );

  const allVisibleSelected =
    visibleSelectableKeys.length > 0 &&
    visibleSelectableKeys.every((key) => selectedRowKeySet.has(key));

  const selectedTrackingIds = useMemo(
    () => getSelectedTableRowTrackingIds(displayedTableRows, selectedVisibleRowKeys),
    [displayedTableRows, selectedVisibleRowKeys]
  );
  const selectedEngineRowIds = useMemo(
    () => getSelectedTableRowEngineRowIds(displayedTableRows, selectedVisibleRowKeys),
    [displayedTableRows, selectedVisibleRowKeys]
  );

  const allTrackingIds = useMemo(
    () => getAllTableRowTrackingIds(displayedTableRows),
    [displayedTableRows]
  );

  const exportableTableRows = useMemo(
    () => getExportableTableRows(displayedTableRows, selectedVisibleRowKeys),
    [displayedTableRows, selectedVisibleRowKeys]
  );

  const retryFailedEntries = useMemo(
    () => getRetryFailedTableRowEntries(displayedTableRows),
    [displayedTableRows]
  );

  const hiddenColumns = useMemo(
    () => getHiddenColumns(activeSheet),
    [activeSheet]
  );

  const loadedCount = useMemo(
    () => getLoadedTableRowCount(displayedTableRows),
    [displayedTableRows]
  );

  const loadingCount = useMemo(
    () => getLoadingTableRowCount(displayedTableRows),
    [displayedTableRows]
  );
  const columnShortcuts = useMemo(
    () => getColumnShortcuts(visibleColumnPathSet),
    [visibleColumnPathSet]
  );

  const analyticsGroupByOptions = useMemo(
    () => getSheetAnalyticsGroupByOptions(),
    []
  );
  const analyticsMetricOptions = useMemo(
    () => getSheetAnalyticsMetricOptions(),
    []
  );

  const emptyAnalyticsSummary = useMemo(
    () => createEmptySheetAnalyticsSummary(activeSheet),
    [activeSheet]
  );
  const [rustAnalyticsSummary, setRustAnalyticsSummary] =
    useState<SheetAnalyticsSummary | null>(null);
  const rustPivotFilters = useMemo(
    () =>
      createRustPivotFilters(
        activeSheet,
        legacyNonEmptyRows,
        visibleColumns,
        visibleColumnPathSet
      ),
    [activeSheet, legacyNonEmptyRows, visibleColumnPathSet, visibleColumns]
  );
  const rustPivotQuery = useMemo(() => {
    if (!activeSheetId || activeSheet.activeMode !== "analytics" || !rustPivotFilters) {
      return null;
    }

    if (
      activeSheet.analytics.sourceScope === "selected_rows" &&
      selectedVisibleRowKeys.length > 0 &&
      selectedEngineRowIds.length !== selectedVisibleRowKeys.length
    ) {
      return null;
    }

    const selectedRustRowIds =
      activeSheet.analytics.sourceScope === "selected_rows"
        ? selectedEngineRowIds
        : selectedVisibleRowKeys;

    return createRustPivotQueryFromSheetAnalytics({
      sheetId: activeSheetId,
      sheetState: activeSheet,
      filters: rustPivotFilters.filters,
      valueFilters: rustPivotFilters.valueFilters,
      selectedRowIds: selectedRustRowIds,
    });
  }, [
    activeSheet,
    activeSheetId,
    rustPivotFilters,
    selectedEngineRowIds,
    selectedVisibleRowKeys,
  ]);

  useEffect(() => {
    if (!rustPivotQuery) {
      setRustAnalyticsSummary(null);
      return undefined;
    }

    let cancelled = false;
    const chartType =
      activeSheet.analytics.chartType === "bar" ||
      activeSheet.analytics.chartType === "donut"
        ? activeSheet.analytics.chartType
        : null;
    const analyticsRequest =
      chartType === null
        ? queryPivot(rustPivotQuery).then((response) =>
            createSheetAnalyticsSummaryFromRustPivot({
              sheetState: activeSheet,
              pivotResult: response.payload,
              selectedRowCount: selectedVisibleRowKeys.length,
            })
          )
        : queryChart({
            pivotQuery: rustPivotQuery,
            chartType,
          }).then((response) =>
            createSheetAnalyticsSummaryFromRustChart({
              sheetState: activeSheet,
              chartResult: response.payload,
              selectedRowCount: selectedVisibleRowKeys.length,
            })
          );

    analyticsRequest
      .then((response) => {
        if (cancelled) {
          return;
        }

        setRustAnalyticsSummary(response);
      })
      .catch(() => {
        if (!cancelled) {
          setRustAnalyticsSummary(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeSheet, rustPivotQuery, selectedVisibleRowKeys.length]);

  const analyticsSummary = rustAnalyticsSummary ?? emptyAnalyticsSummary;

  return {
    activeFilterCount,
    allTrackingIds,
    allVisibleSelected,
    analyticsGroupByOptions,
    analyticsMetricOptions,
    analyticsSummary,
    columnShortcuts,
    displayedTableRows,
    displayedRowWindow,
    effectiveColumnWidths,
    exportableTableRows,
    rustExportRowsQuery,
    hiddenColumns,
    ignoredHiddenFilterCount,
    loadedCount,
    loadingCount,
    pinnedColumnSet,
    pinnedLeftMap,
    retrackableRows,
    retryFailedEntries,
    selectedRowKeySet,
    selectedEngineRowIds,
    selectedTrackingIds,
    selectedVisibleRowKeys,
    totalShipmentCount,
    valueOptionsByPath,
    visibleColumnPathSet,
    visibleColumns,
    visibleSelectableKeys,
    requestVisibleRowWindow,
  };
}
