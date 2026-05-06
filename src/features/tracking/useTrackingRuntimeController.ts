import { ClipboardEvent, FocusEvent, MutableRefObject, useCallback, useEffect, useRef } from "react";
import { trackShipment } from "../../backend/commands";
import { MAX_CONCURRENT_BULK_REQUESTS } from "../sheet/columns";
import {
  applyBulkPasteToSheet,
  clearRowInSheet,
  clearTrackingCellInSheet,
  setRowErrorInSheet,
  setRowLoadingInSheet,
  setRowSuccessInSheet,
  setRowsQueuedInSheet,
  setTrackingInputInSheet,
} from "../sheet/actions";
import { SheetState } from "../sheet/types";
import {
  getTrackingInputValidationError,
  sanitizeTrackingInput,
  sanitizeTrackingPasteValues,
} from "../sheet/utils";
import { WorkspaceState } from "../workspace/types";
import { TrackResponse } from "../../types";

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
};

type FetchRuntimeOptions = {
  forceRefresh?: boolean;
};

type BulkQueueEntry = {
  key: string;
  value: string;
  options?: FetchRuntimeOptions;
};

type BulkRunState = {
  queue: BulkQueueEntry[];
  queuedKeys: Set<string>;
  activeWorkers: number;
  epoch: number;
  waiters: Array<() => void>;
};

