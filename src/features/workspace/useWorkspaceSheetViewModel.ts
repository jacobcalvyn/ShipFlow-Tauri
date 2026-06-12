import { useCallback, useEffect, useMemo, useState } from "react";
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
import {
  createRustSheetQueryFilterParts,
  createRustSheetRowsQuery,
} from "../sheet/rust-row-query-adapter";
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
} from "../sheet/table-row-view";
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
import { formatDateValue, formatNumber } from "../sheet/utils";
import {
  queryChart,
  queryPivot,
  querySheetFieldValues,
  querySheetRows,
  type SheetFieldValuesQuery,
  type SheetFieldValuesResult,
  type SheetFilter,
  type SheetRowWindow,
  type SheetValueFilter,
} from "../workspace-engine/client";

const RUST_ROW_WINDOW_LIMIT = 500;
const RUST_EXPORT_ROW_WINDOW_LIMIT = 1_000;
const RUST_VALUE_OPTIONS_LIMIT = 1_000;
const RUST_ROW_WINDOW_CACHE_LIMIT = 8;

type RustDisplayedRowsCacheEntry = {
  generation: number;
  signature: string;
  window: SheetRowWindow;
};

function setRustDisplayedRowsCacheEntry(
  cache: Record<string, RustDisplayedRowsCacheEntry>,
  queryKey: string,
  entry: RustDisplayedRowsCacheEntry
) {
  const next = {
    ...cache,
    [queryKey]: entry,
  };
  const keys = Object.keys(next);
  for (const key of keys.slice(0, Math.max(0, keys.length - RUST_ROW_WINDOW_CACHE_LIMIT))) {
    delete next[key];
  }

  return next;
}

function deleteRustDisplayedRowsCacheEntry(
  cache: Record<string, RustDisplayedRowsCacheEntry>,
  queryKey: string
) {
  if (!(queryKey in cache)) {
    return cache;
  }

  const next = {
    ...cache,
  };
  delete next[queryKey];
  return next;
}

function createRustRowWindowSignature(window: SheetRowWindow) {
  return [
    window.sheetId,
    window.offset,
    window.limit,
    window.totalCount,
    window.hasMore ? "1" : "0",
    window.nextOffset ?? "",
    window.rows
      .map((row) =>
        [
          row.rowId,
          row.position,
          row.displayTrackingId,
          row.lookupTrackingId,
          row.rowStatus,
          row.errorMessage ?? "",
          JSON.stringify(row.statusJson ?? null),
          JSON.stringify(row.detailJson ?? null),
          JSON.stringify(row.historyJson ?? null),
        ].join("\u001f")
      )
      .join("\u001e"),
  ].join("\u001d");
}

function createEmptyRustRowWindow(
  query: NonNullable<ReturnType<typeof createRustSheetRowsQuery>>
): SheetRowWindow {
  return {
    sheetId: query.sheetId,
    offset: query.offset,
    limit: query.limit,
    totalCount: 0,
    hasMore: false,
    nextOffset: null,
    rows: [],
  };
}

function createRustPivotFilters(
  activeSheet: SheetState,
  nonEmptyRows: SheetState["rows"],
  visibleColumns: ReturnType<typeof getVisibleColumns>,
  visibleColumnPathSet: Set<string>
): { filters: SheetFilter[]; valueFilters: SheetValueFilter[] } | null {
  if (activeSheet.analytics.sourceScope !== "filtered_rows") {
    return {
      filters: [],
      valueFilters: [],
    };
  }

  return createRustSheetQueryFilterParts({
    sheetState: activeSheet,
    nonEmptyRows,
    visibleColumns,
    visibleColumnPathSet,
  });
}

function formatEngineValueOption(column: ColumnDefinition, value: string) {
  if (value === "") {
    return "-";
  }

  switch (column.type) {
    case "currency":
    case "number": {
      const numberValue = Number(value);
      return Number.isFinite(numberValue) ? formatNumber(numberValue) : value;
    }
    case "weight": {
      const numberValue = Number(value);
      return Number.isFinite(numberValue) ? `${formatNumber(numberValue)} Kg` : value;
    }
    case "boolean": {
      const normalized = value.trim().toLowerCase();
      if (normalized === "1" || normalized === "true") {
        return "Ya";
      }
      if (normalized === "0" || normalized === "false") {
        return "Tidak";
      }
      return value;
    }
    case "date":
      return formatDateValue(value);
    default:
      return value;
  }
}

