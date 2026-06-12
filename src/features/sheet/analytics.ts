import { ANALYTICS_FIELD_COLUMN_PATHS, COLUMNS } from "./columns";
import {
  SheetAnalyticsMetric,
  SheetAnalyticsMetricAggregation,
} from "./types";

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
  rowValues: string[];
  groupValues: string[];
  count: number;
  codTotal: number;
  metricValues: Record<SheetAnalyticsMetric, number>;
  metricDisplayValues: Record<SheetAnalyticsMetric, string>;
  pivotMetricValues: Record<string, number>;
  pivotMetricDisplayValues: Record<string, string>;
  metricValue: number;
  share: number;
};

export type SheetAnalyticsPivotColumn = {
  key: string;
  label: string;
  values: string[];
};

export type SheetAnalyticsPivotValueColumn = {
  key: string;
  label: string;
  columnKey: string;
  columnValues: string[];
  metric: SheetAnalyticsMetricOption;
};

export type SheetAnalyticsSummary = {
  sourceRowCount: number;
  loadedRowCount: number;
  selectedRowCount: number;
  totalCod: number;
  totalMetricValue: number;
  rowPaths: string[];
  rowLabel: string;
  rowLabels: string[];
  columnPaths: string[];
  columnLabel: string;
  columnLabels: string[];
  valueMetrics: SheetAnalyticsMetricOption[];
  pivotColumns: SheetAnalyticsPivotColumn[];
  pivotValueColumns: SheetAnalyticsPivotValueColumn[];
  groupByPaths: string[];
  groupByLabel: string;
  groupByLabels: string[];
  metrics: SheetAnalyticsMetricOption[];
  primaryMetric: SheetAnalyticsMetric | null;
  primaryMetricOption: SheetAnalyticsMetricOption | null;
  rows: SheetAnalyticsRow[];
};

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
  { key: "count", label: "Jumlah Data" },
  { key: "count_unique", label: "Banyaknya Nilai Berbeda" },
  { key: "most_frequent", label: "Paling Sering" },
  { key: "first", label: "Pertama" },
  { key: "last", label: "Terakhir" },
];

function isAnalyticsColumnAllowed(path: string) {
  return ANALYTICS_ALLOWED_COLUMN_PATHS.has(path);
}

export function getSheetAnalyticsGroupByOptions(): SheetAnalyticsGroupByOption[] {
  return COLUMNS.filter((column) => isAnalyticsColumnAllowed(column.path)).map((column) => ({
    path: column.path,
    label: column.label,
  }));
}

export function getSheetAnalyticsMetricOptions(): SheetAnalyticsMetricOption[] {
  return COLUMNS.filter((column) => isAnalyticsColumnAllowed(column.path)).map((column) => ({
    key: column.path,
    label: column.label,
    format:
      column.type === "currency"
        ? "currency" as const
        : column.type === "number" || column.type === "weight"
          ? "number" as const
          : "text" as const,
    path: column.path,
  }));
}

export function getSheetAnalyticsMetricAggregationOptions(
  metricOption: SheetAnalyticsMetricOption
): SheetAnalyticsMetricAggregationOption[] {
  return metricOption.format === "text"
    ? TEXT_AGGREGATION_OPTIONS
    : NUMBER_AGGREGATION_OPTIONS;
}

export function getDefaultSheetAnalyticsMetricAggregation(
  metricOption: SheetAnalyticsMetricOption
): SheetAnalyticsMetricAggregation {
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
