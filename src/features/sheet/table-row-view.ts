import type { TrackResponse } from "../../types";
import type {
  SheetRowProjection,
  SheetRowWindow,
} from "../workspace-engine/client";
import { createTrackResponseFromProjection } from "./rust-row-window-adapter";
import type { ColumnDefinition, SheetRow } from "./types";
import {
  formatColumnValue,
  getLatestBagId,
  getLatestBagPrintUrl,
  getLatestManifestId,
  MAX_TRACKING_INPUT_LENGTH,
  getRawColumnValue,
  getRowStatus,
} from "./utils";

export type SheetTableRow = {
  key: string;
  engineRowId?: string;
  position?: number;
  trackingInput: string;
  shipment: TrackResponse | null;
  error: string;
  status: SheetTableRowStatus;
  loading: boolean;
  queued: boolean;
  stale: boolean;
  dirty: boolean;
  getFormattedValue: (column: ColumnDefinition) => string;
  getRawValue: (column: ColumnDefinition) => unknown;
  getLatestBagId: () => string | null;
  getLatestBagPrintUrl: () => string | null;
  getLatestManifestId: () => string | null;
};

export type SheetTableRowStatus =
  | "Loading"
  | "Pending"
  | "Error"
  | "Dirty"
  | "Stale"
  | "Ready"
  | "Draft";

export type SheetTableRowTrackingEntry = {
  key: string;
  value: string;
  engineRowId?: string;
};

function createLegacyRowLookup(rows: SheetRow[]) {
  const lookup = new Map<string, SheetRow>();
  for (const row of rows) {
    const trackingId =
      row.trackingInput.trim() ||
      row.shipment?.detail.shipment_header.nomor_kiriman?.trim() ||
      "";
    if (trackingId && !lookup.has(trackingId)) {
      lookup.set(trackingId, row);
    }
  }

  return lookup;
}

function createLegacyRowKeyLookup(rows: SheetRow[]) {
  const lookup = new Map<string, SheetRow>();
  for (const row of rows) {
    lookup.set(row.key, row);
  }

  return lookup;
}

function createSyntheticSheetRowFromProjection(
  projection: SheetRowProjection,
  shipment: TrackResponse | null,
  legacyRow?: SheetRow
): SheetRow {
  return {
    key: legacyRow?.key ?? projection.rowId,
    trackingInput: projection.displayTrackingId,
    shipment,
    loading: projection.rowStatus === "loading",
    queued: false,
    stale: projection.rowStatus === "stale",
    dirty: false,
    error: projection.errorMessage ?? "",
  };
}

function isSheetEngineRowKey(sheetId: string, rowKey: string) {
  return rowKey.startsWith(`${sheetId}:row:`);
}

function getProjectionTableRowStatus(
  projection: SheetRowProjection
): SheetTableRowStatus {
  switch (projection.rowStatus) {
    case "loading":
      return "Loading";
    case "failed":
      return "Error";
    case "stale":
      return "Stale";
    case "loaded":
      return "Ready";
    case "empty":
      return projection.displayTrackingId.trim() ? "Pending" : "Draft";
    default:
      return "Pending";
  }
}

export function createSheetTableRowFromSheetRow(row: SheetRow): SheetTableRow {
  return {
    key: row.key,
    trackingInput: row.trackingInput,
    shipment: row.shipment,
    error: row.error,
    status: getRowStatus(row) as SheetTableRowStatus,
    loading: row.loading,
    queued: row.queued ?? false,
    stale: row.stale,
    dirty: row.dirty,
    getFormattedValue: (column) => formatColumnValue(row, column),
    getRawValue: (column) => getRawColumnValue(row, column),
    getLatestBagId: () =>
      row.shipment ? (getLatestBagId(row.shipment.history_summary) ?? null) : null,
    getLatestBagPrintUrl: () =>
      row.shipment
        ? (getLatestBagPrintUrl(row.shipment.history_summary) ?? null)
        : null,
    getLatestManifestId: () =>
      row.shipment
        ? (getLatestManifestId(row.shipment.history_summary) ?? null)
        : null,
  };
}

export function createSheetTableRowsFromSheetRows(rows: SheetRow[]) {
  return rows.map((row, position) => ({
    ...createSheetTableRowFromSheetRow(row),
    position,
  }));
}

