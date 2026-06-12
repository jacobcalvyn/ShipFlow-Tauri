import { ClipboardEvent, FocusEvent, MutableRefObject, useCallback, useEffect, useRef } from "react";
import {
  applyBulkPasteToSheet,
  clearTrackingCellInSheet,
  setRowErrorInSheet,
  setRowLoadingInSheet,
  setRowsQueuedInSheet,
  setTrackingInputInSheet,
  settleRowRuntimeStateInSheet,
  settleRowsRuntimeStateInSheet,
} from "../sheet/actions";
import { SheetState } from "../sheet/types";
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
  refreshSheetRowsTracking,
  type SheetRowProjection,
  upsertSheetRows,
} from "../workspace-engine/client";

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

type TrackingRowContext = {
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

function getProjectedBulkPasteRowKey(
  sheetId: string,
  startRowKey: string,
  position: number,
  offset: number
) {
  return offset === 0 ? startRowKey : `${sheetId}:row:${position + offset}`;
}

export function applyProjectedBulkPasteDraftToSheet(
  sheetState: SheetState,
  sheetId: string,
  startRowKey: string,
  startPosition: number,
  values: string[],
  startEngineRowId?: string
): { sheetState: SheetState; targetEntries: TrackingBulkPasteEntry[] } {
  const nextRows = [...sheetState.rows];
  const targetEntries = values.map((value, offset) => {
    const engineRowId =
      offset === 0 && startEngineRowId?.trim() ? startEngineRowId.trim() : "";
    return {
      key: getProjectedBulkPasteRowKey(sheetId, startRowKey, startPosition, offset),
      value,
      position: startPosition + offset,
      ...(engineRowId ? { engineRowId } : {}),
    };
  });

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
          ...targetEntries.map((entry) => entry.key),
        ])
      ),
    },
    targetEntries,
  };
}

