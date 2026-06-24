import {
  setRowErrorInSheet,
  setRowLoadingInSheet,
  setRowSuccessInSheet,
  setRowsQueuedInSheet,
  settleRowsRuntimeStateInSheet,
} from "../sheet/actions";
import { createTrackResponseFromProjection } from "../sheet/rust-row-window-adapter";
import type { SheetRow, SheetState } from "../sheet/types";
import type {
  SheetRowProjection,
  TrackingRefreshProgressEvent,
} from "../workspace-engine/client";

function findSheetRowKeyForProjection(
  sheetState: SheetState,
  projection: SheetRowProjection,
  preferredRowKey?: string
) {
  const normalizedPreferredRowKey = preferredRowKey?.trim();
  if (
    normalizedPreferredRowKey &&
    sheetState.rows.some((row) => row.key === normalizedPreferredRowKey)
  ) {
    return normalizedPreferredRowKey;
  }

  const projectionRowId = projection.rowId.trim();
  const trackingId = projection.displayTrackingId.trim();
  return (
    sheetState.rows.find((row) => row.key === projectionRowId)?.key ??
    sheetState.rows.find((row) => row.trackingInput.trim() === trackingId)?.key ??
    null
  );
}

function createMirrorRowFromProjection(projection: SheetRowProjection): SheetRow {
  return {
    key: projection.rowId.trim(),
    trackingInput: projection.displayTrackingId.trim(),
    shipment: null,
    loading: false,
    queued: false,
    stale: false,
    dirty: false,
    error: "",
  };
}

function ensureSheetRowForProjection(
  sheetState: SheetState,
  projection: SheetRowProjection,
  options: { preferredRowKey?: string; createMissingRow?: boolean } = {}
) {
  const rowKey = findSheetRowKeyForProjection(
    sheetState,
    projection,
    options.preferredRowKey
  );
  if (rowKey) {
    return {
      sheetState,
      rowKey,
    };
  }

  if (
    options.createMissingRow !== true ||
    !projection.rowId.trim() ||
    !projection.displayTrackingId.trim()
  ) {
    return {
      sheetState,
      rowKey: null,
    };
  }

  return {
    sheetState: {
      ...sheetState,
      rows: [...sheetState.rows, createMirrorRowFromProjection(projection)],
    },
    rowKey: projection.rowId.trim(),
  };
}

export function applyTrackingRefreshProgressToSheet(
  sheetState: SheetState,
  event: TrackingRefreshProgressEvent,
  options: { rowKey?: string; createMissingRow?: boolean; runId?: string | null } = {}
) {
  const runId = options.runId ?? event.runId ?? null;
  if (runId && sheetState.activeTrackingRunId !== runId) {
    return sheetState;
  }

  const ensured = ensureSheetRowForProjection(
    sheetState,
    event.row,
    {
      preferredRowKey: options.rowKey,
      createMissingRow: options.createMissingRow,
    }
  );
  const rowKey = ensured.rowKey;
  if (!rowKey) {
    return sheetState;
  }

  const currentRow = ensured.sheetState.rows.find((row) => row.key === rowKey);
  if (
    currentRow &&
    currentRow.trackingInput.trim() !== "" &&
    currentRow.trackingInput.trim() !== event.row.displayTrackingId.trim()
  ) {
    return sheetState;
  }

  if (event.row.rowStatus === "loading") {
    if (
      !runId &&
      currentRow &&
      !currentRow.loading &&
      !currentRow.queued &&
      (currentRow.shipment || currentRow.error || currentRow.dirty || currentRow.stale)
    ) {
      return sheetState;
    }

    return setRowLoadingInSheet(
      ensured.sheetState,
      rowKey,
      event.row.displayTrackingId,
      { runId }
    );
  }

  if (event.row.rowStatus === "pending") {
    if (currentRow?.loading) {
      return sheetState;
    }

    if (
      !runId &&
      (currentRow?.shipment || currentRow?.error || currentRow?.dirty || currentRow?.stale)
    ) {
      return sheetState;
    }

    return setRowsQueuedInSheet(
      ensured.sheetState,
      [
        {
          key: rowKey,
          value: event.row.displayTrackingId,
          engineRowId: event.row.rowId,
        },
      ],
      { runId }
    );
  }

  if (event.row.rowStatus === "failed") {
    return setRowErrorInSheet(
      ensured.sheetState,
      rowKey,
      event.row.errorMessage ?? "Tracking request failed.",
      { runId }
    );
  }

  if (event.row.rowStatus === "loaded") {
    const shipment = createTrackResponseFromProjection(event.row);
    if (shipment) {
      return setRowSuccessInSheet(
        ensured.sheetState,
        rowKey,
        event.row.displayTrackingId,
        shipment,
        { runId }
      );
    }
  }

  return settleRowsRuntimeStateInSheet(ensured.sheetState, [rowKey]);
}

export function applyTrackingRefreshRowsToSheet(
  sheetState: SheetState,
  rows: SheetRowProjection[],
  options: {
    getRowKey?: (row: SheetRowProjection) => string | undefined;
    createMissingRows?: boolean;
    runId?: string | null;
  } = {}
) {
  if (options.runId && sheetState.activeTrackingRunId !== options.runId) {
    return sheetState;
  }

  return rows.reduce(
    (current, row) =>
      applyTrackingRefreshProgressToSheet(
        current,
        {
          sheetId: "",
          row,
          totalCount: rows.length,
          successCount: 0,
          failedCount: 0,
          pendingCount: 0,
          runId: options.runId ?? null,
        },
        {
          rowKey: options.getRowKey?.(row),
          createMissingRow: options.createMissingRows,
          runId: options.runId,
        }
      ),
    sheetState
  );
}
