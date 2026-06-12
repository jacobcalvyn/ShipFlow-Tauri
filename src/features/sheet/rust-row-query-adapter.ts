import type {
  SheetFilter,
  SheetRowsQuery,
  SheetValueFilter,
} from "../workspace-engine/client";
import type { ColumnDefinition, SheetRow, SheetState } from "./types";

const RUST_ROW_QUERY_FIELD_PATHS = new Set([
  "detail.shipment_header.nomor_kiriman",
  "status_akhir.status",
  "status_akhir.location",
  "status_akhir.officer_name",
  "status_akhir.officer_id",
  "status_akhir.datetime",
  "detail.actors.pengirim.nama",
  "detail.actors.pengirim.telepon",
  "detail.actors.pengirim.alamat",
  "detail.actors.penerima.nama",
  "detail.actors.penerima.telepon",
  "detail.actors.penerima.alamat",
  "detail.actors.penerima.kode_pos",
  "detail.shipment_header.id_pelanggan_korporat",
  "detail.origin_detail.nama_kantor",
  "detail.origin_detail.id_kantor",
  "detail.origin_detail.nama_petugas",
  "detail.origin_detail.id_petugas",
  "detail.origin_detail.tanggal_input",
  "detail.package_detail.jenis_layanan",
  "detail.billing_detail.cod_info.is_cod",
  "detail.billing_detail.cod_info.total_cod",
  "detail.billing_detail.cod_info.status",
  "detail.performance_detail.sla_target",
  "detail.performance_detail.sla_category",
  "detail.performance_detail.sla_days_diff",
  "computed.delivery_runsheet_count",
]);

function parseFormattedNumberValue(value: string) {
  const normalized = value
    .trim()
    .replace(/\s*kg$/i, "")
    .replace(/\s/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? String(parsed) : null;
}

function parseFormattedDateValue(value: string) {
  const trimmed = value.trim();
  const dayFirst = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!dayFirst) {
    return [trimmed];
  }

  return [
    trimmed,
    `${dayFirst[3]}-${dayFirst[2].padStart(2, "0")}-${dayFirst[1].padStart(2, "0")}`,
  ];
}

function displayValueToRustValueFilters(column: ColumnDefinition, value: string) {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "-") {
    return null;
  }

  switch (column.type) {
    case "currency":
    case "weight":
    case "number": {
      const parsed = parseFormattedNumberValue(trimmed);
      return parsed === null ? null : [parsed];
    }
    case "boolean": {
      const normalized = trimmed.toLowerCase();
      if (normalized === "ya" || normalized === "true" || normalized === "1") {
        return ["1"];
      }
      if (normalized === "tidak" || normalized === "false" || normalized === "0") {
        return ["0"];
      }
      return null;
    }
    case "date":
      return parseFormattedDateValue(trimmed);
    default:
      return [trimmed];
  }
}

function getVisibleValueFilters(
  sheetState: SheetState,
  visibleColumns: ColumnDefinition[],
  visibleColumnPathSet: Set<string>
): SheetValueFilter[] | null {
  const columnByPath = new Map(visibleColumns.map((column) => [column.path, column]));
  const valueFilters = [];

  for (const [path, values] of Object.entries(sheetState.valueFilters)) {
    if (!visibleColumnPathSet.has(path) || values.length === 0) {
      continue;
    }

    const column = columnByPath.get(path);
    if (!column || !canRustQueryField(path) || column.type === "json") {
      return null;
    }

    const rawValues = new Set<string>();
    for (const value of values) {
      const convertedValues = displayValueToRustValueFilters(column, value);
      if (convertedValues === null) {
        return null;
      }

      for (const convertedValue of convertedValues) {
        rawValues.add(convertedValue);
      }
    }

    if (rawValues.size === 0) {
      return null;
    }

    valueFilters.push({
      field: path,
      values: Array.from(rawValues),
    });
  }

  return valueFilters;
}

function getVisibleTextFilters(
  sheetState: SheetState,
  visibleColumns: ColumnDefinition[]
): SheetFilter[] {
  return visibleColumns
    .map((column) => ({
      field: column.path,
      value: sheetState.filters[column.path]?.trim() ?? "",
    }))
    .filter((filter) => filter.value !== "");
}

function hasIncompleteTrackingRows(rows: SheetRow[]) {
  return rows.some((row) => row.trackingInput.trim() !== "" && row.shipment === null);
}

export function canRustQueryField(path: string) {
  return RUST_ROW_QUERY_FIELD_PATHS.has(path);
}

export function createRustSheetQueryFilterParts(params: {
  sheetState: SheetState;
  nonEmptyRows: SheetRow[];
  visibleColumns: ColumnDefinition[];
  visibleColumnPathSet: Set<string>;
}): { filters: SheetFilter[]; valueFilters: SheetValueFilter[] } | null {
  const { sheetState, visibleColumns, visibleColumnPathSet } = params;
  const filters = getVisibleTextFilters(sheetState, visibleColumns);
  const unsupportedFilter = filters.find((filter) => !canRustQueryField(filter.field));
  if (unsupportedFilter) {
    return null;
  }

  const valueFilters = getVisibleValueFilters(
    sheetState,
    visibleColumns,
    visibleColumnPathSet
  );
  if (valueFilters === null) {
    return null;
  }

  return {
    filters,
    valueFilters,
  };
}

export function createRustSheetRowsQuery(params: {
  sheetId: string;
  sheetState: SheetState;
  nonEmptyRows: SheetRow[];
  visibleColumns: ColumnDefinition[];
  visibleColumnPathSet: Set<string>;
  offset?: number;
  limit?: number;
  allowNonWorkspaceMode?: boolean;
}): SheetRowsQuery | null {
  const {
    sheetId,
    sheetState,
    nonEmptyRows,
    visibleColumns,
    visibleColumnPathSet,
    offset = 0,
    limit = 100_000,
    allowNonWorkspaceMode = false,
  } = params;

  if (sheetState.activeMode !== "workspace" && !allowNonWorkspaceMode) {
    return null;
  }

  const filterParts = createRustSheetQueryFilterParts({
    sheetState,
    nonEmptyRows,
    visibleColumns,
    visibleColumnPathSet,
  });
  if (filterParts === null) {
    return null;
  }
  const { filters, valueFilters } = filterParts;
  const sortPath = sheetState.sortState.path;
  const sort = sortPath
    ? [
        {
          field: sortPath,
          direction: sheetState.sortState.direction,
        },
      ]
    : [];

  if (sortPath && !canRustQueryField(sortPath)) {
    return null;
  }

  if (
    (filters.length > 0 || valueFilters.length > 0 || sort.length > 0) &&
    hasIncompleteTrackingRows(nonEmptyRows)
  ) {
    return null;
  }

  return {
    sheetId,
    offset,
    limit,
    filters,
    ...(valueFilters.length > 0 ? { valueFilters } : {}),
    sort,
  };
}