function emitTrackingTelemetry(
  event: TrackingTelemetryEvent,
  meta: TrackingRequestMeta,
  extra?: Record<string, unknown>
) {
  const payload = {
    event,
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

function createRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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

  useEffect(() => {
    return () => {
      requestControllersRef.current.forEach((controller) => controller.abort());
      requestControllersRef.current.clear();
      requestMetaRef.current.clear();
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
        void deleteTrackingRowsFromEngine(sheetId, [engineRowId]).catch(
          (error) => {
            console.error("[ShipFlowWorkspace] failed to delete Rust draft row", error);
          }
        );
        return;
      }

      void upsertTrackingRowsIntoEngine(sheetId, [
        {
          key: rowKey,
          value,
          position: options?.position,
          engineRowId: options?.engineRowId,
        },
      ]).catch((error) => {
        console.error("[ShipFlowWorkspace] failed to upsert Rust draft row", error);
      });
    },
    [deleteTrackingRowsFromEngine, upsertTrackingRowsIntoEngine]
  );

  const invalidateSheetTrackingWork = useCallback(
    (sheetId: string) => {
      bumpSheetEpoch(requestEpochBySheetRef, sheetId);
      bumpSheetEpoch(bulkRunEpochBySheetRef, sheetId);

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
    [bumpSheetEpoch]
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
        await deleteTrackingRowsFromEngine(sheetId, [
          options?.engineRowId?.trim() || rowKey,
        ]);
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
        await upsertTrackingRowsIntoEngine(sheetId, [
          {
            key: rowKey,
            value: displayShipmentId,
            position: options?.position,
            engineRowId: options?.engineRowId,
          },
        ]);
        const abortPromise = new Promise<never>((_, reject) => {
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
        onWorkspaceEngineMutation?.(sheetId);
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
          settleRowRuntimeStateInSheet(current, rowKey)
        );

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
      void deleteTrackingRowsFromEngine(sheetId, [
        options?.engineRowId?.trim() || rowKey,
      ]).finally(() => {
        updateSheet(sheetId, (current) => clearTrackingCellInSheet(current, rowKey));
      });
    },
    [abortRowTrackingWork, deleteTrackingRowsFromEngine, updateSheet]
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
        return;
      }

      const currentBulkEpoch = getSheetEpoch(bulkRunEpochBySheetRef, sheetId);
      const queuedEntryByKey = new Map<string, BulkQueueEntry>();
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
      });
      queueUpdates.push(...queuedEntryByKey.values());

      if (queueUpdates.length === 0) {
        return;
      }

      queueUpdates.forEach((entry) => {
        const requestMeta = requestMetaByKey.get(entry.key);
        if (requestMeta) {
          emitTrackingTelemetry("start", requestMeta);
        }
      });
      updateSheet(sheetId, (current) => setRowsQueuedInSheet(current, queueUpdates));
      await upsertTrackingRowsIntoEngine(sheetId, queueUpdates, options?.sheetState);

      try {
        const response = await refreshSheetRowsTracking({
          sheetId,
          rowIds: queueUpdates.map((entry) => entry.engineRowId?.trim() || entry.key),
          forceRefresh: options?.forceRefresh === true,
        });
        onWorkspaceEngineMutation?.(sheetId);

        if (getSheetEpoch(bulkRunEpochBySheetRef, sheetId) !== currentBulkEpoch) {
          return;
        }

        if (response.payload.rows.length > 0) {
          const settledRowKeys = response.payload.rows
            .map((projection) => {
              const entry = queuedEntryByKey.get(projection.rowId);
              if (entry) {
                return entry.key;
              }

              return queueUpdates.find(
                (candidate) =>
                  (candidate.engineRowId?.trim() || candidate.key) ===
                    projection.rowId ||
                  sanitizeTrackingInput(candidate.value) ===
                    projection.displayTrackingId
              )?.key;
            })
            .filter((key): key is string => Boolean(key));
          updateSheet(sheetId, (current) =>
            settleRowsRuntimeStateInSheet(current, settledRowKeys)
          );
        }

        response.payload.rows.forEach((row) => {
          const requestMeta =
            requestMetaByEngineRowId.get(row.rowId) ?? requestMetaByKey.get(row.rowId);
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
        const message =
          error instanceof Error ? error.message : "Tracking request failed.";
        updateSheet(sheetId, (current) => {
          const nextEntries = queueUpdates.filter((entry) =>
            current.rows.some(
              (row) =>
                row.key === entry.key &&
                sanitizeTrackingInput(row.trackingInput) === entry.value
            )
          );

          return nextEntries.reduce(
            (sheetState, entry) => setRowErrorInSheet(sheetState, entry.key, message),
            current
          );
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
    },
    [
      getSheetEpoch,
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
      if (
        startIndex === -1 &&
        (typeof options?.position !== "number" || options.position < 0)
      ) {
        return;
      }

      const result =
        startIndex >= 0
          ? (() => {
              const legacyResult = applyBulkPasteToSheet(
                currentSheet,
                startIndex,
                values
              );
              return {
                ...legacyResult,
                targetEntries: legacyResult.targetKeys.map((key, index) => {
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
                }),
              };
            })()
          : applyProjectedBulkPasteDraftToSheet(
              currentSheet,
              sheetId,
              rowKey,
              options?.position ?? 0,
              values,
              options?.engineRowId
            );
      const targetEntries = result.targetEntries;
      const targetKeys = targetEntries.map((entry) => entry.key);

      abortRowTrackingWork(sheetId, targetKeys, "bulk_paste_overwrite");

      updateSheet(sheetId, () => result.sheetState);

      if (targetKeys.length === 0) {
        return;
      }

      targetEntries.forEach((entry) => {
        const value = entry.value;
        const validationError = getTrackingInputValidationError(value);
        if (!validationError) {
          return;
        }

        updateSheet(sheetId, (current) =>
          setRowErrorInSheet(current, entry.key, validationError)
        );
      });

      void refreshTrackingRows(
        sheetId,
        targetEntries.filter(({ value }) => !getTrackingInputValidationError(value)),
        { sheetState: result.sheetState }
      );
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
