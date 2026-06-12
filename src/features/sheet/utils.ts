import {
  ANALYTICS_FIELD_COLUMN_PATHS,
  COLUMNS,
  DAYS_SINCE_LAST_UNBAGGING_COLUMN_PATH,
  DAYS_SINCE_TRANSACTION_COLUMN_PATH,
  DELIVERY_RUNSHEET_COUNT_COLUMN_PATH,
  INITIAL_ROW_COUNT,
  LATEST_BAG_STATUS_COLUMN_PATH,
  LATEST_DELIVERY_COLUMN_PATH,
  LATEST_MANIFEST_COLUMN_PATH,
  MIN_EMPTY_TRAILING_ROWS,
  TRACKING_COLUMN_PATH,
} from "./columns";
import { ColumnDefinition, SheetRow, SheetState } from "./types";

const ZERO_WIDTH_CHARACTERS_REGEX = /[\u200B-\u200D\uFEFF]/g;
const NON_TRACKING_CHARACTERS_REGEX = /[^A-Z0-9.-]/g;
export const MAX_TRACKING_INPUT_LENGTH = 64;
const BAG_PRINT_SUFFIX = "5f9fae9b5fbe9d6e401ad0c5";
const BAG_PRINT_OID = "NWY5ZmFlOWI1ZmJlOWQ2ZTQwMWFkMGM1";
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const TRACKING_VALUE_FILTER_PREFIX_LENGTH = 5;
const HISTORY_SUMMARY_PATHS = new Set([
  "history_summary.irregularity",
  "history_summary.bagging_unbagging",
  "history_summary.manifest_r7",
  "history_summary.delivery_runsheet",
]);

export function createEmptyRow(): SheetRow {
  return {
    key: crypto.randomUUID(),
    trackingInput: "",
    shipment: null,
    loading: false,
    queued: false,
    stale: false,
    dirty: false,
    error: "",
  };
}

export function createEmptyRows(count: number) {
  return Array.from({ length: count }, () => createEmptyRow());
}

