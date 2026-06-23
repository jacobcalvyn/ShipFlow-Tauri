import {
  COLUMNS,
  INITIAL_ROW_COUNT,
  TRACKING_COLUMN_PATH,
  isColumnFilterablePath,
} from "./columns";
import {
  getDefaultSheetAnalyticsMetricAggregation,
  getSheetAnalyticsGroupByOptions,
  getSheetAnalyticsMetricOptions,
  isValidSheetAnalyticsMetricAggregation,
} from "./analytics";
import { createDefaultSheetAnalyticsState } from "./default-state";
import type { SheetTableRowTrackingEntry } from "./table-row-view";
import {
  ImportSourceModalKind,
  SheetAnalyticsChartType,
  SheetAnalyticsMetric,
  SheetAnalyticsMetricAggregation,
  SheetAnalyticsSourceScope,
  SheetState,
  SheetViewMode,
} from "./types";
import {
  createEmptyRows,
  ensureRowCapacity,
  ensureTrailingEmptyRows,
} from "./utils";
import {
  sanitizeTextFilters,
  sanitizeValueFilters,
  setValueFilterSelection,
  toggleColumnVisibilityState,
  togglePinnedColumnState,
  toggleValueFilterSelection,
} from "./state";

function withRuntimeTrackingRunId(
  row: SheetState["rows"][number],
  runId?: string | null
) {
  const { runtimeTrackingRunId: _runtimeTrackingRunId, ...baseRow } = row;
  return runId ? { ...baseRow, runtimeTrackingRunId: runId } : baseRow;
}

export function setSheetViewModeInSheet(
  sheetState: SheetState,
  activeMode: SheetViewMode
) {
  if (sheetState.activeMode === activeMode) {
    return sheetState;
  }

  return {
    ...sheetState,
    activeMode,
    openColumnMenuPath: null,
    highlightedColumnPath: null,
  };
}

export function startTrackingRunInSheet(
  sheetState: SheetState,
  trackingRunId: string
) {
  if (sheetState.activeTrackingRunId === trackingRunId) {
    return sheetState;
  }

  return {
    ...sheetState,
    activeTrackingRunId: trackingRunId,
  };
}

export function clearTrackingRunInSheet(
  sheetState: SheetState,
  trackingRunId?: string | null
) {
  if (
    trackingRunId &&
    sheetState.activeTrackingRunId &&
    sheetState.activeTrackingRunId !== trackingRunId
  ) {
    return sheetState;
  }

  if (sheetState.activeTrackingRunId === null) {
    return sheetState;
  }

  return {
    ...sheetState,
    activeTrackingRunId: null,
  };
}

export function setSheetAnalyticsSourceScopeInSheet(
  sheetState: SheetState,
  sourceScope: SheetAnalyticsSourceScope
) {
  if (sheetState.analytics.sourceScope === sourceScope) {
    return sheetState;
  }

  return {
    ...sheetState,
    analytics: {
      ...sheetState.analytics,
      sourceScope,
    },
  };
}

function areStringArraysEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function dedupeValidStrings(values: string[], validValues: Set<string>) {
  const nextValues: string[] = [];
  for (const value of values) {
    if (validValues.has(value) && !nextValues.includes(value)) {
      nextValues.push(value);
    }
  }
  return nextValues;
}

function normalizeAnalyticsColumnPaths(paths: string[]) {
  const validPaths = new Set(getSheetAnalyticsGroupByOptions().map((option) => option.path));
  return dedupeValidStrings(paths, validPaths);
}

function normalizeAnalyticsValueMetrics(metrics: SheetAnalyticsMetric[]) {
  const validMetrics = new Set(getSheetAnalyticsMetricOptions().map((option) => option.key));
  const normalizedMetrics = metrics.map((metric) =>
    metric === "cod_total" ? "detail.billing_detail.cod_info.total_cod" : metric
  );
  return dedupeValidStrings(normalizedMetrics, validMetrics) as SheetAnalyticsMetric[];
}

