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
  | "json"
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
