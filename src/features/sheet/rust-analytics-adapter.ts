import type {
  AnalyticsAggregation,
  ChartResult,
  PivotQuery,
  PivotResult,
  SheetFilter,
  SheetValueFilter,
} from "../workspace-engine/client";
import {
  getDefaultSheetAnalyticsMetricAggregation,
  getSheetAnalyticsGroupByOptions,
  getSheetAnalyticsMetricAggregationLabel,
  getSheetAnalyticsMetricOptions,
  isValidSheetAnalyticsMetricAggregation,
  type SheetAnalyticsMetricOption,
  type SheetAnalyticsPivotColumn,
  type SheetAnalyticsPivotValueColumn,
  type SheetAnalyticsRow,
  type SheetAnalyticsSummary,
} from "./analytics";
import type {
  SheetAnalyticsMetric,
  SheetAnalyticsMetricAggregation,
  SheetState,
} from "./types";

type RustPivotRow = {
  rowValues: string[];
  columnValues: string[];
  count: number;
  metrics: Record<string, unknown>;
  share: number;
};

type RustPivotSummaryParams = {
  sheetState: SheetState;
  pivotResult: PivotResult;
  selectedRowCount: number;
};

type RustChartSummaryParams = {
  sheetState: SheetState;
  chartResult: ChartResult;
  selectedRowCount: number;
};

type RustPivotQueryParams = {
  sheetId: string;
  sheetState: SheetState;
  filters: SheetFilter[];
  valueFilters?: SheetValueFilter[];
  selectedRowIds: string[];
  sort?: PivotQuery["sort"];
  limit?: number;
};

const DEFAULT_RUST_PIVOT_LIMIT = 10_000;

function dedupeValidStrings(values: string[], validValues: Set<string>) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = value.trim();
    if (!validValues.has(normalized) || seen.has(normalized)) {
      return false;
    }

    seen.add(normalized);
    return true;
  });
}

function getActiveRowPaths(sheetState: SheetState) {
  const validPathSet = new Set(getSheetAnalyticsGroupByOptions().map((option) => option.path));
  return dedupeValidStrings(sheetState.analytics.rowPaths, validPathSet);
}

function getActiveColumnPaths(sheetState: SheetState) {
  const validPathSet = new Set(getSheetAnalyticsGroupByOptions().map((option) => option.path));
  return dedupeValidStrings(sheetState.analytics.columnPaths, validPathSet);
}

function getActiveValueMetrics(sheetState: SheetState) {
  const validMetricSet = new Set(getSheetAnalyticsMetricOptions().map((option) => option.key));
  return dedupeValidStrings(sheetState.analytics.valueMetrics, validMetricSet);
}

function getActiveMetricOption(
  metric: SheetAnalyticsMetric,
  metricOptions: SheetAnalyticsMetricOption[],
  sheetState: SheetState
): SheetAnalyticsMetricOption {
  const baseOption =
    metricOptions.find((option) => option.key === metric) ?? {
      key: metric,
      label: metric,
      format: "number" as const,
    };
  const selectedAggregation = sheetState.analytics.metricAggregations?.[metric];
  const aggregation = isValidSheetAnalyticsMetricAggregation(
    baseOption,
    selectedAggregation
  )
    ? selectedAggregation
    : getDefaultSheetAnalyticsMetricAggregation(baseOption);

  return {
    ...baseOption,
    aggregation,
    aggregationLabel: getSheetAnalyticsMetricAggregationLabel(baseOption, aggregation),
  };
}

function getMetricDisplayLabel(metricOption: SheetAnalyticsMetricOption) {
  return metricOption.aggregationLabel
    ? `${metricOption.label} (${metricOption.aggregationLabel})`
    : metricOption.label;
}

function getMetricKey(
  field: string,
  aggregation: SheetAnalyticsMetricAggregation | AnalyticsAggregation
) {
  return `${field}__${aggregation}`;
}

