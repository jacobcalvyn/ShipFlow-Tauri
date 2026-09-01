import { ClipboardEvent, FocusEvent, MutableRefObject, useCallback, useEffect, useRef } from "react";
import {
  applyBulkPasteToSheet,
  clearTrackingCellInSheet,
  clearTrackingRunInSheet,
  setRowErrorInSheet,
  setRowLoadingInSheet,
  setRowsQueuedInSheet,
  startTrackingRunInSheet,
  setTrackingInputInSheet,
} from "../sheet/actions";
import { SheetState } from "../sheet/types";
import { createEngineRowSelectionKey } from "../sheet/table-row-view";
import {
  getTrackingInputValidationError,
  createEmptyRow,
  ensureTrailingEmptyRows,
  sanitizeTrackingInput,
  sanitizeTrackingPasteValues,
} from "../sheet/utils";
import { WorkspaceState } from "../workspace/types";
import {
  deleteSheetRows,
  refreshSheetRowTracking,
  refreshSheetRowsTrackingWithProgress,
  querySheetRows,
  type SheetRowProjection,
  type SheetRowsQuery,
  upsertSheetRows,
} from "../workspace-engine/client";
import {
  applyTrackingRefreshProgressToSheet,
  applyTrackingRefreshRowsToSheet,
} from "../workspace/tracking-refresh-state";

type TrackingTelemetryEvent = "start" | "success" | "fail" | "abort";
type TrackingErrorClass =
  | "timeout"
  | "abort"
  | "not_found"
  | "parse_error"
  | "invalid_response"
  | "bad_request"
  | "network"
  | "unknown";

type TrackingRequestMeta = {
  requestId: string;
  sheetId: string;
  rowKey: string;
  shipmentId: string;
  startedAt: number;
};

type UseTrackingRuntimeControllerOptions = {
  workspaceRef: MutableRefObject<WorkspaceState>;
  updateSheet: (sheetId: string, updater: (sheetState: SheetState) => SheetState) => void;
  disarmDeleteAll: () => void;
  onWorkspaceEngineMutation?: (sheetIds?: string | string[]) => void;
};

type FetchRuntimeOptions = {
  forceRefresh?: boolean;
  sheetState?: SheetState;
  position?: number;
  engineRowId?: string;
};

type BulkQueueEntry = {
  key: string;
  value: string;
  position?: number;
  engineRowId?: string;
  options?: FetchRuntimeOptions;
};

function getBulkQueueEntryKey(entry: BulkQueueEntry) {
  return entry.engineRowId?.trim() || entry.key;
}

function mergeBulkQueueEntries(
  existingEntries: BulkQueueEntry[],
  nextEntries: BulkQueueEntry[]
) {
  const merged = new Map<string, BulkQueueEntry>();
  existingEntries.forEach((entry) => {
    merged.set(getBulkQueueEntryKey(entry), entry);
  });
  nextEntries.forEach((entry) => {
    merged.set(getBulkQueueEntryKey(entry), entry);
  });
  return Array.from(merged.values());
}

type TrackingRowContext = {
  position?: number;
  engineRowId?: string;
  displayedRows?: BulkPasteDisplayedRow[];
  nextAppendPosition?: number;
  rowsQuery?: SheetRowsQuery;
  queryOffset?: number;
};

export type BulkPasteDisplayedRow = {
  key: string;
  position?: number;
  engineRowId?: string;
};

type TrackingBulkPasteEntry = {
  key: string;
  value: string;
  position?: number;
  engineRowId?: string;
};

