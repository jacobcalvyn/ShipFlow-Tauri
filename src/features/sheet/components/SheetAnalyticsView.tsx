import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import {
  getSheetAnalyticsMetricAggregationOptions,
  SheetAnalyticsGroupByOption,
  SheetAnalyticsMetricOption,
  SheetAnalyticsRow,
  SheetAnalyticsSummary,
} from "../analytics";
import {
  SheetAnalyticsChartType,
  SheetAnalyticsMetric,
  SheetAnalyticsMetricAggregation,
  SheetAnalyticsSourceScope,
  SheetAnalyticsState,
} from "../types";
import { formatNumber } from "../utils";

type SheetAnalyticsViewProps = {
  analytics: SheetAnalyticsState;
  groupByOptions: SheetAnalyticsGroupByOption[];
  metricOptions: SheetAnalyticsMetricOption[];
  summary: SheetAnalyticsSummary;
  onSourceScopeChange: (sourceScope: SheetAnalyticsSourceScope) => void;
  onGroupByPathsChange: (groupByPaths: string[]) => void;
  onMetricsChange: (metrics: SheetAnalyticsMetric[]) => void;
  onMetricAggregationChange: (
    metric: SheetAnalyticsMetric,
    aggregation: SheetAnalyticsMetricAggregation
  ) => void;
  onChartTypeChange: (chartType: SheetAnalyticsChartType) => void;
};

type AnalyticsPickerOption = {
  key: string;
  label: string;
  format?: SheetAnalyticsMetricOption["format"];
  aggregation?: SheetAnalyticsMetricOption["aggregation"];
};

type AnalyticsFieldPickerProps = {
  title: string;
  options: AnalyticsPickerOption[];
  selectedKeys: string[];
  aggregationValues?: Partial<Record<string, SheetAnalyticsMetricAggregation>>;
  onSelectedKeysChange: (keys: string[]) => void;
  onAggregationChange?: (
    key: string,
    aggregation: SheetAnalyticsMetricAggregation
  ) => void;
};

const CHART_COLORS = [
  "#2563eb",
  "#16a34a",
  "#f59e0b",
  "#dc2626",
  "#0891b2",
  "#7c3aed",
  "#475569",
  "#db2777",
];
const DEFAULT_PIVOT_SORT = {
  key: "share",
  direction: "desc",
} as const;
const EMPTY_PIVOT_SORT = {
  key: "",
  direction: "asc",
} as const;

type PivotSortDirection = "asc" | "desc";

type PivotSortState = {
  key: string;
  direction: PivotSortDirection;
};

function formatCurrency(value: number) {
  return `Rp ${formatNumber(value)}`;
}

function formatMetricValue(metric: SheetAnalyticsMetricOption, value: number) {
  if (metric.format === "currency") {
    return formatCurrency(value);
  }

  return formatNumber(value);
}

function formatMetricLabel(metric: SheetAnalyticsMetricOption) {
  if (!metric.aggregationLabel || metric.key === "count") {
    return metric.label;
  }

  return `${metric.label} (${metric.aggregationLabel})`;
}

function formatMetricOptionValue(metric: SheetAnalyticsMetricOption, row: SheetAnalyticsRow) {
  const displayValue = row.metricDisplayValues[metric.key];
  if (displayValue) {
    return displayValue;
  }

  return formatMetricValue(metric, row.metricValues[metric.key] ?? 0);
}

function compareTextValues(left: string, right: string) {
  return left.localeCompare(right, "id", {
    sensitivity: "base",
    numeric: true,
  });
}

function applySortDirection(value: number, direction: PivotSortDirection) {
  return direction === "asc" ? value : -value;
}

function getPivotSortDirection(sortKey: string) {
  return sortKey.startsWith("group:") ? "asc" : "desc";
}

function isPivotSortAvailable(
  sortKey: string,
  summary: SheetAnalyticsSummary,
  hasPrimaryMetric: boolean
) {
  if (sortKey === "share") {
    return hasPrimaryMetric;
  }

  if (sortKey.startsWith("group:")) {
    const groupIndex = Number(sortKey.slice("group:".length));
    return (
      Number.isInteger(groupIndex) &&
      groupIndex >= 0 &&
      groupIndex < summary.groupByLabels.length
    );
  }

  if (sortKey.startsWith("metric:")) {
    const metricKey = sortKey.slice("metric:".length);
    return summary.metrics.some((metric) => metric.key === metricKey);
  }

  return false;
}

