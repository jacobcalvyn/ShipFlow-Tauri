import { TrackResponse } from "../../types";

export type SheetRow = {
  key: string;
  trackingInput: string;
  shipment: TrackResponse | null;
  loading: boolean;
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
  | "date";

export type ColumnDefinition = {
  path: string;
  label: string;
  type: ColumnType;
  defaultWidth: number;
  minWidth?: number;
  tone?: "pengirim" | "penerima" | "status" | "layanan" | "cod";
  sticky?: boolean;
};

export type SortState = {
  path: string | null;
  direction: "asc" | "desc";
};

export type SheetState = {
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
};

export type ColumnShortcut = {
  path: string;
  label: string;
  disabled: boolean;
  toneClass: string;
};

export type { TrackResponse };