function getColumnKey(values: string[]) {
  return JSON.stringify(values);
}

function getColumnLabel(values: string[]) {
  return values.length > 0 ? values.join(" / ") : "";
}

function getAnalyticsFieldLabels(paths: string[]) {
  const groupByOptions = getSheetAnalyticsGroupByOptions();
  return paths.map(
    (path) => groupByOptions.find((option) => option.path === path)?.label ?? path
  );
}

function parseRustPivotRow(row: unknown): RustPivotRow | null {
  if (!row || typeof row !== "object") {
    return null;
  }

  const candidate = row as Partial<RustPivotRow>;
  if (
    !Array.isArray(candidate.rowValues) ||
    !Array.isArray(candidate.columnValues) ||
    typeof candidate.count !== "number" ||
    !candidate.metrics ||
    typeof candidate.metrics !== "object"
  ) {
    return null;
  }

  return {
    rowValues: candidate.rowValues.map((value) => String(value || "-")),
    columnValues: candidate.columnValues.map((value) => String(value || "-")),
    count: Number.isFinite(candidate.count) ? candidate.count : 0,
    metrics: candidate.metrics as Record<string, unknown>,
    share: typeof candidate.share === "number" && Number.isFinite(candidate.share)
      ? candidate.share
      : 0,
  };
}

function getNumericMetricValue(value: unknown, aggregation: SheetAnalyticsMetricAggregation) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string" || value === "-" || value.trim() === "") {
    return 0;
  }

  if (aggregation === "unique_list") {
    return value.split(",").map((item) => item.trim()).filter(Boolean).length;
  }

  return 1;
}

function getMetricDisplayValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function createPivotColumns(
  rows: RustPivotRow[],
  columnPaths: string[]
): SheetAnalyticsPivotColumn[] {
  if (columnPaths.length === 0) {
    return [];
  }

  const columns = new Map<string, SheetAnalyticsPivotColumn>();
  for (const row of rows) {
    const key = getColumnKey(row.columnValues);
    if (!columns.has(key)) {
      columns.set(key, {
        key,
        label: getColumnLabel(row.columnValues),
        values: row.columnValues,
      });
    }
  }

  return Array.from(columns.values()).sort((left, right) =>
    left.label.localeCompare(right.label, "id", {
      sensitivity: "base",
      numeric: true,
    })
  );
}

function createPivotValueColumns(
  pivotColumns: SheetAnalyticsPivotColumn[],
  activeMetricOptions: SheetAnalyticsMetricOption[]
): SheetAnalyticsPivotValueColumn[] {
  if (pivotColumns.length === 0) {
    return activeMetricOptions.map((metricOption) => ({
      key: `value:${metricOption.key}`,
      label: getMetricDisplayLabel(metricOption),
      columnKey: "[]",
      columnValues: [],
      metric: metricOption,
    }));
  }

  return pivotColumns.flatMap((column) =>
    activeMetricOptions.map((metricOption) => {
      const metricLabel = getMetricDisplayLabel(metricOption);
      return {
        key: `${column.key}:${metricOption.key}`,
        label:
          activeMetricOptions.length > 1
            ? `${column.label} / ${metricLabel}`
            : column.label,
        columnKey: column.key,
        columnValues: column.values,
        metric: metricOption,
      };
    })
  );
}

