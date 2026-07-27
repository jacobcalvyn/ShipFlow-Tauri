import { Fragment, useEffect, useMemo, useState } from "react";
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
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
  onRowPathsChange: (rowPaths: string[]) => void;
  onColumnPathsChange: (columnPaths: string[]) => void;
  onValueMetricsChange: (valueMetrics: SheetAnalyticsMetric[]) => void;
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

type AnalyticsFieldSourceListProps = {
  title: string;
  options: AnalyticsPickerOption[];
  onDragStart: (payload: AnalyticsDragPayload) => void;
  onPointerDragStart: (
    payload: AnalyticsPointerDragPayload,
    event: ReactPointerEvent<HTMLElement>
  ) => void;
  onDragMove: (event: ReactDragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
};

type AnalyticsSelectedFieldListProps = {
  title: string;
  zone: AnalyticsSelectedZone;
  options: AnalyticsPickerOption[];
  selectedKeys: string[];
  aggregationValues?: Partial<Record<string, SheetAnalyticsMetricAggregation>>;
  onSelectedKeysChange: (keys: string[]) => void;
  onAggregationChange?: (
    key: string,
    aggregation: SheetAnalyticsMetricAggregation
  ) => void;
  draggedField: AnalyticsDragPayload | null;
  onDragStart: (payload: AnalyticsDragPayload) => void;
  onPointerDragStart: (
    payload: AnalyticsPointerDragPayload,
    event: ReactPointerEvent<HTMLElement>
  ) => void;
  onDragMove: (event: ReactDragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  dropPreview: AnalyticsDropPreview | null;
  onDropPreviewChange: (preview: AnalyticsDropPreview | null) => void;
  onFieldDrop: (params: AnalyticsFieldDropParams) => void;
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

type AnalyticsSelectedZone = "row" | "column" | "value";

type AnalyticsDragSource = AnalyticsSelectedZone | "field";

type AnalyticsDragPayload = {
  source: AnalyticsDragSource;
  key: string;
};

type AnalyticsPointerDragPayload = AnalyticsDragPayload & {
  label: string;
};

type AnalyticsPointerDragState = AnalyticsPointerDragPayload & {
  active: boolean;
  currentX: number;
  currentY: number;
  startX: number;
  startY: number;
};

type AnalyticsDropPreview = {
  zone: AnalyticsSelectedZone;
  key: string;
  index: number;
};

type AnalyticsFieldDropParams = AnalyticsDragPayload & {
  target: AnalyticsSelectedZone;
  targetIndex: number;
};

const ANALYTICS_FIELD_DRAG_MIME = "application/x-shipflow-analytics-field";

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
  if (!metric.aggregationLabel) {
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

function formatPivotValueColumnValue(
  pivotValueColumn: SheetAnalyticsSummary["pivotValueColumns"][number],
  row: SheetAnalyticsRow
) {
  const displayValue = row.pivotMetricDisplayValues[pivotValueColumn.key];
  if (displayValue) {
    return displayValue;
  }

  return formatMetricValue(
    pivotValueColumn.metric,
    row.pivotMetricValues[pivotValueColumn.key] ?? 0
  );
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
  return sortKey.startsWith("row:") ? "asc" : "desc";
}

function isPivotSortAvailable(
  sortKey: string,
  summary: SheetAnalyticsSummary,
  hasPrimaryMetric: boolean
) {
  if (sortKey === "share") {
    return hasPrimaryMetric;
  }

  if (sortKey.startsWith("row:")) {
    const groupIndex = Number(sortKey.slice("row:".length));
    return (
      Number.isInteger(groupIndex) &&
      groupIndex >= 0 &&
      groupIndex < summary.rowLabels.length
    );
  }

  if (sortKey.startsWith("pivot:")) {
    const pivotColumnKey = sortKey.slice("pivot:".length);
    return summary.pivotValueColumns.some((column) => column.key === pivotColumnKey);
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
  } else if (sortState.key.startsWith("row:")) {
    const groupIndex = Number(sortState.key.slice("row:".length));
    result = compareTextValues(
      left.rowValues[groupIndex] ?? "",
      right.rowValues[groupIndex] ?? ""
    );
  } else if (sortState.key.startsWith("pivot:")) {
    const metricKey = sortState.key.slice("pivot:".length);
    result =
      (left.pivotMetricValues[metricKey] ?? 0) -
      (right.pivotMetricValues[metricKey] ?? 0);
    if (result === 0) {
      result = compareTextValues(
        left.pivotMetricDisplayValues[metricKey] ?? "",
        right.pivotMetricDisplayValues[metricKey] ?? ""
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

  if (summary.rowLabels.length > 0) {
    return {
      key: "row:0",
      direction: "asc",
    };
  }

  const firstPivotValueColumn = summary.pivotValueColumns[0];
  if (firstPivotValueColumn) {
    return {
      key: `pivot:${firstPivotValueColumn.key}`,
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

function getAnalyticsDragPayload(
  event: ReactDragEvent<HTMLElement>,
  fallback: AnalyticsDragPayload | null
): AnalyticsDragPayload | null {
  const rawPayload = event.dataTransfer.getData(ANALYTICS_FIELD_DRAG_MIME);
  if (rawPayload) {
    try {
      const parsedPayload = JSON.parse(rawPayload) as Partial<AnalyticsDragPayload>;
      if (
        (parsedPayload.source === "row" ||
          parsedPayload.source === "column" ||
          parsedPayload.source === "value" ||
          parsedPayload.source === "field") &&
        typeof parsedPayload.key === "string"
      ) {
        return {
          source: parsedPayload.source,
          key: parsedPayload.key,
        };
      }
    } catch {
      return null;
    }
  }

  return fallback;
}

function isInteractiveDragTarget(target: EventTarget | null) {
  return target instanceof HTMLElement
    ? target.closest("button, select, input, textarea, a") !== null
    : false;
}

function getAnalyticsDropZone(value: string | null): AnalyticsSelectedZone | null {
  if (value === "row" || value === "column" || value === "value") {
    return value;
  }

  return null;
}

function AnalyticsSelectedFieldList({
  title,
  zone,
  options,
  selectedKeys,
  aggregationValues,
  onSelectedKeysChange,
  onAggregationChange,
  draggedField,
  onDragStart,
  onPointerDragStart,
  onDragMove,
  onDragEnd,
  dropPreview,
  onDropPreviewChange,
  onFieldDrop,
}: AnalyticsSelectedFieldListProps) {
  const optionMap = new Map(options.map((option) => [option.key, option]));
  const selectedOptions = selectedKeys.flatMap((key) => {
    const option = optionMap.get(key);
    return option ? [option] : [];
  });

  const removeOption = (key: string) => {
    onSelectedKeysChange(selectedKeys.filter((item) => item !== key));
  };

  const getValidDragPayload = (event: ReactDragEvent<HTMLElement>) => {
    const payload = getAnalyticsDragPayload(event, draggedField);
    return payload && optionMap.has(payload.key) ? payload : null;
  };

  const clampDropIndex = (targetIndex: number) =>
    Math.max(0, Math.min(targetIndex, selectedOptions.length));

  const updateDropPreview = (
    event: ReactDragEvent<HTMLElement>,
    targetIndex: number = selectedOptions.length
  ) => {
    const payload = getValidDragPayload(event);
    if (!payload) {
      onDropPreviewChange(null);
      return null;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";

    const nextIndex = clampDropIndex(targetIndex);
    onDropPreviewChange({
      zone,
      key: payload.key,
      index: nextIndex,
    });
    return payload;
  };

  const handleListDragEnter = (event: ReactDragEvent<HTMLElement>) => {
    updateDropPreview(event);
  };

  const handleListDragOver = (event: ReactDragEvent<HTMLElement>) => {
    updateDropPreview(event);
  };

  const handleItemDragOver = (event: ReactDragEvent<HTMLElement>, index: number) => {
    event.stopPropagation();
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    const targetIndex = event.clientX > rect.left + rect.width / 2 ? index + 1 : index;
    updateDropPreview(event, targetIndex);
  };

  const handleDrop = (
    event: ReactDragEvent<HTMLElement>,
    targetIndex: number = selectedOptions.length
  ) => {
    const payload = getValidDragPayload(event);
    if (!payload) {
      onDropPreviewChange(null);
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onFieldDrop({
      ...payload,
      target: zone,
      targetIndex,
    });
    onDropPreviewChange(null);
  };
  const previewOption =
    dropPreview?.zone === zone ? optionMap.get(dropPreview.key) : null;
  const normalizedDropPreviewIndex =
    previewOption && dropPreview?.zone === zone
      ? clampDropIndex(dropPreview.index)
      : null;
  const hasDropPreview = previewOption !== undefined && normalizedDropPreviewIndex !== null;
  const renderDropPreview = (key: string) =>
    previewOption ? (
      <div
        className="analytics-selected-row analytics-selected-drop-preview"
        key={key}
        role="presentation"
      >
        <span className="analytics-selected-label">{previewOption.label}</span>
      </div>
    ) : null;

  return (
    <div className="analytics-selected-field-row">
      <span className="analytics-selected-title">{title}</span>
      <div
        className={`analytics-selected-list${hasDropPreview ? " is-drop-target" : ""}`}
        role="list"
        aria-label={`${title} aktif`}
        data-analytics-drop-zone={zone}
        onDragEnter={handleListDragEnter}
        onDragOver={handleListDragOver}
        onDrop={handleDrop}
        onDragLeave={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            !event.currentTarget.contains(event.relatedTarget)
          ) {
            onDropPreviewChange(null);
          }
        }}
      >
        {selectedOptions.length === 0 ? (
          <>
            {normalizedDropPreviewIndex === 0 ? renderDropPreview("preview-empty") : null}
            {normalizedDropPreviewIndex === null ? (
              <span className="analytics-selected-empty">Belum ada field dipilih</span>
            ) : null}
          </>
        ) : (
          <>
            {selectedOptions.map((option, index) => {
              const isDragged =
                draggedField?.source === zone && draggedField.key === option.key;
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
              const hasAggregationSelect =
                !!onAggregationChange && !!option.format && !!aggregationValue;

              return (
                <Fragment key={option.key}>
                  {normalizedDropPreviewIndex === index
                    ? renderDropPreview(`preview-before-${option.key}`)
                    : null}
                  <div
                    className={`analytics-selected-row${
                      hasAggregationSelect ? " has-aggregation" : ""
                    }${isDragged ? " is-dragging" : ""}`}
                    role="listitem"
                    draggable={false}
                    aria-label={`${title} ${option.label}`}
                    onPointerDown={(event) => {
                      if (
                        event.button !== 0 ||
                        isInteractiveDragTarget(event.target)
                      ) {
                        return;
                      }

                      event.preventDefault();
                      event.currentTarget.setPointerCapture?.(event.pointerId);
                      onPointerDragStart(
                        {
                          source: zone,
                          key: option.key,
                          label: option.label,
                        },
                        event
                      );
                    }}
                    onDragStart={(event) => {
                      if (isInteractiveDragTarget(event.target)) {
                        event.preventDefault();
                        return;
                      }

                      const payload = { source: zone, key: option.key };
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData(
                        ANALYTICS_FIELD_DRAG_MIME,
                        JSON.stringify(payload)
                      );
                      event.dataTransfer.setData("text/plain", option.label);
                      onDragStart(payload);
                    }}
                    onDrag={onDragMove}
                    onDragOver={(event) => handleItemDragOver(event, index)}
                    onDrop={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      const targetIndex =
                        event.clientX > rect.left + rect.width / 2 ? index + 1 : index;
                      handleDrop(event, targetIndex);
                    }}
                    onDragEnd={() => {
                      onDragEnd();
                    }}
                  >
                    <span className="analytics-selected-label">{option.label}</span>
                    {hasAggregationSelect ? (
                      <select
                        className="analytics-aggregation-select"
                        aria-label={`Mode ${title} ${option.label}`}
                        value={aggregationValue}
                        onChange={(event) =>
                          onAggregationChange?.(
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
                        className="analytics-selected-delete"
                        aria-label={`Hapus ${title} ${option.label}`}
                        onClick={() => removeOption(option.key)}
                      >
                        x
                      </button>
                    </div>
                  </div>
                </Fragment>
              );
            })}
            {normalizedDropPreviewIndex !== null &&
            normalizedDropPreviewIndex >= selectedOptions.length
              ? renderDropPreview("preview-end")
              : null}
          </>
        )}
      </div>
    </div>
  );
}

function AnalyticsFieldSourceList({
  title,
  options,
  onDragStart,
  onPointerDragStart,
  onDragMove,
  onDragEnd,
}: AnalyticsFieldSourceListProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase("id");
  const visibleOptions =
    normalizedSearchQuery === ""
      ? options
      : options.filter((option) =>
          `${option.label} ${option.key}`.toLocaleLowerCase("id").includes(normalizedSearchQuery)
        );

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
        role="list"
        aria-label={`${title} tersedia`}
      >
        {visibleOptions.length === 0 ? (
          <span className="analytics-option-empty">Field tidak ditemukan</span>
        ) : null}
        {visibleOptions.map((option) => (
          <div
            className="analytics-option-row"
            key={option.key}
            role="listitem"
            draggable={false}
            aria-label={`Field ${option.label}`}
            onPointerDown={(event) => {
              if (event.button !== 0 || isInteractiveDragTarget(event.target)) {
                return;
              }

              event.preventDefault();
              event.currentTarget.setPointerCapture?.(event.pointerId);
              onPointerDragStart(
                {
                  source: "field",
                  key: option.key,
                  label: option.label,
                },
                event
              );
            }}
            onDragStart={(event) => {
              const payload = { source: "field" as const, key: option.key };
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData(
                ANALYTICS_FIELD_DRAG_MIME,
                JSON.stringify(payload)
              );
              event.dataTransfer.setData("text/plain", option.label);
              onDragStart(payload);
            }}
            onDrag={onDragMove}
            onDragEnd={onDragEnd}
          >
            <span>{option.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function selectChartRows(rows: SheetAnalyticsRow[], limit = 12) {
  return [...rows]
    .sort((left, right) => {
      const leftMetricValue = Number.isFinite(left.metricValue) ? left.metricValue : 0;
      const rightMetricValue = Number.isFinite(right.metricValue) ? right.metricValue : 0;
      return rightMetricValue - leftMetricValue;
    })
    .slice(0, Math.max(0, limit));
}

export function createDonutBackground(
  rows: SheetAnalyticsRow[],
  totalMetricValue: number
) {
  const activeRows = rows.filter((row) => row.metricValue > 0);
  if (activeRows.length === 0) {
    return "#e2e8f0";
  }

  const visibleMetricValue = activeRows.reduce(
    (total, row) => total + row.metricValue,
    0
  );
  const metricTotal = Math.max(
    Number.isFinite(totalMetricValue) ? totalMetricValue : 0,
    visibleMetricValue
  );
  if (metricTotal <= 0) {
    return "#e2e8f0";
  }

  let cursor = 0;
  const segments = activeRows.map((row, index) => {
    const start = cursor;
    cursor = Math.min(100, cursor + (row.metricValue / metricTotal) * 100);
    return `${CHART_COLORS[index % CHART_COLORS.length]} ${start}% ${cursor}%`;
  });
  if (cursor < 100) {
    segments.push(`#e2e8f0 ${cursor}% 100%`);
  }

  return `conic-gradient(${segments.join(", ")})`;
}

export function SheetAnalyticsView({
  analytics,
  groupByOptions,
  metricOptions,
  summary,
  onSourceScopeChange,
  onRowPathsChange,
  onColumnPathsChange,
  onValueMetricsChange,
  onMetricAggregationChange,
  onChartTypeChange,
}: SheetAnalyticsViewProps) {
  const chartRows = selectChartRows(summary.rows);
  const maxMetricValue = Math.max(...chartRows.map((row) => row.metricValue), 0);
  const metricLabel =
    summary.valueMetrics.length > 0
      ? summary.valueMetrics.map(formatMetricLabel).join(" + ")
      : "Value";
  const rowKeys = analytics.rowPaths;
  const columnKeys = analytics.columnPaths;
  const valueKeys = analytics.valueMetrics;
  const primaryMetric = summary.primaryMetric;
  const primaryMetricOption = summary.primaryMetricOption;
  const hasPrimaryMetric = primaryMetric !== null;
  const isPivotMode = analytics.chartType === "pivot";
  const dimensionOptions = groupByOptions.map((option) => ({
    key: option.path,
    label: option.label,
  }));
  const fieldSourceOptions = [
    ...dimensionOptions,
    ...metricOptions.filter(
      (metricOption) =>
        !dimensionOptions.some((dimensionOption) => dimensionOption.key === metricOption.key)
    ),
  ];
  const dimensionKeySet = new Set(dimensionOptions.map((option) => option.key));
  const metricKeySet = new Set(metricOptions.map((option) => option.key));
  const [draggedField, setDraggedField] = useState<AnalyticsDragPayload | null>(null);
  const [dropPreview, setDropPreview] = useState<AnalyticsDropPreview | null>(null);
  const [pointerDrag, setPointerDrag] = useState<AnalyticsPointerDragState | null>(
    null
  );
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
    background: createDonutBackground(chartRows, summary.totalMetricValue),
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
  const getSelectedKeysByZone = (zone: AnalyticsSelectedZone) => {
    switch (zone) {
      case "row":
        return rowKeys;
      case "column":
        return columnKeys;
      case "value":
        return valueKeys;
      default:
        return [];
    }
  };
  const setSelectedKeysByZone = (zone: AnalyticsSelectedZone, keys: string[]) => {
    switch (zone) {
      case "row":
        onRowPathsChange(keys);
        break;
      case "column":
        onColumnPathsChange(keys);
        break;
      case "value":
        onValueMetricsChange(keys as SheetAnalyticsMetric[]);
        break;
    }
  };
  const getDropIndexFromPointer = (
    dropList: HTMLElement,
    clientX: number,
    clientY: number
  ) => {
    const chips = Array.from(
      dropList.querySelectorAll<HTMLElement>(
        ".analytics-selected-row:not(.analytics-selected-drop-preview)"
      )
    );

    for (const [index, chip] of chips.entries()) {
      const rect = chip.getBoundingClientRect();
      const midpointX = rect.left + rect.width / 2;
      const midpointY = rect.top + rect.height / 2;
      const isBeforeChip =
        clientY < midpointY || (clientY <= rect.bottom && clientX < midpointX);
      if (isBeforeChip) {
        return index;
      }
    }

    return chips.length;
  };
  const getDropPreviewFromPointer = (
    activeDocument: Document,
    clientX: number,
    clientY: number,
    draggedKey: string
  ): AnalyticsDropPreview | null => {
    if (
      clientX === 0 && clientY === 0 ||
      typeof activeDocument.elementFromPoint !== "function"
    ) {
      return null;
    }

    const hoveredElement = activeDocument.elementFromPoint(clientX, clientY);
    const dropList = hoveredElement?.closest<HTMLElement>("[data-analytics-drop-zone]");
    const target = getAnalyticsDropZone(
      dropList?.getAttribute("data-analytics-drop-zone") ?? null
    );
    if (!dropList || !target) {
      return null;
    }

    const validTargetKeys = target === "value" ? metricKeySet : dimensionKeySet;
    if (!validTargetKeys.has(draggedKey)) {
      return null;
    }

    return {
      zone: target,
      key: draggedKey,
      index: getDropIndexFromPointer(dropList, clientX, clientY),
    };
  };
  const updateDropPreviewFromPointer = (
    activeDocument: Document,
    clientX: number,
    clientY: number,
    draggedKey: string
  ) => {
    const nextDropPreview = getDropPreviewFromPointer(
      activeDocument,
      clientX,
      clientY,
      draggedKey
    );
    if (!nextDropPreview) {
      setDropPreview(null);
      return false;
    }

    setDropPreview({
      zone: nextDropPreview.zone,
      key: nextDropPreview.key,
      index: nextDropPreview.index,
    });
    return true;
  };
  const handleSelectedFieldDragMove = (event: ReactDragEvent<HTMLElement>) => {
    if (!draggedField) {
      return;
    }

    updateDropPreviewFromPointer(
      event.currentTarget.ownerDocument,
      event.clientX,
      event.clientY,
      draggedField.key
    );
  };
  const handleSelectedFieldPointerDragStart = (
    payload: AnalyticsPointerDragPayload,
    event: ReactPointerEvent<HTMLElement>
  ) => {
    setDraggedField({
      source: payload.source,
      key: payload.key,
    });
    setPointerDrag({
      ...payload,
      active: false,
      currentX: event.clientX,
      currentY: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
    });
  };
  useEffect(() => {
    if (!draggedField) {
      return undefined;
    }

    const handleDocumentDragOver = (event: DragEvent) => {
      const didUpdatePreview = updateDropPreviewFromPointer(
        document,
        event.clientX,
        event.clientY,
        draggedField.key
      );
      if (didUpdatePreview) {
        event.preventDefault();
      }
    };
    const clearDocumentDragPreview = () => {
      setDropPreview(null);
    };

    document.addEventListener("dragover", handleDocumentDragOver);
    document.addEventListener("drop", clearDocumentDragPreview);
    document.addEventListener("dragend", clearDocumentDragPreview);

    return () => {
      document.removeEventListener("dragover", handleDocumentDragOver);
      document.removeEventListener("drop", clearDocumentDragPreview);
      document.removeEventListener("dragend", clearDocumentDragPreview);
    };
  }, [draggedField, dimensionKeySet, metricKeySet]);
  const handleSelectedFieldDrop = ({
    source,
    target,
    key,
    targetIndex,
  }: AnalyticsFieldDropParams) => {
    const validTargetKeys = target === "value" ? metricKeySet : dimensionKeySet;
    if (!validTargetKeys.has(key)) {
      setDraggedField(null);
      setDropPreview(null);
      setPointerDrag(null);
      return;
    }

    const sourceKeys = source === "field" ? [] : getSelectedKeysByZone(source);
    if (source !== "field" && !sourceKeys.includes(key)) {
      setDraggedField(null);
      setDropPreview(null);
      setPointerDrag(null);
      return;
    }

    const targetKeys = getSelectedKeysByZone(target);
    const sourceIndex = source === "field" ? -1 : sourceKeys.indexOf(key);
    const nextSourceKeys =
      source === "field" ? sourceKeys : sourceKeys.filter((item) => item !== key);
    const targetKeysWithoutDragged =
      source === target ? nextSourceKeys : targetKeys.filter((item) => item !== key);
    const adjustedTargetIndex =
      source === target && sourceIndex >= 0 && sourceIndex < targetIndex
        ? targetIndex - 1
        : targetIndex;
    const nextTargetIndex = Math.max(
      0,
      Math.min(adjustedTargetIndex, targetKeysWithoutDragged.length)
    );
    const nextTargetKeys = [
      ...targetKeysWithoutDragged.slice(0, nextTargetIndex),
      key,
      ...targetKeysWithoutDragged.slice(nextTargetIndex),
    ];

    if (source === target || source === "field") {
      setSelectedKeysByZone(target, nextTargetKeys);
    } else {
      setSelectedKeysByZone(source, nextSourceKeys);
      setSelectedKeysByZone(target, nextTargetKeys);
    }
    setDraggedField(null);
    setDropPreview(null);
    setPointerDrag(null);
  };
  const handleSelectedFieldDragEnd = () => {
    setDraggedField(null);
    setDropPreview(null);
    setPointerDrag(null);
  };
  useEffect(() => {
    if (!pointerDrag) {
      return undefined;
    }

    const getHasStartedDrag = (event: PointerEvent) =>
      pointerDrag.active ||
      Math.hypot(event.clientX - pointerDrag.startX, event.clientY - pointerDrag.startY) >
        3;

    const handlePointerMove = (event: PointerEvent) => {
      const isActive = getHasStartedDrag(event);
      setPointerDrag((current) =>
        current
          ? {
              ...current,
              active: isActive,
              currentX: event.clientX,
              currentY: event.clientY,
            }
          : null
      );

      if (!isActive) {
        return;
      }

      event.preventDefault();
      updateDropPreviewFromPointer(document, event.clientX, event.clientY, pointerDrag.key);
    };

    const handlePointerUp = (event: PointerEvent) => {
      const isActive = getHasStartedDrag(event);
      const pointerDropPreview = getDropPreviewFromPointer(
        document,
        event.clientX,
        event.clientY,
        pointerDrag.key
      );
      if (isActive && pointerDropPreview) {
        handleSelectedFieldDrop({
          source: pointerDrag.source,
          key: pointerDrag.key,
          target: pointerDropPreview.zone,
          targetIndex: pointerDropPreview.index,
        });
      } else {
        setDraggedField(null);
        setDropPreview(null);
        setPointerDrag(null);
      }
    };

    const cancelPointerDrag = () => {
      setDraggedField(null);
      setDropPreview(null);
      setPointerDrag(null);
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", cancelPointerDrag);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", cancelPointerDrag);
    };
  }, [pointerDrag, dropPreview, dimensionKeySet, metricKeySet]);

  return (
    <div className="sheet-analytics-view">
      {pointerDrag?.active ? (
        <div
          className="analytics-selected-pointer-ghost"
          style={{
            left: pointerDrag.currentX,
            top: pointerDrag.currentY,
          }}
        >
          {pointerDrag.label}
        </div>
      ) : null}
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
        <AnalyticsFieldSourceList
          title="Field"
          options={fieldSourceOptions}
          onDragStart={setDraggedField}
          onPointerDragStart={handleSelectedFieldPointerDragStart}
          onDragMove={handleSelectedFieldDragMove}
          onDragEnd={handleSelectedFieldDragEnd}
        />
      </aside>

      <div
        className="analytics-main-panel"
        role="region"
        aria-label="Panel Utama Pivot Grafik"
      >
        <div className="analytics-selected-panel" aria-label="Field Aktif Pivot Grafik">
          <AnalyticsSelectedFieldList
            title="Row"
            zone="row"
            options={dimensionOptions}
            selectedKeys={rowKeys}
            onSelectedKeysChange={onRowPathsChange}
            draggedField={draggedField}
            onDragStart={setDraggedField}
            onPointerDragStart={handleSelectedFieldPointerDragStart}
            onDragMove={handleSelectedFieldDragMove}
            onDragEnd={handleSelectedFieldDragEnd}
            dropPreview={dropPreview}
            onDropPreviewChange={setDropPreview}
            onFieldDrop={handleSelectedFieldDrop}
          />
          <AnalyticsSelectedFieldList
            title="Column"
            zone="column"
            options={dimensionOptions}
            selectedKeys={columnKeys}
            onSelectedKeysChange={onColumnPathsChange}
            draggedField={draggedField}
            onDragStart={setDraggedField}
            onPointerDragStart={handleSelectedFieldPointerDragStart}
            onDragMove={handleSelectedFieldDragMove}
            onDragEnd={handleSelectedFieldDragEnd}
            dropPreview={dropPreview}
            onDropPreviewChange={setDropPreview}
            onFieldDrop={handleSelectedFieldDrop}
          />
          <AnalyticsSelectedFieldList
            title="Value"
            zone="value"
            options={metricOptions}
            selectedKeys={valueKeys}
            aggregationValues={analytics.metricAggregations}
            onSelectedKeysChange={(keys) => onValueMetricsChange(keys as SheetAnalyticsMetric[])}
            onAggregationChange={(metric, aggregation) =>
              onMetricAggregationChange(metric as SheetAnalyticsMetric, aggregation)
            }
            draggedField={draggedField}
            onDragStart={setDraggedField}
            onPointerDragStart={handleSelectedFieldPointerDragStart}
            onDragMove={handleSelectedFieldDragMove}
            onDragEnd={handleSelectedFieldDragEnd}
            dropPreview={dropPreview}
            onDropPreviewChange={setDropPreview}
            onFieldDrop={handleSelectedFieldDrop}
          />
        </div>
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
                      {summary.rowLabels.map((label, index) => {
                        const sortKey = `row:${index}`;
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
                      {summary.pivotValueColumns.map((pivotValueColumn) => {
                        const sortKey = `pivot:${pivotValueColumn.key}`;
                        return (
                          <th
                            key={pivotValueColumn.key}
                            aria-sort={getSortAria(activePivotSort, sortKey)}
                          >
                            <button
                              type="button"
                              className="analytics-sort-header"
                              onClick={() => togglePivotSort(sortKey)}
                            >
                              <span>{pivotValueColumn.label}</span>
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
                            summary.rowLabels.length +
                            summary.pivotValueColumns.length +
                            (hasPrimaryMetric ? 1 : 0)
                          }
                        >
                          Belum ada data.
                        </td>
                      </tr>
                    ) : (
                      pivotRows.map((row) => (
                        <tr key={row.key}>
                          {summary.rowLabels.map((label, index) => (
                            <td key={`${label}-${index}`}>
                              {row.rowValues[index] ?? "-"}
                            </td>
                          ))}
                          {summary.pivotValueColumns.map((pivotValueColumn) => (
                            <td key={pivotValueColumn.key}>
                              {formatPivotValueColumnValue(pivotValueColumn, row)}
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
                <span>{summary.rowLabel}</span>
                <strong>{metricLabel}</strong>
              </div>

              {!hasPrimaryMetric ? (
                <div className="analytics-empty">Value belum dipilih.</div>
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