function normalizeAnalyticsMetricAggregations(
  metrics: SheetAnalyticsMetric[],
  metricAggregations?: Partial<Record<SheetAnalyticsMetric, SheetAnalyticsMetricAggregation>>
) {
  const metricOptionMap = new Map(
    getSheetAnalyticsMetricOptions().map((option) => [option.key, option])
  );
  const nextAggregations: Partial<
    Record<SheetAnalyticsMetric, SheetAnalyticsMetricAggregation>
  > = {};

  for (const metric of metrics) {
    const metricOption = metricOptionMap.get(metric);
    if (!metricOption) {
      continue;
    }

    const selectedAggregation = metricAggregations?.[metric];
    nextAggregations[metric] = isValidSheetAnalyticsMetricAggregation(
      metricOption,
      selectedAggregation
    )
      ? selectedAggregation
      : getDefaultSheetAnalyticsMetricAggregation(metricOption);
  }

  return nextAggregations;
}

export function setSheetAnalyticsRowPathsInSheet(
  sheetState: SheetState,
  rowPaths: string[]
) {
  const normalizedRowPaths = normalizeAnalyticsColumnPaths(rowPaths);
  if (areStringArraysEqual(sheetState.analytics.rowPaths, normalizedRowPaths)) {
    return sheetState;
  }

  return {
    ...sheetState,
    analytics: {
      ...sheetState.analytics,
      rowPaths: normalizedRowPaths,
    },
  };
}

export function setSheetAnalyticsColumnPathsInSheet(
  sheetState: SheetState,
  columnPaths: string[]
) {
  const normalizedColumnPaths = normalizeAnalyticsColumnPaths(columnPaths);
  if (areStringArraysEqual(sheetState.analytics.columnPaths, normalizedColumnPaths)) {
    return sheetState;
  }

  return {
    ...sheetState,
    analytics: {
      ...sheetState.analytics,
      columnPaths: normalizedColumnPaths,
    },
  };
}

export function setSheetAnalyticsValueMetricsInSheet(
  sheetState: SheetState,
  metrics: SheetAnalyticsMetric[]
) {
  const normalizedMetrics = normalizeAnalyticsValueMetrics(metrics);
  const metricAggregations = normalizeAnalyticsMetricAggregations(
    normalizedMetrics,
    sheetState.analytics.metricAggregations
  );
  if (
    areStringArraysEqual(sheetState.analytics.valueMetrics, normalizedMetrics) &&
    JSON.stringify(sheetState.analytics.metricAggregations ?? {}) ===
      JSON.stringify(metricAggregations)
  ) {
    return sheetState;
  }

  return {
    ...sheetState,
    analytics: {
      ...sheetState.analytics,
      valueMetrics: normalizedMetrics,
      metricAggregations,
    },
  };
}

export function setSheetAnalyticsGroupByPathsInSheet(
  sheetState: SheetState,
  groupByPaths: string[]
) {
  return setSheetAnalyticsRowPathsInSheet(sheetState, groupByPaths);
}

export function setSheetAnalyticsGroupByInSheet(
  sheetState: SheetState,
  groupByPath: string | null
) {
  return setSheetAnalyticsRowPathsInSheet(sheetState, groupByPath ? [groupByPath] : []);
}

export function setSheetAnalyticsMetricsInSheet(
  sheetState: SheetState,
  metrics: SheetAnalyticsMetric[]
) {
  return setSheetAnalyticsValueMetricsInSheet(sheetState, metrics);
}

export function setSheetAnalyticsMetricInSheet(
  sheetState: SheetState,
  metric: SheetAnalyticsMetric
) {
  return setSheetAnalyticsValueMetricsInSheet(sheetState, [metric]);
}

export function setSheetAnalyticsMetricAggregationInSheet(
  sheetState: SheetState,
  metric: SheetAnalyticsMetric,
  aggregation: SheetAnalyticsMetricAggregation
) {
  const normalizedMetrics = normalizeAnalyticsValueMetrics([metric]);
  const normalizedMetric = normalizedMetrics[0];
  if (!normalizedMetric || !sheetState.analytics.valueMetrics.includes(normalizedMetric)) {
    return sheetState;
  }

  const metricOption = getSheetAnalyticsMetricOptions().find(
    (option) => option.key === normalizedMetric
  );
  if (!metricOption || !isValidSheetAnalyticsMetricAggregation(metricOption, aggregation)) {
    return sheetState;
  }

  if (sheetState.analytics.metricAggregations?.[normalizedMetric] === aggregation) {
    return sheetState;
  }

  return {
    ...sheetState,
    analytics: {
      ...sheetState.analytics,
      metricAggregations: {
        ...sheetState.analytics.metricAggregations,
        [normalizedMetric]: aggregation,
      },
    },
  };
}