function createValueOptionsFromRustFieldValues(
  column: ColumnDefinition,
  result: SheetFieldValuesResult
): ValueFilterOption[] {
  const countByValue = new Map<string, number>();
  for (const option of result.values) {
    const value = formatEngineValueOption(column, option.value);
    if (value === "-") {
      continue;
    }

    countByValue.set(value, (countByValue.get(value) ?? 0) + option.count);
  }

  return Array.from(countByValue, ([value, count]) => ({
    value,
    count,
  })).sort((left, right) => {
    if (left.count !== right.count) {
      return right.count - left.count;
    }

    return left.value.localeCompare(right.value, "id", {
      sensitivity: "base",
      numeric: true,
    });
  });
}

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
    if (!column || column.type === "json") {
      return null;
    }

    return {
      column,
      query: {
        sheetId: rustSheetRowsBaseQuery.sheetId,
        field: activeSheet.openColumnMenuPath,
        filters: rustSheetRowsBaseQuery.filters,
        ...(rustSheetRowsBaseQuery.valueFilters
          ? { valueFilters: rustSheetRowsBaseQuery.valueFilters }
          : {}),
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

        const signature = createRustRowWindowSignature(response.payload);
        setFailedRustDisplayedRowsQueryKey((current) =>
          current === rustSheetRowsCacheKey ? null : current
        );
        setRustDisplayedRowsByQuery((current) =>
          current[rustSheetRowsCacheKey]?.signature === signature &&
          current[rustSheetRowsCacheKey]?.generation === workspaceEngineCacheGeneration
            ? current
            : setRustDisplayedRowsCacheEntry(current, rustSheetRowsCacheKey, {
                generation: workspaceEngineCacheGeneration,
                signature,
                window: response.payload,
              })
        );
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
      ? (rustDisplayedRowsByQuery[rustSheetRowsCacheKey]?.generation ===
        workspaceEngineCacheGeneration
          ? rustDisplayedRowsByQuery[rustSheetRowsCacheKey]
          : null)
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
      !failedRustDisplayedRowsWindow &&
      legacyNonEmptyRows.length === 0
        ? createEmptyRustRowWindow(rustSheetRowsQuery)
        : null,
    [
      activeRustDisplayedRowsState,
      failedRustDisplayedRowsWindow,
      legacyNonEmptyRows.length,
      rustSheetRowsQuery,
    ]
  );
  const authoritativeRustDisplayedRowsWindow =
    activeRustDisplayedRowsState?.window ??
    failedRustDisplayedRowsWindow ??
    pendingRustDisplayedRowsWindow;
  const legacyDisplayedTableRows = useMemo(
    () => createSheetTableRowsFromSheetRows(legacyDisplayedRows),
    [legacyDisplayedRows]
  );
  const rustProjectedTableRows = useMemo(
    () =>
      authoritativeRustDisplayedRowsWindow
        ? createSheetTableRowsFromRustWindow(
            authoritativeRustDisplayedRowsWindow,
            activeSheet.rows
          )
        : null,
    [activeSheet.rows, authoritativeRustDisplayedRowsWindow]
  );
  const displayedTableRows = rustProjectedTableRows ?? legacyDisplayedTableRows;
  const displayedRowWindow = authoritativeRustDisplayedRowsWindow;

  const retrackableRows = useMemo(
    () => getRetrackableTableRows(displayedTableRows),
    [displayedTableRows]
  );

  const totalShipmentCount = useMemo(
    () => {
      const displayedCount = getTotalTableRowTrackingCount(displayedTableRows);
      return displayedRowWindow
        ? Math.max(displayedRowWindow.totalCount, displayedCount)
        : displayedCount;
    },
    [displayedRowWindow?.totalCount, displayedTableRows]
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