export function createEmptySheetAnalyticsSummary(
  sheetState: SheetState
): SheetAnalyticsSummary {
  const rowPaths = getActiveRowPaths(sheetState);
  const columnPaths = getActiveColumnPaths(sheetState);
  const metricOptions = getSheetAnalyticsMetricOptions();
  const activeMetricOptions = getActiveValueMetrics(sheetState).map((metric) =>
    getActiveMetricOption(metric, metricOptions, sheetState)
  );
  const primaryMetric =
    sheetState.analytics.chartType === "pivot"
      ? activeMetricOptions[0]?.key ?? null
      : activeMetricOptions[0]?.key ?? null;
  const primaryMetricOption =
    activeMetricOptions.find((option) => option.key === primaryMetric) ?? null;
  const rowLabels = rowPaths.length > 0 ? getAnalyticsFieldLabels(rowPaths) : ["Semua Row"];
  const columnLabels = getAnalyticsFieldLabels(columnPaths);

  return {
    sourceRowCount: 0,
    loadedRowCount: 0,
    selectedRowCount: 0,
    totalCod: 0,
    totalMetricValue: 0,
    rowPaths,
    rowLabel: rowLabels.join(" / "),
    rowLabels,
    columnPaths,
    columnLabel: columnLabels.join(" / "),
    columnLabels,
    valueMetrics: activeMetricOptions,
    pivotColumns: [],
    pivotValueColumns: createPivotValueColumns([], activeMetricOptions),
    groupByPaths: rowPaths,
    groupByLabel: rowLabels.join(" / "),
    groupByLabels: rowLabels,
    metrics: activeMetricOptions,
    primaryMetric,
    primaryMetricOption,
    rows: [],
  };
}

export function createRustPivotQueryFromSheetAnalytics({
  sheetId,
  sheetState,
  filters,
  valueFilters = [],
  selectedRowIds,
  sort = [{ field: "share", direction: "desc" }],
  limit = DEFAULT_RUST_PIVOT_LIMIT,
}: RustPivotQueryParams): PivotQuery {
  const metricOptions = getSheetAnalyticsMetricOptions();
  const values = getActiveValueMetrics(sheetState).map((metric) => {
    const metricOption = getActiveMetricOption(metric, metricOptions, sheetState);
    return {
      field: metricOption.key,
      aggregation:
        metricOption.aggregation ?? getDefaultSheetAnalyticsMetricAggregation(metricOption),
    };
  });

  return {
    sheetId,
    sourceScope: sheetState.analytics.sourceScope,
    filters,
    ...(valueFilters.length > 0 ? { valueFilters } : {}),
    selectedRowIds,
    rowFields: getActiveRowPaths(sheetState),
    columnFields:
      sheetState.analytics.chartType === "pivot" ? getActiveColumnPaths(sheetState) : [],
    values,
    sort,
    limit,
  };
}

export function createSheetAnalyticsSummaryFromRustChart({
  sheetState,
  chartResult,
  selectedRowCount,
}: RustChartSummaryParams): SheetAnalyticsSummary {
  return createSheetAnalyticsSummaryFromRustPivot({
    sheetState,
    pivotResult: {
      sheetId: chartResult.sheetId,
      sourceRowCount: chartResult.sourceRowCount,
      rows: chartResult.series,
    },
    selectedRowCount,
  });
}

