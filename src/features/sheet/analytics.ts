import { ANALYTICS_FIELD_COLUMN_PATHS, COLUMNS } from "./columns";
import {
  ColumnDefinition,
  SheetAnalyticsMetric,
  SheetAnalyticsMetricAggregation,
  SheetRow,
  SheetState,
} from "./types";
import { formatColumnValue, getRawColumnValue } from "./utils";

const COUNT_METRIC_KEY = "count";
const LEGACY_COD_TOTAL_METRIC_KEY = "cod_total";
const COD_TOTAL_COLUMN_PATH = "detail.billing_detail.cod_info.total_cod";
export const ANALYTICS_ALLOWED_COLUMN_PATHS = new Set<string>(
  ANALYTICS_FIELD_COLUMN_PATHS
);
export const ANALYTICS_EXCLUDED_COLUMN_PATHS = new Set(
  COLUMNS.filter((column) => !ANALYTICS_ALLOWED_COLUMN_PATHS.has(column.path)).map(
    (column) => column.path
  )
);

export type SheetAnalyticsGroupByOption = {
  path: string;
  label: string;
};

export type SheetAnalyticsMetricOption = {
  key: SheetAnalyticsMetric;
  label: string;
  format: "number" | "currency" | "text";
  path?: string;
  aggregation?: SheetAnalyticsMetricAggregation;
  aggregationLabel?: string;
};

export type SheetAnalyticsRow = {
  key: string;
  label: string;
  groupValues: string[];
  count: number;
  codTotal: number;
  metricValues: Record<SheetAnalyticsMetric, number>;
  metricDisplayValues: Record<SheetAnalyticsMetric, string>;
  metricValue: number;
  share: number;
};

export type SheetAnalyticsSummary = {
  sourceRowCount: number;
  loadedRowCount: number;
  selectedRowCount: number;
  totalCod: number;
  totalMetricValue: number;
  groupByPaths: string[];
  groupByLabel: string;
  groupByLabels: string[];
  metrics: SheetAnalyticsMetricOption[];
  primaryMetric: SheetAnalyticsMetric | null;
  primaryMetricOption: SheetAnalyticsMetricOption | null;
  rows: SheetAnalyticsRow[];
};

const ANALYTICS_METRIC_OPTIONS: SheetAnalyticsMetricOption[] = [
  { key: COUNT_METRIC_KEY, label: "Jumlah Kiriman", format: "number" },
];

export type SheetAnalyticsMetricAggregationOption = {
  key: SheetAnalyticsMetricAggregation;
  label: string;
};

const NUMBER_AGGREGATION_OPTIONS: SheetAnalyticsMetricAggregationOption[] = [
  { key: "sum", label: "Jumlah" },
  { key: "average", label: "Rata-rata" },
  { key: "max", label: "Nilai Maksimum" },
  { key: "min", label: "Nilai Minimum" },
  { key: "count", label: "Jumlah Data" },
  { key: "count_unique", label: "Banyaknya Nilai Berbeda" },
];

const TEXT_AGGREGATION_OPTIONS: SheetAnalyticsMetricAggregationOption[] = [
  { key: "unique_list", label: "Teks" },
  { key: "most_frequent", label: "Paling Sering" },
  { key: "first", label: "Pertama" },
  { key: "last", label: "Terakhir" },
];

const COUNT_AGGREGATION_OPTIONS: SheetAnalyticsMetricAggregationOption[] = [
  { key: "count", label: "Jumlah Data" },
];

function isAnalyticsColumnAllowed(path: string) {
  return ANALYTICS_ALLOWED_COLUMN_PATHS.has(path);
}

function isNumericAnalyticsColumn(column: ColumnDefinition) {
  return (
    column.type === "currency" || column.type === "number" || column.type === "weight"
  );
}

function getEmptyAnalyticsColumnValue(column: ColumnDefinition) {
  return isNumericAnalyticsColumn(column) ? "0" : "-";
}