export function setSheetAnalyticsChartTypeInSheet(
  sheetState: SheetState,
  chartType: SheetAnalyticsChartType
) {
  if (sheetState.analytics.chartType === chartType) {
    return sheetState;
  }

  return {
    ...sheetState,
    analytics: {
      ...sheetState.analytics,
      chartType,
    },
  };
}

export function setTrackingInputInSheet(
  sheetState: SheetState,
  rowKey: string,
  value: string
) {
  const nextTrackingInput = value;
  const nextTrackingInputTrimmed = nextTrackingInput.trim();

  return {
    ...sheetState,
    rows: ensureTrailingEmptyRows(
      sheetState.rows.map((row) =>
        row.key === rowKey
          ? withRuntimeTrackingRunId({
              ...row,
              trackingInput: nextTrackingInput,
              shipment: nextTrackingInputTrimmed === "" ? null : row.shipment,
              loading: false,
              queued: false,
              stale:
                nextTrackingInputTrimmed !== "" &&
                row.shipment !== null &&
                nextTrackingInputTrimmed !== row.trackingInput.trim(),
              dirty:
                nextTrackingInputTrimmed !== "" &&
                nextTrackingInputTrimmed !== row.trackingInput.trim(),
              error: "",
            })
          : row
      )
    ),
  };
}

export function clearRowInSheet(sheetState: SheetState, rowKey: string) {
  return {
    ...sheetState,
    rows: sheetState.rows.map((row) =>
      row.key === rowKey
        ? withRuntimeTrackingRunId({
            ...row,
            shipment: null,
            loading: false,
            queued: false,
            stale: false,
            dirty: false,
            error: "",
          })
        : row
    ),
  };
}

export function setRowServerUnavailableInSheet(
  sheetState: SheetState,
  rowKey: string,
  error: string
) {
  return {
    ...sheetState,
    rows: sheetState.rows.map((row) =>
      row.key === rowKey
        ? {
            ...row,
            shipment: row.shipment,
            loading: false,
            queued: false,
            stale: row.shipment !== null,
            dirty: row.shipment !== null,
            error,
          }
        : row
    ),
  };
}

export function setRowLoadingInSheet(
  sheetState: SheetState,
  rowKey: string,
  trackingInput: string,
  options: { runId?: string | null } = {}
) {
  return {
    ...sheetState,
    rows: sheetState.rows.map((row) =>
      row.key === rowKey
        ? withRuntimeTrackingRunId({
            ...row,
            trackingInput,
            loading: true,
            queued: false,
            stale: row.shipment !== null,
            dirty: row.shipment !== null,
            error: "",
          }, options.runId)
        : row
    ),
  };
}

export function setRowSuccessInSheet(
  sheetState: SheetState,
  rowKey: string,
  trackingInput: string,
  shipment: NonNullable<(typeof sheetState.rows)[number]["shipment"]>,
  options: { runId?: string | null } = {}
) {
  return {
    ...sheetState,
    rows: ensureTrailingEmptyRows(
      sheetState.rows.map((row) =>
        row.key === rowKey
          ? withRuntimeTrackingRunId({
              ...row,
              trackingInput,
              shipment,
              loading: false,
              queued: false,
              stale: false,
              dirty: false,
              error: "",
            }, options.runId)
          : row
      )
    ),
  };
}

export function settleRowRuntimeStateInSheet(
  sheetState: SheetState,
  rowKey: string
) {
  return {
    ...sheetState,
    rows: ensureTrailingEmptyRows(
      sheetState.rows.map((row) =>
        row.key === rowKey
          ? {
              ...row,
              loading: false,
              queued: false,
              stale: false,
              dirty: false,
              error: "",
            }
          : row
      )
    ),
  };
}

export function settleRowsRuntimeStateInSheet(
  sheetState: SheetState,
  rowKeys: string[]
) {
  const rowKeySet = new Set(rowKeys);
  if (rowKeySet.size === 0) {
    return sheetState;
  }

  return {
    ...sheetState,
    rows: ensureTrailingEmptyRows(
      sheetState.rows.map((row) =>
        rowKeySet.has(row.key)
          ? {
              ...row,
              loading: false,
              queued: false,
              stale: false,
              dirty: false,
              error: "",
            }
          : row
      )
    ),
  };
}

