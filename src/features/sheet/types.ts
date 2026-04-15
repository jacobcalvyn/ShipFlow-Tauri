import { TrackResponse } from "../../types";

export type SheetRow = {
  key: string;
  trackingInput: string;
  shipment: TrackResponse | null;
  loading: boolean;
  stale: boolean;
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

export type { TrackResponse };
