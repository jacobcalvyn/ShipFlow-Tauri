import {
  COLUMNS,
  FILTER_PRESETS_STORAGE_KEY,
  INITIAL_ROW_COUNT,
  MIN_EMPTY_TRAILING_ROWS,
} from "./columns";
import { ColumnDefinition, FilterPreset, SheetRow } from "./types";

export function createEmptyRow(): SheetRow {
  return {
    key: crypto.randomUUID(),
    trackingInput: "",
    shipment: null,
    loading: false,
    error: "",
  };
}

export function createEmptyRows(count: number) {
  return Array.from({ length: count }, () => createEmptyRow());
}

export function ensureTrailingEmptyRows(rows: SheetRow[]) {
  if (rows.length === 0) {
    return createEmptyRows(INITIAL_ROW_COUNT);
  }

  let trailingEmpty = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].trackingInput.trim() === "") {
      trailingEmpty += 1;
    } else {
      break;
    }
  }

  if (trailingEmpty >= MIN_EMPTY_TRAILING_ROWS) {
    return rows;
  }

  return [...rows, ...createEmptyRows(MIN_EMPTY_TRAILING_ROWS - trailingEmpty)];
}

export function ensureRowCapacity(rows: SheetRow[], requiredLength: number) {
  if (rows.length >= requiredLength) {
    return rows;
  }

  return [...rows, ...createEmptyRows(requiredLength - rows.length)];
}

export function getByPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object") {
      return undefined;
    }

    return (current as Record<string, unknown>)[segment];
  }, source);
}

export function getRowStatus(row: SheetRow) {
  if (row.loading) {
    return "Loading";
  }

  if (row.error) {
    return "Error";
  }

  if (row.shipment) {
    return "Ready";
  }

  if (row.trackingInput.trim()) {
    return "Pending";
  }

  return "Draft";
}

export function getRawColumnValue(row: SheetRow, column: ColumnDefinition): unknown {
  if (column.path === "detail.shipment_header.nomor_kiriman" && !row.shipment) {
    return row.trackingInput.trim();
  }

  if (!row.shipment) {
    return undefined;
  }

  return getByPath(row.shipment, column.path);
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat("id-ID", {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 0,
    maximumFractionDigits: 3,
  }).format(value);
}

export function formatDateValue(value: string) {
  const trimmed = value.trim();

  if (/^\d{2}[-/]\d{2}[-/]\d{4}$/.test(trimmed)) {
    return trimmed.replace(/-/g, "/");
  }

  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return new Intl.DateTimeFormat("id-ID", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      }).format(parsed);
    }
  }

  return trimmed;
}

export function formatColumnValue(row: SheetRow, column: ColumnDefinition) {
  const rawValue = getRawColumnValue(row, column);

  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return "-";
  }

  switch (column.type) {
    case "currency":
      return formatNumber(Number(rawValue));
    case "weight":
      return `${formatNumber(Number(rawValue))} Kg`;
    case "number":
      return formatNumber(Number(rawValue));
    case "boolean":
      return rawValue ? "Ya" : "Tidak";
    case "date":
      return formatDateValue(String(rawValue));
    default:
      return String(rawValue);
  }
}

export function getColumnValueOptions(rows: SheetRow[], column: ColumnDefinition) {
  return Array.from(
    new Set(
      rows
        .map((row) => formatColumnValue(row, column))
        .filter((value) => value !== "-")
    )
  ).sort((left, right) =>
    left.localeCompare(right, "id", {
      sensitivity: "base",
      numeric: true,
    })
  );
}

export function getColumnHeaderMinWidth(column: ColumnDefinition) {
  const estimatedLabelWidth = column.label.length * 8.5;
  const headerChromeWidth = 74;
  return Math.max(column.minWidth ?? 100, Math.ceil(estimatedLabelWidth + headerChromeWidth));
}

export function getEffectiveColumnWidth(
  column: ColumnDefinition,
  columnWidths: Record<string, number>
) {
  return Math.max(
    columnWidths[column.path] ?? column.defaultWidth,
    getColumnHeaderMinWidth(column)
  );
}

export function getColumnToneClass(column: ColumnDefinition) {
  switch (column.tone) {
    case "pengirim":
      return "tone-pengirim";
    case "penerima":
      return "tone-penerima";
    default:
      return "";
  }
}

export function getColumnTypeClass(column: ColumnDefinition) {
  switch (column.type) {
    case "currency":
    case "weight":
    case "number":
      return "align-right";
    default:
      return "";
  }
}

