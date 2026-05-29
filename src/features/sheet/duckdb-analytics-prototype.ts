import type { DuckDBBundles } from "@duckdb/duckdb-wasm";
import {
  getDefaultSheetAnalyticsMetricAggregation,
  getSheetAnalyticsSourceRows,
  type SheetAnalyticsMetricOption,
} from "./analytics";
import type { SheetAnalyticsQuery } from "./analytics-engine";
import { ANALYTICS_FIELD_COLUMN_PATHS, COLUMNS } from "./columns";
import type {
  ColumnDefinition,
  SheetAnalyticsMetricAggregation,
  SheetRow,
} from "./types";
import { formatColumnValue, getRawColumnValue } from "./utils";

export const DUCKDB_ANALYTICS_ENGINE_ID = "duckdb-wasm-prototype";
export const DUCKDB_ANALYTICS_DEFAULT_TABLE_NAME = "shipflow_rows";

export type DuckDbAnalyticsRuntimeModule = typeof import("@duckdb/duckdb-wasm");
export type DuckDbAnalyticsBundles = DuckDBBundles;

export type DuckDbAnalyticsColumn = {
  path: string;
  label: string;
  type: "number" | "text";
  valueColumn: string;
  presenceColumn: string;
};

export type DuckDbAnalyticsCellValue = string | number | boolean;

export type DuckDbAnalyticsRow = Record<string, DuckDbAnalyticsCellValue>;

export type DuckDbAnalyticsValueMetric = {
  path: string;
  label: string;
  format: SheetAnalyticsMetricOption["format"];
  aggregation: SheetAnalyticsMetricAggregation;
};

export type DuckDbAnalyticsSqlPlan = {
  engineId: typeof DUCKDB_ANALYTICS_ENGINE_ID;
  tableName: string;
  rowPaths: string[];
  columnPaths: string[];
  valueMetrics: DuckDbAnalyticsValueMetric[];
  rows: DuckDbAnalyticsRow[];
  sql: string;
};

export async function loadDuckDbAnalyticsRuntime(): Promise<DuckDbAnalyticsRuntimeModule> {
  return import("@duckdb/duckdb-wasm");
}

function isNumericAnalyticsColumn(column: ColumnDefinition) {
  return (
    column.type === "currency" || column.type === "number" || column.type === "weight"
  );
}

function isAllowedAnalyticsColumn(column: ColumnDefinition) {
  return ANALYTICS_FIELD_COLUMN_PATHS.includes(
    column.path as (typeof ANALYTICS_FIELD_COLUMN_PATHS)[number]
  );
}

export function getDuckDbAnalyticsColumns(): DuckDbAnalyticsColumn[] {
  return COLUMNS.filter(isAllowedAnalyticsColumn).map((column) => ({
    path: column.path,
    label: column.label,
    type: isNumericAnalyticsColumn(column) ? "number" : "text",
    valueColumn: column.path,
    presenceColumn: `${column.path}__has_value`,
  }));
}

export function quoteDuckDbIdentifier(identifier: string) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function hasFormattedValue(value: string) {
  return value !== "" && value !== "-";
}

function getColumnByPath(path: string) {
  return COLUMNS.find((column) => column.path === path && isAllowedAnalyticsColumn(column));
}

function toNumericCellValue(rawValue: unknown) {
  if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
    return rawValue;
  }

  const parsedValue = Number(rawValue);
  return Number.isFinite(parsedValue) ? parsedValue : 0;
}

export function createDuckDbAnalyticsRows(
  rows: SheetRow[],
  columns = getDuckDbAnalyticsColumns()
): DuckDbAnalyticsRow[] {
  return rows.map((row) => {
    const duckDbRow: DuckDbAnalyticsRow = {};

    for (const analyticsColumn of columns) {
      const column = getColumnByPath(analyticsColumn.path);
      if (!column) {
        continue;
      }

      const formattedValue = formatColumnValue(row, column).trim();
      const hasValue = hasFormattedValue(formattedValue);
      duckDbRow[analyticsColumn.valueColumn] =
        analyticsColumn.type === "number" && hasValue
          ? toNumericCellValue(getRawColumnValue(row, column))
          : analyticsColumn.type === "number"
            ? 0
            : hasValue
              ? formattedValue
              : "-";
      duckDbRow[analyticsColumn.presenceColumn] = hasValue;
    }

    return duckDbRow;
  });
}