function getAnalyticsGroupValue(row: SheetRow, column: ColumnDefinition) {
  const value = formatColumnValue(row, column).trim();
  return value === "-" || value === "" ? getEmptyAnalyticsColumnValue(column) : value;
}

export function getSheetAnalyticsGroupByOptions(): SheetAnalyticsGroupByOption[] {
  return COLUMNS.filter((column) => isAnalyticsColumnAllowed(column.path)).map((column) => ({
    path: column.path,
    label: column.label,
  }));
}

export function getSheetAnalyticsMetricOptions(): SheetAnalyticsMetricOption[] {
  return [
    ...ANALYTICS_METRIC_OPTIONS,
    ...COLUMNS.filter((column) => isAnalyticsColumnAllowed(column.path)).map((column) => ({
      key: column.path,
      label: column.label,
      format:
        column.type === "currency"
          ? "currency" as const
          : column.type === "number" || column.type === "weight"
            ? "number" as const
            : "text" as const,
      path: column.path,
    })),
  ];
}

export function getSheetAnalyticsMetricAggregationOptions(
  metricOption: SheetAnalyticsMetricOption
): SheetAnalyticsMetricAggregationOption[] {
  if (metricOption.key === COUNT_METRIC_KEY) {
    return COUNT_AGGREGATION_OPTIONS;
  }

  return metricOption.format === "text"
    ? TEXT_AGGREGATION_OPTIONS
    : NUMBER_AGGREGATION_OPTIONS;
}

export function getDefaultSheetAnalyticsMetricAggregation(
  metricOption: SheetAnalyticsMetricOption
): SheetAnalyticsMetricAggregation {
  if (metricOption.key === COUNT_METRIC_KEY) {
    return "count";
  }

  return metricOption.format === "text" ? "unique_list" : "sum";
}

export function isValidSheetAnalyticsMetricAggregation(
  metricOption: SheetAnalyticsMetricOption,
  aggregation: unknown
): aggregation is SheetAnalyticsMetricAggregation {
  return getSheetAnalyticsMetricAggregationOptions(metricOption).some(
    (option) => option.key === aggregation
  );
}

export function getSheetAnalyticsMetricAggregationLabel(
  metricOption: SheetAnalyticsMetricOption,
  aggregation: SheetAnalyticsMetricAggregation
) {
  return (
    getSheetAnalyticsMetricAggregationOptions(metricOption).find(
      (option) => option.key === aggregation
    )?.label ?? aggregation
  );
}

function getCodTotal(row: SheetRow) {
  const rawValue = row.shipment?.detail.billing_detail.cod_info.total_cod;
  return typeof rawValue === "number" && Number.isFinite(rawValue) ? rawValue : 0;
}

function isAnalyticsRow(row: SheetRow) {
  return row.trackingInput.trim() !== "" || row.shipment !== null;
}

function dedupeByKey<T extends string>(values: T[]) {
  const seen = new Set<T>();
  return values.filter((value) => {
    if (seen.has(value)) {
      return false;
    }

    seen.add(value);
    return true;
  });
}

function getActiveGroupByPaths(sheetState: SheetState) {
  const groupByOptions = getSheetAnalyticsGroupByOptions();
  const validPathSet = new Set(groupByOptions.map((option) => option.path));
  const selectedPaths = dedupeByKey(sheetState.analytics.groupByPaths).filter((path) =>
    validPathSet.has(path)
  );

  return selectedPaths;
}

