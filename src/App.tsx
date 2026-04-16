import {
  ClipboardEvent,
  FocusEvent,
  KeyboardEvent,
  MutableRefObject,
  MouseEvent as ReactMouseEvent,
  UIEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  HIDDEN_COLUMNS_STORAGE_KEY,
  MAX_CONCURRENT_BULK_REQUESTS,
  PINNED_COLUMNS_STORAGE_KEY,
} from "./features/sheet/columns";
import { COLUMNS, SELECTOR_COLUMN_WIDTH } from "./features/sheet/columns";
import { SheetActionBar } from "./features/sheet/components/SheetActionBar";
import { SheetTable } from "./features/sheet/components/SheetTable";
import { ColumnShortcut, SheetState } from "./features/sheet/types";
import {
  assertValidSheetState,
  buildCsvValue,
  formatColumnValue,
  getTrackingInputValidationError,
  isBrowserReady,
  sanitizeTrackingInput,
  sanitizeTrackingPasteValues,
} from "./features/sheet/utils";
import {
  applyBulkPasteToSheet,
  armDeleteAllInSheet,
  clearAllDataInSheet,
  clearFiltersInSheet,
  clearHiddenFiltersInSheet,
  clearRowInSheet,
  clearTrackingCellInSheet,
  clearSelectionInSheet,
  clearValueFilterInSheet,
  deleteRowsInSheet,
  disarmDeleteAllInSheet,
  getColumnSortDirection as getColumnSortDirectionFromSheet,
  setColumnWidthInSheet,
  setHighlightedColumnInSheet,
  setOpenColumnMenuInSheet,
  setRowErrorInSheet,
  setRowLoadingInSheet,
  setRowSuccessInSheet,
  setSortInSheet,
  setTextFilterInSheet,
  setTrackingInputInSheet,
  pruneSelectionToVisibleRowsInSheet,
  syncSelectionWithVisibleRowsInSheet,
  toggleColumnVisibilityInSheet,
  togglePinnedColumnInSheet,
  toggleRowSelectionInSheet,
  toggleValueFilterInSheet,
  toggleVisibleSelectionInSheet,
} from "./features/sheet/actions";
import {
  getActiveFilterCount,
  getAllTrackingIds,
  getColumnShortcuts,
  getDisplayedRows,
  getEffectiveColumnWidths,
  getExportableRows,
  getHiddenColumns,
  getIgnoredHiddenFilterCount,
  getLoadedCount,
  getNonEmptyRows,
  getPinnedColumnSet,
  getPinnedLeftMap,
  getSelectedTrackingIds,
  getSelectedVisibleRowKeys,
  getTotalShipmentCount,
  getTrackingColumnAutoWidth,
  getValueOptionsForOpenColumn,
  getVisibleColumnPathSet,
  getVisibleColumns,
  getVisibleSelectableKeys,
} from "./features/sheet/selectors";
import { createDefaultWorkspaceState } from "./features/workspace/default-state";
import {
  createSheetInWorkspace,
  createSheetWithTrackingIdsInWorkspace,
  deleteSheetInWorkspace,
  renameSheetInWorkspace,
  setActiveSheetInWorkspace,
  updateActiveSheetInWorkspace,
  updateSheetInWorkspace,
} from "./features/workspace/actions";
import {
  getActiveSheet,
  getWorkspaceTabs,
} from "./features/workspace/selectors";
import { SheetTabs } from "./features/workspace/components/SheetTabs";
import {
  ApiServiceStatus,
  ServiceConfig,
  ServiceMode,
  TrackResponse,
} from "./types";

type ActionNotice = {
  id?: string;
  tone: "success" | "error" | "info";
  message: string;
};

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

type DisplayScale = "small" | "medium" | "large";

const DISPLAY_SCALE_STORAGE_KEY = "shipflow-display-scale";
const SERVICE_CONFIG_STORAGE_KEY = "shipflow-service-config";

const DEFAULT_SERVICE_CONFIG: ServiceConfig = {
  version: 1,
  enabled: false,
  mode: "local",
  port: 18422,
  authToken: "",
  lastUpdatedAt: "",
};

const DEFAULT_API_SERVICE_STATUS: ApiServiceStatus = {
  status: "stopped",
  enabled: false,
  mode: null,
  bindAddress: null,
  port: null,
  errorMessage: null,
};

function isDisplayScale(value: string | null): value is DisplayScale {
  return value === "small" || value === "medium" || value === "large";
}

function isServiceMode(value: unknown): value is ServiceMode {
  return value === "local" || value === "lan";
}

function normalizeServicePort(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return DEFAULT_SERVICE_CONFIG.port;
  }

  if (value < 1 || value > 65535) {
    return DEFAULT_SERVICE_CONFIG.port;
  }

  return value;
}

function createServiceToken() {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return `sf_${Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")}`;
  }

  return `sf_${createRequestId().replace(/-/g, "")}`;
}

function loadServiceConfig(): ServiceConfig {
  if (!isBrowserReady()) {
    return DEFAULT_SERVICE_CONFIG;
  }

  const stored = window.localStorage.getItem(SERVICE_CONFIG_STORAGE_KEY);
  if (!stored) {
    return DEFAULT_SERVICE_CONFIG;
  }

  try {
    const parsed = JSON.parse(stored) as Partial<ServiceConfig>;
    return {
      version: 1,
      enabled: Boolean(parsed.enabled),
      mode: isServiceMode(parsed.mode) ? parsed.mode : DEFAULT_SERVICE_CONFIG.mode,
      port: normalizeServicePort(parsed.port),
      authToken: typeof parsed.authToken === "string" ? parsed.authToken : "",
      lastUpdatedAt:
        typeof parsed.lastUpdatedAt === "string" ? parsed.lastUpdatedAt : "",
    };
  } catch {
    return DEFAULT_SERVICE_CONFIG;
  }
}

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