export function clearTrackingCellInSheet(sheetState: SheetState, rowKey: string) {
  return {
    ...sheetState,
    rows: ensureTrailingEmptyRows(
      sheetState.rows.map((row) =>
        row.key === rowKey
          ? withRuntimeTrackingRunId({
              ...row,
              trackingInput: "",
              shipment: null,
              loading: false,
              queued: false,
              stale: false,
              dirty: false,
              error: "",
            })
          : row
      )
    ),
  };
}

export function setRowErrorInSheet(
  sheetState: SheetState,
  rowKey: string,
  error: string,
  options: { runId?: string | null } = {}
) {
  return {
    ...sheetState,
    rows: sheetState.rows.map((row) =>
      row.key === rowKey
        ? withRuntimeTrackingRunId({
            ...row,
            shipment: row.shipment,
            loading: false,
            queued: false,
            stale: row.shipment !== null,
            dirty: row.shipment !== null,
            error,
          }, options.runId)
        : row
    ),
  };
}

export function setRowsQueuedInSheet(
  sheetState: SheetState,
  entries: SheetTableRowTrackingEntry[],
  options: { runId?: string | null } = {}
) {
  if (entries.length === 0) {
    return sheetState;
  }

  const queuedTrackingInputs = new Map(
    entries.map((entry) => [entry.key, entry.value.trim()])
  );

  return {
    ...sheetState,
    rows: sheetState.rows.map((row) => {
      const trackingInput = queuedTrackingInputs.get(row.key);
      if (!trackingInput) {
        return row;
      }

      return withRuntimeTrackingRunId({
        ...row,
        trackingInput,
        loading: false,
        queued: true,
        stale: false,
        dirty: false,
        error: "",
      }, options.runId);
    }),
  };
}

export function applyBulkPasteToSheet(
  sheetState: SheetState,
  startIndex: number,
  values: string[]
) {
  const requiredLength = startIndex + values.length;
  const expandedRows = ensureRowCapacity([...sheetState.rows], requiredLength);
  const targetKeys: string[] = [];

  for (let offset = 0; offset < values.length; offset += 1) {
    const row = expandedRows[startIndex + offset];
    targetKeys.push(row.key);
    expandedRows[startIndex + offset] = withRuntimeTrackingRunId({
      ...row,
      trackingInput: values[offset],
      shipment: null,
      loading: false,
      queued: false,
      stale: false,
      dirty: false,
      error: "",
    });
  }

  return {
    sheetState: {
      ...sheetState,
      rows: ensureTrailingEmptyRows(expandedRows),
      selectedRowKeys: Array.from(new Set([...sheetState.selectedRowKeys, ...targetKeys])),
    },
    targetKeys,
  };
}

export function setTextFilterInSheet(
  sheetState: SheetState,
  path: string,
  value: string
) {
  if (!isColumnFilterablePath(path)) {
    if (!(path in sheetState.filters)) {
      return sheetState;
    }

    const nextFilters = { ...sheetState.filters };
    delete nextFilters[path];
    return {
      ...sheetState,
      filters: nextFilters,
    };
  }

  return {
    ...sheetState,
    filters: {
      ...sheetState.filters,
      [path]: value,
    },
  };
}

export function toggleValueFilterInSheet(
  sheetState: SheetState,
  path: string,
  value: string
) {
  if (!isColumnFilterablePath(path)) {
    return sheetState;
  }

  return {
    ...sheetState,
    valueFilters: toggleValueFilterSelection(sheetState.valueFilters, path, value),
  };
}

export function setValueFilterSelectionInSheet(
  sheetState: SheetState,
  path: string,
  values: string[]
) {
  if (!isColumnFilterablePath(path)) {
    return sheetState;
  }

  return {
    ...sheetState,
    valueFilters: setValueFilterSelection(sheetState.valueFilters, path, values),
  };
}

export function clearValueFilterInSheet(sheetState: SheetState, path: string) {
  if (!(path in sheetState.valueFilters)) {
    return sheetState;
  }

  const next = { ...sheetState.valueFilters };
  delete next[path];

  return {
    ...sheetState,
    valueFilters: next,
  };
}

export function setSortInSheet(
  sheetState: SheetState,
  path: string,
  direction: "asc" | "desc" | null
) {
  return {
    ...sheetState,
    sortState: {
      path: direction ? path : null,
      direction: direction ?? "asc",
    },
  };
}