export function createSheetTableRowsFromRustWindow(
  window: SheetRowWindow,
  legacyRows: SheetRow[]
): SheetTableRow[] {
  const legacyRowByTrackingId = createLegacyRowLookup(legacyRows);
  const legacyRowByKey = createLegacyRowKeyLookup(legacyRows);
  const projectionRowIds = new Set(window.rows.map((row) => row.rowId));
  const projectionTrackingIds = new Set(
    window.rows.map((row) => row.displayTrackingId.trim()).filter(Boolean)
  );
  const rustRows: SheetTableRow[] = window.rows.map((projection) => {
    const legacyRowByProjectionKey = legacyRowByKey.get(projection.rowId);
    if (
      legacyRowByProjectionKey &&
      legacyRowByProjectionKey.trackingInput.trim() !==
        projection.displayTrackingId.trim()
    ) {
      return {
        ...createSheetTableRowFromSheetRow(legacyRowByProjectionKey),
        engineRowId: projection.rowId,
        position: projection.position,
      };
    }

    const legacyRow =
      legacyRowByProjectionKey ??
      legacyRowByTrackingId.get(projection.displayTrackingId);
    const shipment = createTrackResponseFromProjection(projection);
    const row = createSyntheticSheetRowFromProjection(
      projection,
      shipment,
      legacyRow
    );
    const shouldUseLocalRuntimeState = projection.rowStatus !== "loaded";
    const hasLocalRuntimeState = Boolean(
      shouldUseLocalRuntimeState &&
        legacyRow &&
        (legacyRow.loading ||
          legacyRow.queued ||
          legacyRow.error ||
          legacyRow.dirty ||
          legacyRow.stale)
    );
    const mergedRow = hasLocalRuntimeState
      ? {
          ...row,
          loading: row.loading || legacyRow?.loading === true,
          queued: row.queued || legacyRow?.queued === true,
          error: legacyRow?.error ?? row.error,
          dirty: legacyRow?.dirty ?? row.dirty,
          stale: legacyRow?.stale ?? row.stale,
        }
      : row;

    return {
      key: mergedRow.key,
      engineRowId: projection.rowId,
      position: projection.position,
      trackingInput: mergedRow.trackingInput,
      shipment,
      error: mergedRow.error,
      status: hasLocalRuntimeState
        ? (getRowStatus(mergedRow) as SheetTableRowStatus)
        : getProjectionTableRowStatus(projection),
      loading: mergedRow.loading,
      queued: mergedRow.queued ?? false,
      stale: mergedRow.stale,
      dirty: mergedRow.dirty,
      getFormattedValue: (column) => formatColumnValue(row, column),
      getRawValue: (column) => getRawColumnValue(row, column),
      getLatestBagId: () =>
        shipment ? (getLatestBagId(shipment.history_summary) ?? null) : null,
      getLatestBagPrintUrl: () =>
        shipment ? (getLatestBagPrintUrl(shipment.history_summary) ?? null) : null,
      getLatestManifestId: () =>
        shipment ? (getLatestManifestId(shipment.history_summary) ?? null) : null,
    };
  });
  const localTransientRows = legacyRows
    .filter(
      (row) =>
        !projectionRowIds.has(row.key) &&
        !projectionTrackingIds.has(row.trackingInput.trim()) &&
        (row.shipment === null || isSheetEngineRowKey(window.sheetId, row.key))
    )
    .map((row, index) => ({
      ...createSheetTableRowFromSheetRow(row),
      position: window.rows.length + index,
    }));

  return localTransientRows.length > 0
    ? [...rustRows, ...localTransientRows]
    : rustRows;
}

export function getVisibleSelectableTableRowKeys(rows: SheetTableRow[]) {
  return rows
    .filter((row) => row.trackingInput.trim() !== "" || row.shipment !== null)
    .map((row) => row.key);
}

function getSheetRowTrackingId(row: SheetRow) {
  return (
    row.trackingInput.trim() ||
    row.shipment?.detail.shipment_header.nomor_kiriman?.trim() ||
    ""
  );
}

function getTableRowTrackingId(row: SheetTableRow) {
  return (
    row.trackingInput.trim() ||
    row.shipment?.detail.shipment_header.nomor_kiriman?.trim() ||
    ""
  );
}

function createSelectedTrackingIdSet(
  selectedRowKeys: string[],
  sourceRows: SheetRow[]
) {
  const selectedRowKeySet = new Set(selectedRowKeys);
  const trackingIds = new Set<string>();

  for (const row of sourceRows) {
    if (!selectedRowKeySet.has(row.key)) {
      continue;
    }

    const trackingId = getSheetRowTrackingId(row);
    if (trackingId) {
      trackingIds.add(trackingId);
    }
  }

  return trackingIds;
}

function isSelectableTableRowSelected(
  row: SheetTableRow,
  selectedRowKeySet: Set<string>,
  selectedTrackingIdSet: Set<string>
) {
  if (selectedRowKeySet.has(row.key)) {
    return true;
  }

  if (row.engineRowId && selectedRowKeySet.has(row.engineRowId)) {
    return true;
  }

  const trackingId = getTableRowTrackingId(row);
  return trackingId !== "" && selectedTrackingIdSet.has(trackingId);
}

