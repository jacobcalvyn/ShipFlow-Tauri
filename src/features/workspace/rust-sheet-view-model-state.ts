import { createRustSheetQueryFilterParts } from "../sheet/rust-row-query-adapter";
import { getVisibleColumns } from "../sheet/selectors";
import {
  ColumnDefinition,
  SheetState,
  ValueFilterOption,
} from "../sheet/types";
import { formatDateValue, formatNumber } from "../sheet/utils";
import {
  type SheetFieldValuesResult,
  type SheetFilter,
  type SheetRowWindow,
  type SheetValueFilter,
} from "../workspace-engine/client";

export const RUST_ROW_WINDOW_LIMIT = 500;
export const RUST_EXPORT_ROW_WINDOW_LIMIT = 1_000;
export const RUST_VALUE_OPTIONS_LIMIT = 1_000;
const RUST_ROW_WINDOW_CACHE_LIMIT = 8;

export type RustDisplayedRowsCacheEntry = {
  generation: number;
  signature: string;
  window: SheetRowWindow;
};

export function setRustDisplayedRowsCacheEntry(
  cache: Record<string, RustDisplayedRowsCacheEntry>,
  queryKey: string,
  entry: RustDisplayedRowsCacheEntry
) {
  const next = {
    ...cache,
    [queryKey]: entry,
  };
  const keys = Object.keys(next);
  for (const key of keys.slice(0, Math.max(0, keys.length - RUST_ROW_WINDOW_CACHE_LIMIT))) {
    delete next[key];
  }

  return next;
}

export function deleteRustDisplayedRowsCacheEntry(
  cache: Record<string, RustDisplayedRowsCacheEntry>,
  queryKey: string
) {
  if (!(queryKey in cache)) {
    return cache;
  }

  const next = {
    ...cache,
  };
  delete next[queryKey];
  return next;
}

export function createRustRowWindowSignature(window: SheetRowWindow) {
  return [
    window.sheetId,
    window.offset,
    window.limit,
    window.totalCount,
    window.hasMore ? "1" : "0",
    window.nextOffset ?? "",
    window.rows
      .map((row) =>
        [
          row.rowId,
          row.position,
          row.displayTrackingId,
          row.lookupTrackingId,
          row.rowStatus,
          row.errorMessage ?? "",
          JSON.stringify(row.statusJson ?? null),
          JSON.stringify(row.detailJson ?? null),
          JSON.stringify(row.historyJson ?? null),
        ].join("\u001f")
      )
      .join("\u001e"),
  ].join("\u001d");
}

export function createEmptyRustRowWindow(query: {
  sheetId: string;
  offset: number;
  limit: number;
}): SheetRowWindow {
  return {
    sheetId: query.sheetId,
    offset: query.offset,
    limit: query.limit,
    totalCount: 0,
    hasMore: false,
    nextOffset: null,
    rows: [],
  };
}

export function mergeRustRowWindowRuntimeState(
  currentWindow: SheetRowWindow | undefined,
  nextWindow: SheetRowWindow
): SheetRowWindow {
  if (!currentWindow || currentWindow.sheetId !== nextWindow.sheetId) {
    return nextWindow;
  }

  const currentRowsById = new Map(
    currentWindow.rows.map((row) => [row.rowId, row])
  );
  let changed = false;
  const rows = nextWindow.rows.map((row) => {
    const currentRow = currentRowsById.get(row.rowId);
    if (!currentRow || row.rowStatus !== "pending") {
      return row;
    }

    if (
      currentRow.rowStatus === "loading" ||
      currentRow.rowStatus === "loaded" ||
      currentRow.rowStatus === "failed"
    ) {
      changed = true;
      return currentRow;
    }

    return row;
  });

  return changed
    ? {
        ...nextWindow,
        rows,
      }
    : nextWindow;
}

export function createRustPivotFilters(
  activeSheet: SheetState,
  nonEmptyRows: SheetState["rows"],
  visibleColumns: ReturnType<typeof getVisibleColumns>,
  visibleColumnPathSet: Set<string>
): { filters: SheetFilter[]; valueFilters: SheetValueFilter[] } | null {
  if (activeSheet.analytics.sourceScope !== "filtered_rows") {
    return {
      filters: [],
      valueFilters: [],
    };
  }

  return createRustSheetQueryFilterParts({
    sheetState: activeSheet,
    nonEmptyRows,
    visibleColumns,
    visibleColumnPathSet,
  });
}

function formatEngineValueOption(column: ColumnDefinition, value: string) {
  if (value === "") {
    return "-";
  }

  switch (column.type) {
    case "currency":
    case "number": {
      const numberValue = Number(value);
      return Number.isFinite(numberValue) ? formatNumber(numberValue) : value;
    }
    case "weight": {
      const numberValue = Number(value);
      return Number.isFinite(numberValue) ? `${formatNumber(numberValue)} Kg` : value;
    }
    case "boolean": {
      const normalized = value.trim().toLowerCase();
      if (normalized === "1" || normalized === "true") {
        return "Ya";
      }
      if (normalized === "0" || normalized === "false") {
        return "Tidak";
      }
      return value;
    }
    case "date":
      return formatDateValue(value);
    default:
      return value;
  }
}

export function createValueOptionsFromRustFieldValues(
  column: ColumnDefinition,
  result: SheetFieldValuesResult
): ValueFilterOption[] {
  const countByValue = new Map<string, number>();
  for (const option of result.values) {
    const value = formatEngineValueOption(column, option.value);
    if (value === "-") {
      continue;
    }

    countByValue.set(value, (countByValue.get(value) ?? 0) + option.count);
  }

  return Array.from(countByValue, ([value, count]) => ({
    value,
    count,
  })).sort((left, right) => {
    if (left.count !== right.count) {
      return right.count - left.count;
    }

    return left.value.localeCompare(right.value, "id", {
      sensitivity: "base",
      numeric: true,
    });
  });
}

export function excludeCurrentFieldValueFilters(
  valueFilters: SheetValueFilter[] | undefined,
  field: string
) {
  return valueFilters?.filter((filter) => filter.field !== field) ?? [];
}