export function toggleRowSelectionInSheet(
  sheetState: SheetState,
  rowKey: string
) {
  return {
    ...sheetState,
    selectionFollowsVisibleRows: false,
    selectedRowKeys: sheetState.selectedRowKeys.includes(rowKey)
      ? sheetState.selectedRowKeys.filter((key) => key !== rowKey)
      : [...sheetState.selectedRowKeys, rowKey],
  };
}

export function toggleVisibleSelectionInSheet(
  sheetState: SheetState,
  allVisibleSelected: boolean,
  visibleSelectableKeys: string[]
) {
  return {
    ...sheetState,
    selectionFollowsVisibleRows: !allVisibleSelected,
    selectedRowKeys: allVisibleSelected
      ? sheetState.selectedRowKeys.filter(
          (key) => !visibleSelectableKeys.includes(key)
        )
      : visibleSelectableKeys,
  };
}

export function syncSelectionWithVisibleRowsInSheet(
  sheetState: SheetState,
  visibleSelectableKeys: string[]
) {
  if (!sheetState.selectionFollowsVisibleRows) {
    return sheetState;
  }

  if (
    sheetState.selectedRowKeys.length === visibleSelectableKeys.length &&
    sheetState.selectedRowKeys.every(
      (key, index) => key === visibleSelectableKeys[index]
    )
  ) {
    return sheetState;
  }

  return {
    ...sheetState,
    selectedRowKeys: visibleSelectableKeys,
  };
}

export function forceSelectionToVisibleRowsInSheet(
  sheetState: SheetState,
  visibleSelectableKeys: string[]
) {
  if (
    sheetState.selectionFollowsVisibleRows &&
    sheetState.selectedRowKeys.length === visibleSelectableKeys.length &&
    sheetState.selectedRowKeys.every(
      (key, index) => key === visibleSelectableKeys[index]
    )
  ) {
    return sheetState;
  }

  return {
    ...sheetState,
    selectionFollowsVisibleRows: true,
    selectedRowKeys: visibleSelectableKeys,
  };
}

export function stopSelectionFollowingVisibleRowsInSheet(sheetState: SheetState) {
  if (!sheetState.selectionFollowsVisibleRows) {
    return sheetState;
  }

  return {
    ...sheetState,
    selectionFollowsVisibleRows: false,
  };
}

export function pruneSelectionToVisibleRowsInSheet(
  sheetState: SheetState,
  visibleSelectableKeys: string[]
) {
  const visibleSelectableKeySet = new Set(visibleSelectableKeys);
  const nextSelectedRowKeys = sheetState.selectedRowKeys.filter((key) =>
    visibleSelectableKeySet.has(key)
  );

  if (
    nextSelectedRowKeys.length === sheetState.selectedRowKeys.length &&
    nextSelectedRowKeys.every((key, index) => key === sheetState.selectedRowKeys[index])
  ) {
    return sheetState;
  }

  return {
    ...sheetState,
    selectedRowKeys: nextSelectedRowKeys,
  };
}

export function clearSelectionInSheet(sheetState: SheetState) {
  return {
    ...sheetState,
    selectionFollowsVisibleRows: false,
    selectedRowKeys: [],
  };
}

export function openImportSourceModalInSheet(
  sheetState: SheetState,
  kind: ImportSourceModalKind
) {
  if (sheetState.importSourceModalKind === kind) {
    return sheetState;
  }

  return {
    ...sheetState,
    importSourceModalKind: kind,
  };
}

export function closeImportSourceModalInSheet(sheetState: SheetState) {
  if (sheetState.importSourceModalKind === null) {
    return sheetState;
  }

  return {
    ...sheetState,
    importSourceModalKind: null,
  };
}

export function setImportSourceDraftInSheet(
  sheetState: SheetState,
  kind: ImportSourceModalKind,
  value: string
) {
  if (sheetState.importSourceDrafts[kind] === value) {
    return sheetState;
  }

  return {
    ...sheetState,
    importSourceDrafts: {
      ...sheetState.importSourceDrafts,
      [kind]: value,
    },
    importSourceLookupStates: {
      ...sheetState.importSourceLookupStates,
      [kind]: {
        loading: false,
        rawResponse: "",
        error: "",
        trackingIds: [],
        jobId: null,
        requestKey: null,
        sourceItemStates: [],
        manifestBagStates: [],
      },
    },
  };
}