function comparePivotRows(
  left: SheetAnalyticsRow,
  right: SheetAnalyticsRow,
  sortState: PivotSortState
) {
  let result = 0;
  if (sortState.key === "share") {
    result = left.share - right.share;
  } else if (sortState.key.startsWith("group:")) {
    const groupIndex = Number(sortState.key.slice("group:".length));
    result = compareTextValues(
      left.groupValues[groupIndex] ?? "",
      right.groupValues[groupIndex] ?? ""
    );
  } else if (sortState.key.startsWith("metric:")) {
    const metricKey = sortState.key.slice("metric:".length);
    result =
      (left.metricValues[metricKey] ?? 0) - (right.metricValues[metricKey] ?? 0);
    if (result === 0) {
      result = compareTextValues(
        left.metricDisplayValues[metricKey] ?? "",
        right.metricDisplayValues[metricKey] ?? ""
      );
    }
  }

  if (result === 0) {
    return compareTextValues(left.label, right.label);
  }

  return applySortDirection(result, sortState.direction);
}

function getFallbackPivotSort(
  summary: SheetAnalyticsSummary,
  hasPrimaryMetric: boolean
): PivotSortState {
  if (hasPrimaryMetric) {
    return DEFAULT_PIVOT_SORT;
  }

  if (summary.groupByLabels.length > 0) {
    return {
      key: "group:0",
      direction: "asc",
    };
  }

  const firstMetric = summary.metrics[0];
  if (firstMetric) {
    return {
      key: `metric:${firstMetric.key}`,
      direction: "desc",
    };
  }

  return EMPTY_PIVOT_SORT;
}

function getSortIndicator(sortState: PivotSortState, sortKey: string) {
  if (sortState.key !== sortKey) {
    return "";
  }

  return sortState.direction === "asc" ? "↑" : "↓";
}

function getSortAria(sortState: PivotSortState, sortKey: string) {
  if (sortState.key !== sortKey) {
    return "none" as const;
  }

  return sortState.direction === "asc" ? "ascending" as const : "descending" as const;
}

