import { invoke } from "@tauri-apps/api/core";
import { ClipboardEvent, FocusEvent, MutableRefObject, useCallback, useEffect, useRef } from "react";
import { MAX_CONCURRENT_BULK_REQUESTS } from "../sheet/columns";
import {
  applyBulkPasteToSheet,
  clearRowInSheet,
  clearTrackingCellInSheet,
  setRowErrorInSheet,
  setRowLoadingInSheet,
  setRowSuccessInSheet,
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
          invoke<TrackResponse>("track_shipment", {
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

  const runBulkPasteFetches = useCallback(
    async (
      sheetId: string,
      entries: Array<{ key: string; value: string }>,
      options?: FetchRuntimeOptions
    ) => {
      const runEpoch = bumpSheetEpoch(bulkRunEpochBySheetRef, sheetId);
      const queue = [...entries];
      const workerCount = Math.min(MAX_CONCURRENT_BULK_REQUESTS, queue.length);

      const workers = Array.from({ length: workerCount }, async () => {
        while (queue.length > 0 && getSheetEpoch(bulkRunEpochBySheetRef, sheetId) === runEpoch) {
          const next = queue.shift();
          if (!next) {
            return;
          }

          if (getSheetEpoch(bulkRunEpochBySheetRef, sheetId) !== runEpoch) {
            return;
          }

          await fetchShipmentIntoRow(sheetId, next.key, next.value, options);
        }
      });

      await Promise.allSettled(workers);
    },
    [bumpSheetEpoch, fetchShipmentIntoRow, getSheetEpoch]
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