export function createSheetAnalyticsSummaryFromRustPivot({
  sheetState,
  pivotResult,
  selectedRowCount,
}: RustPivotSummaryParams): SheetAnalyticsSummary {
  const rowPaths = getActiveRowPaths(sheetState);
  const columnPaths = getActiveColumnPaths(sheetState);
  const metricOptions = getSheetAnalyticsMetricOptions();
  const activeMetricOptions = getActiveValueMetrics(sheetState).map((metric) =>
    getActiveMetricOption(metric, metricOptions, sheetState)
  );
  const primaryMetric =
    sheetState.analytics.chartType === "pivot"
      ? activeMetricOptions[0]?.key ?? null
      : activeMetricOptions[0]?.key ?? null;
  const primaryMetricOption =
    activeMetricOptions.find((option) => option.key === primaryMetric) ?? null;
  const rowLabels = rowPaths.length > 0 ? getAnalyticsFieldLabels(rowPaths) : ["Semua Row"];
  const columnLabels = getAnalyticsFieldLabels(columnPaths);
  const rustRows = pivotResult.rows
    .map(parseRustPivotRow)
    .filter((row): row is RustPivotRow => row !== null);
  const pivotColumns = createPivotColumns(rustRows, columnPaths);
  const pivotValueColumns = createPivotValueColumns(pivotColumns, activeMetricOptions);
  const rowGroups = new Map<string, SheetAnalyticsRow>();

  for (const rustRow of rustRows) {
    const rowValues = rustRow.rowValues.length > 0 ? rustRow.rowValues : ["Semua Row"];
    const rowKey = getColumnKey(rowValues);
    const existing = rowGroups.get(rowKey) ?? {
      key: rowKey,
      label: rowValues.join(" / "),
      rowValues,
      groupValues: rowValues,
      count: 0,
      codTotal: 0,
      metricValues: { count: 0 },
      metricDisplayValues: {},
      pivotMetricValues: {},
      pivotMetricDisplayValues: {},
      metricValue: 0,
      share: 0,
    };
    const columnKey = columnPaths.length > 0 ? getColumnKey(rustRow.columnValues) : "[]";
    const nextRow: SheetAnalyticsRow = {
      ...existing,
      count: existing.count + rustRow.count,
      metricValues: { ...existing.metricValues },
      metricDisplayValues: { ...existing.metricDisplayValues },
      pivotMetricValues: { ...existing.pivotMetricValues },
      pivotMetricDisplayValues: { ...existing.pivotMetricDisplayValues },
    };

    nextRow.metricValues.count = nextRow.count;
    for (const metricOption of activeMetricOptions) {
      const aggregation =
        metricOption.aggregation ?? getDefaultSheetAnalyticsMetricAggregation(metricOption);
      const rustMetricKey = getMetricKey(metricOption.key, aggregation);
      const rawMetricValue = rustRow.metrics[rustMetricKey];
      const numericValue = getNumericMetricValue(rawMetricValue, aggregation);
      const displayValue = getMetricDisplayValue(rawMetricValue);
      const pivotValueColumnKey =
        columnPaths.length > 0
          ? `${columnKey}:${metricOption.key}`
          : `value:${metricOption.key}`;

      nextRow.metricValues[metricOption.key] =
        (nextRow.metricValues[metricOption.key] ?? 0) + numericValue;
      nextRow.pivotMetricValues[pivotValueColumnKey] = numericValue;
      if (displayValue !== null) {
        nextRow.pivotMetricDisplayValues[pivotValueColumnKey] = displayValue;
        if (!nextRow.metricDisplayValues[metricOption.key]) {
          nextRow.metricDisplayValues[metricOption.key] = displayValue;
        }
      }
    }

    rowGroups.set(rowKey, nextRow);
  }

  const rows = Array.from(rowGroups.values()).map((row) => {
    const metricValue = primaryMetric ? row.metricValues[primaryMetric] ?? 0 : 0;
    return {
      ...row,
      metricValue,
      share:
        pivotResult.sourceRowCount > 0
          ? (row.count / pivotResult.sourceRowCount) * 100
          : 0,
    };
  });
  const totalMetricValue = rows.reduce((total, row) => total + row.metricValue, 0);

  return {
    ...createEmptySheetAnalyticsSummary(sheetState),
    sourceRowCount: pivotResult.sourceRowCount,
    loadedRowCount: pivotResult.sourceRowCount,
    selectedRowCount,
    totalMetricValue,
    rowPaths,
    rowLabel: rowLabels.join(" / "),
    rowLabels,
    columnPaths,
    columnLabel: columnLabels.join(" / "),
    columnLabels,
    valueMetrics: activeMetricOptions,
    pivotColumns,
    pivotValueColumns,
    groupByPaths: rowPaths,
    groupByLabel: rowLabels.join(" / "),
    groupByLabels: rowLabels,
    metrics: activeMetricOptions,
    primaryMetric,
    primaryMetricOption,
    rows,
  };
}