export function startImportSourceLookupInSheet(
  sheetState: SheetState,
  kind: ImportSourceModalKind,
  requestKey: string,
  sourceItemIds: string[] = []
) {
  return {
    ...sheetState,
    importSourceLookupStates: {
      ...sheetState.importSourceLookupStates,
      [kind]: {
        loading: true,
        rawResponse: "",
        error: "",
        trackingIds: [],
        jobId: null,
        requestKey,
        sourceItemStates: sourceItemIds.map((itemId) => ({
          itemId,
          loading: true,
          error: "",
          trackingIds: [],
        })),
        manifestBagStates: [],
      },
    },
  };
}

export function startImportSourceRetryInSheet(
  sheetState: SheetState,
  kind: ImportSourceModalKind,
  requestKey: string,
  sourceItemIds: string[] = [],
  manifestBagIds: string[] = []
) {
  const currentLookupState = sheetState.importSourceLookupStates[kind];
  const sourceItemIdSet = new Set(sourceItemIds);
  const manifestBagIdSet = new Set(manifestBagIds);

  return {
    ...sheetState,
    importSourceLookupStates: {
      ...sheetState.importSourceLookupStates,
      [kind]: {
        ...currentLookupState,
        error: "",
        requestKey,
        sourceItemStates: (currentLookupState.sourceItemStates ?? []).map((state) =>
          sourceItemIdSet.has(state.itemId)
            ? {
                ...state,
                loading: true,
                error: "",
                trackingIds: [],
              }
            : state
        ),
        manifestBagStates: (currentLookupState.manifestBagStates ?? []).map((state) =>
          manifestBagIdSet.has(state.bagId)
            ? {
                ...state,
                loading: true,
                error: "",
                trackingIds: [],
              }
            : state
        ),
      },
    },
  };
}

export function setImportSourceJobInSheet(
  sheetState: SheetState,
  kind: ImportSourceModalKind,
  requestKey: string,
  jobId: string
) {
  const currentLookupState = sheetState.importSourceLookupStates[kind];
  if (currentLookupState.requestKey !== requestKey) {
    return sheetState;
  }

  if (currentLookupState.jobId === jobId) {
    return sheetState;
  }

  return {
    ...sheetState,
    importSourceLookupStates: {
      ...sheetState.importSourceLookupStates,
      [kind]: {
        ...currentLookupState,
        jobId,
      },
    },
  };
}

export function setImportSourceLookupSuccessInSheet(
  sheetState: SheetState,
  kind: ImportSourceModalKind,
  rawResponse: string,
  trackingIds: string[],
  requestKey: string,
  manifestBagStates: NonNullable<
    SheetState["importSourceLookupStates"]["manifest"]["manifestBagStates"]
  > = [],
  sourceItemStates: NonNullable<
    SheetState["importSourceLookupStates"]["manifest"]["sourceItemStates"]
  > = []
) {
  if (sheetState.importSourceLookupStates[kind].requestKey !== requestKey) {
    return sheetState;
  }

  return {
    ...sheetState,
    importSourceLookupStates: {
      ...sheetState.importSourceLookupStates,
      [kind]: {
        loading: false,
        rawResponse,
        error: "",
        trackingIds,
        jobId: sheetState.importSourceLookupStates[kind].jobId ?? null,
        requestKey,
        sourceItemStates,
        manifestBagStates,
      },
    },
  };
}

export function setImportSourceLookupProgressInSheet(
  sheetState: SheetState,
  kind: ImportSourceModalKind,
  rawResponse: string,
  trackingIds: string[],
  requestKey: string,
  loading: boolean,
  manifestBagStates: NonNullable<
    SheetState["importSourceLookupStates"]["manifest"]["manifestBagStates"]
  > = [],
  sourceItemStates: NonNullable<
    SheetState["importSourceLookupStates"]["manifest"]["sourceItemStates"]
  > = []
) {
  const currentLookupState = sheetState.importSourceLookupStates[kind];
  if (currentLookupState.requestKey !== requestKey) {
    return sheetState;
  }

  return {
    ...sheetState,
    importSourceLookupStates: {
      ...sheetState.importSourceLookupStates,
      [kind]: {
        ...currentLookupState,
        loading,
        rawResponse,
        error: "",
        trackingIds,
        requestKey,
        sourceItemStates,
        manifestBagStates,
      },
    },
  };
}