export function getSelectedVisibleTableRowKeys(
  rows: SheetTableRow[],
  selectedRowKeys: string[],
  sourceRows: SheetRow[] = []
) {
  const selectedRowKeySet = new Set(selectedRowKeys);
  const selectedTrackingIdSet = createSelectedTrackingIdSet(
    selectedRowKeys,
    sourceRows
  );

  return rows
    .filter((row) => row.trackingInput.trim() !== "" || row.shipment !== null)
    .filter((row) =>
      isSelectableTableRowSelected(
        row,
        selectedRowKeySet,
        selectedTrackingIdSet
      )
    )
    .map((row) => row.key);
}

export function getSelectedTableRowKeySet(
  rows: SheetTableRow[],
  selectedRowKeys: string[],
  sourceRows: SheetRow[] = []
) {
  const selectedRowKeySet = new Set(selectedRowKeys);

  for (const rowKey of getSelectedVisibleTableRowKeys(
    rows,
    selectedRowKeys,
    sourceRows
  )) {
    selectedRowKeySet.add(rowKey);
  }

  return selectedRowKeySet;
}

export function getSelectedTableRowTrackingIds(
  rows: SheetTableRow[],
  selectedVisibleRowKeys: string[]
) {
  const selectedVisibleRowKeySet = new Set(selectedVisibleRowKeys);
  return rows
    .filter((row) => selectedVisibleRowKeySet.has(row.key))
    .map((row) => row.trackingInput.trim())
    .filter(Boolean);
}

export function getSelectedTableRowEngineRowIds(
  rows: SheetTableRow[],
  selectedVisibleRowKeys: string[]
) {
  const selectedVisibleRowKeySet = new Set(selectedVisibleRowKeys);
  return rows
    .filter((row) => selectedVisibleRowKeySet.has(row.key))
    .map((row) => row.engineRowId?.trim() ?? "")
    .filter(Boolean);
}

export function getAllTableRowTrackingIds(rows: SheetTableRow[]) {
  return rows
    .map((row) => row.trackingInput.trim())
    .filter((value) => value !== "");
}

export function getLoadedTableRowCount(rows: SheetTableRow[]) {
  return rows.filter((row) => row.status === "Ready").length;
}

export function getLoadingTableRowCount(rows: SheetTableRow[]) {
  return rows.filter((row) => row.loading || row.queued).length;
}

export function getTotalTableRowTrackingCount(rows: SheetTableRow[]) {
  return rows.filter((row) => row.trackingInput.trim() !== "").length;
}

export function getTableRowTrackingColumnAutoWidth(rows: SheetTableRow[]) {
  const longestTrackingValue = rows.reduce((longest, row) => {
    const candidate =
      row.trackingInput.trim() ||
      row.shipment?.detail?.shipment_header?.nomor_kiriman ||
      "";
    const boundedCandidate = candidate.slice(0, MAX_TRACKING_INPUT_LENGTH);

    return boundedCandidate.length > longest.length ? boundedCandidate : longest;
  }, "");

  if (!longestTrackingValue) {
    return 0;
  }

  const estimatedTextWidth = longestTrackingValue.length * 8.7;
  const trackingCellChromeWidth = 118;
  return Math.ceil(estimatedTextWidth + trackingCellChromeWidth);
}

export function getRetrackableTableRows(rows: SheetTableRow[]) {
  return rows
    .filter((row) => row.trackingInput.trim() !== "")
    .map((row) => ({ key: row.key, value: row.trackingInput.trim() }));
}

export function getRetryFailedTableRowEntries(rows: SheetTableRow[]) {
  return rows
    .filter(
      (row) =>
        row.trackingInput.trim() !== "" &&
        !row.loading &&
        !row.queued &&
        (row.error !== "" || row.stale || row.dirty)
    )
    .map((row) => ({
      key: row.key,
      value: row.trackingInput.trim(),
      engineRowId: row.engineRowId,
    }));
}

export function getExportableTableRows(
  rows: SheetTableRow[],
  selectedVisibleRowKeys: string[]
) {
  const hasSelection = selectedVisibleRowKeys.length > 0;
  const selectedVisibleRowKeySet = new Set(selectedVisibleRowKeys);

  return rows.filter((row) => {
    if (hasSelection && !selectedVisibleRowKeySet.has(row.key)) {
      return false;
    }

    return row.trackingInput.trim() !== "" || row.shipment !== null;
  });
}