export function sanitizeTrackingInput(value: string) {
  return value
    .normalize("NFKC")
    .replace(ZERO_WIDTH_CHARACTERS_REGEX, "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(NON_TRACKING_CHARACTERS_REGEX, "");
}

export function sanitizeTrackingPasteValues(value: string) {
  return value
    .split(/\r?\n/)
    .map((item) => sanitizeTrackingInput(item))
    .filter(Boolean);
}

export function getTrackingInputValidationError(value: string) {
  if (!value) {
    return null;
  }

  if (value.length > MAX_TRACKING_INPUT_LENGTH) {
    return `Shipment ID exceeds ${MAX_TRACKING_INPUT_LENGTH} characters.`;
  }

  return null;
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

function createValidatedLocalDate(year: number, month: number, day: number) {
  const parsed = new Date(year, month - 1, day);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null;
  }

  return parsed;
}

function parseLocalDateValue(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const yearFirst = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (yearFirst) {
    return createValidatedLocalDate(
      Number(yearFirst[1]),
      Number(yearFirst[2]),
      Number(yearFirst[3])
    );
  }

  const dayFirst = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (dayFirst) {
    return createValidatedLocalDate(
      Number(dayFirst[3]),
      Number(dayFirst[2]),
      Number(dayFirst[1])
    );
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseLocalDateTimeValue(dateValue: string, timeValue?: string) {
  const parsed = parseLocalDateValue(dateValue);
  if (!parsed || !timeValue) {
    return parsed;
  }

  const timeMatch = timeValue.trim().match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if (!timeMatch) {
    return parsed;
  }

  const hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);
  const seconds = Number(timeMatch[3] ?? "0");
  if (hours > 23 || minutes > 59 || seconds > 59) {
    return parsed;
  }

  parsed.setHours(hours, minutes, seconds, 0);
  return parsed;
}

function getUtcCalendarStart(date: Date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

function getElapsedCalendarDays(dateValue: unknown, today = new Date()) {
  if (typeof dateValue !== "string" || dateValue.trim() === "") {
    return undefined;
  }

  const parsed = parseLocalDateValue(dateValue);
  if (!parsed) {
    return undefined;
  }

  const elapsedDays = Math.floor(
    (getUtcCalendarStart(today) - getUtcCalendarStart(parsed)) / DAY_IN_MS
  );
  return Math.max(0, elapsedDays);
}

export function getRowStatus(row: SheetRow) {
  if (row.loading) {
    return "Loading";
  }

  if (row.queued) {
    return "Pending";
  }

  if (row.error) {
    return "Error";
  }

  if (row.dirty) {
    return "Dirty";
  }

  if (row.stale) {
    return "Stale";
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

  if (column.path === LATEST_BAG_STATUS_COLUMN_PATH) {
    return getLatestBagStatusText(row.shipment.history_summary);
  }

  if (column.path === DAYS_SINCE_TRANSACTION_COLUMN_PATH) {
    return getElapsedCalendarDays(row.shipment.detail.origin_detail.tanggal_input);
  }

  if (column.path === DAYS_SINCE_LAST_UNBAGGING_COLUMN_PATH) {
    return getDaysSinceLatestUnbagging(row.shipment.history_summary);
  }

  if (column.path === LATEST_MANIFEST_COLUMN_PATH) {
    return getLatestManifestText(row.shipment.history_summary);
  }

  if (column.path === LATEST_DELIVERY_COLUMN_PATH) {
    return getLatestDeliveryText(row.shipment.history_summary);
  }

  if (column.path === DELIVERY_RUNSHEET_COUNT_COLUMN_PATH) {
    return getDeliveryRunsheetCount(row.shipment.history_summary);
  }

  return getByPath(row.shipment, column.path);
}

export function isHistorySummaryPath(path: string) {
  return HISTORY_SUMMARY_PATHS.has(path);
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

function formatDateTimeParts(date?: string, time?: string) {
  const parts = [date, time].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "-";
}

function formatYearMonthDayPart(date?: string) {
  const trimmed = date?.trim();
  if (!trimmed) {
    return "-";
  }

  const yearFirst = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (yearFirst) {
    return [
      yearFirst[1],
      yearFirst[2].padStart(2, "0"),
      yearFirst[3].padStart(2, "0"),
    ].join("-");
  }

  const dayFirst = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (dayFirst) {
    return [
      dayFirst[3],
      dayFirst[2].padStart(2, "0"),
      dayFirst[1].padStart(2, "0"),
    ].join("-");
  }

  return trimmed;
}

function getRecordValue(
  source: Record<string, unknown>,
  key: string
): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function getLatestBagStatusDetails(historySummary: unknown) {
  if (!historySummary || typeof historySummary !== "object") {
    return null;
  }

  const rawValue = (historySummary as Record<string, unknown>).bagging_unbagging;
  if (!Array.isArray(rawValue) || rawValue.length === 0) {
    return null;
  }

  let latestBagStatus:
    | {
        bagId: string;
        statusLabel: "Bagging" | "Unbagging";
      }
    | null = null;

  for (const item of rawValue) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const nomorKantung = getRecordValue(record, "nomor_kantung");
    if (!nomorKantung) {
      continue;
    }

    if (record.bagging && typeof record.bagging === "object") {
      latestBagStatus = {
        bagId: nomorKantung,
        statusLabel: "Bagging",
      };
    }

    if (record.unbagging && typeof record.unbagging === "object") {
      latestBagStatus = {
        bagId: nomorKantung,
        statusLabel: "Unbagging",
      };
    }
  }

  return latestBagStatus;
}

function getLatestBagStatusText(historySummary: unknown) {
  const latestBagStatus = getLatestBagStatusDetails(historySummary);
  if (!latestBagStatus) {
    return "-";
  }

  return `${latestBagStatus.bagId} - ${latestBagStatus.statusLabel}`;
}

export function getLatestBagId(historySummary: unknown) {
  return getLatestBagStatusDetails(historySummary)?.bagId ?? null;
}

function getDaysSinceLatestUnbagging(historySummary: unknown) {
  if (!historySummary || typeof historySummary !== "object") {
    return undefined;
  }

  const rawValue = (historySummary as Record<string, unknown>).bagging_unbagging;
  if (!Array.isArray(rawValue) || rawValue.length === 0) {
    return undefined;
  }

  let latestUnbagging:
    | {
        date: string;
        timestamp: number;
      }
    | null = null;

  for (const item of rawValue) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const unbagging = (item as Record<string, unknown>).unbagging;
    if (!unbagging || typeof unbagging !== "object") {
      continue;
    }

    const eventRecord = unbagging as Record<string, unknown>;
    const date = getRecordValue(eventRecord, "tanggal");
    if (!date) {
      continue;
    }

    const parsed = parseLocalDateTimeValue(
      date,
      getRecordValue(eventRecord, "waktu")
    );
    if (!parsed) {
      continue;
    }

    const timestamp = parsed.getTime();
    if (!latestUnbagging || timestamp >= latestUnbagging.timestamp) {
      latestUnbagging = { date, timestamp };
    }
  }

  return latestUnbagging
    ? getElapsedCalendarDays(latestUnbagging.date)
    : undefined;
}

export function getLatestManifestId(historySummary: unknown) {
  if (!historySummary || typeof historySummary !== "object") {
    return null;
  }

  const rawValue = (historySummary as Record<string, unknown>).manifest_r7;
  if (!Array.isArray(rawValue) || rawValue.length === 0) {
    return null;
  }

  const latest = rawValue[rawValue.length - 1];
  if (!latest || typeof latest !== "object") {
    return null;
  }

  return getRecordValue(latest as Record<string, unknown>, "nomor_r7");
}

function getLatestManifestText(historySummary: unknown) {
  return getLatestManifestId(historySummary) ?? "-";
}

function getLatestDeliveryText(historySummary: unknown) {
  if (!historySummary || typeof historySummary !== "object") {
    return "-";
  }

  const rawValue = (historySummary as Record<string, unknown>).delivery_runsheet;
  if (!Array.isArray(rawValue) || rawValue.length === 0) {
    return "-";
  }

  return getHistorySummaryLatestText(rawValue, "history_summary.delivery_runsheet");
}

function getDeliveryRunsheetCount(historySummary: unknown) {
  if (!historySummary || typeof historySummary !== "object") {
    return 0;
  }

  const rawValue = (historySummary as Record<string, unknown>).delivery_runsheet;
  return Array.isArray(rawValue) ? rawValue.length : 0;
}

export function getLatestBagPrintUrl(historySummary: unknown) {
  const latestBagId = getLatestBagId(historySummary);
  if (!latestBagId) {
    return null;
  }

  const bagIdentifier = `${latestBagId}_${BAG_PRINT_SUFFIX}`;
  return `https://apiexpos.mile.app/api/v1/print-bag?bag_id=${encodeURIComponent(
    bagIdentifier
  )}&oid=${encodeURIComponent(BAG_PRINT_OID)}`;
}

function getHistorySummaryLatestText(rawValue: unknown, path: string) {
  if (!Array.isArray(rawValue) || rawValue.length === 0) {
    return "-";
  }

  if (path === "history_summary.irregularity") {
    const latest = rawValue[rawValue.length - 1];
    if (!latest || typeof latest !== "object") {
      return "-";
    }

    const record = latest as Record<string, unknown>;
    return [
      getRecordValue(record, "status") ?? "Irregularity",
      getRecordValue(record, "lokasi") ?? getRecordValue(record, "petugas") ?? "-",
      formatDateTimeParts(
        getRecordValue(record, "tanggal"),
        getRecordValue(record, "waktu")
      ),
    ].join(" | ");
  }

  if (path === "history_summary.bagging_unbagging") {
    let latestEvent:
      | {
          label: string;
          lokasi?: string;
          petugas?: string;
          tanggal?: string;
          waktu?: string;
        }
      | null = null;

    for (const item of rawValue) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const record = item as Record<string, unknown>;
      const nomorKantung = getRecordValue(record, "nomor_kantung") ?? "-";

      for (const [eventType, label] of [
        ["bagging", "Bagging"],
        ["unbagging", "Unbagging"],
      ] as const) {
        const event = record[eventType];
        if (!event || typeof event !== "object") {
          continue;
        }

        const eventRecord = event as Record<string, unknown>;
        latestEvent = {
          label: `${label} ${nomorKantung}`,
          lokasi: getRecordValue(eventRecord, "lokasi"),
          petugas: getRecordValue(eventRecord, "petugas"),
          tanggal: getRecordValue(eventRecord, "tanggal"),
          waktu: getRecordValue(eventRecord, "waktu"),
        };
      }
    }

    if (!latestEvent) {
      return "-";
    }

    return [
      latestEvent.label,
      latestEvent.lokasi ?? latestEvent.petugas ?? "-",
      formatDateTimeParts(latestEvent.tanggal, latestEvent.waktu),
    ].join(" | ");
  }

  if (path === "history_summary.manifest_r7") {
    const latest = rawValue[rawValue.length - 1];
    if (!latest || typeof latest !== "object") {
      return "-";
    }

    const record = latest as Record<string, unknown>;
    return [
      getRecordValue(record, "nomor_r7") ?? "Manifest R7",
      getRecordValue(record, "tujuan") ?? getRecordValue(record, "lokasi") ?? "-",
      formatDateTimeParts(
        getRecordValue(record, "tanggal"),
        getRecordValue(record, "waktu")
      ),
    ].join(" | ");
  }

  if (path === "history_summary.delivery_runsheet") {
    const latest = rawValue[rawValue.length - 1];
    if (!latest || typeof latest !== "object") {
      return "-";
    }

    const record = latest as Record<string, unknown>;
    const updates = Array.isArray(record.updates) ? record.updates : [];
    const latestUpdate =
      updates.length > 0 && typeof updates[updates.length - 1] === "object"
        ? (updates[updates.length - 1] as Record<string, unknown>)
        : null;
    const latestStatus = latestUpdate
      ? getRecordValue(latestUpdate, "status") ?? "Delivery Update"
      : getRecordValue(record, "status") ?? "Delivery Runsheet";

    return [
      latestStatus,
      latestUpdate
        ? formatYearMonthDayPart(getRecordValue(latestUpdate, "tanggal"))
        : formatYearMonthDayPart(getRecordValue(record, "tanggal")),
      latestUpdate
        ? getRecordValue(latestUpdate, "petugas") ?? "-"
        : getRecordValue(record, "petugas_kurir") ??
          getRecordValue(record, "petugas_mandor") ??
          getRecordValue(record, "lokasi") ??
          "-",
    ].join(" | ");
  }

  return JSON.stringify(rawValue);
}

export function formatHistorySummaryPreview(rawValue: unknown) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return "-";
  }

  return JSON.stringify(rawValue, null, 2);
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
    case "json":
      if (isHistorySummaryPath(column.path)) {
        return getHistorySummaryLatestText(rawValue, column.path);
      }
      return JSON.stringify(rawValue);
    default:
      return String(rawValue);
  }
}