export function setImportSourceLookupErrorInSheet(
  sheetState: SheetState,
  kind: ImportSourceModalKind,
  error: string,
  requestKey: string,
  sourceItemStates: NonNullable<
    SheetState["importSourceLookupStates"]["manifest"]["sourceItemStates"]
  > = []
) {
  if (sheetState.importSourceLookupStates[kind].requestKey !== requestKey) {
    return sheetState;
  }

  return {
    ...sheetState,
    importSourceLookupStates: {
      ...sheetState.importSourceLookupStates,
      [kind]: {
        loading: false,
        rawResponse: "",
        error,
        trackingIds: [],
        jobId: sheetState.importSourceLookupStates[kind].jobId ?? null,
        requestKey,
        sourceItemStates,
        manifestBagStates: [],
      },
    },
  };
}

export function setManifestBagLookupSuccessInSheet(
  sheetState: SheetState,
  bagId: string,
  trackingIds: string[],
  requestKey: string
) {
  if (sheetState.importSourceLookupStates.manifest.requestKey !== requestKey) {
    return sheetState;
  }

  const currentStates =
    sheetState.importSourceLookupStates.manifest.manifestBagStates ?? [];

  return {
    ...sheetState,
    importSourceLookupStates: {
      ...sheetState.importSourceLookupStates,
      manifest: {
        ...sheetState.importSourceLookupStates.manifest,
        manifestBagStates: currentStates.map((state) =>
          state.bagId === bagId
            ? {
                ...state,
                loading: false,
                error: "",
                trackingIds,
              }
            : state
        ),
      },
    },
  };
}

export function setManifestBagLookupErrorInSheet(
  sheetState: SheetState,
  bagId: string,
  error: string,
  requestKey: string
) {
  if (sheetState.importSourceLookupStates.manifest.requestKey !== requestKey) {
    return sheetState;
  }

  const currentStates =
    sheetState.importSourceLookupStates.manifest.manifestBagStates ?? [];

  return {
    ...sheetState,
    importSourceLookupStates: {
      ...sheetState.importSourceLookupStates,
      manifest: {
        ...sheetState.importSourceLookupStates.manifest,
        manifestBagStates: currentStates.map((state) =>
          state.bagId === bagId
            ? {
                ...state,
                loading: false,
                error,
                trackingIds: [],
              }
            : state
        ),
      },
    },
  };
}

export function clearFiltersInSheet(sheetState: SheetState) {
  return {
    ...sheetState,
    filters: {},
    valueFilters: {},
  };
}

export function clearHiddenFiltersInSheet(
  sheetState: SheetState,
  visibleColumnPathSet: Set<string>
) {
  return {
    ...sheetState,
    filters: sanitizeTextFilters(sheetState.filters, visibleColumnPathSet),
    valueFilters: sanitizeValueFilters(
      sheetState.valueFilters,
      visibleColumnPathSet
    ),
  };
}

export function deleteRowsInSheet(
  sheetState: SheetState,
  rowKeys: string[]
) {
  const remainingRows = sheetState.rows.filter((row) => !rowKeys.includes(row.key));
  const filledRows = remainingRows.filter(
    (row) => row.trackingInput.trim() !== "" || row.shipment !== null
  );
  const emptyRows = remainingRows.filter(
    (row) => row.trackingInput.trim() === "" && row.shipment === null
  );

  return {
    ...sheetState,
    rows: [...filledRows, ...emptyRows, ...createEmptyRows(rowKeys.length)],
    selectedRowKeys: sheetState.selectedRowKeys.filter((key) => !rowKeys.includes(key)),
    selectionFollowsVisibleRows: false,
    activeTrackingRunId: null,
  };
}

export function clearAllDataInSheet(sheetState: SheetState) {
  return {
    ...sheetState,
    activeMode: "workspace" as const,
    analytics: createDefaultSheetAnalyticsState(),
    rows: createEmptyRows(INITIAL_ROW_COUNT),
    filters: {},
    valueFilters: {},
    sortState: {
      path: null,
      direction: "asc" as const,
    },
    selectedRowKeys: [],
    selectionFollowsVisibleRows: false,
    activeTrackingRunId: null,
    openColumnMenuPath: null,
    highlightedColumnPath: null,
    deleteAllArmed: false,
    importSourceModalKind: null,
    importSourceDrafts: {
      bag: "",
      manifest: "",
    },
    importSourceLookupStates: {
      bag: {
        loading: false,
        rawResponse: "",
        error: "",
        trackingIds: [],
        jobId: null,
        requestKey: null,
        sourceItemStates: [],
        manifestBagStates: [],
      },
      manifest: {
        loading: false,
        rawResponse: "",
        error: "",
        trackingIds: [],
        jobId: null,
        requestKey: null,
        sourceItemStates: [],
        manifestBagStates: [],
      },
    },
  };
}