function getActiveMetrics(sheetState: SheetState) {
  const metricOptions = getSheetAnalyticsMetricOptions();
  const metricKeySet = new Set(metricOptions.map((option) => option.key));
  const normalizedMetrics = sheetState.analytics.metrics.map((metric) =>
    metric === LEGACY_COD_TOTAL_METRIC_KEY ? COD_TOTAL_COLUMN_PATH : metric
  );

  return dedupeByKey(normalizedMetrics.filter((metric) => metricKeySet.has(metric)));
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

type MetricAccumulator = {
  count: number;
  sum: number;
  numericValues: number[];
  textValues: string[];
};

function getMetricRawValues(row: SheetRow, metricOption: SheetAnalyticsMetricOption) {
  if (metricOption.key === COUNT_METRIC_KEY) {
    return {
      numericValue: 1,
      textValue: "1",
    };
  }

  const column = metricOption.path
    ? COLUMNS.find((item) => item.path === metricOption.path) ?? null
    : null;
  if (!column) {
    return null;
  }

  const rawValue = getRawColumnValue(row, column);
  const formattedValue = formatColumnValue(row, column).trim();
  if (formattedValue === "-" || formattedValue === "") {
    return null;
  }

  let numericValue: number | null = null;
  if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
    numericValue = rawValue;
  } else if (typeof rawValue === "boolean") {
    numericValue = rawValue ? 1 : 0;
  } else if (column.type === "currency" || column.type === "number" || column.type === "weight") {
    const parsedNumber = Number(rawValue);
    numericValue = Number.isFinite(parsedNumber) ? parsedNumber : null;
  }

  return {
    numericValue,
    textValue: formattedValue,
  };
}

function formatTextMetricDisplay(values: string[] | undefined) {
  if (!values || values.length === 0) {
    return "-";
  }

  const visibleValues = values.slice(0, 3);
  return values.length > visibleValues.length
    ? `${visibleValues.join(", ")} +${values.length - visibleValues.length}`
    : visibleValues.join(", ");
}

function getMostFrequentMetricText(values: string[]) {
  if (values.length === 0) {
    return "-";
  }

  const frequencyByValue = new Map<string, number>();
  for (const value of values) {
    frequencyByValue.set(value, (frequencyByValue.get(value) ?? 0) + 1);
  }

  return Array.from(frequencyByValue.entries()).sort((left, right) => {
    if (left[1] !== right[1]) {
      return right[1] - left[1];
    }

    return left[0].localeCompare(right[0], "id", {
      sensitivity: "base",
      numeric: true,
    });
  })[0][0];
}

function createMetricAccumulator(): MetricAccumulator {
  return {
    count: 0,
    sum: 0,
    numericValues: [],
    textValues: [],
  };
}

function addMetricAccumulatorValue(
  accumulator: MetricAccumulator | undefined,
  row: SheetRow,
  metricOption: SheetAnalyticsMetricOption
) {
  const nextAccumulator = accumulator ?? createMetricAccumulator();
  const metricValues = getMetricRawValues(row, metricOption);
  if (!metricValues) {
    return nextAccumulator;
  }

  nextAccumulator.count += 1;
  nextAccumulator.textValues.push(metricValues.textValue);
  if (metricValues.numericValue !== null) {
    nextAccumulator.sum += metricValues.numericValue;
    nextAccumulator.numericValues.push(metricValues.numericValue);
  }

  return nextAccumulator;
}

function getUniqueMetricValues(values: string[]) {
  return dedupeByKey(values);
}

function getMetricAggregate(
  accumulator: MetricAccumulator | undefined,
  metricOption: SheetAnalyticsMetricOption
) {
  const aggregation = metricOption.aggregation ?? getDefaultSheetAnalyticsMetricAggregation(
    metricOption
  );
  const count = accumulator?.count ?? 0;
  const numericValues = accumulator?.numericValues ?? [];
  const textValues = accumulator?.textValues ?? [];
  const uniqueValues = getUniqueMetricValues(textValues);

  switch (aggregation) {
    case "average": {
      const value =
        numericValues.length > 0
          ? numericValues.reduce((total, value) => total + value, 0) / numericValues.length
          : 0;
      return { numericValue: value, displayValue: null };
    }
    case "min":
      return {
        numericValue: numericValues.length > 0 ? Math.min(...numericValues) : 0,
        displayValue: null,
      };
    case "max":
      return {
        numericValue: numericValues.length > 0 ? Math.max(...numericValues) : 0,
        displayValue: null,
      };
    case "count":
      return { numericValue: count, displayValue: null };
    case "count_unique":
      return { numericValue: uniqueValues.length, displayValue: null };
    case "unique_list":
      return {
        numericValue: uniqueValues.length,
        displayValue: formatTextMetricDisplay(uniqueValues),
      };
    case "most_frequent": {
      const value = getMostFrequentMetricText(textValues);
      const frequency = value === "-" ? 0 : textValues.filter((item) => item === value).length;
      return {
        numericValue: frequency,
        displayValue: value,
      };
    }
    case "first":
      return {
        numericValue: textValues.length > 0 ? 1 : 0,
        displayValue: textValues[0] ?? "-",
      };
    case "last":
      return {
        numericValue: textValues.length > 0 ? 1 : 0,
        displayValue: textValues[textValues.length - 1] ?? "-",
      };
    default:
      return { numericValue: accumulator?.sum ?? 0, displayValue: null };
  }
}