function getSheetRequestKey(sheetId: string, rowKey: string) {
  return `${sheetId}:${rowKey}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getProjectionResolvedShipmentId(row: SheetRowProjection) {
  const detailJson = isObject(row.detailJson) ? row.detailJson : {};
  const shipmentHeader = isObject(detailJson.shipment_header)
    ? detailJson.shipment_header
    : {};
  const resolvedShipmentId = shipmentHeader.nomor_kiriman;

  return typeof resolvedShipmentId === "string" && resolvedShipmentId.trim() !== ""
    ? resolvedShipmentId
    : row.lookupTrackingId;
}

function getTrackingFailureMessage(error: unknown) {
  return error instanceof Error ? error.message : "Tracking request failed.";
}

function createEngineRowsFromEntries(
  sheetState: SheetState | undefined,
  entries: Array<{
    key: string;
    value: string;
    position?: number;
    engineRowId?: string;
  }>
) {
  if (!sheetState) {
    return [];
  }

  const positionByRowKey = new Map(
    sheetState.rows.map((row, position) => [row.key, position])
  );

  return entries
    .map((entry) => ({
      rowId: entry.engineRowId?.trim() || entry.key,
      position:
        typeof entry.position === "number" && entry.position >= 0
          ? entry.position
          : (positionByRowKey.get(entry.key) ?? -1),
      displayTrackingId: sanitizeTrackingInput(entry.value),
    }))
    .filter(
      (row) =>
        row.position >= 0 &&
        row.displayTrackingId !== "" &&
        !getTrackingInputValidationError(row.displayTrackingId)
    )
    .map((row) => ({
      rowId: row.rowId,
      position: row.position,
      displayTrackingId: row.displayTrackingId,
    }));
}

function hasRowKey(sheetState: SheetState, rowKey: string) {
  return sheetState.rows.some((row) => row.key === rowKey);
}

function ensureTrackingDraftRowInSheet(
  sheetState: SheetState,
  rowKey: string,
  trackingInput: string
) {
  if (hasRowKey(sheetState, rowKey)) {
    return sheetState;
  }

  return {
    ...sheetState,
    rows: ensureTrailingEmptyRows([
      ...sheetState.rows,
      {
        ...createEmptyRow(),
        key: rowKey,
        trackingInput,
      },
    ]),
  };
}

function setTrackingDraftInputInSheet(
  sheetState: SheetState,
  rowKey: string,
  trackingInput: string
) {
  return setTrackingInputInSheet(
    ensureTrackingDraftRowInSheet(sheetState, rowKey, trackingInput),
    rowKey,
    trackingInput
  );
}

function createPasteBatchId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function maxDisplayedPastePosition(
  displayedRows: BulkPasteDisplayedRow[],
  startPosition?: number
) {
  let maxPosition =
    typeof startPosition === "number" && startPosition >= 0 ? startPosition : -1;
  for (const row of displayedRows) {
    if (typeof row.position === "number" && row.position > maxPosition) {
      maxPosition = row.position;
    }
  }
  return maxPosition;
}

export function createBulkPasteTargetEntries({
  sheetId,
  startRowKey,
  values,
  displayedRows,
  startPosition,
  startEngineRowId,
  nextAppendPosition,
}: {
  sheetId: string;
  startRowKey: string;
  values: string[];
  displayedRows: BulkPasteDisplayedRow[];
  startPosition?: number;
  startEngineRowId?: string;
  nextAppendPosition?: number;
}): TrackingBulkPasteEntry[] {
  const startIndex = displayedRows.findIndex((row) => row.key === startRowKey);
  const batchId = createPasteBatchId();
  const fallbackAppendPosition = Math.max(
    maxDisplayedPastePosition(displayedRows, startPosition) + 1,
    typeof nextAppendPosition === "number" && nextAppendPosition >= 0
      ? nextAppendPosition
      : 0
  );
  let appendOffset = 0;

  return values.map((value, offset) => {
    const displayed = startIndex >= 0 ? displayedRows[startIndex + offset] : undefined;
    if (displayed) {
      const engineRowId =
        displayed.engineRowId?.trim() ||
        (offset === 0 ? startEngineRowId?.trim() : "") ||
        "";
      const position =
        typeof displayed.position === "number" && displayed.position >= 0
          ? displayed.position
          : typeof startPosition === "number"
            ? startPosition + offset
            : undefined;
      return {
        key: displayed.key,
        value,
        ...(typeof position === "number" ? { position } : {}),
        ...(engineRowId ? { engineRowId } : {}),
      };
    }

    if (offset === 0) {
      const engineRowId = startEngineRowId?.trim() || "";
      return {
        key: startRowKey,
        value,
        position:
          typeof startPosition === "number" && startPosition >= 0
            ? startPosition
            : fallbackAppendPosition,
        ...(engineRowId ? { engineRowId } : {}),
      };
    }

    const position = fallbackAppendPosition + appendOffset;
    appendOffset += 1;
    return {
      key: `${sheetId}:paste:${batchId}:${offset}`,
      value,
      position,
    };
  });
}

export async function resolveProjectedBulkPasteTargetEntries({
  sheetId,
  values,
  displayedRows,
  startOffset,
  rowsQuery,
  loadRows = querySheetRows,
}: {
  sheetId: string;
  values: string[];
  displayedRows: BulkPasteDisplayedRow[];
  startOffset: number;
  rowsQuery: SheetRowsQuery;
  loadRows?: typeof querySheetRows;
}): Promise<TrackingBulkPasteEntry[]> {
  const displayedByEngineRowId = new Map(
    displayedRows
      .filter((row) => row.engineRowId?.trim())
      .map((row) => [row.engineRowId!.trim(), row])
  );
  const targetEntries: TrackingBulkPasteEntry[] = [];
  let offset = Math.max(0, startOffset);

  while (targetEntries.length < values.length) {
    const remaining = values.length - targetEntries.length;
    const response = await loadRows({
      ...rowsQuery,
      offset,
      limit: Math.min(1_000, remaining),
    });
    if (response.payload.rows.length === 0) {
      break;
    }

    for (const row of response.payload.rows) {
      if (targetEntries.length >= values.length) {
        break;
      }
      const displayed = displayedByEngineRowId.get(row.rowId);
      targetEntries.push({
        key: displayed?.key ?? row.rowId,
        value: values[targetEntries.length],
        position: row.position,
        engineRowId: row.rowId,
      });
    }

    if (!response.payload.hasMore || response.payload.nextOffset === null) {
      break;
    }
    if (response.payload.nextOffset <= offset) {
      throw new Error("Rust bulk-paste pagination stalled.");
    }
    offset = response.payload.nextOffset;
  }

  if (targetEntries.length >= values.length) {
    return targetEntries;
  }

  const tailResponse = await loadRows({
    sheetId,
    offset: 0,
    limit: 1,
    filters: [],
    valueFilters: [],
    sort: [{ field: "position", direction: "desc" }],
  });
  const nextAppendPosition =
    (tailResponse.payload.rows[0]?.position ?? -1) + 1;
  const batchId = createPasteBatchId();
  const appendStartIndex = targetEntries.length;
  for (let index = appendStartIndex; index < values.length; index += 1) {
    const rowId = `${sheetId}:paste:${batchId}:${index}`;
    targetEntries.push({
      key: rowId,
      value: values[index],
      position: nextAppendPosition + index - appendStartIndex,
      engineRowId: rowId,
    });
  }

  return targetEntries;
}

export function applyBulkPasteEntriesToSheet(
  sheetState: SheetState,
  targetEntries: TrackingBulkPasteEntry[]
): { sheetState: SheetState; targetEntries: TrackingBulkPasteEntry[] } {
  const nextRows = [...sheetState.rows];

  for (const entry of targetEntries) {
    const rowIndex = nextRows.findIndex((row) => row.key === entry.key);
    const nextRow = {
      ...(rowIndex >= 0 ? nextRows[rowIndex] : createEmptyRow()),
      key: entry.key,
      trackingInput: entry.value,
      shipment: null,
      loading: false,
      queued: false,
      stale: false,
      dirty: false,
      error: "",
    };

    if (rowIndex >= 0) {
      nextRows[rowIndex] = nextRow;
    } else {
      nextRows.push(nextRow);
    }
  }

  return {
    sheetState: {
      ...sheetState,
      rows: ensureTrailingEmptyRows(nextRows),
      selectedRowKeys: Array.from(
        new Set([
          ...sheetState.selectedRowKeys,
          ...targetEntries.map((entry) =>
            createEngineRowSelectionKey(entry.engineRowId?.trim() || entry.key)
          ),
        ])
      ),
    },
    targetEntries,
  };
}

export function applyProjectedBulkPasteDraftToSheet(
  sheetState: SheetState,
  sheetId: string,
  startRowKey: string,
  startPosition: number,
  values: string[],
  startEngineRowId?: string,
  displayedRows: BulkPasteDisplayedRow[] = [],
  nextAppendPosition?: number
): { sheetState: SheetState; targetEntries: TrackingBulkPasteEntry[] } {
  return applyBulkPasteEntriesToSheet(
    sheetState,
    createBulkPasteTargetEntries({
      sheetId,
      startRowKey,
      values,
      displayedRows,
      startPosition,
      startEngineRowId,
      nextAppendPosition,
    })
  );
}

function emitTrackingTelemetry(
  event: TrackingTelemetryEvent,
  meta: TrackingRequestMeta,
  extra?: Record<string, unknown>
) {
  const payload = {
    event,
    requestId: meta.requestId,
    sheetId: meta.sheetId,
    rowKey: meta.rowKey,
    shipmentId: meta.shipmentId,
    ...extra,
  };

  if (event === "fail") {
    console.error("[ShipFlowTelemetry]", payload);
    return;
  }

  console.info("[ShipFlowTelemetry]", payload);
}

function emitTrackingRunLog(event: string, payload: Record<string, unknown>) {
  console.info("[ShipFlowTrackingRun]", {
    event,
    ...payload,
  });
}

function createRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createTrackingRunId(sheetId: string, runToken: number) {
  return `${sheetId}:tracking-run:${runToken}:${Date.now()}`;
}

function classifyTrackingError(error: unknown): TrackingErrorClass {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "abort";
  }

  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  if (message.includes("timed out") || message.includes("timeout")) {
    return "timeout";
  }

  if (message.includes("shipment was not found") || message.includes("not found")) {
    return "not_found";
  }

  if (message.includes("unable to parse") || message.includes("upstream html")) {
    return "parse_error";
  }

  if (message.includes("invalid tracking response shape")) {
    return "invalid_response";
  }

  if (message.includes("shipment id is required") || message.includes("bad request")) {
    return "bad_request";
  }

  if (message.includes("network") || message.includes("failed to fetch")) {
    return "network";
  }

  return "unknown";
}

export function useTrackingRuntimeController({
  workspaceRef,
  updateSheet,
  disarmDeleteAll,
  onWorkspaceEngineMutation,
}: UseTrackingRuntimeControllerOptions) {
  const requestControllersRef = useRef(new Map<string, AbortController>());
  const requestMetaRef = useRef(new Map<string, TrackingRequestMeta>());
  const requestEpochBySheetRef = useRef(new Map<string, number>());
  const bulkRunEpochBySheetRef = useRef(new Map<string, number>());
  const bulkRunTokenRef = useRef(0);
  const activeBulkRunTokenBySheetRef = useRef(new Map<string, number>());
  const pendingBulkEntriesBySheetRef = useRef(new Map<string, BulkQueueEntry[]>());
  const engineMutationQueueByRowRef = useRef(new Map<string, Promise<void>>());

  useEffect(() => {
    return () => {
      requestControllersRef.current.forEach((controller) => controller.abort());
      requestControllersRef.current.clear();
      requestMetaRef.current.clear();
      engineMutationQueueByRowRef.current.clear();
    };
  }, []);

  const getSheetEpoch = useCallback(
    (
      epochMapRef: MutableRefObject<Map<string, number>>,
      sheetId: string
    ) => epochMapRef.current.get(sheetId) ?? 0,
    []
  );

  const bumpSheetEpoch = useCallback(
    (
      epochMapRef: MutableRefObject<Map<string, number>>,
      sheetId: string
    ) => {
      const nextEpoch = getSheetEpoch(epochMapRef, sheetId) + 1;
      epochMapRef.current.set(sheetId, nextEpoch);
      return nextEpoch;
    },
    [getSheetEpoch]
  );

  const forgetSheetTrackingRuntime = useCallback((sheetId: string) => {
    requestEpochBySheetRef.current.delete(sheetId);
    bulkRunEpochBySheetRef.current.delete(sheetId);
    activeBulkRunTokenBySheetRef.current.delete(sheetId);
    pendingBulkEntriesBySheetRef.current.delete(sheetId);
  }, []);

  const upsertTrackingRowsIntoEngine = useCallback(
    async (
      sheetId: string,
      entries: Array<{
        key: string;
        value: string;
        position?: number;
        engineRowId?: string;
      }>,
      sheetState?: SheetState
    ) => {
      const rows = createEngineRowsFromEntries(
        sheetState ?? workspaceRef.current.sheetsById[sheetId],
        entries
      );
      if (rows.length === 0) {
        return;
      }

      await upsertSheetRows({
        sheetId,
        rows,
      });
      onWorkspaceEngineMutation?.(sheetId);
    },
    [onWorkspaceEngineMutation, workspaceRef]
  );

  const deleteTrackingRowsFromEngine = useCallback(
    async (sheetId: string, rowIds: string[]) => {
      if (rowIds.length === 0) {
        return;
      }

      await deleteSheetRows({
        sheetId,
        rowIds,
      });
      onWorkspaceEngineMutation?.(sheetId);
    },
    [onWorkspaceEngineMutation]
  );

  const queueTrackingRowEngineMutation = useCallback(
    async (
      sheetId: string,
      rowId: string,
      mutation: () => Promise<void>
    ) => {
      const mutationKey = getSheetRequestKey(sheetId, rowId);
      const previousMutation =
        engineMutationQueueByRowRef.current.get(mutationKey) ?? Promise.resolve();
      const currentMutation = previousMutation
        .catch(() => undefined)
        .then(mutation);

      engineMutationQueueByRowRef.current.set(mutationKey, currentMutation);

      try {
        await currentMutation;
      } finally {
        if (
          engineMutationQueueByRowRef.current.get(mutationKey) === currentMutation
        ) {
          engineMutationQueueByRowRef.current.delete(mutationKey);
        }
      }
    },
    []
  );

  const markTrackingEntriesFailed = useCallback(
    (sheetId: string, entries: BulkQueueEntry[], error: unknown) => {
      const message = getTrackingFailureMessage(error);
      updateSheet(sheetId, (current) => {
        const liveEntries = entries.filter((entry) =>
          current.rows.some(
            (row) =>
              row.key === entry.key &&
              sanitizeTrackingInput(row.trackingInput) === entry.value
          )
        );

        return liveEntries.reduce(
          (sheetState, entry) => setRowErrorInSheet(sheetState, entry.key, message),
          current
        );
      });

      return message;
    },
    [updateSheet]
  );

  const syncTrackingInputDraftToEngine = useCallback(
    (
      sheetId: string,
      rowKey: string,
      value: string,
      validationError: string | null,
      options?: TrackingRowContext
    ) => {
      if (validationError) {
        return;
      }

      if (!value) {
        const engineRowId = options?.engineRowId?.trim() || rowKey;
        void queueTrackingRowEngineMutation(sheetId, engineRowId, () =>
          deleteTrackingRowsFromEngine(sheetId, [engineRowId])
        ).catch((error) => {
          console.error("[ShipFlowWorkspace] failed to delete Rust draft row", error);
        });
        return;
      }

      const engineRowId = options?.engineRowId?.trim() || rowKey;
      void queueTrackingRowEngineMutation(sheetId, engineRowId, () =>
        upsertTrackingRowsIntoEngine(sheetId, [
          {
            key: rowKey,
            value,
            position: options?.position,
            engineRowId: options?.engineRowId,
          },
        ])
      ).catch((error) => {
        console.error("[ShipFlowWorkspace] failed to upsert Rust draft row", error);
      });
    },
    [
      deleteTrackingRowsFromEngine,
      queueTrackingRowEngineMutation,
      upsertTrackingRowsIntoEngine,
    ]
  );

  const invalidateSheetTrackingWork = useCallback(
    (sheetId: string) => {
      bumpSheetEpoch(requestEpochBySheetRef, sheetId);
      bumpSheetEpoch(bulkRunEpochBySheetRef, sheetId);
      activeBulkRunTokenBySheetRef.current.delete(sheetId);
      pendingBulkEntriesBySheetRef.current.delete(sheetId);
      updateSheet(sheetId, (current) => clearTrackingRunInSheet(current));

      requestControllersRef.current.forEach((controller, requestKey) => {
        if (requestKey.startsWith(`${sheetId}:`)) {
          const meta = requestMetaRef.current.get(requestKey);
          if (meta) {
            emitTrackingTelemetry("abort", meta, {
              reason: "sheet_invalidation",
            });
          }
          controller.abort();
          requestControllersRef.current.delete(requestKey);
          requestMetaRef.current.delete(requestKey);
        }
      });
    },
    [bumpSheetEpoch, updateSheet]
  );

  const abortRowTrackingWork = useCallback(
    (
      sheetId: string,
      rowKeys: string[],
      reason:
        | "selected_rows_deleted"
        | "sheet_invalidation"
        | "cell_cleared"
        | "bulk_paste_overwrite"
    ) => {
      rowKeys.forEach((rowKey) => {
        const requestKey = getSheetRequestKey(sheetId, rowKey);
        const controller = requestControllersRef.current.get(requestKey);
        const meta = requestMetaRef.current.get(requestKey);

        if (meta) {
          emitTrackingTelemetry("abort", meta, { reason });
        }

        controller?.abort();
        requestControllersRef.current.delete(requestKey);
        requestMetaRef.current.delete(requestKey);
      });
    },
    []
  );

  const handleTrackingInputChange = useCallback(
    (
      sheetId: string,
      rowKey: string,
      value: string,
      options?: TrackingRowContext
    ) => {
      disarmDeleteAll();
      const sanitizedValue = sanitizeTrackingInput(value);
      const validationError = getTrackingInputValidationError(sanitizedValue);
      const requestKey = getSheetRequestKey(sheetId, rowKey);
      const activeController = requestControllersRef.current.get(requestKey);

      if (activeController) {
        const meta = requestMetaRef.current.get(requestKey);
        if (meta) {
          emitTrackingTelemetry("abort", meta, {
            reason: "input_changed",
          });
        }
        activeController.abort();
        requestControllersRef.current.delete(requestKey);
        requestMetaRef.current.delete(requestKey);
      }

      updateSheet(sheetId, (current) => {
        const nextState = setTrackingDraftInputInSheet(
          current,
          rowKey,
          sanitizedValue
        );
        return validationError
          ? setRowErrorInSheet(nextState, rowKey, validationError)
          : nextState;
      });
      syncTrackingInputDraftToEngine(
        sheetId,
        rowKey,
        sanitizedValue,
        validationError,
        options
      );
    },
    [disarmDeleteAll, syncTrackingInputDraftToEngine, updateSheet]
  );

  const fetchShipmentIntoRow = useCallback(
    async (
      sheetId: string,
      rowKey: string,
      shipmentId: string,
      options?: FetchRuntimeOptions
    ) => {
      const displayShipmentId = sanitizeTrackingInput(shipmentId);
      const requestKey = getSheetRequestKey(sheetId, rowKey);
      const requestEpoch = getSheetEpoch(requestEpochBySheetRef, sheetId);
      const validationError = getTrackingInputValidationError(displayShipmentId);
      const activeRequestMeta = requestMetaRef.current.get(requestKey);
      const activeController = requestControllersRef.current.get(requestKey);

      if (
        activeController &&
        activeRequestMeta &&
        activeRequestMeta.shipmentId === displayShipmentId
      ) {
        return;
      }

      activeController?.abort();

      if (!displayShipmentId) {
        requestControllersRef.current.delete(requestKey);
        requestMetaRef.current.delete(requestKey);
        const engineRowId = options?.engineRowId?.trim() || rowKey;
        await queueTrackingRowEngineMutation(sheetId, engineRowId, () =>
          deleteTrackingRowsFromEngine(sheetId, [engineRowId])
        );
        updateSheet(sheetId, (current) => clearTrackingCellInSheet(current, rowKey));
        return;
      }

      if (validationError) {
        requestControllersRef.current.delete(requestKey);
        requestMetaRef.current.delete(requestKey);
        updateSheet(sheetId, (current) =>
          setRowErrorInSheet(
            setTrackingDraftInputInSheet(current, rowKey, displayShipmentId),
            rowKey,
            validationError
          )
        );
        return;
      }

      updateSheet(sheetId, (current) =>
        ensureTrackingDraftRowInSheet(current, rowKey, displayShipmentId)
      );

      const controller = new AbortController();
      requestControllersRef.current.set(requestKey, controller);
      const requestMeta = {
        requestId: createRequestId(),
        sheetId,
        rowKey,
        shipmentId: displayShipmentId,
        startedAt: performance.now(),
      };
      requestMetaRef.current.set(requestKey, requestMeta);
      emitTrackingTelemetry("start", requestMeta);

      updateSheet(sheetId, (current) =>
        setRowLoadingInSheet(current, rowKey, displayShipmentId)
      );

      try {
        const engineRowId = options?.engineRowId?.trim() || rowKey;
        await queueTrackingRowEngineMutation(sheetId, engineRowId, () =>
          upsertTrackingRowsIntoEngine(sheetId, [
            {
              key: rowKey,
              value: displayShipmentId,
              position: options?.position,
              engineRowId: options?.engineRowId,
            },
          ])
        );
        controller.signal.throwIfAborted();
        const abortPromise = new Promise<never>((_, reject) => {
          if (controller.signal.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          controller.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true }
          );
        });
        const response = await Promise.race([
          refreshSheetRowTracking({
            rowId: options?.engineRowId?.trim() || rowKey,
            forceRefresh: options?.forceRefresh === true,
          }),
          abortPromise,
        ]);
        const rowProjection = response.payload;
        const targetSheet = workspaceRef.current.sheetsById[sheetId];

        if (
          requestControllersRef.current.get(requestKey) !== controller ||
          getSheetEpoch(requestEpochBySheetRef, sheetId) !== requestEpoch ||
          !targetSheet ||
          !targetSheet.rows.some((row) => row.key === rowKey)
        ) {
          return;
        }

        const targetRow = targetSheet.rows.find((row) => row.key === rowKey);
        if (
          !targetRow ||
          sanitizeTrackingInput(targetRow.trackingInput) !== displayShipmentId
        ) {
          return;
        }

        updateSheet(sheetId, (current) =>
          applyTrackingRefreshRowsToSheet(current, [rowProjection], {
            getRowKey: () => rowKey,
          })
        );
        onWorkspaceEngineMutation?.(sheetId);

        if (rowProjection.rowStatus === "failed") {
          const errorMessage = rowProjection.errorMessage ?? "Tracking request failed.";
          emitTrackingTelemetry("fail", requestMeta, {
            classification: classifyTrackingError(errorMessage),
            error: errorMessage,
            durationMs: Math.round(performance.now() - requestMeta.startedAt),
          });
          return;
        }

        emitTrackingTelemetry("success", requestMeta, {
          lookupShipmentId: rowProjection.lookupTrackingId,
          resolvedShipmentId: getProjectionResolvedShipmentId(rowProjection),
          durationMs: Math.round(performance.now() - requestMeta.startedAt),
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          if (requestMetaRef.current.get(requestKey) === requestMeta) {
            emitTrackingTelemetry("abort", requestMeta, {
              reason: "abort_signal",
              classification: "abort",
              durationMs: Math.round(performance.now() - requestMeta.startedAt),
            });
          }
          const targetRow = workspaceRef.current.sheetsById[sheetId]?.rows.find(
            (row) => row.key === rowKey
          );
          if (
            targetRow &&
            sanitizeTrackingInput(targetRow.trackingInput) === "" &&
            !requestControllersRef.current.has(requestKey)
          ) {
            const engineRowId = options?.engineRowId?.trim() || rowKey;
            await queueTrackingRowEngineMutation(sheetId, engineRowId, () =>
              deleteTrackingRowsFromEngine(sheetId, [engineRowId])
            ).catch((cleanupError) => {
              console.error(
                "[ShipFlowWorkspace] failed to remove an aborted empty draft row",
                cleanupError
              );
            });
          }
          return;
        }

        const targetSheet = workspaceRef.current.sheetsById[sheetId];
        if (
          requestControllersRef.current.get(requestKey) !== controller ||
          getSheetEpoch(requestEpochBySheetRef, sheetId) !== requestEpoch ||
          !targetSheet ||
          !targetSheet.rows.some((row) => row.key === rowKey)
        ) {
          return;
        }

        const targetRow = targetSheet.rows.find((row) => row.key === rowKey);
        if (
          !targetRow ||
          sanitizeTrackingInput(targetRow.trackingInput) !== displayShipmentId
        ) {
          return;
        }

        updateSheet(sheetId, (current) =>
          setRowErrorInSheet(
            current,
            rowKey,
            error instanceof Error ? error.message : "Tracking request failed."
          )
        );
        const classification = classifyTrackingError(error);
        emitTrackingTelemetry("fail", requestMeta, {
          classification,
          error: error instanceof Error ? error.message : "Tracking request failed.",
          durationMs: Math.round(performance.now() - requestMeta.startedAt),
        });
      } finally {
        if (requestControllersRef.current.get(requestKey) === controller) {
          requestControllersRef.current.delete(requestKey);
        }
        if (requestMetaRef.current.get(requestKey) === requestMeta) {
          requestMetaRef.current.delete(requestKey);
        }
      }
    },
    [
      deleteTrackingRowsFromEngine,
      getSheetEpoch,
      queueTrackingRowEngineMutation,
      updateSheet,
      upsertTrackingRowsIntoEngine,
      onWorkspaceEngineMutation,
      workspaceRef,
    ]
  );

  const fetchRow = useCallback(
    async (
      sheetId: string,
      rowKey: string,
      shipmentIdOverride?: string,
      options?: FetchRuntimeOptions
    ) => {
      const shipmentId =
        shipmentIdOverride !== undefined
          ? sanitizeTrackingInput(shipmentIdOverride)
          : workspaceRef.current.sheetsById[sheetId]?.rows.find((row) => row.key === rowKey)
              ?.trackingInput ?? "";

      if (!shipmentId && shipmentIdOverride === undefined) {
        return;
      }

      await fetchShipmentIntoRow(sheetId, rowKey, shipmentId, options);
    },
    [fetchShipmentIntoRow, workspaceRef]
  );

  const handleTrackingInputBlur = useCallback(
    (
      event: FocusEvent<HTMLInputElement>,
      sheetId: string,
      rowKey: string,
      options?: TrackingRowContext
    ) => {
      void fetchRow(sheetId, rowKey, event.currentTarget.value, options);
    },
    [fetchRow]
  );

  const clearTrackingCell = useCallback(
    (sheetId: string, rowKey: string, options?: TrackingRowContext) => {
      abortRowTrackingWork(sheetId, [rowKey], "cell_cleared");
      updateSheet(sheetId, (current) => clearTrackingCellInSheet(current, rowKey));
      const engineRowId = options?.engineRowId?.trim() || rowKey;
      void queueTrackingRowEngineMutation(sheetId, engineRowId, () =>
        deleteTrackingRowsFromEngine(sheetId, [engineRowId])
      ).catch((error) => {
        console.error("[ShipFlowWorkspace] failed to delete cleared Rust row", error);
      });
    },
    [
      abortRowTrackingWork,
      deleteTrackingRowsFromEngine,
      queueTrackingRowEngineMutation,
      updateSheet,
    ]
  );

  const refreshTrackingRows = useCallback(
    async (
      sheetId: string,
      entries: Array<{
        key: string;
        value: string;
        position?: number;
        engineRowId?: string;
      }>,
      options?: FetchRuntimeOptions
    ) => {
      const validEntries = entries
        .map((entry) => ({
          key: entry.key,
          value: sanitizeTrackingInput(entry.value),
          position: entry.position,
          engineRowId: entry.engineRowId,
          options,
        }))
        .filter(
          (entry) =>
            entry.value !== "" && !getTrackingInputValidationError(entry.value)
      );

      if (validEntries.length === 0) {
        emitTrackingRunLog("skip_empty_or_invalid_entries", {
          sheetId,
          inputCount: entries.length,
        });
        return;
      }

      if (activeBulkRunTokenBySheetRef.current.has(sheetId)) {
        const activeRunToken = activeBulkRunTokenBySheetRef.current.get(sheetId);
        pendingBulkEntriesBySheetRef.current.set(
          sheetId,
          mergeBulkQueueEntries(
            pendingBulkEntriesBySheetRef.current.get(sheetId) ?? [],
            validEntries
          )
        );
        emitTrackingRunLog("queue_while_active", {
          sheetId,
          activeRunToken,
          queuedCount: validEntries.length,
          pendingQueueCount:
            pendingBulkEntriesBySheetRef.current.get(sheetId)?.length ?? 0,
        });
        const activeTrackingRunId =
          workspaceRef.current.sheetsById[sheetId]?.activeTrackingRunId ?? null;
        updateSheet(sheetId, (current) =>
          setRowsQueuedInSheet(current, validEntries, {
            runId: activeTrackingRunId,
          })
        );
        try {
          await upsertTrackingRowsIntoEngine(sheetId, validEntries, options?.sheetState);
          emitTrackingRunLog("queued_entries_upserted", {
            sheetId,
            activeRunToken,
            queuedCount: validEntries.length,
          });
        } catch (error) {
          const message = markTrackingEntriesFailed(sheetId, validEntries, error);
          emitTrackingRunLog("queued_entries_upsert_failed", {
            sheetId,
            activeRunToken,
            queuedCount: validEntries.length,
            error: message,
          });
          const pendingEntries = pendingBulkEntriesBySheetRef.current.get(sheetId) ?? [];
          const failedEntryKeys = new Set(validEntries.map(getBulkQueueEntryKey));
          const nextPendingEntries = pendingEntries.filter(
            (entry) => !failedEntryKeys.has(getBulkQueueEntryKey(entry))
          );
          if (nextPendingEntries.length > 0) {
            pendingBulkEntriesBySheetRef.current.set(sheetId, nextPendingEntries);
          } else {
            pendingBulkEntriesBySheetRef.current.delete(sheetId);
          }
        }
        return;
      }

      const bulkRunToken = bulkRunTokenRef.current + 1;
      bulkRunTokenRef.current = bulkRunToken;
      const trackingRunId = createTrackingRunId(sheetId, bulkRunToken);
      activeBulkRunTokenBySheetRef.current.set(sheetId, bulkRunToken);
      emitTrackingRunLog("run_start", {
        sheetId,
        runToken: bulkRunToken,
        runId: trackingRunId,
        inputCount: entries.length,
        validCount: validEntries.length,
        forceRefresh: options?.forceRefresh === true,
      });
      try {
        const currentBulkEpoch = getSheetEpoch(bulkRunEpochBySheetRef, sheetId);
        const queuedEntryByKey = new Map<string, BulkQueueEntry>();
        const queuedEntryByEngineRowId = new Map<string, BulkQueueEntry>();
        const requestMetaByKey = new Map<string, TrackingRequestMeta>();
        const requestMetaByEngineRowId = new Map<string, TrackingRequestMeta>();
        const queueUpdates: BulkQueueEntry[] = [];
        validEntries.forEach((entry) => {
          const requestKey = getSheetRequestKey(sheetId, entry.key);
          const controller = requestControllersRef.current.get(requestKey);
          const meta = requestMetaRef.current.get(requestKey);

          if (
            meta &&
            meta.shipmentId === entry.value &&
            options?.forceRefresh !== true
          ) {
            return;
          }

          if (meta) {
            emitTrackingTelemetry("abort", meta, {
              reason: "bulk_tracking_restart",
            });
          }

          controller?.abort();
          requestControllersRef.current.delete(requestKey);
          requestMetaRef.current.delete(requestKey);

          const requestMeta = {
            requestId: createRequestId(),
            sheetId,
            rowKey: entry.key,
            shipmentId: entry.value,
            startedAt: performance.now(),
          };
          queuedEntryByKey.set(entry.key, entry);
          requestMetaByKey.set(entry.key, requestMeta);
          requestMetaByEngineRowId.set(
            entry.engineRowId?.trim() || entry.key,
            requestMeta
          );
          queuedEntryByEngineRowId.set(entry.engineRowId?.trim() || entry.key, entry);
        });
        queueUpdates.push(...queuedEntryByKey.values());

        if (queueUpdates.length === 0) {
          emitTrackingRunLog("run_noop_existing_requests", {
            sheetId,
            runToken: bulkRunToken,
            validCount: validEntries.length,
          });
          return;
        }

        queueUpdates.forEach((entry) => {
          const requestMeta = requestMetaByKey.get(entry.key);
          if (requestMeta) {
            emitTrackingTelemetry("start", requestMeta);
          }
        });
        updateSheet(sheetId, (current) =>
          setRowsQueuedInSheet(
            startTrackingRunInSheet(current, trackingRunId),
            queueUpdates,
            { runId: trackingRunId }
          )
        );
        emitTrackingRunLog("run_queued", {
          sheetId,
          runToken: bulkRunToken,
          runId: trackingRunId,
          queuedCount: queueUpdates.length,
        });
        try {
          await upsertTrackingRowsIntoEngine(sheetId, queueUpdates, options?.sheetState);
          emitTrackingRunLog("run_upserted", {
            sheetId,
            runToken: bulkRunToken,
            queuedCount: queueUpdates.length,
          });
        } catch (error) {
          const message = markTrackingEntriesFailed(sheetId, queueUpdates, error);
          emitTrackingRunLog("run_upsert_failed", {
            sheetId,
            runToken: bulkRunToken,
            queuedCount: queueUpdates.length,
            error: message,
          });
          queueUpdates.forEach((entry) => {
            const requestMeta = requestMetaByKey.get(entry.key);
            if (!requestMeta) {
              return;
            }
            emitTrackingTelemetry("fail", requestMeta, {
              classification: classifyTrackingError(error),
              error: message,
              durationMs: Math.round(performance.now() - requestMeta.startedAt),
            });
          });
          return;
        }

        try {
          const response = await refreshSheetRowsTrackingWithProgress(
            {
              sheetId,
              rowIds: queueUpdates.map(
                (entry) => entry.engineRowId?.trim() || entry.key
              ),
              forceRefresh: options?.forceRefresh === true,
              runId: trackingRunId,
            },
            (event) => {
              if (
                event.type !== "tracking_refresh_progress" ||
                event.payload.sheetId !== sheetId ||
                event.payload.runId !== trackingRunId ||
                getSheetEpoch(bulkRunEpochBySheetRef, sheetId) !== currentBulkEpoch
              ) {
                return;
              }

              const row = event.payload.row;
              emitTrackingRunLog("progress_event", {
                sheetId,
                runToken: bulkRunToken,
                rowId: row.rowId,
                rowStatus: row.rowStatus,
                displayTrackingId: row.displayTrackingId,
                lookupTrackingId: row.lookupTrackingId,
                totalCount: event.payload.totalCount,
                successCount: event.payload.successCount,
                failedCount: event.payload.failedCount,
                pendingCount: event.payload.pendingCount,
              });
              const entry =
                queuedEntryByEngineRowId.get(row.rowId) ??
                queueUpdates.find(
                  (candidate) =>
                    sanitizeTrackingInput(candidate.value) === row.displayTrackingId
                );
              if (entry) {
                const currentRow = workspaceRef.current.sheetsById[
                  sheetId
                ]?.rows.find((candidate) => candidate.key === entry.key);
                if (!currentRow) {
                  emitTrackingRunLog("progress_ignored_missing_current_row", {
                    sheetId,
                    runToken: bulkRunToken,
                    rowId: row.rowId,
                    rowKey: entry.key,
                    displayTrackingId: row.displayTrackingId,
                  });
                  return;
                }
                if (
                  sanitizeTrackingInput(currentRow.trackingInput) !== entry.value
                ) {
                  emitTrackingRunLog("progress_ignored_stale_input", {
                    sheetId,
                    runToken: bulkRunToken,
                    rowId: row.rowId,
                    expected: entry.value,
                    current: sanitizeTrackingInput(currentRow.trackingInput),
                  });
                  return;
                }

                updateSheet(sheetId, (current) =>
                  applyTrackingRefreshProgressToSheet(current, event.payload, {
                    rowKey: entry.key,
                    createMissingRow: true,
                    runId: trackingRunId,
                  })
                );
              } else {
                emitTrackingRunLog("progress_ignored_missing_entry", {
                  sheetId,
                  runToken: bulkRunToken,
                  rowId: row.rowId,
                  displayTrackingId: row.displayTrackingId,
                });
              }
            }
          );
          onWorkspaceEngineMutation?.(sheetId);

          if (
            response.payload.runId !== trackingRunId ||
            getSheetEpoch(bulkRunEpochBySheetRef, sheetId) !== currentBulkEpoch
          ) {
            emitTrackingRunLog("run_result_ignored_epoch_changed", {
              sheetId,
              runToken: bulkRunToken,
              runId: trackingRunId,
              responseRows: response.payload.rows.length,
            });
            return;
          }

          if (response.payload.rows.length > 0) {
            const getRowKey = (projection: SheetRowProjection) => {
              const entry = queuedEntryByKey.get(projection.rowId);
              const matchingEntry =
                entry ??
                queueUpdates.find(
                  (candidate) =>
                    (candidate.engineRowId?.trim() || candidate.key) ===
                      projection.rowId ||
                    sanitizeTrackingInput(candidate.value) ===
                      projection.displayTrackingId
                );
              if (!matchingEntry) {
                return undefined;
              }

              const currentRow = workspaceRef.current.sheetsById[
                sheetId
              ]?.rows.find((candidate) => candidate.key === matchingEntry.key);
              if (
                !currentRow ||
                sanitizeTrackingInput(currentRow.trackingInput) !==
                  matchingEntry.value
              ) {
                return undefined;
              }

              return matchingEntry.key;
            };
            updateSheet(sheetId, (current) =>
              applyTrackingRefreshRowsToSheet(current, response.payload.rows, {
                getRowKey,
                createMissingRows: false,
                runId: trackingRunId,
              })
            );
          }

          emitTrackingRunLog("run_complete", {
            sheetId,
            runToken: bulkRunToken,
            runId: trackingRunId,
            successCount: response.payload.successCount,
            failedCount: response.payload.failedCount,
            responseRows: response.payload.rows.length,
          });
          response.payload.rows.forEach((row) => {
            const requestMeta =
              requestMetaByEngineRowId.get(row.rowId) ??
              requestMetaByKey.get(row.rowId);
            if (!requestMeta) {
              return;
            }

            if (row.rowStatus === "failed") {
              const errorMessage = row.errorMessage ?? "Tracking request failed.";
              emitTrackingTelemetry("fail", requestMeta, {
                classification: classifyTrackingError(errorMessage),
                error: errorMessage,
                durationMs: Math.round(performance.now() - requestMeta.startedAt),
              });
              return;
            }

            emitTrackingTelemetry("success", requestMeta, {
              lookupShipmentId: row.lookupTrackingId,
              resolvedShipmentId: getProjectionResolvedShipmentId(row),
              durationMs: Math.round(performance.now() - requestMeta.startedAt),
            });
          });
        } catch (error) {
          const message = markTrackingEntriesFailed(sheetId, queueUpdates, error);
          emitTrackingRunLog("run_failed", {
            sheetId,
            runToken: bulkRunToken,
            queuedCount: queueUpdates.length,
            error: message,
          });
          queueUpdates.forEach((entry) => {
            const requestMeta = requestMetaByKey.get(entry.key);
            if (!requestMeta) {
              return;
            }
            emitTrackingTelemetry("fail", requestMeta, {
              classification: classifyTrackingError(error),
              error: message,
              durationMs: Math.round(performance.now() - requestMeta.startedAt),
            });
          });
        }
      } finally {
        if (activeBulkRunTokenBySheetRef.current.get(sheetId) !== bulkRunToken) {
          emitTrackingRunLog("run_finally_skipped_token_replaced", {
            sheetId,
            runToken: bulkRunToken,
            activeRunToken: activeBulkRunTokenBySheetRef.current.get(sheetId),
          });
          return;
        }

        activeBulkRunTokenBySheetRef.current.delete(sheetId);
        const pendingEntries = pendingBulkEntriesBySheetRef.current.get(sheetId) ?? [];
        pendingBulkEntriesBySheetRef.current.delete(sheetId);
        emitTrackingRunLog("run_finalized", {
          sheetId,
          runToken: bulkRunToken,
          runId: trackingRunId,
          pendingQueueCount: pendingEntries.length,
        });
        if (pendingEntries.length > 0) {
          void refreshTrackingRows(
            sheetId,
            pendingEntries,
            pendingEntries[0]?.options
          );
        } else {
          updateSheet(sheetId, (current) =>
            clearTrackingRunInSheet(current, trackingRunId)
          );
        }
      }
    },
    [
      getSheetEpoch,
      markTrackingEntriesFailed,
      updateSheet,
      upsertTrackingRowsIntoEngine,
      onWorkspaceEngineMutation,
      workspaceRef,
    ]
  );

  const handleTrackingInputPaste = useCallback(
    (
      event: ClipboardEvent<HTMLInputElement>,
      sheetId: string,
      rowKey: string,
      options?: TrackingRowContext
    ) => {
      disarmDeleteAll();
      const values = sanitizeTrackingPasteValues(event.clipboardData.getData("text"));

      if (values.length <= 1) {
        return;
      }

      event.preventDefault();

      const currentSheet = workspaceRef.current.sheetsById[sheetId];
      if (!currentSheet) {
        return;
      }

      const startIndex = currentSheet.rows.findIndex((row) => row.key === rowKey);
      const displayedRows = options?.displayedRows ?? [];
      if (
        displayedRows.length === 0 &&
        startIndex === -1 &&
        (typeof options?.position !== "number" || options.position < 0)
      ) {
        return;
      }

      void (async () => {
        const targetEntries =
          displayedRows.length > 0 &&
          options?.rowsQuery &&
          typeof options.queryOffset === "number"
            ? await resolveProjectedBulkPasteTargetEntries({
                sheetId,
                values,
                displayedRows,
                startOffset: options.queryOffset,
                rowsQuery: options.rowsQuery,
              })
            : displayedRows.length > 0
              ? createBulkPasteTargetEntries({
                  sheetId,
                  startRowKey: rowKey,
                  values,
                  displayedRows,
                  startPosition: options?.position,
                  startEngineRowId: options?.engineRowId,
                  nextAppendPosition: options?.nextAppendPosition,
                })
              : startIndex >= 0
                ? (() => {
                    const legacyResult = applyBulkPasteToSheet(
                      currentSheet,
                      startIndex,
                      values
                    );
                    return legacyResult.targetKeys.map((key, index) => {
                      const engineRowId =
                        index === 0 && options?.engineRowId?.trim()
                          ? options.engineRowId.trim()
                          : "";
                      return {
                        key,
                        value: values[index],
                        position: startIndex + index,
                        ...(engineRowId ? { engineRowId } : {}),
                      };
                    });
                  })()
                : createBulkPasteTargetEntries({
                    sheetId,
                    startRowKey: rowKey,
                    values,
                    displayedRows: [],
                    startPosition: options?.position,
                    startEngineRowId: options?.engineRowId,
                  });
        const latestSheet = workspaceRef.current.sheetsById[sheetId];
        if (!latestSheet || targetEntries.length === 0) {
          return;
        }
        const result = applyBulkPasteEntriesToSheet(latestSheet, targetEntries);
        const targetKeys = targetEntries.map((entry) => entry.key);

        abortRowTrackingWork(sheetId, targetKeys, "bulk_paste_overwrite");
        updateSheet(sheetId, () => result.sheetState);

        targetEntries.forEach((entry) => {
          const validationError = getTrackingInputValidationError(entry.value);
          if (validationError) {
            updateSheet(sheetId, (current) =>
              setRowErrorInSheet(current, entry.key, validationError)
            );
          }
        });

        await refreshTrackingRows(
          sheetId,
          targetEntries.filter(({ value }) => !getTrackingInputValidationError(value)),
          { sheetState: result.sheetState }
        );
      })().catch((error) => {
        console.error("[ShipFlowWorkspace] bulk paste failed", error);
        updateSheet(sheetId, (current) =>
          setRowErrorInSheet(
            current,
            rowKey,
            error instanceof Error ? error.message : "Bulk paste failed."
          )
        );
      });
    },
    [
      abortRowTrackingWork,
      disarmDeleteAll,
      refreshTrackingRows,
      updateSheet,
      workspaceRef,
    ]
  );

  return {
    abortRowTrackingWork,
    clearTrackingCell,
    fetchRow,
    forgetSheetTrackingRuntime,
    handleTrackingInputBlur,
    handleTrackingInputChange,
    handleTrackingInputPaste,
    invalidateSheetTrackingWork,
    refreshTrackingRows,
  };
}