export function clearSheetDataPreservingImportStateInSheet(sheetState: SheetState) {
  return {
    ...sheetState,
    activeMode: "workspace" as const,
    analytics: createDefaultSheetAnalyticsState(),
    rows: createEmptyRows(INITIAL_ROW_COUNT),
    filters: {},
    valueFilters: {},
    sortState: {
      path: null,
      direction: "asc" as const,
    },
    selectedRowKeys: [],
    selectionFollowsVisibleRows: false,
    activeTrackingRunId: null,
    openColumnMenuPath: null,
    highlightedColumnPath: null,
    deleteAllArmed: false,
  };
}

export function armDeleteAllInSheet(sheetState: SheetState) {
  return {
    ...sheetState,
    selectionFollowsVisibleRows: false,
    selectedRowKeys: [],
    deleteAllArmed: true,
    importSourceModalKind: null,
    importSourceDrafts: {
      bag: "",
      manifest: "",
    },
    importSourceLookupStates: {
      bag: {
        loading: false,
        rawResponse: "",
        error: "",
        trackingIds: [],
        jobId: null,
        requestKey: null,
        sourceItemStates: [],
        manifestBagStates: [],
      },
      manifest: {
        loading: false,
        rawResponse: "",
        error: "",
        trackingIds: [],
        jobId: null,
        requestKey: null,
        sourceItemStates: [],
        manifestBagStates: [],
      },
    },
  };
}

export function disarmDeleteAllInSheet(sheetState: SheetState) {
  if (!sheetState.deleteAllArmed) {
    return sheetState;
  }

  return {
    ...sheetState,
    deleteAllArmed: false,
  };
}

export function setColumnWidthInSheet(
  sheetState: SheetState,
  path: string,
  width: number
) {
  if (sheetState.columnWidths[path] === width) {
    return sheetState;
  }

  return {
    ...sheetState,
    columnWidths: {
      ...sheetState.columnWidths,
      [path]: width,
    },
  };
}

export function setOpenColumnMenuInSheet(
  sheetState: SheetState,
  path: string | null
) {
  return {
    ...sheetState,
    openColumnMenuPath: path,
  };
}

export function setHighlightedColumnInSheet(
  sheetState: SheetState,
  path: string | null
) {
  return {
    ...sheetState,
    highlightedColumnPath: path,
  };
}

export function toggleColumnVisibilityInSheet(
  sheetState: SheetState,
  path: string
) {
  if (path === TRACKING_COLUMN_PATH) {
    return sheetState;
  }

  let nextFilters = sheetState.filters;
  let nextValueFilters = sheetState.valueFilters;
  let nextSortState = sheetState.sortState;

  if (!sheetState.hiddenColumnPaths.includes(path)) {
    if (sheetState.filters[path]) {
      nextFilters = { ...sheetState.filters };
      delete nextFilters[path];
    }

    if (path in sheetState.valueFilters) {
      nextValueFilters = { ...sheetState.valueFilters };
      delete nextValueFilters[path];
    }

    if (sheetState.sortState.path === path) {
      nextSortState = { path: null, direction: "asc" };
    }
  }

  return {
    ...sheetState,
    filters: nextFilters,
    valueFilters: nextValueFilters,
    sortState: nextSortState,
    hiddenColumnPaths: toggleColumnVisibilityState(sheetState.hiddenColumnPaths, path),
  };
}

export function togglePinnedColumnInSheet(
  sheetState: SheetState,
  path: string
) {
  return {
    ...sheetState,
    pinnedColumnPaths: togglePinnedColumnState(sheetState.pinnedColumnPaths, path),
  };
}

export function getSortLabel(sheetState: SheetState, path: string) {
  if (sheetState.sortState.path !== path) {
    return "↕";
  }

  return sheetState.sortState.direction === "asc" ? "↑" : "↓";
}

export function getColumnSortDirection(sheetState: SheetState, path: string) {
  return sheetState.sortState.path === path ? sheetState.sortState.direction : null;
}