function getSheetRequestKey(sheetId: string, rowKey: string) {
  return `${sheetId}:${rowKey}`;
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

function assertValidTrackResponse(
  response: unknown,
  meta: Pick<TrackingRequestMeta, "sheetId" | "rowKey" | "shipmentId">
): asserts response is TrackResponse {
  if (!response || typeof response !== "object") {
    throw new Error(
      `Invalid tracking response shape for sheet ${meta.sheetId}, row ${meta.rowKey}, shipment ${meta.shipmentId}: response is not an object.`
    );
  }

  const candidate = response as Partial<TrackResponse>;
  if (
    typeof candidate.url !== "string" ||
    !candidate.detail ||
    typeof candidate.detail !== "object" ||
    !candidate.status_akhir ||
    typeof candidate.status_akhir !== "object" ||
    !Array.isArray(candidate.history) ||
    !candidate.history_summary ||
    typeof candidate.history_summary !== "object"
  ) {
    throw new Error(
      `Invalid tracking response shape for sheet ${meta.sheetId}, row ${meta.rowKey}, shipment ${meta.shipmentId}.`
    );
  }
}

export function useTrackingRuntimeController({
  workspaceRef,
  updateSheet,
  disarmDeleteAll,
}: UseTrackingRuntimeControllerOptions) {
  const requestControllersRef = useRef(new Map<string, AbortController>());
  const requestMetaRef = useRef(new Map<string, TrackingRequestMeta>());
  const requestEpochBySheetRef = useRef(new Map<string, number>());
  const bulkRunEpochBySheetRef = useRef(new Map<string, number>());
  const bulkRunStateBySheetRef = useRef(new Map<string, BulkRunState>());

  useEffect(() => {
    return () => {
      requestControllersRef.current.forEach((controller) => controller.abort());
      requestControllersRef.current.clear();
      requestMetaRef.current.clear();
      bulkRunStateBySheetRef.current.forEach((state) => {
        state.queue = [];
        state.queuedKeys.clear();
        const waiters = state.waiters.splice(0);
        waiters.forEach((resolve) => resolve());
      });
      bulkRunStateBySheetRef.current.clear();
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
    const bulkRunState = bulkRunStateBySheetRef.current.get(sheetId);
    if (bulkRunState) {
      bulkRunState.queue = [];
      bulkRunState.queuedKeys.clear();
      const waiters = bulkRunState.waiters.splice(0);
      waiters.forEach((resolve) => resolve());
      bulkRunStateBySheetRef.current.delete(sheetId);
    }
  }, []);

  const settleBulkRunIfIdle = useCallback((sheetId: string, state: BulkRunState) => {
    if (state.activeWorkers > 0 || state.queue.length > 0) {
      return;
    }

    const waiters = state.waiters.splice(0);
    if (bulkRunStateBySheetRef.current.get(sheetId) === state) {
      bulkRunStateBySheetRef.current.delete(sheetId);
    }
    waiters.forEach((resolve) => resolve());
  }, []);

  const removeQueuedBulkEntries = useCallback(
    (sheetId: string, rowKeys?: string[]) => {
      const bulkRunState = bulkRunStateBySheetRef.current.get(sheetId);
      if (!bulkRunState) {
        return;
      }

      if (!rowKeys) {
        bulkRunState.queue = [];
        bulkRunState.queuedKeys.clear();
        const waiters = bulkRunState.waiters.splice(0);
        waiters.forEach((resolve) => resolve());
        bulkRunStateBySheetRef.current.delete(sheetId);
        return;
      }

      const rowKeySet = new Set(rowKeys);
      bulkRunState.queue = bulkRunState.queue.filter((entry) => {
        if (!rowKeySet.has(entry.key)) {
          return true;
        }

        bulkRunState.queuedKeys.delete(entry.key);
        return false;
      });
      settleBulkRunIfIdle(sheetId, bulkRunState);
    },
    [settleBulkRunIfIdle]
  );

  const invalidateSheetTrackingWork = useCallback(
    (sheetId: string) => {
      bumpSheetEpoch(requestEpochBySheetRef, sheetId);
      bumpSheetEpoch(bulkRunEpochBySheetRef, sheetId);
      removeQueuedBulkEntries(sheetId);

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
    [bumpSheetEpoch, removeQueuedBulkEntries]
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
      removeQueuedBulkEntries(sheetId, rowKeys);

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
    [removeQueuedBulkEntries]
  );

  const handleTrackingInputChange = useCallback(
    (sheetId: string, rowKey: string, value: string) => {
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
        const nextState = setTrackingInputInSheet(current, rowKey, sanitizedValue);
        return validationError
          ? setRowErrorInSheet(nextState, rowKey, validationError)
          : nextState;
      });
    },
    [disarmDeleteAll, updateSheet]
  );

  const fetchShipmentIntoRow = useCallback(
    async (
      sheetId: string,
      rowKey: string,
      shipmentId: string,
      options?: FetchRuntimeOptions
    ) => {
      const normalizedId = sanitizeTrackingInput(shipmentId);
      const requestKey = getSheetRequestKey(sheetId, rowKey);
      const requestEpoch = getSheetEpoch(requestEpochBySheetRef, sheetId);
      const validationError = getTrackingInputValidationError(normalizedId);
      const activeRequestMeta = requestMetaRef.current.get(requestKey);
      const activeController = requestControllersRef.current.get(requestKey);

      if (
        activeController &&
        activeRequestMeta &&
        activeRequestMeta.shipmentId === normalizedId
      ) {
        return;
      }

      activeController?.abort();

      if (!normalizedId) {
        requestControllersRef.current.delete(requestKey);
        requestMetaRef.current.delete(requestKey);
        updateSheet(sheetId, (current) => clearRowInSheet(current, rowKey));
        return;
      }

      if (validationError) {
        requestControllersRef.current.delete(requestKey);
        requestMetaRef.current.delete(requestKey);
        updateSheet(sheetId, (current) =>
          setRowErrorInSheet(
            setTrackingInputInSheet(current, rowKey, normalizedId),
            rowKey,
            validationError
          )
        );
        return;
      }

      const controller = new AbortController();
      requestControllersRef.current.set(requestKey, controller);
      const requestMeta = {
        requestId: createRequestId(),
        sheetId,
        rowKey,
        shipmentId: normalizedId,
        startedAt: performance.now(),
      };
      requestMetaRef.current.set(requestKey, requestMeta);
      emitTrackingTelemetry("start", requestMeta);

      updateSheet(sheetId, (current) => setRowLoadingInSheet(current, rowKey, normalizedId));

      try {
        const abortPromise = new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true }
          );
        });
        const result = (await Promise.race([
          trackShipment({
            shipmentId: normalizedId,
            forceRefresh: options?.forceRefresh === true,
            sheetId,
            rowKey,
          }),
          abortPromise,
        ])) as TrackResponse;
        assertValidTrackResponse(result, requestMeta);
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
        if (!targetRow || sanitizeTrackingInput(targetRow.trackingInput) !== normalizedId) {
          return;
        }

        updateSheet(sheetId, (current) =>
          setRowSuccessInSheet(
            current,
            rowKey,
            result.detail.shipment_header.nomor_kiriman ?? normalizedId,
            result
          )
        );
        emitTrackingTelemetry("success", requestMeta, {
          resolvedShipmentId: result.detail.shipment_header.nomor_kiriman ?? normalizedId,
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
        if (!targetRow || sanitizeTrackingInput(targetRow.trackingInput) !== normalizedId) {
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
    [getSheetEpoch, updateSheet, workspaceRef]
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

      if (!shipmentId) {
        return;
      }

      await fetchShipmentIntoRow(sheetId, rowKey, shipmentId, options);
    },
    [fetchShipmentIntoRow, workspaceRef]
  );

  const handleTrackingInputBlur = useCallback(
    (event: FocusEvent<HTMLInputElement>, sheetId: string, rowKey: string) => {
      void fetchRow(sheetId, rowKey, event.currentTarget.value);
    },
    [fetchRow]
  );

  const clearTrackingCell = useCallback(
    (sheetId: string, rowKey: string) => {
      abortRowTrackingWork(sheetId, [rowKey], "cell_cleared");
      updateSheet(sheetId, (current) => clearTrackingCellInSheet(current, rowKey));
    },
    [abortRowTrackingWork, updateSheet]
  );

  const startBulkWorker = useCallback(
    async (sheetId: string, state: BulkRunState) => {
      state.activeWorkers += 1;

      try {
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, 0);
        });

        while (
          state.queue.length > 0 &&
          getSheetEpoch(bulkRunEpochBySheetRef, sheetId) ===
            state.epoch
        ) {
          const next = state.queue.shift();
          if (!next) {
            return;
          }

          state.queuedKeys.delete(next.key);

          const targetSheet = workspaceRef.current.sheetsById[sheetId];
          const targetRow = targetSheet?.rows.find((row) => row.key === next.key);
          if (
            !targetSheet ||
            !targetRow ||
            sanitizeTrackingInput(targetRow.trackingInput) !== next.value
          ) {
            continue;
          }

          await fetchShipmentIntoRow(sheetId, next.key, next.value, next.options);
        }
      } finally {
        state.activeWorkers -= 1;
        settleBulkRunIfIdle(sheetId, state);
      }
    },
    [fetchShipmentIntoRow, getSheetEpoch, settleBulkRunIfIdle, workspaceRef]
  );

  const ensureBulkWorkers = useCallback(
    (sheetId: string, state: BulkRunState) => {
      const workerSlots = Math.max(0, MAX_CONCURRENT_BULK_REQUESTS - state.activeWorkers);
      const workersToStart = Math.min(workerSlots, state.queue.length);

      for (let index = 0; index < workersToStart; index += 1) {
        void startBulkWorker(sheetId, state);
      }
    },
    [startBulkWorker]
  );

  const runBulkPasteFetches = useCallback(
    async (
      sheetId: string,
      entries: Array<{ key: string; value: string }>,
      options?: FetchRuntimeOptions
    ) => {
      const validEntries = entries
        .map((entry) => ({
          key: entry.key,
          value: sanitizeTrackingInput(entry.value),
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
      let bulkRunState = bulkRunStateBySheetRef.current.get(sheetId);
      if (bulkRunState && bulkRunState.epoch !== currentBulkEpoch) {
        bulkRunState.queue = [];
        bulkRunState.queuedKeys.clear();
        const waiters = bulkRunState.waiters.splice(0);
        waiters.forEach((resolve) => resolve());
        bulkRunState = undefined;
      }

      if (!bulkRunState) {
        bulkRunState = {
          queue: [],
          queuedKeys: new Set(),
          activeWorkers: 0,
          epoch: currentBulkEpoch,
          waiters: [],
        };
        bulkRunStateBySheetRef.current.set(sheetId, bulkRunState);
      }

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

        if (bulkRunState.queuedKeys.has(entry.key)) {
          const queuedEntry = bulkRunState.queue.find(
            (currentEntry) => currentEntry.key === entry.key
          );
          if (queuedEntry) {
            queuedEntry.value = entry.value;
            queuedEntry.options = entry.options;
          }
        } else {
          bulkRunState.queue.push(entry);
          bulkRunState.queuedKeys.add(entry.key);
        }
        queueUpdates.push(entry);
      });

      if (queueUpdates.length === 0) {
        return;
      }

      updateSheet(sheetId, (current) => setRowsQueuedInSheet(current, queueUpdates));

      const runPromise = new Promise<void>((resolve) => {
        bulkRunState.waiters.push(resolve);
      });

      ensureBulkWorkers(sheetId, bulkRunState);
      settleBulkRunIfIdle(sheetId, bulkRunState);
      await runPromise;
    },
    [ensureBulkWorkers, getSheetEpoch, settleBulkRunIfIdle, updateSheet]
  );

  const handleTrackingInputPaste = useCallback(
    (event: ClipboardEvent<HTMLInputElement>, sheetId: string, rowKey: string) => {
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
      if (startIndex === -1) {
        return;
      }

      const result = applyBulkPasteToSheet(currentSheet, startIndex, values);
      const targetKeys = result.targetKeys;

      abortRowTrackingWork(sheetId, targetKeys, "bulk_paste_overwrite");

      updateSheet(sheetId, () => result.sheetState);

      if (targetKeys.length === 0) {
        return;
      }

      targetKeys.forEach((key, index) => {
        const value = values[index];
        const validationError = getTrackingInputValidationError(value);
        if (!validationError) {
          return;
        }

        updateSheet(sheetId, (current) => setRowErrorInSheet(current, key, validationError));
      });

      void runBulkPasteFetches(
        sheetId,
        targetKeys
          .map((key, index) => ({ key, value: values[index] }))
          .filter(({ value }) => !getTrackingInputValidationError(value))
      );
    },
    [abortRowTrackingWork, disarmDeleteAll, runBulkPasteFetches, updateSheet, workspaceRef]
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
    runBulkPasteFetches,
  };
}