export function getStatusToneClass(status: string) {
  switch (status) {
    case "Ready":
      return "status-ready";
    case "Loading":
      return "status-loading";
    case "Error":
      return "status-error";
    case "Pending":
      return "status-pending";
    default:
      return "status-draft";
  }
}

export function getComparableValue(row: SheetRow, column: ColumnDefinition) {
  const rawValue = getRawColumnValue(row, column);

  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return null;
  }

  switch (column.type) {
    case "currency":
    case "weight":
    case "number":
      return Number(rawValue);
    case "boolean":
      return rawValue ? 1 : 0;
    case "date": {
      const normalized = formatDateValue(String(rawValue));
      const parts = normalized.split(/[/-]/);
      if (parts.length === 3) {
        const [day, month, year] = parts.map(Number);
        if ([day, month, year].every((part) => Number.isFinite(part))) {
          return new Date(year, month - 1, day).getTime();
        }
      }

      const parsed = Date.parse(String(rawValue));
      return Number.isNaN(parsed) ? String(rawValue).toLowerCase() : parsed;
    }
    default:
      return String(rawValue).toLowerCase();
  }
}

export function compareRows(
  left: SheetRow,
  right: SheetRow,
  column: ColumnDefinition,
  direction: "asc" | "desc"
) {
  const leftValue = getComparableValue(left, column);
  const rightValue = getComparableValue(right, column);

  if (leftValue === null && rightValue === null) {
    return 0;
  }

  if (leftValue === null) {
    return 1;
  }

  if (rightValue === null) {
    return -1;
  }

  let result = 0;

  if (typeof leftValue === "number" && typeof rightValue === "number") {
    result = leftValue - rightValue;
  } else {
    result = String(leftValue).localeCompare(String(rightValue), "id", {
      sensitivity: "base",
      numeric: true,
    });
  }

  return direction === "asc" ? result : result * -1;
}

export function getInitialColumnWidths() {
  return Object.fromEntries(
    COLUMNS.map((column) => [column.path, column.defaultWidth])
  );
}

export function isBrowserReady() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function loadStoredStringArray(storageKey: string, fallback: string[]) {
  if (!isBrowserReady()) {
    return fallback;
  }

  try {
    const rawValue = window.localStorage.getItem(storageKey);
    if (!rawValue) {
      return fallback;
    }

    const validPaths = new Set(COLUMNS.map((column) => column.path));
    const parsed = JSON.parse(rawValue);

    if (!Array.isArray(parsed)) {
      return fallback;
    }

    return parsed.filter(
      (value): value is string => typeof value === "string" && validPaths.has(value)
    );
  } catch {
    return fallback;
  }
}

export function loadStoredFilterPresets(): FilterPreset[] {
  if (!isBrowserReady()) {
    return [];
  }

  try {
    const rawValue = window.localStorage.getItem(FILTER_PRESETS_STORAGE_KEY);
    if (!rawValue) {
      return [];
    }

    const validPaths = new Set(COLUMNS.map((column) => column.path));
    const parsed = JSON.parse(rawValue);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.flatMap((preset) => {
      if (
        !preset ||
        typeof preset !== "object" ||
        typeof preset.id !== "string" ||
        typeof preset.name !== "string" ||
        (
          (!("textFilters" in preset) || typeof preset.textFilters !== "object") &&
          (!("filters" in preset) || typeof preset.filters !== "object")
        )
      ) {
        return [];
      }

      const normalizedTextFilters = Object.entries(
        (
          "textFilters" in preset && preset.textFilters
            ? preset.textFilters
            : preset.filters
        ) as Record<string, unknown>
      ).reduce<Record<string, string>>((result, [path, value]) => {
        if (validPaths.has(path) && typeof value === "string") {
          result[path] = value;
        }

        return result;
      }, {});

      const normalizedValueFilters =
        "valueFilters" in preset && preset.valueFilters && typeof preset.valueFilters === "object"
          ? Object.entries(preset.valueFilters as Record<string, unknown>).reduce<
              Record<string, string[]>
            >((result, [path, value]) => {
              if (!validPaths.has(path) || !Array.isArray(value)) {
                return result;
              }

              const normalizedValues = value.filter(
                (item): item is string => typeof item === "string" && item.trim() !== ""
              );

              if (normalizedValues.length > 0) {
                result[path] = normalizedValues;
              }

              return result;
            }, {})
          : {};

      return [
        {
          id: preset.id,
          name: preset.name,
          textFilters: normalizedTextFilters,
          valueFilters: normalizedValueFilters,
        },
      ];
    });
  } catch {
    return [];
  }
}

export function buildCsvValue(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}