function shouldAssertSheetState() {
  return import.meta.env.DEV || import.meta.env.MODE === "test";
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

function App() {
  const [workspaceState, setWorkspaceState] = useState(createDefaultWorkspaceState);
  const [displayScale, setDisplayScale] = useState<DisplayScale>(() => {
    if (!isBrowserReady()) {
      return "small";
    }

    const storedDisplayScale = window.localStorage.getItem(DISPLAY_SCALE_STORAGE_KEY);
    return isDisplayScale(storedDisplayScale) ? storedDisplayScale : "small";
  });
  const [displayScalePreview, setDisplayScalePreview] = useState<DisplayScale | null>(null);
  const [serviceConfig, setServiceConfig] = useState<ServiceConfig>(loadServiceConfig);
  const [serviceConfigPreview, setServiceConfigPreview] = useState<ServiceConfig | null>(null);
  const [apiServiceStatus, setApiServiceStatus] = useState<ApiServiceStatus>(
    DEFAULT_API_SERVICE_STATUS
  );
  const [actionNoticeBySheetId, setActionNoticeBySheetId] = useState<
    Record<string, ActionNotice[]>
  >({});
  const [hoveredColumn, setHoveredColumn] = useState<number | null>(null);
  const resizeStateRef = useRef<{
    path: string;
    startX: number;
    startWidth: number;
  } | null>(null);
  const requestControllersRef = useRef(new Map<string, AbortController>());
  const requestMetaRef = useRef(new Map<string, TrackingRequestMeta>());
  const requestEpochBySheetRef = useRef(new Map<string, number>());
  const bulkRunEpochBySheetRef = useRef(new Map<string, number>());
  const columnMenuRefs = useRef(new Map<string, HTMLDivElement | null>());
  const sheetScrollRef = useRef<HTMLDivElement>(null);
  const sheetScrollPositionsRef = useRef(
    new Map<string, { left: number; top: number }>()
  );
  const highlightedColumnTimeoutRef = useRef<number | null>(null);
  const highlightedColumnSheetIdRef = useRef<string | null>(null);
  const actionNoticeTimeoutsRef = useRef(new Map<string, number>());
  const deleteAllTimeoutRef = useRef<number | null>(null);
  const deleteAllArmedSheetIdRef = useRef<string | null>(null);
  const activeSheet = useMemo(() => getActiveSheet(workspaceState), [workspaceState]);
  const activeSheetId = workspaceState.activeSheetId;
  const workspaceTabs = useMemo(
    () => getWorkspaceTabs(workspaceState),
    [workspaceState]
  );
  const activeActionNotices = actionNoticeBySheetId[activeSheetId] ?? [];
  const workspaceRef = useRef(workspaceState);
  const serviceConfigRef = useRef(serviceConfig);
  const effectiveDisplayScale = displayScalePreview ?? displayScale;
  const effectiveServiceConfig = serviceConfigPreview ?? serviceConfig;
  const hasPendingServiceConfigChanges = serviceConfigPreview !== null;

  const updateActiveSheet = useCallback(
    (updater: (sheetState: SheetState) => SheetState) => {
      setWorkspaceState((current) =>
        updateActiveSheetInWorkspace(current, (sheetState) => {
          const nextSheetState = updater(sheetState);
          return shouldAssertSheetState()
            ? assertValidSheetState(nextSheetState)
            : nextSheetState;
        })
      );
    },
    []
  );

  const updateSheet = useCallback(
    (sheetId: string, updater: (sheetState: SheetState) => SheetState) => {
      setWorkspaceState((current) =>
        updateSheetInWorkspace(current, sheetId, (sheetState) => {
          const nextSheetState = updater(sheetState);
          return shouldAssertSheetState()
            ? assertValidSheetState(nextSheetState)
            : nextSheetState;
        })
      );
    },
    []
  );

  useEffect(() => {
    workspaceRef.current = workspaceState;
  }, [workspaceState]);

  useEffect(() => {
    serviceConfigRef.current = serviceConfig;
  }, [serviceConfig]);

  useEffect(() => {
    const scrollContainer = sheetScrollRef.current;
    if (!scrollContainer) {
      return;
    }

    const nextPosition = sheetScrollPositionsRef.current.get(activeSheetId) ?? {
      left: 0,
      top: 0,
    };

    scrollContainer.scrollLeft = nextPosition.left;
    scrollContainer.scrollTop = nextPosition.top;
  }, [activeSheetId]);

  useEffect(() => {
    const openColumnMenuPath = activeSheet.openColumnMenuPath;

    if (!openColumnMenuPath) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const activeMenu = columnMenuRefs.current.get(openColumnMenuPath);
      if (!activeMenu || !(event.target instanceof Node)) {
        return;
      }

      if (!activeMenu.contains(event.target)) {
        updateActiveSheet((current) => setOpenColumnMenuInSheet(current, null));
      }
    };

    document.addEventListener("mousedown", handlePointerDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [activeSheet.openColumnMenuPath, updateActiveSheet]);

  useEffect(() => {
    if (!isBrowserReady()) {
      return;
    }

    window.localStorage.setItem(
      HIDDEN_COLUMNS_STORAGE_KEY,
      JSON.stringify(activeSheet.hiddenColumnPaths)
    );
  }, [activeSheet.hiddenColumnPaths]);

  useEffect(() => {
    if (!isBrowserReady()) {
      return;
    }

    window.localStorage.setItem(
      PINNED_COLUMNS_STORAGE_KEY,
      JSON.stringify(activeSheet.pinnedColumnPaths)
    );
  }, [activeSheet.pinnedColumnPaths]);

  useEffect(() => {
    if (!isBrowserReady()) {
      return;
    }

    window.localStorage.setItem(DISPLAY_SCALE_STORAGE_KEY, displayScale);
  }, [displayScale]);

  useEffect(() => {
    if (!isBrowserReady()) {
      return;
    }

    window.localStorage.setItem(
      SERVICE_CONFIG_STORAGE_KEY,
      JSON.stringify(serviceConfig)
    );
  }, [serviceConfig]);

  const previewDisplayScale = useCallback((scale: DisplayScale) => {
    setDisplayScalePreview(scale);
  }, []);

  const previewServiceConfig = useCallback(
    (updater: (config: ServiceConfig) => ServiceConfig) => {
      setServiceConfigPreview((current) => {
        const base = current ?? serviceConfigRef.current;
        return updater(base);
      });
    },
    []
  );

  const previewServiceEnabled = useCallback(
    (enabled: boolean) => {
      previewServiceConfig((current) => ({
        ...current,
        enabled,
      }));
    },
    [previewServiceConfig]
  );

  const previewServiceMode = useCallback(
    (mode: ServiceMode) => {
      previewServiceConfig((current) => ({
        ...current,
        mode,
      }));
    },
    [previewServiceConfig]
  );

  const previewServicePort = useCallback(
    (port: number) => {
      previewServiceConfig((current) => ({
        ...current,
        port: normalizeServicePort(port),
      }));
    },
    [previewServiceConfig]
  );

  const previewGenerateServiceToken = useCallback(() => {
    previewServiceConfig((current) => ({
      ...current,
      authToken: createServiceToken(),
    }));
  }, [previewServiceConfig]);

  const previewRegenerateServiceToken = useCallback(() => {
    previewServiceConfig((current) => ({
      ...current,
      authToken: createServiceToken(),
    }));
  }, [previewServiceConfig]);

  const confirmSettings = useCallback(() => {
    setDisplayScale((current) => displayScalePreview ?? current);
    setDisplayScalePreview(null);
    setServiceConfig((current) => {
      if (!serviceConfigPreview) {
        return current;
      }

      return {
        ...serviceConfigPreview,
        lastUpdatedAt: new Date().toISOString(),
      };
    });
    setServiceConfigPreview(null);
  }, [displayScalePreview, serviceConfigPreview]);

  const cancelSettingsPreview = useCallback(() => {
    setDisplayScalePreview(null);
    setServiceConfigPreview(null);
  }, []);

  useEffect(() => {
    return () => {
      requestControllersRef.current.forEach((controller) => controller.abort());
      requestControllersRef.current.clear();
      requestMetaRef.current.clear();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (highlightedColumnTimeoutRef.current !== null) {
        window.clearTimeout(highlightedColumnTimeoutRef.current);
      }
      actionNoticeTimeoutsRef.current.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      actionNoticeTimeoutsRef.current.clear();
      if (deleteAllTimeoutRef.current !== null) {
        window.clearTimeout(deleteAllTimeoutRef.current);
      }
    };
  }, []);

  const armDeleteAll = useCallback(() => {
    const targetSheetId = activeSheetId;
    updateSheet(targetSheetId, (current) => armDeleteAllInSheet(current));
    deleteAllArmedSheetIdRef.current = targetSheetId;

    if (deleteAllTimeoutRef.current !== null) {
      window.clearTimeout(deleteAllTimeoutRef.current);
    }

    deleteAllTimeoutRef.current = window.setTimeout(() => {
      const armedSheetId = deleteAllArmedSheetIdRef.current;
      if (armedSheetId) {
        updateSheet(armedSheetId, (current) => disarmDeleteAllInSheet(current));
      }
      deleteAllTimeoutRef.current = null;
      deleteAllArmedSheetIdRef.current = null;
    }, 4000);
  }, [activeSheetId, updateSheet]);

  const disarmDeleteAll = useCallback(() => {
    const targetSheetId = deleteAllArmedSheetIdRef.current ?? activeSheetId;
    updateSheet(targetSheetId, (current) => disarmDeleteAllInSheet(current));
    if (deleteAllTimeoutRef.current !== null) {
      window.clearTimeout(deleteAllTimeoutRef.current);
      deleteAllTimeoutRef.current = null;
    }
    deleteAllArmedSheetIdRef.current = null;
  }, [activeSheetId, updateSheet]);

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

  const invalidateSheetTrackingWork = useCallback((sheetId: string) => {
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
  }, [bumpSheetEpoch]);

  const abortRowTrackingWork = useCallback(
    (
      sheetId: string,
      rowKeys: string[],
      reason: "selected_rows_deleted" | "sheet_invalidation" | "cell_cleared"
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

  const showActionNotice = useCallback((sheetId: string, notice: ActionNotice) => {
    const noticeId = notice.id || createRequestId();

    setActionNoticeBySheetId((current) => ({
      ...current,
      [sheetId]: [...(current[sheetId] ?? []), { ...notice, id: noticeId }].slice(-5),
    }));

    const timeoutId = window.setTimeout(() => {
      setActionNoticeBySheetId((current) => {
        const currentNotices = current[sheetId] ?? [];
        if (currentNotices.length === 0) {
          return current;
        }

        const nextSheetNotices = currentNotices.filter(
          (currentNotice) => currentNotice.id !== noticeId
        );
        const next = { ...current };
        if (nextSheetNotices.length > 0) {
          next[sheetId] = nextSheetNotices;
        } else {
          delete next[sheetId];
        }
        return next;
      });
      actionNoticeTimeoutsRef.current.delete(noticeId);
    }, 2200);

    actionNoticeTimeoutsRef.current.set(noticeId, timeoutId);
  }, []);

  const refreshApiServiceStatus = useCallback(async () => {
    try {
      const status = await invoke<ApiServiceStatus>("get_api_service_status");
      setApiServiceStatus(status);
    } catch (error) {
      setApiServiceStatus({
        status: "error",
        enabled: serviceConfigRef.current.enabled,
        mode: serviceConfigRef.current.mode,
        bindAddress:
          serviceConfigRef.current.mode === "lan" ? "0.0.0.0" : "127.0.0.1",
        port: serviceConfigRef.current.port,
        errorMessage:
          error instanceof Error
            ? error.message
            : "Gagal membaca status API service.",
      });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    void invoke<ApiServiceStatus>("configure_api_service", { config: serviceConfig })
      .then((status) => {
        if (cancelled) {
          return;
        }

        setApiServiceStatus(status);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        setApiServiceStatus({
          status: "error",
          enabled: serviceConfig.enabled,
          mode: serviceConfig.mode,
          bindAddress: serviceConfig.mode === "lan" ? "0.0.0.0" : "127.0.0.1",
          port: serviceConfig.port,
          errorMessage:
            error instanceof Error
              ? error.message
              : "Gagal mengonfigurasi API service.",
        });
        showActionNotice(workspaceRef.current.activeSheetId, {
          tone: "error",
          message:
            error instanceof Error
              ? error.message
              : "Gagal mengonfigurasi API service.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [serviceConfig, showActionNotice]);

  useEffect(() => {
    void refreshApiServiceStatus();
  }, [refreshApiServiceStatus]);

  useEffect(() => {
    if (!serviceConfig.enabled) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void refreshApiServiceStatus();
    }, 5000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [refreshApiServiceStatus, serviceConfig.enabled]);

  const focusFirstTrackingInput = useCallback(() => {
    window.requestAnimationFrame(() => {
      const firstInput =
        sheetScrollRef.current?.querySelector<HTMLInputElement>(
          "tbody .tracking-cell .sheet-input"
        ) ?? null;

      firstInput?.focus();
    });
  }, []);

  const openSourceLink = useCallback(
    async (url: string) => {
      try {
        await invoke("open_external_url", { url });
      } catch (error) {
        showActionNotice(activeSheetId, {
          tone: "error",
          message: "Gagal membuka sumber scrap.",
        });
        console.error("[ShipFlow] Unable to open source link.", error);
      }
    },
    [activeSheetId, showActionNotice]
  );

  const focusTrackingInputRelative = useCallback(
    (currentInput: HTMLInputElement, offset: number) => {
      const trackingInputs = Array.from(
        sheetScrollRef.current?.querySelectorAll<HTMLInputElement>(
          "tbody .tracking-cell .sheet-input"
        ) ?? []
      );

      if (trackingInputs.length === 0) {
        return false;
      }

      const currentIndex = trackingInputs.indexOf(currentInput);
      if (currentIndex === -1) {
        return false;
      }

      const nextIndex = currentIndex + offset;
      if (nextIndex < 0 || nextIndex >= trackingInputs.length) {
        return false;
      }

      trackingInputs[nextIndex]?.focus();
      return true;
    },
    []
  );

  const nonEmptyRows = useMemo(() => getNonEmptyRows(activeSheet.rows), [activeSheet.rows]);

  const retrackableRows = useMemo(
    () =>
      nonEmptyRows
        .filter((row) => row.trackingInput.trim() !== "")
        .map((row) => ({ key: row.key, value: row.trackingInput.trim() })),
    [nonEmptyRows]
  );

  const totalShipmentCount = useMemo(
    () => getTotalShipmentCount(nonEmptyRows),
    [nonEmptyRows]
  );

  const visibleColumns = useMemo(() => getVisibleColumns(activeSheet), [activeSheet]);

  const visibleColumnPathSet = useMemo(
    () => getVisibleColumnPathSet(visibleColumns),
    [visibleColumns]
  );

  const pinnedColumnSet = useMemo(
    () => getPinnedColumnSet(activeSheet),
    [activeSheet]
  );

  const trackingColumnAutoWidth = useMemo(
    () => getTrackingColumnAutoWidth(nonEmptyRows),
    [nonEmptyRows]
  );

  const effectiveColumnWidths = useMemo(
    () =>
      getEffectiveColumnWidths(
        visibleColumns,
        activeSheet.columnWidths,
        trackingColumnAutoWidth
      ),
    [activeSheet.columnWidths, trackingColumnAutoWidth, visibleColumns]
  );

  const pinnedLeftMap = useMemo(() => {
    return getPinnedLeftMap(visibleColumns, pinnedColumnSet, effectiveColumnWidths);
  }, [effectiveColumnWidths, pinnedColumnSet, visibleColumns]);

  const activeFilterCount = useMemo(
    () => getActiveFilterCount(activeSheet, visibleColumnPathSet),
    [activeSheet, visibleColumnPathSet]
  );

  const ignoredHiddenFilterCount = useMemo(
    () => getIgnoredHiddenFilterCount(activeSheet, activeFilterCount),
    [activeFilterCount, activeSheet]
  );

  const valueOptionsByPath = useMemo(
    () =>
      getValueOptionsForOpenColumn(
        nonEmptyRows,
        visibleColumns,
        activeSheet.openColumnMenuPath
      ),
    [activeSheet.openColumnMenuPath, nonEmptyRows, visibleColumns]
  );

  const displayedRows = useMemo(() => {
    return getDisplayedRows(activeSheet, nonEmptyRows, visibleColumns, activeFilterCount);
  }, [activeFilterCount, nonEmptyRows, activeSheet, visibleColumns]);

  const visibleSelectableKeys = useMemo(
    () => getVisibleSelectableKeys(displayedRows),
    [displayedRows]
  );

  const allVisibleSelected =
    visibleSelectableKeys.length > 0 &&
    visibleSelectableKeys.every((key) => activeSheet.selectedRowKeys.includes(key));

  const selectedVisibleRowKeys = useMemo(
    () => getSelectedVisibleRowKeys(activeSheet.selectedRowKeys, visibleSelectableKeys),
    [activeSheet.selectedRowKeys, visibleSelectableKeys]
  );

  const selectedTrackingIds = useMemo(
    () => getSelectedTrackingIds(activeSheet.rows, selectedVisibleRowKeys),
    [activeSheet.rows, selectedVisibleRowKeys]
  );

  const allTrackingIds = useMemo(
    () => getAllTrackingIds(activeSheet.rows),
    [activeSheet.rows]
  );

  const selectedRowKeySet = useMemo(
    () => new Set(activeSheet.selectedRowKeys),
    [activeSheet.selectedRowKeys]
  );

  const exportableRows = useMemo(() => {
    return getExportableRows(activeSheet.rows, displayedRows, selectedVisibleRowKeys);
  }, [displayedRows, activeSheet.rows, selectedVisibleRowKeys]);

  const hiddenColumns = useMemo(
    () => getHiddenColumns(activeSheet),
    [activeSheet]
  );

  const loadedCount = useMemo(
    () => getLoadedCount(displayedRows),
    [displayedRows]
  );
  const loadingCount = useMemo(
    () => displayedRows.filter((row) => row.loading).length,
    [displayedRows]
  );

  const columnShortcuts = useMemo<ColumnShortcut[]>(
    () => getColumnShortcuts(visibleColumnPathSet),
    [visibleColumnPathSet]
  );

  const handleTrackingInputChange = useCallback((sheetId: string, rowKey: string, value: string) => {
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
  }, [disarmDeleteAll, updateSheet]);

  const fetchShipmentIntoRow = useCallback(
    async (sheetId: string, rowKey: string, shipmentId: string) => {
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

      updateSheet(sheetId, (current) =>
        setRowLoadingInSheet(current, rowKey, normalizedId)
      );

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

        updateSheet(sheetId, (current) =>
          setRowSuccessInSheet(
            current,
            rowKey,
            result.detail.shipment_header.nomor_kiriman ?? normalizedId,
            result
          )
        );
        emitTrackingTelemetry("success", requestMeta, {
          resolvedShipmentId:
            result.detail.shipment_header.nomor_kiriman ?? normalizedId,
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
          error:
            error instanceof Error ? error.message : "Tracking request failed.",
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
      getSheetEpoch,
      updateSheet,
    ]
  );

  const fetchRow = useCallback(
    async (sheetId: string, rowKey: string, shipmentIdOverride?: string) => {
      const shipmentId =
        sanitizeTrackingInput(shipmentIdOverride ?? "") ||
        (workspaceRef.current.sheetsById[sheetId]?.rows
          .find((row) => row.key === rowKey)
          ?.trackingInput ??
          "");

      if (!shipmentId) {
        return;
      }

      await fetchShipmentIntoRow(sheetId, rowKey, shipmentId);
    },
    [fetchShipmentIntoRow]
  );

  const handleTrackingInputBlur = useCallback(
    (
      event: FocusEvent<HTMLInputElement>,
      sheetId: string,
      rowKey: string
    ) => {
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

  const handleTrackingInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>, sheetId: string, rowKey: string) => {
      const currentInput = event.currentTarget;

      if (event.key === "Delete" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        clearTrackingCell(sheetId, rowKey);
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        const moved = focusTrackingInputRelative(currentInput, 1);
        if (!moved) {
          void fetchRow(sheetId, rowKey, currentInput.value);
          currentInput.blur();
        }
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        focusTrackingInputRelative(currentInput, 1);
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        focusTrackingInputRelative(currentInput, -1);
      }
    },
    [clearTrackingCell, fetchRow, focusTrackingInputRelative]
  );

  const runBulkPasteFetches = useCallback(
    async (sheetId: string, entries: Array<{ key: string; value: string }>) => {
      const runEpoch = bumpSheetEpoch(bulkRunEpochBySheetRef, sheetId);
      const queue = [...entries];
      const workerCount = Math.min(MAX_CONCURRENT_BULK_REQUESTS, queue.length);

      const workers = Array.from({ length: workerCount }, async () => {
        while (
          queue.length > 0 &&
          getSheetEpoch(bulkRunEpochBySheetRef, sheetId) === runEpoch
        ) {
          const next = queue.shift();
          if (!next) {
            return;
          }

          if (getSheetEpoch(bulkRunEpochBySheetRef, sheetId) !== runEpoch) {
            return;
          }

          await fetchShipmentIntoRow(sheetId, next.key, next.value);
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
    [disarmDeleteAll, runBulkPasteFetches, updateSheet]
  );

  const handleFilterChange = useCallback((path: string, value: string) => {
    updateActiveSheet((current) => setTextFilterInSheet(current, path, value));
  }, [updateActiveSheet]);

  const toggleColumnValueFilter = useCallback((path: string, value: string) => {
    updateActiveSheet((current) => toggleValueFilterInSheet(current, path, value));
  }, [updateActiveSheet]);

  const clearColumnValueFilter = useCallback((path: string) => {
    updateActiveSheet((current) => clearValueFilterInSheet(current, path));
  }, [updateActiveSheet]);

  const setColumnSort = useCallback(
    (path: string, direction: "asc" | "desc" | null) => {
      updateActiveSheet((current) => setSortInSheet(current, path, direction));
    },
    [updateActiveSheet]
  );

  const getColumnSortDirection = useCallback(
    (path: string) => getColumnSortDirectionFromSheet(activeSheet, path),
    [activeSheet]
  );

  const toggleRowSelection = useCallback((rowKey: string) => {
    updateActiveSheet((current) => toggleRowSelectionInSheet(current, rowKey));
  }, [updateActiveSheet]);

  const toggleVisibleSelection = useCallback(() => {
    updateActiveSheet((current) =>
      toggleVisibleSelectionInSheet(current, allVisibleSelected, visibleSelectableKeys)
    );
  }, [allVisibleSelected, updateActiveSheet, visibleSelectableKeys]);

  useEffect(() => {
    if (!activeSheet.selectionFollowsVisibleRows) {
      return;
    }

    updateActiveSheet((current) =>
      syncSelectionWithVisibleRowsInSheet(current, visibleSelectableKeys)
    );
  }, [activeSheet.selectionFollowsVisibleRows, updateActiveSheet, visibleSelectableKeys]);

  useEffect(() => {
    if (activeSheet.selectionFollowsVisibleRows) {
      return;
    }

    updateActiveSheet((current) =>
      pruneSelectionToVisibleRowsInSheet(current, visibleSelectableKeys)
    );
  }, [activeSheet.selectionFollowsVisibleRows, updateActiveSheet, visibleSelectableKeys]);

  const handleResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLSpanElement>, column: (typeof COLUMNS)[number]) => {
      event.preventDefault();
      event.stopPropagation();

      resizeStateRef.current = {
        path: column.path,
        startX: event.clientX,
        startWidth: activeSheet.columnWidths[column.path],
      };

      const handlePointerMove = (moveEvent: MouseEvent) => {
        const activeResize = resizeStateRef.current;
        if (!activeResize) {
          return;
        }

        const nextWidth = Math.max(
          column.minWidth ?? 100,
          activeResize.startWidth + moveEvent.clientX - activeResize.startX
        );

        updateActiveSheet((current) =>
          setColumnWidthInSheet(current, activeResize.path, nextWidth)
        );
      };

      const handlePointerUp = () => {
        resizeStateRef.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", handlePointerMove);
        document.removeEventListener("mouseup", handlePointerUp);
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", handlePointerMove);
      document.addEventListener("mouseup", handlePointerUp);
    },
    [activeSheet.columnWidths, updateActiveSheet]
  );

  const copySelectedTrackingIds = useCallback(() => {
    if (selectedTrackingIds.length === 0) {
      return;
    }

    void navigator.clipboard
      .writeText(selectedTrackingIds.join("\n"))
      .then(() =>
        showActionNotice(activeSheetId, {
          tone: "success",
          message: `${selectedTrackingIds.length} ID kiriman berhasil disalin.`,
        })
      )
      .catch(() =>
        showActionNotice(activeSheetId, {
          tone: "error",
          message: "Gagal menyalin ID kiriman terselect.",
        })
      );
  }, [activeSheetId, selectedTrackingIds, showActionNotice]);

  const copyAllTrackingIds = useCallback(() => {
    if (allTrackingIds.length === 0) {
      return;
    }

    void navigator.clipboard
      .writeText(allTrackingIds.join("\n"))
      .then(() =>
        showActionNotice(activeSheetId, {
          tone: "success",
          message: `${allTrackingIds.length} ID kiriman berhasil disalin.`,
        })
      )
      .catch(() =>
        showActionNotice(activeSheetId, {
          tone: "error",
          message: "Gagal menyalin seluruh ID kiriman.",
        })
      );
  }, [activeSheetId, allTrackingIds, showActionNotice]);

  const copyTrackingId = useCallback(
    (value: string) => {
      const trackingId = value.trim();
      if (!trackingId) {
        return;
      }

      void navigator.clipboard
        .writeText(trackingId)
        .then(() =>
          showActionNotice(activeSheetId, {
            tone: "success",
            message: "ID kiriman berhasil disalin.",
          })
        )
        .catch(() =>
          showActionNotice(activeSheetId, {
            tone: "error",
            message: "Gagal menyalin ID kiriman.",
          })
        );
    },
    [activeSheetId, showActionNotice]
  );

  const clearSelection = useCallback(() => {
    updateActiveSheet((current) => clearSelectionInSheet(current));
  }, [updateActiveSheet]);

  const createSheetFromSelectedIds = useCallback(() => {
    if (selectedTrackingIds.length === 0) {
      return;
    }

    disarmDeleteAll();
    setHoveredColumn(null);

    const currentWorkspace = workspaceRef.current;
    const result = createSheetWithTrackingIdsInWorkspace(
      currentWorkspace,
      selectedTrackingIds
    );

    setWorkspaceState(result.workspaceState);

    if (result.targetKeys.length === 0) {
      return;
    }

    void runBulkPasteFetches(
      result.sheetId,
      result.targetKeys.map((key, index) => ({
        key,
        value: selectedTrackingIds[index],
      }))
    );
  }, [disarmDeleteAll, runBulkPasteFetches, selectedTrackingIds]);

  const clearAllFilters = useCallback(() => {
    updateActiveSheet((current) => clearFiltersInSheet(current));
  }, [updateActiveSheet]);

  const clearHiddenFilters = useCallback(() => {
    updateActiveSheet((current) =>
      clearHiddenFiltersInSheet(current, visibleColumnPathSet)
    );
  }, [updateActiveSheet, visibleColumnPathSet]);

  const deleteSelectedRows = useCallback(() => {
    if (selectedVisibleRowKeys.length === 0) {
      return;
    }

    abortRowTrackingWork(activeSheetId, selectedVisibleRowKeys, "selected_rows_deleted");

    updateActiveSheet((current) =>
      clearSelectionInSheet(deleteRowsInSheet(current, selectedVisibleRowKeys))
    );
    showActionNotice(activeSheetId, {
      tone: "info",
      message: `${selectedVisibleRowKeys.length} row terselect dihapus.`,
    });
  }, [
    activeSheetId,
    abortRowTrackingWork,
    selectedVisibleRowKeys,
    showActionNotice,
    updateActiveSheet,
  ]);

  const deleteAllRows = useCallback(() => {
    if (allTrackingIds.length === 0) {
      return;
    }

    if (!activeSheet.deleteAllArmed) {
      armDeleteAll();
      return;
    }

    disarmDeleteAll();
    invalidateSheetTrackingWork(activeSheetId);

    updateActiveSheet((current) => clearAllDataInSheet(current));
    showActionNotice(activeSheetId, {
      tone: "info",
      message: `${allTrackingIds.length} ID kiriman dihapus.`,
    });
    focusFirstTrackingInput();
  }, [
    allTrackingIds.length,
    armDeleteAll,
    activeSheet.deleteAllArmed,
    disarmDeleteAll,
    focusFirstTrackingInput,
    invalidateSheetTrackingWork,
    showActionNotice,
    updateActiveSheet,
    activeSheetId,
  ]);

  const exportCsv = useCallback(() => {
    if (exportableRows.length === 0) {
      return;
    }

    const header = visibleColumns.map((column) => buildCsvValue(column.label));
    const lines = exportableRows.map((row) =>
      visibleColumns
        .map((column) => buildCsvValue(formatColumnValue(row, column)))
        .join(",")
    );

    const csvContent = [header.join(","), ...lines].join("\n");
    const blob = new Blob([csvContent], {
      type: "text/csv;charset=utf-8;",
    });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const dateSuffix = new Date().toISOString().slice(0, 10);

    link.href = objectUrl;
    link.download =
      selectedVisibleRowKeys.length > 0
        ? `shipflow-selected-${dateSuffix}.csv`
        : `shipflow-view-${dateSuffix}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
    showActionNotice(activeSheetId, {
      tone: "success",
      message: `${exportableRows.length} row berhasil diexport ke CSV.`,
    });
  }, [activeSheetId, exportableRows, selectedVisibleRowKeys.length, showActionNotice, visibleColumns]);

  const retrackAllRows = useCallback(() => {
    if (retrackableRows.length === 0) {
      return;
    }

    const targetSheetId = activeSheetId;
    const retrackableKeySet = new Set(retrackableRows.map((row) => row.key));

    showActionNotice(targetSheetId, {
      tone: "info",
      message: `Lacak ulang dimulai untuk ${retrackableRows.length} kiriman.`,
    });

    void runBulkPasteFetches(targetSheetId, retrackableRows).then(() => {
      const refreshedRows =
        workspaceRef.current.sheetsById[targetSheetId]?.rows.filter((row) =>
          retrackableKeySet.has(row.key)
        ) ?? [];
      const failedCount = refreshedRows.filter((row) => row.error).length;
      const successCount = refreshedRows.length - failedCount;

      showActionNotice(targetSheetId, {
        tone: failedCount > 0 ? "info" : "success",
        message:
          failedCount > 0
            ? `Lacak ulang selesai. ${successCount} berhasil, ${failedCount} gagal.`
            : `Lacak ulang selesai untuk ${retrackableRows.length} kiriman.`,
      });
    });
  }, [activeSheetId, retrackableRows, runBulkPasteFetches, showActionNotice]);

  const activateSheet = useCallback((sheetId: string) => {
    disarmDeleteAll();
    if (highlightedColumnTimeoutRef.current !== null) {
      window.clearTimeout(highlightedColumnTimeoutRef.current);
      highlightedColumnTimeoutRef.current = null;
      highlightedColumnSheetIdRef.current = null;
    }
    setHoveredColumn(null);
    setWorkspaceState((current) => setActiveSheetInWorkspace(current, sheetId));
  }, [disarmDeleteAll]);

  const createSheet = useCallback(() => {
    disarmDeleteAll();
    setHoveredColumn(null);
    setWorkspaceState((current) => createSheetInWorkspace(current));
  }, [disarmDeleteAll]);

  const duplicateActiveSheet = useCallback(() => {
    disarmDeleteAll();
    setHoveredColumn(null);
    setWorkspaceState((current) =>
      createSheetInWorkspace(current, {
        sourceSheetId: activeSheetId,
      })
    );
  }, [activeSheetId, disarmDeleteAll]);

  const renameActiveSheet = useCallback(
    (sheetId: string, name: string) => {
      const normalizedName = name.trim();
      if (!normalizedName) {
        showActionNotice(sheetId, {
          tone: "error",
          message: "Nama sheet tidak boleh kosong.",
        });
        return;
      }

      setWorkspaceState((current) => renameSheetInWorkspace(current, sheetId, name));
      showActionNotice(sheetId, {
        tone: "success",
        message: "Nama sheet berhasil diperbarui.",
      });
    },
    [showActionNotice]
  );

  const deleteActiveSheet = useCallback(
    (sheetId: string) => {
      invalidateSheetTrackingWork(sheetId);
      requestEpochBySheetRef.current.delete(sheetId);
      bulkRunEpochBySheetRef.current.delete(sheetId);
      sheetScrollPositionsRef.current.delete(sheetId);
      if (highlightedColumnSheetIdRef.current === sheetId) {
        if (highlightedColumnTimeoutRef.current !== null) {
          window.clearTimeout(highlightedColumnTimeoutRef.current);
          highlightedColumnTimeoutRef.current = null;
        }
        highlightedColumnSheetIdRef.current = null;
      }
      if (deleteAllArmedSheetIdRef.current === sheetId) {
        if (deleteAllTimeoutRef.current !== null) {
          window.clearTimeout(deleteAllTimeoutRef.current);
          deleteAllTimeoutRef.current = null;
        }
        deleteAllArmedSheetIdRef.current = null;
      }
      const currentWorkspace = workspaceRef.current;
      const currentIndex = currentWorkspace.sheetOrder.indexOf(sheetId);
      const nextSheetId =
        currentWorkspace.activeSheetId === sheetId
          ? currentWorkspace.sheetOrder.filter((currentSheetId) => currentSheetId !== sheetId)[
              Math.max(currentIndex - 1, 0)
            ] ??
            currentWorkspace.sheetOrder.find((currentSheetId) => currentSheetId !== sheetId) ??
            null
          : currentWorkspace.activeSheetId;
      setActionNoticeBySheetId((current) => {
        const sheetNotices = current[sheetId] ?? [];
        sheetNotices.forEach((notice) => {
          if (!notice.id) {
            return;
          }
          const timeoutId = actionNoticeTimeoutsRef.current.get(notice.id);
          if (timeoutId !== undefined) {
            window.clearTimeout(timeoutId);
            actionNoticeTimeoutsRef.current.delete(notice.id);
          }
        });
        const next = { ...current };
        delete next[sheetId];
        return next;
      });
      setHoveredColumn(null);
      setWorkspaceState((current) => deleteSheetInWorkspace(current, sheetId));
      if (nextSheetId) {
        showActionNotice(nextSheetId, {
          tone: "info",
          message: "Sheet berhasil dihapus.",
        });
      }
    },
    [invalidateSheetTrackingWork, showActionNotice]
  );

  const scrollToColumn = useCallback(
    (path: string) => {
      const scrollContainer = sheetScrollRef.current;
      if (!scrollContainer || !visibleColumnPathSet.has(path)) {
        return;
      }

      const headerCells = Array.from(
        scrollContainer.querySelectorAll<HTMLTableCellElement>(
          'thead tr:first-child th[data-column-path]'
        )
      );
      const targetCell = headerCells.find(
        (cell) => cell.dataset.columnPath === path
      );

      if (!targetCell) {
        return;
      }

      const targetSheetId = activeSheetId;
      updateSheet(targetSheetId, (current) =>
        setHighlightedColumnInSheet(current, path)
      );
      highlightedColumnSheetIdRef.current = targetSheetId;
      if (highlightedColumnTimeoutRef.current !== null) {
        window.clearTimeout(highlightedColumnTimeoutRef.current);
      }
      highlightedColumnTimeoutRef.current = window.setTimeout(() => {
        const highlightedSheetId = highlightedColumnSheetIdRef.current;
        if (highlightedSheetId) {
          updateSheet(highlightedSheetId, (current) =>
            setHighlightedColumnInSheet(
              current,
              current.highlightedColumnPath === path
                ? null
                : current.highlightedColumnPath
            )
          );
        }
        highlightedColumnTimeoutRef.current = null;
        highlightedColumnSheetIdRef.current = null;
      }, 2000);

      const stickyWidth = Array.from(pinnedColumnSet).reduce(
        (total, columnPath) => total + (effectiveColumnWidths[columnPath] ?? 0),
        SELECTOR_COLUMN_WIDTH
      );

      scrollContainer.scrollTo({
        left: Math.max(targetCell.offsetLeft - stickyWidth - 12, 0),
        behavior: "smooth",
      });
    },
    [activeSheetId, effectiveColumnWidths, pinnedColumnSet, updateSheet, visibleColumnPathSet]
  );

  const toggleColumnVisibility = useCallback(
    (path: string) => {
      updateActiveSheet((current) => toggleColumnVisibilityInSheet(current, path));
    },
    [updateActiveSheet]
  );

  const togglePinnedColumn = useCallback((path: string) => {
    updateActiveSheet((current) => togglePinnedColumnInSheet(current, path));
  }, [updateActiveSheet]);

  const closeColumnMenu = useCallback(() => {
    updateActiveSheet((current) => setOpenColumnMenuInSheet(current, null));
  }, [updateActiveSheet]);

  const handleColumnMenuRef = useCallback(
    (path: string, element: HTMLDivElement | null) => {
      columnMenuRefs.current.set(path, element);
    },
    []
  );

  const handleSheetScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      sheetScrollPositionsRef.current.set(activeSheetId, {
        left: event.currentTarget.scrollLeft,
        top: event.currentTarget.scrollTop,
      });
    },
    [activeSheetId]
  );

  const toggleColumnMenu = useCallback((path: string) => {
    updateActiveSheet((current) =>
      setOpenColumnMenuInSheet(
        current,
        current.openColumnMenuPath === path ? null : path
      )
    );
  }, [updateActiveSheet]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (document.querySelector('.settings-modal[role="dialog"][aria-modal="true"]')) {
        return;
      }

      if (selectedVisibleRowKeys.length === 0) {
        return;
      }

      const activeTag = document.activeElement?.tagName;
      if (
        activeTag === "INPUT" ||
        activeTag === "TEXTAREA" ||
        (document.activeElement instanceof HTMLElement &&
          document.activeElement.isContentEditable)
      ) {
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
        if (selectedTrackingIds.length === 0) {
          return;
        }

        event.preventDefault();
        copySelectedTrackingIds();
      }

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelectedRows();
      }
    };

    const handleCopy = (event: globalThis.ClipboardEvent) => {
      if (document.querySelector('.settings-modal[role="dialog"][aria-modal="true"]')) {
        return;
      }

      if (selectedVisibleRowKeys.length === 0) {
        return;
      }

      const activeTag = document.activeElement?.tagName;
      if (
        activeTag === "INPUT" ||
        activeTag === "TEXTAREA" ||
        (document.activeElement instanceof HTMLElement &&
          document.activeElement.isContentEditable)
      ) {
        return;
      }

      if (selectedTrackingIds.length === 0) {
        return;
      }

      event.preventDefault();
      event.clipboardData?.setData("text/plain", selectedTrackingIds.join("\n"));
    };

    window.addEventListener("keydown", handleKeyDown);
    document.addEventListener("copy", handleCopy);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("copy", handleCopy);
    };
  }, [
    copySelectedTrackingIds,
    deleteSelectedRows,
    selectedTrackingIds,
    selectedVisibleRowKeys.length,
  ]);

  return (
    <>
      {activeActionNotices.length > 0 ? (
        <div className="action-toast-stack" aria-live="polite">
          {activeActionNotices.map((notice) => (
            <div
              key={notice.id ?? notice.message}
              className={`action-notice action-notice-${notice.tone}`}
              role="status"
            >
              {notice.message}
            </div>
          ))}
        </div>
      ) : null}
      <main className={`shell display-scale-${effectiveDisplayScale}`}>
        <SheetTabs
          tabs={workspaceTabs}
          activeSheetId={activeSheetId}
          displayScale={effectiveDisplayScale}
          serviceConfig={effectiveServiceConfig}
          serviceStatus={apiServiceStatus}
          hasPendingServiceConfigChanges={hasPendingServiceConfigChanges}
          onActivateSheet={activateSheet}
          onCreateSheet={createSheet}
          onDuplicateActiveSheet={duplicateActiveSheet}
          onRenameSheet={renameActiveSheet}
          onDeleteSheet={deleteActiveSheet}
          onPreviewDisplayScale={previewDisplayScale}
          onPreviewServiceEnabled={previewServiceEnabled}
          onPreviewServiceMode={previewServiceMode}
          onPreviewServicePort={previewServicePort}
          onGenerateServiceToken={previewGenerateServiceToken}
          onRegenerateServiceToken={previewRegenerateServiceToken}
          onConfirmSettings={confirmSettings}
          onCancelSettings={cancelSettingsPreview}
        />
        <section className="sheet-panel">
          <SheetActionBar
            loadedCount={loadedCount}
            totalShipmentCount={totalShipmentCount}
            loadingCount={loadingCount}
            retrackableRowsCount={retrackableRows.length}
            deleteAllArmed={activeSheet.deleteAllArmed}
            exportableRowsCount={exportableRows.length}
            activeFilterCount={activeFilterCount}
            selectedRowCount={selectedVisibleRowKeys.length}
            ignoredHiddenFilterCount={ignoredHiddenFilterCount}
            columnShortcuts={columnShortcuts}
            onRetrackAll={retrackAllRows}
            onExportCsv={exportCsv}
            onCopyAllIds={copyAllTrackingIds}
            onDeleteAllRows={deleteAllRows}
            onClearSelection={clearSelection}
            onCreateSheetFromSelectedIds={createSheetFromSelectedIds}
            onClearFilter={clearAllFilters}
            onCopySelectedIds={copySelectedTrackingIds}
            onDeleteSelectedRows={deleteSelectedRows}
            onClearHiddenFilters={clearHiddenFilters}
            onScrollToColumn={scrollToColumn}
          />

          <SheetTable
            sheetId={activeSheetId}
            displayScale={effectiveDisplayScale}
            displayedRows={displayedRows}
            visibleColumns={visibleColumns}
            hiddenColumns={hiddenColumns}
            columnWidths={effectiveColumnWidths}
            pinnedColumnSet={pinnedColumnSet}
            pinnedLeftMap={pinnedLeftMap}
            hoveredColumn={hoveredColumn}
            allVisibleSelected={allVisibleSelected}
            selectedRowKeySet={selectedRowKeySet}
            filters={activeSheet.filters}
            valueFilters={activeSheet.valueFilters}
            valueOptionsByPath={valueOptionsByPath}
            openColumnMenuPath={activeSheet.openColumnMenuPath}
            highlightedColumnPath={activeSheet.highlightedColumnPath}
            scrollContainerRef={sheetScrollRef}
            onScrollContainer={handleSheetScroll}
            sortDirectionForPath={getColumnSortDirection}
            onMouseLeaveTable={() => setHoveredColumn(null)}
            onHoverColumn={setHoveredColumn}
            onToggleVisibleSelection={toggleVisibleSelection}
            onToggleRowSelection={toggleRowSelection}
            onOpenSourceLink={openSourceLink}
            onCopyTrackingId={copyTrackingId}
            onClearTrackingCell={clearTrackingCell}
            onTrackingInputChange={handleTrackingInputChange}
            onTrackingInputBlur={handleTrackingInputBlur}
            onTrackingInputKeyDown={handleTrackingInputKeyDown}
            onTrackingInputPaste={handleTrackingInputPaste}
            onFilterChange={handleFilterChange}
            onResizeStart={handleResizeStart}
            onToggleColumnMenu={toggleColumnMenu}
            onSetColumnSort={setColumnSort}
            onTogglePinnedColumn={togglePinnedColumn}
            onToggleColumnVisibility={toggleColumnVisibility}
            onToggleValueFilter={toggleColumnValueFilter}
            onClearValueFilter={clearColumnValueFilter}
            onCloseColumnMenu={closeColumnMenu}
            onColumnMenuRef={handleColumnMenuRef}
          />
        </section>
      </main>
    </>
  );
}

export default App;