function buildMetricAggregationExpression(metric: DuckDbAnalyticsValueMetric) {
  const valueIdentifier = quoteDuckDbIdentifier(metric.path);
  const presenceIdentifier = quoteDuckDbIdentifier(`${metric.path}__has_value`);
  const numericExpression = `try_cast(${valueIdentifier} as double)`;
  const textExpression = `cast(${valueIdentifier} as varchar)`;

  switch (metric.aggregation) {
    case "average":
      return `coalesce(avg(${numericExpression}) filter (where ${presenceIdentifier}), 0)`;
    case "min":
      return `coalesce(min(${numericExpression}) filter (where ${presenceIdentifier}), 0)`;
    case "max":
      return `coalesce(max(${numericExpression}) filter (where ${presenceIdentifier}), 0)`;
    case "count":
      return `sum(case when ${presenceIdentifier} then 1 else 0 end)`;
    case "count_unique":
      return `count(distinct case when ${presenceIdentifier} then ${textExpression} else null end)`;
    case "unique_list":
      return `coalesce(string_agg(distinct case when ${presenceIdentifier} then ${textExpression} else null end, ', '), '-')`;
    case "most_frequent":
      return `coalesce(mode(${textExpression}) filter (where ${presenceIdentifier}), '-')`;
    case "first":
      return `coalesce(first(${textExpression}) filter (where ${presenceIdentifier}), '-')`;
    case "last":
      return `coalesce(last(${textExpression}) filter (where ${presenceIdentifier}), '-')`;
    default:
      return `coalesce(sum(${numericExpression}) filter (where ${presenceIdentifier}), 0)`;
  }
}

function getMetricAlias(metric: DuckDbAnalyticsValueMetric) {
  return `${metric.path}__${metric.aggregation}`;
}

export function buildDuckDbLongFormAnalyticsSql(params: {
  tableName?: string;
  rowPaths: string[];
  columnPaths: string[];
  valueMetrics: DuckDbAnalyticsValueMetric[];
}) {
  const tableName = params.tableName ?? DUCKDB_ANALYTICS_DEFAULT_TABLE_NAME;
  const dimensionPaths = [...params.rowPaths, ...params.columnPaths].filter((path) =>
    Boolean(getColumnByPath(path))
  );
  const selectDimensions = dimensionPaths.map((path) => quoteDuckDbIdentifier(path));
  const metricExpressions = params.valueMetrics.map(
    (metric) =>
      `${buildMetricAggregationExpression(metric)} as ${quoteDuckDbIdentifier(
        getMetricAlias(metric)
      )}`
  );
  const selectExpressions = [
    ...selectDimensions,
    `count(*) as ${quoteDuckDbIdentifier("__row_count")}`,
    ...metricExpressions,
  ];
  const groupByClause =
    dimensionPaths.length > 0
      ? `\nGROUP BY ${dimensionPaths.map(quoteDuckDbIdentifier).join(", ")}`
      : "";
  const orderByClause =
    dimensionPaths.length > 0
      ? `\nORDER BY ${dimensionPaths.map(quoteDuckDbIdentifier).join(", ")}`
      : "";

  return [
    `SELECT ${selectExpressions.join(",\n       ")}`,
    `FROM ${quoteDuckDbIdentifier(tableName)}`,
    `${groupByClause}${orderByClause};`,
  ].join("\n");
}

export function createDuckDbAnalyticsSqlPlan(
  query: SheetAnalyticsQuery,
  options: {
    tableName?: string;
    valueMetrics: SheetAnalyticsMetricOption[];
    rowPaths: string[];
    columnPaths: string[];
  }
): DuckDbAnalyticsSqlPlan {
  const sourceRows = getSheetAnalyticsSourceRows(query);
  const valueMetrics = options.valueMetrics
    .filter((metric) => Boolean(metric.path && getColumnByPath(metric.path)))
    .map((metric) => ({
      path: metric.path as string,
      label: metric.label,
      format: metric.format,
      aggregation:
        metric.aggregation ?? getDefaultSheetAnalyticsMetricAggregation(metric),
    }));
  const rowPaths = options.rowPaths.filter((path) => Boolean(getColumnByPath(path)));
  const columnPaths = options.columnPaths.filter((path) => Boolean(getColumnByPath(path)));
  const tableName = options.tableName ?? DUCKDB_ANALYTICS_DEFAULT_TABLE_NAME;

  return {
    engineId: DUCKDB_ANALYTICS_ENGINE_ID,
    tableName,
    rowPaths,
    columnPaths,
    valueMetrics,
    rows: createDuckDbAnalyticsRows(sourceRows),
    sql: buildDuckDbLongFormAnalyticsSql({
      tableName,
      rowPaths,
      columnPaths,
      valueMetrics,
    }),
  };
}