export function getSheetAnalyticsSourceRows(params: {
  sheetState: SheetState;
  nonEmptyRows: SheetRow[];
  displayedRows: SheetRow[];
  selectedVisibleRowKeys: string[];
}) {
  const { sheetState, nonEmptyRows, displayedRows, selectedVisibleRowKeys } = params;

  switch (sheetState.analytics.sourceScope) {
    case "all_rows":
      return nonEmptyRows.filter(isAnalyticsRow);
    case "selected_rows": {
      const selectedKeySet = new Set(selectedVisibleRowKeys);
      return sheetState.rows.filter(
        (row) => selectedKeySet.has(row.key) && isAnalyticsRow(row)
      );
    }
    default:
      return displayedRows.filter(isAnalyticsRow);
  }
}

export function getSheetAnalyticsSummary(params: {
  sheetState: SheetState;
  nonEmptyRows: SheetRow[];
  displayedRows: SheetRow[];
  selectedVisibleRowKeys: string[];
}): SheetAnalyticsSummary {
  const { sheetState, nonEmptyRows, displayedRows, selectedVisibleRowKeys } = params;
  const groupByPaths = getActiveGroupByPaths(sheetState);
  const groupByColumns = groupByPaths
    .map((path) => COLUMNS.find((column) => column.path === path) ?? null)
    .filter((column): column is NonNullable<typeof column> => column !== null);
  const metrics = getActiveMetrics(sheetState);
  const metricOptions = getSheetAnalyticsMetricOptions();
  const activeMetricOptions = metrics.map((metric) =>
    getActiveMetricOption(metric, metricOptions, sheetState)
  );
  const pivotSplitMetricOptions =
    sheetState.analytics.chartType === "pivot"
      ? activeMetricOptions.filter(
          (metricOption) =>
            metricOption.format === "text" &&
            metricOption.aggregation === "unique_list"
        )
      : [];
  const pivotSplitMetricKeySet = new Set(
    pivotSplitMetricOptions.map((metricOption) => metricOption.key)
  );
  const displayMetricOptions =
    sheetState.analytics.chartType === "pivot"
      ? activeMetricOptions.filter(
          (metricOption) => !pivotSplitMetricKeySet.has(metricOption.key)
        )
      : activeMetricOptions;
  const primaryMetric =
    sheetState.analytics.chartType === "pivot"
      ? displayMetricOptions.find((metricOption) => metricOption.key === COUNT_METRIC_KEY)
          ?.key ?? displayMetricOptions[0]?.key ?? null
      : metrics[0] ?? null;
  const primaryMetricOption =
    (sheetState.analytics.chartType === "pivot"
      ? displayMetricOptions
      : activeMetricOptions
    ).find((option) => option.key === primaryMetric) ?? null;
  const sourceRows = getSheetAnalyticsSourceRows({
    sheetState,
    nonEmptyRows,
    displayedRows,
    selectedVisibleRowKeys,
  });
  const groups = new Map<
    string,
    {
      key: string;
      label: string;
      groupValues: string[];
      count: number;
      codTotal: number;
      metricAccumulators: Record<string, MetricAccumulator>;
    }
  >();

  for (const row of sourceRows) {
    const groupValues = groupByColumns.map((column) => getAnalyticsGroupValue(row, column));
    const pivotSplitValues = pivotSplitMetricOptions.map((metricOption) => {
      const metricValues = getMetricRawValues(row, metricOption);
      return metricValues?.textValue ?? "-";
    });
    const normalizedGroupValues =
      groupValues.length > 0 ? groupValues : pivotSplitValues.length > 0 ? [] : ["Semua Row"];
    const allGroupValues = [...normalizedGroupValues, ...pivotSplitValues];
    const label = allGroupValues.join(" / ");
    const key = JSON.stringify(allGroupValues);
    const current = groups.get(key) ?? {
      key,
      label,
      groupValues: allGroupValues,
      count: 0,
      codTotal: 0,
      metricAccumulators: {},
    };
    const nextMetricAccumulators = { ...current.metricAccumulators };
    for (const metricOption of activeMetricOptions) {
      nextMetricAccumulators[metricOption.key] = addMetricAccumulatorValue(
        nextMetricAccumulators[metricOption.key],
        row,
        metricOption
      );
    }
    groups.set(key, {
      key: current.key,
      label: current.label,
      groupValues: current.groupValues,
      count: current.count + 1,
      codTotal: current.codTotal + getCodTotal(row),
      metricAccumulators: nextMetricAccumulators,
    });
  }

  const totalCod = sourceRows.reduce((total, row) => total + getCodTotal(row), 0);
  const usesPivotCountShare = sheetState.analytics.chartType === "pivot";
  const rows = Array.from(groups.values(), (group) => {
    const metricValues: Record<string, number> = {
      count: group.count,
      [COD_TOTAL_COLUMN_PATH]: group.codTotal,
    };
    const metricDisplayValues: Record<string, string> = {};
    for (const metricOption of activeMetricOptions) {
      const aggregate = getMetricAggregate(
        group.metricAccumulators[metricOption.key],
        metricOption
      );
      metricValues[metricOption.key] = aggregate.numericValue;
      if (aggregate.displayValue !== null) {
        metricDisplayValues[metricOption.key] = aggregate.displayValue;
      }
    }
    return {
      key: group.key,
      label: group.label,
      groupValues: group.groupValues,
      count: group.count,
      codTotal: group.codTotal,
      metricValues,
      metricDisplayValues,
      metricValue: primaryMetric ? metricValues[primaryMetric] : 0,
      share: 0,
    };
  }).sort((left, right) => {
    if (left.metricValue !== right.metricValue) {
      return right.metricValue - left.metricValue;
    }

    if (left.count !== right.count) {
      return right.count - left.count;
    }

    return left.label.localeCompare(right.label, "id", {
      sensitivity: "base",
      numeric: true,
    });
  });
  const totalMetricValue = rows.reduce((total, row) => total + row.metricValue, 0);
  const totalShareValue = usesPivotCountShare
    ? rows.reduce((total, row) => total + row.count, 0)
    : totalMetricValue;

  return {
    sourceRowCount: sourceRows.length,
    loadedRowCount: sourceRows.filter((row) => row.shipment !== null).length,
    selectedRowCount: selectedVisibleRowKeys.length,
    totalCod,
    totalMetricValue,
    groupByPaths,
    groupByLabel:
      groupByColumns.length > 0 || pivotSplitMetricOptions.length > 0
        ? [
            ...groupByColumns.map((column) => column.label),
            ...pivotSplitMetricOptions.map((metricOption) => metricOption.label),
          ].join(" / ")
        : "Semua Row",
    groupByLabels:
      groupByColumns.length > 0 || pivotSplitMetricOptions.length > 0
        ? [
            ...groupByColumns.map((column) => column.label),
            ...pivotSplitMetricOptions.map((metricOption) => metricOption.label),
          ]
        : ["Semua Row"],
    metrics: displayMetricOptions,
    primaryMetric,
    primaryMetricOption,
    rows: rows.map((row) => ({
      ...row,
      share:
        totalShareValue > 0
          ? ((usesPivotCountShare ? row.count : row.metricValue) / totalShareValue) * 100
          : 0,
    })),
  };
}