function AnalyticsFieldPicker({
  title,
  options,
  selectedKeys,
  aggregationValues,
  onSelectedKeysChange,
  onAggregationChange,
}: AnalyticsFieldPickerProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const optionMap = new Map(options.map((option) => [option.key, option]));
  const selectedOptions = selectedKeys.flatMap((key) => {
    const option = optionMap.get(key);
    return option ? [option] : [];
  });
  const selectedKeySet = new Set(selectedOptions.map((option) => option.key));
  const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase("id");
  const visibleOptions =
    normalizedSearchQuery === ""
      ? options
      : options.filter((option) =>
          `${option.label} ${option.key}`.toLocaleLowerCase("id").includes(normalizedSearchQuery)
        );

  const removeOption = (key: string) => {
    onSelectedKeysChange(selectedKeys.filter((item) => item !== key));
  };

  const toggleOption = (key: string, checked: boolean) => {
    if (!optionMap.has(key)) {
      return;
    }

    if (checked) {
      if (selectedKeySet.has(key)) {
        return;
      }

      onSelectedKeysChange([...selectedKeys, key]);
      return;
    }

    removeOption(key);
  };

  const moveOption = (key: string, direction: -1 | 1) => {
    const currentIndex = selectedKeys.indexOf(key);
    const targetIndex = currentIndex + direction;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= selectedKeys.length) {
      return;
    }

    const nextKeys = [...selectedKeys];
    [nextKeys[currentIndex], nextKeys[targetIndex]] = [
      nextKeys[targetIndex],
      nextKeys[currentIndex],
    ];
    onSelectedKeysChange(nextKeys);
  };

  return (
    <div className="analytics-field analytics-field-picker">
      <span>{title}</span>
      <input
        type="search"
        className="analytics-picker-search"
        value={searchQuery}
        aria-label={`Cari ${title}`}
        placeholder={`Cari ${title.toLowerCase()}...`}
        onChange={(event) => setSearchQuery(event.target.value)}
      />
      <div
        className="analytics-option-list"
        role="group"
        aria-label={`Pilih ${title}`}
      >
        {visibleOptions.length === 0 ? (
          <span className="analytics-option-empty">Field tidak ditemukan</span>
        ) : null}
        {visibleOptions.map((option) => {
          const checked = selectedKeySet.has(option.key);
          return (
            <label
              className={`analytics-option-row${checked ? " is-selected" : ""}`}
              key={option.key}
            >
              <input
                type="checkbox"
                checked={checked}
                aria-label={`Pilih ${title} ${option.label}`}
                onChange={(event) => toggleOption(option.key, event.target.checked)}
              />
              <span>{option.label}</span>
            </label>
          );
        })}
      </div>
      <div className="analytics-selected-list" role="list" aria-label={`${title} aktif`}>
        {selectedOptions.length === 0 ? (
          <span className="analytics-selected-empty">Belum ada field dipilih</span>
        ) : (
          selectedOptions.map((option, index) => {
            const aggregationOptions =
              onAggregationChange && option.format
                ? getSheetAnalyticsMetricAggregationOptions(
                    option as SheetAnalyticsMetricOption
                  )
                : [];
            const selectedAggregation =
              aggregationValues?.[option.key] ?? option.aggregation;
            const aggregationValue =
              aggregationOptions.find((item) => item.key === selectedAggregation)?.key ??
              aggregationOptions[0]?.key;

            return (
              <div className="analytics-selected-row" key={option.key} role="listitem">
                <span className="analytics-selected-label">{option.label}</span>
                {onAggregationChange && option.format && aggregationValue ? (
                  <select
                    className="analytics-aggregation-select"
                    aria-label={`Mode ${title} ${option.label}`}
                    value={aggregationValue}
                    onChange={(event) =>
                      onAggregationChange(
                        option.key,
                        event.target.value as SheetAnalyticsMetricAggregation
                      )
                    }
                  >
                    {aggregationOptions.map((aggregationOption) => (
                      <option key={aggregationOption.key} value={aggregationOption.key}>
                        {aggregationOption.label}
                      </option>
                    ))}
                  </select>
                ) : null}
                <div className="analytics-selected-actions">
                  <button
                    type="button"
                    aria-label={`Naikkan ${title} ${option.label}`}
                    disabled={index === 0}
                    onClick={() => moveOption(option.key, -1)}
                  >
                    ^
                  </button>
                  <button
                    type="button"
                    aria-label={`Turunkan ${title} ${option.label}`}
                    disabled={index === selectedOptions.length - 1}
                    onClick={() => moveOption(option.key, 1)}
                  >
                    v
                  </button>
                  <button
                    type="button"
                    aria-label={`Hapus ${title} ${option.label}`}
                    onClick={() => removeOption(option.key)}
                  >
                    x
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function createDonutBackground(rows: SheetAnalyticsRow[]) {
  const activeRows = rows.filter((row) => row.metricValue > 0);
  if (activeRows.length === 0) {
    return "#e2e8f0";
  }

  let cursor = 0;
  const segments = activeRows.map((row, index) => {
    const start = cursor;
    cursor += row.share;
    return `${CHART_COLORS[index % CHART_COLORS.length]} ${start}% ${cursor}%`;
  });

  return `conic-gradient(${segments.join(", ")})`;
}

export function SheetAnalyticsView({
  analytics,
  groupByOptions,
  metricOptions,
  summary,
  onSourceScopeChange,
  onGroupByPathsChange,
  onMetricsChange,
  onMetricAggregationChange,
  onChartTypeChange,
}: SheetAnalyticsViewProps) {
  const chartRows = summary.rows.slice(0, 12);
  const maxMetricValue = Math.max(...chartRows.map((row) => row.metricValue), 0);
  const metricLabel =
    summary.metrics.length > 0
      ? summary.metrics.map(formatMetricLabel).join(" + ")
      : "Metric";
  const groupByKeys = analytics.groupByPaths;
  const metricKeys = analytics.metrics;
  const primaryMetric = summary.primaryMetric;
  const primaryMetricOption = summary.primaryMetricOption;
  const hasPrimaryMetric = primaryMetric !== null;
  const isPivotMode = analytics.chartType === "pivot";
  const [pivotSort, setPivotSort] = useState<PivotSortState>(DEFAULT_PIVOT_SORT);
  const fallbackPivotSort = getFallbackPivotSort(summary, hasPrimaryMetric);
  const activePivotSort = isPivotSortAvailable(pivotSort.key, summary, hasPrimaryMetric)
    ? pivotSort
    : fallbackPivotSort;
  const pivotRows = useMemo(
    () => [...summary.rows].sort((left, right) =>
      comparePivotRows(left, right, activePivotSort)
    ),
    [activePivotSort, summary.rows]
  );
  const donutStyle: CSSProperties = {
    background: createDonutBackground(chartRows),
  };
  const togglePivotSort = (sortKey: string) => {
    setPivotSort((current) => {
      if (current.key !== sortKey) {
        return {
          key: sortKey,
          direction: getPivotSortDirection(sortKey),
        };
      }

      return {
        key: sortKey,
        direction: current.direction === "asc" ? "desc" : "asc",
      };
    });
  };

  return (
    <div className="sheet-analytics-view">
      <aside className="analytics-action-panel" aria-label="Panel Aksi Pivot Grafik">
        <div className="analytics-inline-controls">
          <label className="analytics-field analytics-select-field">
            <span>Sumber</span>
            <select
              value={analytics.sourceScope}
              aria-label="Sumber Data Pivot"
              onChange={(event) =>
                onSourceScopeChange(event.target.value as SheetAnalyticsSourceScope)
              }
            >
              <option value="filtered_rows">Row Terfilter</option>
              <option value="all_rows">Semua Row</option>
              <option value="selected_rows">Row Terpilih</option>
            </select>
          </label>
          <label className="analytics-field analytics-select-field">
            <span>Mode</span>
            <select
              value={analytics.chartType}
              aria-label="Mode Pivot Grafik"
              onChange={(event) =>
                onChartTypeChange(event.target.value as SheetAnalyticsChartType)
              }
            >
              <option value="pivot">Pivot</option>
              <option value="bar">Bar</option>
              <option value="donut">Donut</option>
            </select>
          </label>
        </div>
        <AnalyticsFieldPicker
          title="Group"
          options={groupByOptions.map((option) => ({
            key: option.path,
            label: option.label,
          }))}
          selectedKeys={groupByKeys}
          onSelectedKeysChange={onGroupByPathsChange}
        />
        <AnalyticsFieldPicker
          title="Metric"
          options={metricOptions}
          selectedKeys={metricKeys}
          aggregationValues={analytics.metricAggregations}
          onSelectedKeysChange={(keys) => onMetricsChange(keys as SheetAnalyticsMetric[])}
          onAggregationChange={(metric, aggregation) =>
            onMetricAggregationChange(metric as SheetAnalyticsMetric, aggregation)
          }
        />
      </aside>

      <div
        className="analytics-main-panel"
        role="region"
        aria-label="Panel Utama Pivot Grafik"
      >
        <div className="analytics-content-stack">
          {isPivotMode ? (
            <section className="analytics-summary-panel" aria-label="Tabel Pivot">
              <div className="analytics-panel-header">
                <span>Pivot</span>
                <strong>{summary.rows.length} group</strong>
              </div>
              <div className="analytics-summary-scroll">
                <table className="analytics-summary-table">
                  <thead>
                    <tr>
                      {summary.groupByLabels.map((label, index) => {
                        const sortKey = `group:${index}`;
                        return (
                          <th key={label} aria-sort={getSortAria(activePivotSort, sortKey)}>
                            <button
                              type="button"
                              className="analytics-sort-header"
                              onClick={() => togglePivotSort(sortKey)}
                            >
                              <span>{label}</span>
                              <span className="sort-indicator is-active">
                                {getSortIndicator(activePivotSort, sortKey)}
                              </span>
                            </button>
                          </th>
                        );
                      })}
                      {summary.metrics.map((metric) => {
                        const sortKey = `metric:${metric.key}`;
                        return (
                          <th
                            key={metric.key}
                            aria-sort={getSortAria(activePivotSort, sortKey)}
                          >
                            <button
                              type="button"
                              className="analytics-sort-header"
                              onClick={() => togglePivotSort(sortKey)}
                            >
                              <span>{formatMetricLabel(metric)}</span>
                              <span className="sort-indicator is-active">
                                {getSortIndicator(activePivotSort, sortKey)}
                              </span>
                            </button>
                          </th>
                        );
                      })}
                      {hasPrimaryMetric ? (
                        <th aria-sort={getSortAria(activePivotSort, "share")}>
                          <button
                            type="button"
                            className="analytics-sort-header"
                            onClick={() => togglePivotSort("share")}
                          >
                            <span>Share</span>
                            <span className="sort-indicator is-active">
                              {getSortIndicator(activePivotSort, "share")}
                            </span>
                          </button>
                        </th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {summary.rows.length === 0 ? (
                      <tr>
                        <td
                          colSpan={
                            summary.groupByLabels.length +
                            summary.metrics.length +
                            (hasPrimaryMetric ? 1 : 0)
                          }
                        >
                          Belum ada data.
                        </td>
                      </tr>
                    ) : (
                      pivotRows.map((row) => (
                        <tr key={row.key}>
                          {summary.groupByLabels.map((label, index) => (
                            <td key={`${label}-${index}`}>
                              {row.groupValues[index] ?? "-"}
                            </td>
                          ))}
                          {summary.metrics.map((metric) => (
                            <td key={metric.key}>
                              {formatMetricOptionValue(metric, row)}
                            </td>
                          ))}
                          {hasPrimaryMetric ? <td>{formatNumber(row.share)}%</td> : null}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          ) : (
            <section className="analytics-chart-panel" aria-label="Grafik Pivot">
              <div className="analytics-panel-header">
                <span>{summary.groupByLabel}</span>
                <strong>{metricLabel}</strong>
              </div>

              {!hasPrimaryMetric ? (
                <div className="analytics-empty">Metric belum dipilih.</div>
              ) : chartRows.length === 0 ? (
                <div className="analytics-empty">Belum ada data siap dianalisis.</div>
              ) : analytics.chartType === "donut" ? (
                <div className="analytics-donut-layout">
                  <div className="analytics-donut" style={donutStyle}>
                    <span>
                      {primaryMetricOption
                        ? formatMetricValue(primaryMetricOption, summary.totalMetricValue)
                        : formatNumber(summary.totalMetricValue)}
                    </span>
                  </div>
                  <div className="analytics-legend">
                    {chartRows.map((row, index) => (
                      <div className="analytics-legend-row" key={row.key}>
                        <span
                          className="analytics-legend-swatch"
                          style={{
                            backgroundColor: CHART_COLORS[index % CHART_COLORS.length],
                          }}
                        />
                        <span>{row.label}</span>
                        <strong>
                          {primaryMetricOption
                            ? formatMetricValue(primaryMetricOption, row.metricValue)
                            : formatNumber(row.metricValue)}
                        </strong>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="analytics-bar-chart">
                  {chartRows.map((row, index) => {
                    const barWidth =
                      maxMetricValue > 0 ? (row.metricValue / maxMetricValue) * 100 : 0;
                    return (
                      <div className="analytics-bar-row" key={row.key}>
                        <span className="analytics-bar-label">{row.label}</span>
                        <div className="analytics-bar-track">
                          <span
                            className="analytics-bar-fill"
                            style={
                              {
                                width: `${barWidth}%`,
                                backgroundColor:
                                  CHART_COLORS[index % CHART_COLORS.length],
                              } as CSSProperties
                            }
                          />
                        </div>
                        <strong>
                          {primaryMetricOption
                            ? formatMetricValue(primaryMetricOption, row.metricValue)
                            : formatNumber(row.metricValue)}
                        </strong>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