export function formatColumnValueFilterKey(row: SheetRow, column: ColumnDefinition) {
  const value = formatColumnValue(row, column);

  if (value === "-" || column.path !== TRACKING_COLUMN_PATH) {
    return value;
  }

  return value.slice(0, TRACKING_VALUE_FILTER_PREFIX_LENGTH);
}

export function matchesColumnValueFilter(
  row: SheetRow,
  column: ColumnDefinition,
  selectedValues: string[]
) {
  if (selectedValues.length === 0) {
    return true;
  }

  const value = formatColumnValue(row, column);
  if (value === "-") {
    return false;
  }

  if (column.path === TRACKING_COLUMN_PATH) {
    return (
      selectedValues.includes(value.slice(0, TRACKING_VALUE_FILTER_PREFIX_LENGTH)) ||
      selectedValues.includes(value)
    );
  }

  return selectedValues.includes(value);
}

export function getColumnValueOptions(rows: SheetRow[], column: ColumnDefinition) {
  const optionCounts = new Map<string, number>();

  for (const row of rows) {
    const value = formatColumnValueFilterKey(row, column);
    if (value === "-") {
      continue;
    }

    optionCounts.set(value, (optionCounts.get(value) ?? 0) + 1);
  }

  return Array.from(optionCounts, ([value, count]) => ({
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

export function getColumnHeaderMinWidth(column: ColumnDefinition) {
  const estimatedLabelWidth = column.label.length * 8.5;
  const headerChromeWidth = column.compact ? 42 : 74;
  return Math.max(column.minWidth ?? 100, Math.ceil(estimatedLabelWidth + headerChromeWidth));
}

export function getEffectiveColumnWidth(
  column: ColumnDefinition,
  columnWidths: Record<string, number>
) {
  const width = Math.max(
    columnWidths[column.path] ?? column.defaultWidth,
    getColumnHeaderMinWidth(column)
  );

  return column.maxWidth ? Math.min(width, column.maxWidth) : width;
}

export function getColumnToneClass(column: ColumnDefinition) {
  switch (column.tone) {
    case "pengirim":
      return "tone-pengirim";
    case "penerima":
      return "tone-penerima";
    case "status":
      return "tone-status";
    case "layanan":
      return "tone-layanan";
    case "cod":
      return "tone-cod";
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
    case "Dirty":
      return "status-dirty";
    case "Stale":
      return "status-stale";
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
    case "json":
      if (isHistorySummaryPath(column.path)) {
        return getHistorySummaryLatestText(rawValue, column.path).toLowerCase();
      }
      return JSON.stringify(rawValue);
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

export function assertValidSheetState(sheetState: SheetState) {
  if (
    sheetState.activeMode !== "workspace" &&
    sheetState.activeMode !== "analytics"
  ) {
    throw new Error(`Invalid sheet mode: ${String(sheetState.activeMode)}`);
  }

  if (
    sheetState.analytics.sourceScope !== "all_rows" &&
    sheetState.analytics.sourceScope !== "filtered_rows" &&
    sheetState.analytics.sourceScope !== "selected_rows"
  ) {
    throw new Error(
      `Invalid sheet analytics source scope: ${String(sheetState.analytics.sourceScope)}`
    );
  }

  if (!Array.isArray(sheetState.analytics.rowPaths)) {
    throw new Error("Invalid sheet analytics row paths.");
  }

  if (!Array.isArray(sheetState.analytics.columnPaths)) {
    throw new Error("Invalid sheet analytics column paths.");
  }

  const analyticsColumnPaths = COLUMNS.filter((column) =>
    ANALYTICS_FIELD_COLUMN_PATHS.includes(
      column.path as (typeof ANALYTICS_FIELD_COLUMN_PATHS)[number]
    )
  ).map((column) => column.path);
  const analyticsGroupPathSet = new Set(analyticsColumnPaths);
  for (const rowPath of sheetState.analytics.rowPaths) {
    if (!analyticsGroupPathSet.has(rowPath)) {
      throw new Error(`Invalid sheet analytics row path: ${rowPath}`);
    }
  }

  for (const columnPath of sheetState.analytics.columnPaths) {
    if (!analyticsGroupPathSet.has(columnPath)) {
      throw new Error(`Invalid sheet analytics column path: ${columnPath}`);
    }
  }

  if (!Array.isArray(sheetState.analytics.valueMetrics)) {
    throw new Error("Invalid sheet analytics values.");
  }

  const analyticsMetricSet = new Set(analyticsColumnPaths);
  for (const metric of sheetState.analytics.valueMetrics) {
    if (!analyticsMetricSet.has(metric)) {
      throw new Error(`Invalid sheet analytics value: ${String(metric)}`);
    }
  }

  if (
    sheetState.analytics.metricAggregations !== undefined &&
    (!sheetState.analytics.metricAggregations ||
      typeof sheetState.analytics.metricAggregations !== "object" ||
      Array.isArray(sheetState.analytics.metricAggregations))
  ) {
    throw new Error("Invalid sheet analytics metric aggregations.");
  }

  const analyticsMetricAggregationSet = new Set([
    "sum",
    "average",
    "min",
    "max",
    "count",
    "count_unique",
    "unique_list",
    "most_frequent",
    "first",
    "last",
  ]);
  for (const [metric, aggregation] of Object.entries(
    sheetState.analytics.metricAggregations ?? {}
  )) {
    if (!analyticsMetricSet.has(metric)) {
      throw new Error(`Invalid sheet analytics metric aggregation key: ${metric}`);
    }

    if (
      typeof aggregation !== "string" ||
      !analyticsMetricAggregationSet.has(aggregation)
    ) {
      throw new Error(
        `Invalid sheet analytics metric aggregation: ${String(aggregation)}`
      );
    }
  }

  if (
    sheetState.analytics.chartType !== "bar" &&
    sheetState.analytics.chartType !== "donut" &&
    sheetState.analytics.chartType !== "pivot"
  ) {
    throw new Error(
      `Invalid sheet analytics chart type: ${String(sheetState.analytics.chartType)}`
    );
  }

  const rowKeySet = new Set<string>();

  for (const row of sheetState.rows) {
    if (rowKeySet.has(row.key)) {
      throw new Error(`Duplicate row key detected: ${row.key}`);
    }
    rowKeySet.add(row.key);

    if (row.loading && row.error) {
      throw new Error(`Row ${row.key} cannot be loading and errored at the same time.`);
    }

    if (row.loading && row.queued) {
      throw new Error(`Row ${row.key} cannot be loading and queued at the same time.`);
    }

    if (row.queued && row.trackingInput.trim() === "") {
      throw new Error(`Row ${row.key} cannot be queued without a tracking input.`);
    }

    if (row.stale && row.shipment === null) {
      throw new Error(`Row ${row.key} cannot be stale without a last-known-good shipment.`);
    }

    if (row.trackingInput.trim() === "") {
      if (
        row.shipment !== null ||
        row.loading ||
        row.queued ||
        row.stale ||
        row.dirty ||
        row.error
      ) {
        throw new Error(`Row ${row.key} is empty but still carries tracking state.`);
      }
    }
  }

  for (const selectedRowKey of sheetState.selectedRowKeys) {
    if (!rowKeySet.has(selectedRowKey)) {
      throw new Error(`Selected row key ${selectedRowKey} does not exist in sheet state.`);
    }
  }

  return sheetState;
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

export function buildCsvValue(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}
