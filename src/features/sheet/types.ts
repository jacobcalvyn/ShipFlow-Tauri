import { TrackResponse } from "../../types";

export type SheetRow = {
  key: string;
  trackingInput: string;
  shipment: TrackResponse | null;
  loading: boolean;
  queued?: boolean;
  stale: boolean;
  dirty: boolean;
  error: string;
};

export type ColumnType =
  | "text"
  | "currency"
  | "weight"
  | "number"
  | "boolean"
  | "json"
  | "date";

export type ColumnDefinition = {
  path: string;
  label: string;
  type: ColumnType;
  defaultWidth: number;
  minWidth?: number;
  maxWidth?: number;
  tone?: "pengirim" | "penerima" | "status" | "layanan" | "cod";
  compact?: boolean;
  sticky?: boolean;
};

export type ValueFilterOption = {
  value: string;
  count: number;
};

export type SortState = {
  path: string | null;
  direction: "asc" | "desc";
};

export type ImportSourceModalKind = "bag" | "manifest";

export type ImportSourceDrafts = Record<ImportSourceModalKind, string>;

export type ManifestBagLookupState = {
  bagId: string;
  loading: boolean;
  error: string;
  trackingIds: string[];
};

export type ImportSourceLookupState = {
  loading: boolean;
  rawResponse: string;
  error: string;
  trackingIds: string[];
  requestKey?: string | null;
  manifestBagStates?: ManifestBagLookupState[];
};

export type ImportSourceLookupStates = Record<
  ImportSourceModalKind,
  ImportSourceLookupState
>;

export type SheetViewMode = "workspace" | "analytics";

export type SheetAnalyticsSourceScope =
  | "all_rows"
  | "filtered_rows"
  | "selected_rows";

export type SheetAnalyticsMetric = string;

export type SheetAnalyticsChartType = "bar" | "donut" | "pivot";

export type SheetAnalyticsMetricAggregation =
  | "sum"
  | "average"
  | "min"
  | "max"
  | "count"
  | "count_unique"
  | "unique_list"
  | "most_frequent"
  | "first"
  | "last";

export type SheetAnalyticsState = {
  sourceScope: SheetAnalyticsSourceScope;
  rowPaths: string[];
  columnPaths: string[];
  valueMetrics: SheetAnalyticsMetric[];
  metricAggregations?: Partial<
    Record<SheetAnalyticsMetric, SheetAnalyticsMetricAggregation>
  >;
  chartType: SheetAnalyticsChartType;
};

export type SheetState = {
  activeMode: SheetViewMode;
  analytics: SheetAnalyticsState;
  rows: SheetRow[];
  filters: Record<string, string>;
  valueFilters: Record<string, string[]>;
  sortState: SortState;
  selectedRowKeys: string[];
  selectionFollowsVisibleRows: boolean;
  columnWidths: Record<string, number>;
  hiddenColumnPaths: string[];
  pinnedColumnPaths: string[];
  openColumnMenuPath: string | null;
  highlightedColumnPath: string | null;
  deleteAllArmed: boolean;
  importSourceModalKind: ImportSourceModalKind | null;
  importSourceDrafts: ImportSourceDrafts;
  importSourceLookupStates: ImportSourceLookupStates;
};

export type ColumnShortcut = {
  path: string;
  label: string;
  disabled: boolean;
  toneClass: string;
};

export type { TrackResponse };
