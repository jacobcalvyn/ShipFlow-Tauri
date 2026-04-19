import {
  ClipboardEvent,
  DragEvent as ReactDragEvent,
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
import { listen } from "@tauri-apps/api/event";
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
  appendTrackingIdsToExistingSheetInWorkspace,
  createSheetInWorkspace,
  createSheetWithTrackingIdsInWorkspace,
  deleteSheetInWorkspace,
  moveTrackingIdsToExistingSheetInWorkspace,
  moveTrackingIdsToNewSheetInWorkspace,
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
import { ServiceSettingsWindow } from "./features/service/components/ServiceSettingsWindow";
import {
  createDefaultWorkspaceDocumentMeta,
  createPersistedWorkspaceDocumentMeta,
  createWorkspaceDocumentFile,
  getWorkspaceDocumentName,
  normalizePersistedWorkspaceDocumentMeta,
  WorkspaceDocumentFile,
  WorkspaceDocumentMeta,
} from "./features/workspace/document";
import {
  ApiServiceStatus,
  ServiceConfig,
  ServiceMode,
  TrackResponse,
  TrackingSource,
} from "./types";
import { createDefaultSheetState } from "./features/sheet/default-state";
import { createEmptyRow, ensureTrailingEmptyRows } from "./features/sheet/utils";
import {
  WorkspaceSheetColor,
  WorkspaceSheetIcon,
  WorkspaceState,
} from "./features/workspace/types";

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
type SelectionTransferMode = "copy" | "move";

const DISPLAY_SCALE_STORAGE_KEY = "shipflow-display-scale";
const WORKSPACE_STATE_STORAGE_KEY = "shipflow-workspace-state";
const WORKSPACE_DOCUMENT_META_STORAGE_KEY = "shipflow-workspace-document-meta";
const RECENT_WORKSPACE_DOCUMENTS_STORAGE_KEY = "shipflow-recent-workspaces";
const DOCUMENT_AUTOSAVE_ENABLED_STORAGE_KEY = "shipflow-document-autosave-enabled";

type WorkspaceDocumentDialogMode = "open" | "saveAs";

type WorkspaceDocumentReadResult = {
  path: string;
  document: WorkspaceDocumentFile;
};

type WorkspaceDocumentWriteResult = {
  path: string;
  savedAt: string;
};

type WorkspaceWindowLaunchRequest = {
  documentPath: string | null;
  startFresh: boolean;
};

type WorkspaceDocumentClaimResult = {
  status: "claimed" | "alreadyOpen";
  path: string | null;
  ownerLabel: string | null;
};

type WindowCloseRequestPayload = {
  documentName: string;
};

const DEFAULT_SERVICE_CONFIG: ServiceConfig = {
  version: 1,
  enabled: false,
  mode: "local",
  port: 18422,
  authToken: "",
  trackingSource: "default",
  externalApiBaseUrl: "",
  externalApiAuthToken: "",
  allowInsecureExternalApiHttp: false,
  keepRunningInTray: true,
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

function isWorkspaceSheetColor(value: unknown): value is WorkspaceSheetColor {
  return (
    value === "slate" ||
    value === "blue" ||
    value === "green" ||
    value === "amber" ||
    value === "rose" ||
    value === "violet"
  );
}

function isWorkspaceSheetIcon(value: unknown): value is WorkspaceSheetIcon {
  return (
    value === "sheet" ||
    value === "pin" ||
    value === "stack" ||
    value === "flag" ||
    value === "star"
  );
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

function isTrackResponseLike(value: unknown): value is TrackResponse {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<TrackResponse>;
  return (
    typeof candidate.url === "string" &&
    !!candidate.detail &&
    typeof candidate.detail === "object" &&
    !!candidate.status_akhir &&
    typeof candidate.status_akhir === "object" &&
    Array.isArray(candidate.history) &&
    !!candidate.history_summary &&
    typeof candidate.history_summary === "object"
  );
}

function createStorageSafeTrackResponse(response: TrackResponse): TrackResponse {
  return {
    ...response,
    pod: {
      ...response.pod,
      photo1_url: "",
      photo2_url: "",
      signature_url: "",
    },
  };
}

function createStorageSafeWorkspaceState(
  workspaceState: WorkspaceState,
  mode: "full" | "inputs_only" = "full"
) {
  return {
    ...workspaceState,
    sheetsById: Object.fromEntries(
      Object.entries(workspaceState.sheetsById).map(([sheetId, sheetState]) => [
        sheetId,
        {
          ...sheetState,
          deleteAllArmed: false,
          openColumnMenuPath: null,
          highlightedColumnPath: null,
          rows: sheetState.rows.map((row) => ({
            ...row,
            loading: false,
            shipment:
              mode === "full" && row.shipment
                ? createStorageSafeTrackResponse(row.shipment)
                : null,
            stale: mode === "full" ? row.stale : false,
            dirty: mode === "full" ? row.dirty : false,
          })),
        },
      ])
    ),
  };
}

function normalizePersistedWorkspaceState(
  workspace: Partial<WorkspaceState> | null | undefined
): WorkspaceState {
  const fallback = createDefaultWorkspaceState();
  if (!workspace || typeof workspace !== "object") {
    return fallback;
  }

  const parsedSheetOrder = Array.isArray(workspace.sheetOrder)
    ? workspace.sheetOrder.filter((sheetId): sheetId is string => typeof sheetId === "string")
    : [];
  const parsedMeta =
    workspace.sheetMetaById && typeof workspace.sheetMetaById === "object"
      ? workspace.sheetMetaById
      : {};
  const parsedSheets =
    workspace.sheetsById && typeof workspace.sheetsById === "object"
      ? workspace.sheetsById
      : {};

  const normalizedSheetOrder = parsedSheetOrder.filter(
    (sheetId) => sheetId in parsedMeta && sheetId in parsedSheets
  );

  if (normalizedSheetOrder.length === 0) {
    return fallback;
  }

  const sheetsById = Object.fromEntries(
    normalizedSheetOrder.map((sheetId) => {
      const baseSheet = createDefaultSheetState();
      const candidate =
        parsedSheets[sheetId] && typeof parsedSheets[sheetId] === "object"
          ? (parsedSheets[sheetId] as Partial<SheetState>)
          : null;
      const parsedRows = Array.isArray(candidate?.rows) ? candidate.rows : [];
      const normalizedRows = ensureTrailingEmptyRows(
        parsedRows.length > 0
          ? parsedRows.map((row) => {
              const baseRow = createEmptyRow();
              if (!row || typeof row !== "object") {
                return baseRow;
              }

              const candidateRow = row as Partial<(typeof baseSheet.rows)[number]>;
              const trackingInput =
                typeof candidateRow.trackingInput === "string"
                  ? candidateRow.trackingInput
                  : "";
              const shipment = isTrackResponseLike(candidateRow.shipment)
                ? candidateRow.shipment
                : null;
              const rowKey =
                typeof candidateRow.key === "string" && candidateRow.key
                  ? candidateRow.key
                  : baseRow.key;

              if (trackingInput.trim() === "") {
                return {
                  ...baseRow,
                  key: rowKey,
                };
              }

              return {
                key: rowKey,
                trackingInput,
                shipment,
                loading: false,
                stale: shipment ? Boolean(candidateRow.stale) : false,
                dirty: shipment ? Boolean(candidateRow.dirty) : false,
                error: typeof candidateRow.error === "string" ? candidateRow.error : "",
              };
            })
          : baseSheet.rows
      );
      const rowKeySet = new Set(normalizedRows.map((row) => row.key));

      const nextSheet: SheetState = {
        ...baseSheet,
        rows: normalizedRows,
        filters:
          candidate?.filters && typeof candidate.filters === "object"
            ? Object.fromEntries(
                Object.entries(candidate.filters).filter(
                  (entry): entry is [string, string] => typeof entry[1] === "string"
                )
              )
            : baseSheet.filters,
        valueFilters:
          candidate?.valueFilters && typeof candidate.valueFilters === "object"
            ? Object.fromEntries(
                Object.entries(candidate.valueFilters).map(([path, values]) => [
                  path,
                  Array.isArray(values)
                    ? values.filter((value): value is string => typeof value === "string")
                    : [],
                ])
              )
            : baseSheet.valueFilters,
        sortState:
          candidate?.sortState &&
          typeof candidate.sortState === "object" &&
          (candidate.sortState.path === null ||
            typeof candidate.sortState.path === "string") &&
          (candidate.sortState.direction === "asc" ||
            candidate.sortState.direction === "desc")
            ? candidate.sortState
            : baseSheet.sortState,
        selectedRowKeys: Array.isArray(candidate?.selectedRowKeys)
          ? candidate.selectedRowKeys.filter(
              (rowKey): rowKey is string =>
                typeof rowKey === "string" && rowKeySet.has(rowKey)
            )
          : baseSheet.selectedRowKeys,
        selectionFollowsVisibleRows: Boolean(candidate?.selectionFollowsVisibleRows),
        columnWidths:
          candidate?.columnWidths && typeof candidate.columnWidths === "object"
            ? {
                ...baseSheet.columnWidths,
                ...Object.fromEntries(
                  Object.entries(candidate.columnWidths).filter(
                    (entry): entry is [string, number] =>
                      typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] > 0
                  )
                ),
              }
            : baseSheet.columnWidths,
        hiddenColumnPaths: Array.isArray(candidate?.hiddenColumnPaths)
          ? candidate.hiddenColumnPaths.filter(
              (path): path is string =>
                typeof path === "string" && COLUMNS.some((column) => column.path === path)
            )
          : baseSheet.hiddenColumnPaths,
        pinnedColumnPaths: Array.isArray(candidate?.pinnedColumnPaths)
          ? candidate.pinnedColumnPaths.filter(
              (path): path is string =>
                typeof path === "string" && COLUMNS.some((column) => column.path === path)
            )
          : baseSheet.pinnedColumnPaths,
        openColumnMenuPath: null,
        highlightedColumnPath: null,
        deleteAllArmed: false,
      };

      return [sheetId, shouldAssertSheetState() ? assertValidSheetState(nextSheet) : nextSheet];
    })
  );

  const sheetMetaById = Object.fromEntries(
    normalizedSheetOrder.map((sheetId) => [
      sheetId,
      {
        name:
          parsedMeta[sheetId] &&
          typeof parsedMeta[sheetId] === "object" &&
          typeof (parsedMeta[sheetId] as { name?: unknown }).name === "string" &&
          (parsedMeta[sheetId] as { name: string }).name.trim()
            ? (parsedMeta[sheetId] as { name: string }).name
            : `Sheet ${normalizedSheetOrder.indexOf(sheetId) + 1}`,
        color:
          parsedMeta[sheetId] &&
          typeof parsedMeta[sheetId] === "object" &&
          isWorkspaceSheetColor((parsedMeta[sheetId] as { color?: unknown }).color)
            ? (parsedMeta[sheetId] as { color: WorkspaceSheetColor }).color
            : "slate",
        icon:
          parsedMeta[sheetId] &&
          typeof parsedMeta[sheetId] === "object" &&
          isWorkspaceSheetIcon((parsedMeta[sheetId] as { icon?: unknown }).icon)
            ? (parsedMeta[sheetId] as { icon: WorkspaceSheetIcon }).icon
            : "sheet",
      },
    ])
  );

  const activeSheetId =
    typeof workspace.activeSheetId === "string" && workspace.activeSheetId in sheetsById
      ? workspace.activeSheetId
      : normalizedSheetOrder[0];

  return {
    version: 1,
    activeSheetId,
    sheetOrder: normalizedSheetOrder,
    sheetMetaById,
    sheetsById,
  };
}

function loadWorkspaceState(windowLabel: string | null = null): WorkspaceState {
  if (!isBrowserReady()) {
    return createDefaultWorkspaceState();
  }

  const stored = window.localStorage.getItem(
    getScopedStorageKey(WORKSPACE_STATE_STORAGE_KEY, windowLabel)
  );
  if (!stored) {
    return createDefaultWorkspaceState();
  }

  try {
    return normalizePersistedWorkspaceState(JSON.parse(stored) as Partial<WorkspaceState>);
  } catch {
    return createDefaultWorkspaceState();
  }
}

function getScopedStorageKey(baseKey: string, windowLabel: string | null) {
  if (!windowLabel || windowLabel === "main") {
    return baseKey;
  }

  return `${baseKey}:${windowLabel}`;
}

function clearScopedStorageKey(baseKey: string, windowLabel: string | null) {
  if (!isBrowserReady()) {
    return;
  }

  window.localStorage.removeItem(getScopedStorageKey(baseKey, windowLabel));
}

function loadWorkspaceDocumentMeta(windowLabel: string | null = null): WorkspaceDocumentMeta {
  if (!isBrowserReady()) {
    return createDefaultWorkspaceDocumentMeta();
  }

  const stored = window.localStorage.getItem(
    getScopedStorageKey(WORKSPACE_DOCUMENT_META_STORAGE_KEY, windowLabel)
  );
  if (!stored) {
    return createDefaultWorkspaceDocumentMeta();
  }

  try {
    return normalizePersistedWorkspaceDocumentMeta(JSON.parse(stored));
  } catch {
    return createDefaultWorkspaceDocumentMeta();
  }
}

function loadRecentWorkspaceDocuments() {
  if (!isBrowserReady()) {
    return [] as string[];
  }

  const stored = window.localStorage.getItem(RECENT_WORKSPACE_DOCUMENTS_STORAGE_KEY);
  if (!stored) {
    return [] as string[];
  }

  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed)
      ? parsed.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0
        )
      : [];
  } catch {
    return [] as string[];
  }
}

function loadDocumentAutosaveEnabled() {
  if (!isBrowserReady()) {
    return true;
  }

  return window.localStorage.getItem(DOCUMENT_AUTOSAVE_ENABLED_STORAGE_KEY) !== "false";
}

function areServiceConfigsEqual(left: ServiceConfig, right: ServiceConfig) {
  return (
    left.version === right.version &&
    left.enabled === right.enabled &&
    left.mode === right.mode &&
    left.port === right.port &&
    left.authToken === right.authToken &&
    left.trackingSource === right.trackingSource &&
    left.externalApiBaseUrl === right.externalApiBaseUrl &&
    left.externalApiAuthToken === right.externalApiAuthToken &&
    left.allowInsecureExternalApiHttp === right.allowInsecureExternalApiHttp &&
    left.keepRunningInTray === right.keepRunningInTray &&
    left.lastUpdatedAt === right.lastUpdatedAt
  );
}

function getSheetRequestKey(sheetId: string, rowKey: string) {
  return `${sheetId}:${rowKey}`;
}

function serializeWorkspaceStateForDocument(workspaceState: WorkspaceState) {
  return JSON.stringify(createStorageSafeWorkspaceState(workspaceState, "full"));
}

function buildWorkspaceWindowTitle(documentMeta: WorkspaceDocumentMeta) {
  const dirtyPrefix = documentMeta.isDirty ? "* " : "";
  return `${dirtyPrefix}${documentMeta.name} - ShipFlow Desktop`;
}

async function pickWorkspaceDocumentPath(
  mode: "open" | "save",
  suggestedName?: string
) {
  return Promise.resolve(
    invoke<string | null>("pick_workspace_document_path", {
      mode,
      suggestedName,
    })
  );
}

function pushRecentWorkspaceDocument(currentPaths: string[], nextPath: string) {
  return [nextPath, ...currentPaths.filter((path) => path !== nextPath)].slice(0, 8);
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

function resolveShipFlowWindowKind() {
  if (typeof window === "undefined") {
    return "workspace" as const;
  }

  const searchParams = new URLSearchParams(window.location.search);
  if (searchParams.get("windowKind") === "service-settings") {
    return "service-settings" as const;
  }

  const shipflowWindow = window as Window & {
    __SHIPFLOW_WINDOW_KIND__?: string;
  };

  return shipflowWindow.__SHIPFLOW_WINDOW_KIND__ === "service-settings"
    ? ("service-settings" as const)
    : ("workspace" as const);
}

async function writeClipboardText(value: string) {
  const text = value.trim();
  if (!text) {
    throw new Error("Clipboard text is required.");
  }

  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the native clipboard bridge below.
    }
  }

  await invoke("copy_to_clipboard", { text });
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

function WorkspaceApp() {
  const [workspaceState, setWorkspaceState] = useState(loadWorkspaceState);
  const [documentMeta, setDocumentMeta] = useState<WorkspaceDocumentMeta>(
    () => loadWorkspaceDocumentMeta()
  );
  const [windowStorageScope, setWindowStorageScope] = useState<string | null>("main");
  const [recentWorkspaceDocuments, setRecentWorkspaceDocuments] = useState<string[]>(
    loadRecentWorkspaceDocuments
  );
  const [autosaveEnabled, setAutosaveEnabled] = useState(loadDocumentAutosaveEnabled);
  const [pendingWindowCloseRequest, setPendingWindowCloseRequest] =
    useState<WindowCloseRequestPayload | null>(null);
  const [isResolvingWindowClose, setIsResolvingWindowClose] = useState(false);
  const [documentDialogMode, setDocumentDialogMode] =
    useState<WorkspaceDocumentDialogMode | null>(null);
  const [documentPathDraft, setDocumentPathDraft] = useState("");
  const [displayScale, setDisplayScale] = useState<DisplayScale>(() => {
    if (!isBrowserReady()) {
      return "small";
    }

    const storedDisplayScale = window.localStorage.getItem(DISPLAY_SCALE_STORAGE_KEY);
    return isDisplayScale(storedDisplayScale) ? storedDisplayScale : "small";
  });
  const [displayScalePreview, setDisplayScalePreview] = useState<DisplayScale | null>(null);
  const [serviceConfig, setServiceConfig] = useState<ServiceConfig>(DEFAULT_SERVICE_CONFIG);
  const [serviceConfigPreview, setServiceConfigPreview] = useState<ServiceConfig | null>(null);
  const [hasLoadedServiceConfig, setHasLoadedServiceConfig] = useState(false);
  const [apiServiceStatus, setApiServiceStatus] = useState<ApiServiceStatus>(
    DEFAULT_API_SERVICE_STATUS
  );
  const [actionNotices, setActionNotices] = useState<ActionNotice[]>([]);
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
  const documentBaselineRef = useRef<string>("__unset__");
  const documentSaveInFlightRef = useRef(false);
  const documentAutosaveTimeoutRef = useRef<number | null>(null);
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
  const deleteSelectedTimeoutRef = useRef<number | null>(null);
  const deleteSelectedArmedSheetIdRef = useRef<string | null>(null);
  const [deleteSelectedArmedSheetId, setDeleteSelectedArmedSheetId] = useState<string | null>(
    null
  );
  const [isSheetTransferDragActive, setIsSheetTransferDragActive] = useState(false);
  const activeSheet = useMemo(() => getActiveSheet(workspaceState), [workspaceState]);
  const activeSheetId = workspaceState.activeSheetId;
  const workspaceTabs = useMemo(
    () => getWorkspaceTabs(workspaceState),
    [workspaceState]
  );
  const appendTargetSheets = useMemo(
    () =>
      workspaceTabs
        .filter((tab) => tab.id !== activeSheetId)
        .map((tab) => ({
          id: tab.id,
          name: tab.name,
        })),
    [activeSheetId, workspaceTabs]
  );
  const workspaceRef = useRef(workspaceState);
  const serviceConfigRef = useRef(serviceConfig);
  const documentMetaRef = useRef(documentMeta);
  const effectiveDisplayScale = displayScalePreview ?? displayScale;
  const effectiveServiceConfig = serviceConfigPreview ?? serviceConfig;
  const hasPendingServiceConfigChanges = serviceConfigPreview !== null;
  const canUseAutosave = documentMeta.path !== null;
  const isAutosaveActive = canUseAutosave && autosaveEnabled;
  const recentDocumentItems = recentWorkspaceDocuments.map((path) => ({
    path,
    name: getWorkspaceDocumentName(path),
  }));

  if (documentBaselineRef.current === "__unset__") {
    documentBaselineRef.current = serializeWorkspaceStateForDocument(workspaceState);
  }

  useEffect(() => {
    const emitRuntimeEvent = (level: "info" | "error", message: string) => {
      void Promise.resolve(
        invoke("log_frontend_runtime_event", { level, message })
      ).catch(() => {
        // Ignore logging failures to avoid recursive runtime errors.
      });
    };

    emitRuntimeEvent("info", "App mounted.");

    const handlePageHide = () => {
      emitRuntimeEvent("info", "window.pagehide fired.");
    };

    const handleBeforeUnload = () => {
      emitRuntimeEvent("info", "window.beforeunload fired.");
    };

    const handleVisibilityChange = () => {
      emitRuntimeEvent("info", `document.visibilityState=${document.visibilityState}`);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      emitRuntimeEvent("info", "App unmounted.");
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);

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

  const syncServiceConfigFromBackend = useCallback(
    async (options?: { preservePreview?: boolean }) => {
      const preservePreview = options?.preservePreview ?? true;

      try {
        const savedConfig = await invoke<ServiceConfig | null>("load_saved_api_service_config");
        const nextConfig = savedConfig
          ? {
              ...savedConfig,
              keepRunningInTray: true,
            }
          : DEFAULT_SERVICE_CONFIG;

        if (!preservePreview || serviceConfigPreview === null) {
          if (!areServiceConfigsEqual(serviceConfigRef.current, nextConfig)) {
            serviceConfigRef.current = nextConfig;
            setServiceConfig(nextConfig);
          }
        }

        return nextConfig;
      } catch {
        if (!preservePreview || serviceConfigPreview === null) {
          if (!areServiceConfigsEqual(serviceConfigRef.current, DEFAULT_SERVICE_CONFIG)) {
            serviceConfigRef.current = DEFAULT_SERVICE_CONFIG;
            setServiceConfig(DEFAULT_SERVICE_CONFIG);
          }
        }

        return DEFAULT_SERVICE_CONFIG;
      }
    },
    [serviceConfigPreview]
  );

  useEffect(() => {
    workspaceRef.current = workspaceState;
  }, [workspaceState]);

  useEffect(() => {
    serviceConfigRef.current = serviceConfig;
  }, [serviceConfig]);

  useEffect(() => {
    let cancelled = false;

    void syncServiceConfigFromBackend({ preservePreview: false }).finally(() => {
      if (!cancelled) {
        setHasLoadedServiceConfig(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [syncServiceConfigFromBackend]);

  useEffect(() => {
    documentMetaRef.current = documentMeta;
  }, [documentMeta]);

  useEffect(() => {
    void Promise.resolve(invoke<string>("get_current_window_label"))
      .then((label) => {
        setWindowStorageScope(label);

        if (label !== "main") {
          const scopedWorkspace = loadWorkspaceState(label);
          const scopedDocumentMeta = loadWorkspaceDocumentMeta(label);
          documentBaselineRef.current = serializeWorkspaceStateForDocument(scopedWorkspace);
          setWorkspaceState(scopedWorkspace);
          setDocumentMeta(scopedDocumentMeta);
        }
      })
      .catch(() => {
        setWindowStorageScope("main");
      });
  }, []);

  useEffect(() => {
    const serializedWorkspace = serializeWorkspaceStateForDocument(workspaceState);
    const isDirty = serializedWorkspace !== documentBaselineRef.current;

    setDocumentMeta((current) =>
      current.isDirty === isDirty ? current : { ...current, isDirty }
    );
  }, [workspaceState]);

  useEffect(() => {
    if (!isBrowserReady() || windowStorageScope === null) {
      return;
    }

    const scopedMetaKey = getScopedStorageKey(
      WORKSPACE_DOCUMENT_META_STORAGE_KEY,
      windowStorageScope
    );
    if (!documentMeta.path) {
      window.localStorage.removeItem(scopedMetaKey);
      return;
    }

    window.localStorage.setItem(
      scopedMetaKey,
      JSON.stringify(createPersistedWorkspaceDocumentMeta(documentMeta))
    );
  }, [documentMeta.lastSavedAt, documentMeta.path, windowStorageScope]);

  useEffect(() => {
    if (!isBrowserReady()) {
      return;
    }

    window.localStorage.setItem(
      RECENT_WORKSPACE_DOCUMENTS_STORAGE_KEY,
      JSON.stringify(recentWorkspaceDocuments)
    );
  }, [recentWorkspaceDocuments]);

  useEffect(() => {
    if (!isBrowserReady()) {
      return;
    }

    window.localStorage.setItem(
      DOCUMENT_AUTOSAVE_ENABLED_STORAGE_KEY,
      autosaveEnabled ? "true" : "false"
    );
  }, [autosaveEnabled]);

  useEffect(() => {
    void Promise.resolve(
      invoke("set_current_window_title", {
        title: buildWorkspaceWindowTitle(documentMeta),
      })
    ).catch(() => {
      // Ignore title update failures so document state stays functional.
    });
  }, [documentMeta]);

  useEffect(() => {
    void Promise.resolve(
      invoke("set_current_window_document_state", {
        isDirty: documentMeta.isDirty,
        documentName: documentMeta.name,
      })
    ).catch(() => {
      // Ignore sync failures so editing stays functional.
    });
  }, [documentMeta.isDirty, documentMeta.name]);

  useEffect(() => {
    let isDisposed = false;
    let unlistenWindowCloseRequest: null | (() => void) = null;

    void listen<WindowCloseRequestPayload>("shipflow://window-close-requested", (event) => {
      if (isDisposed) {
        return;
      }

      setPendingWindowCloseRequest({
        documentName: event.payload.documentName,
      });
    }).then((unlisten) => {
      if (isDisposed) {
        void unlisten();
        return;
      }

      unlistenWindowCloseRequest = unlisten;
    });

    return () => {
      isDisposed = true;
      if (unlistenWindowCloseRequest) {
        void unlistenWindowCloseRequest();
      }
    };
  }, []);

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
    if (!isBrowserReady() || windowStorageScope === null) {
      return;
    }

    if (!documentMeta.path) {
      clearScopedStorageKey(WORKSPACE_STATE_STORAGE_KEY, windowStorageScope);
      return;
    }

    // Unsaved edits should be lost on exit; keep only the last clean snapshot.
    if (documentMeta.isDirty) {
      return;
    }

    const persistWorkspace = (mode: "full" | "inputs_only") => {
      const serialized = JSON.stringify(
        createStorageSafeWorkspaceState(workspaceState, mode)
      );
      window.localStorage.setItem(
        getScopedStorageKey(WORKSPACE_STATE_STORAGE_KEY, windowStorageScope),
        serialized
      );
    };

    try {
      persistWorkspace("full");
    } catch (error) {
      console.warn(
        "[ShipFlowWorkspace] failed to persist full workspace snapshot, falling back to inputs-only snapshot.",
        error
      );

      try {
        persistWorkspace("inputs_only");
      } catch (fallbackError) {
        console.error(
          "[ShipFlowWorkspace] failed to persist workspace snapshot.",
          fallbackError
        );
      }
    }
  }, [documentMeta.isDirty, documentMeta.path, windowStorageScope, workspaceState]);

  const closeDocumentDialog = useCallback(() => {
    setDocumentDialogMode(null);
    setDocumentPathDraft("");
  }, []);

  const claimCurrentWorkspaceDocumentPath = useCallback(
    async (path: string | null) => {
      return Promise.resolve(
        invoke<WorkspaceDocumentClaimResult>("claim_current_workspace_document", {
          path,
        })
      );
    },
    []
  );

  const openDocumentDialog = useCallback(
    (mode: WorkspaceDocumentDialogMode) => {
      setDocumentDialogMode(mode);
      setDocumentPathDraft(documentMeta.path ?? "");
    },
    [documentMeta.path]
  );

  const confirmReplaceCurrentDocument = useCallback((message: string) => {
    const hasUnsavedChanges =
      serializeWorkspaceStateForDocument(workspaceRef.current) !== documentBaselineRef.current;

    if (!hasUnsavedChanges) {
      return true;
    }

    return window.confirm(message);
  }, []);

  const saveWorkspaceDocumentToPath = useCallback(
    async (path: string, options?: { silent?: boolean }) => {
      const trimmedPath = path.trim();
      if (!trimmedPath || documentSaveInFlightRef.current) {
        return false;
      }

      const previousPath = documentMetaRef.current.path;
      const claimResult = await claimCurrentWorkspaceDocumentPath(trimmedPath);
      if (claimResult.status === "alreadyOpen") {
        if (!options?.silent) {
          showActionNotice(workspaceRef.current.activeSheetId, {
            tone: "info",
            message: "Dokumen itu sudah terbuka di jendela lain.",
          });
        }
        return false;
      }

      const savedAt = new Date().toISOString();
      const serializedWorkspace = serializeWorkspaceStateForDocument(workspaceRef.current);
      const document = createWorkspaceDocumentFile(
        JSON.parse(serializedWorkspace) as WorkspaceState,
        savedAt
      );

      documentSaveInFlightRef.current = true;
      setDocumentMeta((current) => ({
        ...current,
        persistenceStatus: "saving",
        errorMessage: null,
      }));

      try {
        const result = await Promise.resolve(
          invoke<WorkspaceDocumentWriteResult>("write_workspace_document", {
            path: trimmedPath,
            document,
          })
        );

        documentBaselineRef.current = serializedWorkspace;
        setDocumentMeta({
          path: result.path,
          name: getWorkspaceDocumentName(result.path),
          isDirty: false,
          lastSavedAt: result.savedAt,
          persistenceStatus: "idle",
          errorMessage: null,
        });
        setRecentWorkspaceDocuments((current) =>
          pushRecentWorkspaceDocument(current, result.path)
        );

        if (!options?.silent) {
          showActionNotice(workspaceRef.current.activeSheetId, {
            tone: "success",
            message: "Dokumen berhasil disimpan.",
          });
        }

        return true;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Gagal menyimpan dokumen.";

        if (previousPath !== trimmedPath) {
          void claimCurrentWorkspaceDocumentPath(previousPath);
        }

        setDocumentMeta((current) => ({
          ...current,
          persistenceStatus: "error",
          errorMessage: message,
        }));

        if (!options?.silent) {
          showActionNotice(workspaceRef.current.activeSheetId, {
            tone: "error",
            message,
          });
        }

        return false;
      } finally {
        documentSaveInFlightRef.current = false;
      }
    },
    [claimCurrentWorkspaceDocumentPath]
  );

  const applyWorkspaceDocument = useCallback(
    (path: string, document: WorkspaceDocumentFile) => {
      const normalizedWorkspace = normalizePersistedWorkspaceState(document.workspace);
      const serializedWorkspace = serializeWorkspaceStateForDocument(normalizedWorkspace);
      documentBaselineRef.current = serializedWorkspace;
      setWorkspaceState(normalizedWorkspace);
      setDocumentMeta({
        path,
        name: getWorkspaceDocumentName(path),
        isDirty: false,
        lastSavedAt: document.savedAt,
        persistenceStatus: "idle",
        errorMessage: null,
      });
    },
    []
  );

  const openWorkspaceDocumentFromPath = useCallback(
    async (path: string) => {
      const trimmedPath = path.trim();
      if (!trimmedPath) {
        return false;
      }

      if (!confirmReplaceCurrentDocument("Perubahan belum disimpan. Buka dokumen lain?")) {
        return false;
      }

      const previousPath = documentMetaRef.current.path;
      const claimResult = await claimCurrentWorkspaceDocumentPath(trimmedPath);
      if (claimResult.status === "alreadyOpen") {
        showActionNotice(workspaceRef.current.activeSheetId, {
          tone: "info",
          message: "Dokumen itu sudah terbuka di jendela lain.",
        });
        return false;
      }

      try {
        const result = await Promise.resolve(
          invoke<WorkspaceDocumentReadResult>("read_workspace_document", {
            path: trimmedPath,
          })
        );

        applyWorkspaceDocument(result.path, result.document);
        setRecentWorkspaceDocuments((current) =>
          pushRecentWorkspaceDocument(current, result.path)
        );
        showActionNotice(workspaceRef.current.activeSheetId, {
          tone: "success",
          message: "Dokumen berhasil dibuka.",
        });
        return true;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Gagal membuka dokumen.";
        void claimCurrentWorkspaceDocumentPath(previousPath);
        showActionNotice(workspaceRef.current.activeSheetId, {
          tone: "error",
          message,
        });
        return false;
      }
    },
    [applyWorkspaceDocument, claimCurrentWorkspaceDocumentPath, confirmReplaceCurrentDocument]
  );

  const openWorkspaceDocumentWithPicker = useCallback(async () => {
    try {
      const pickedPath = await pickWorkspaceDocumentPath("open");
      if (!pickedPath) {
        return false;
      }

      return openWorkspaceDocumentFromPath(pickedPath);
    } catch {
      openDocumentDialog("open");
      return false;
    }
  }, [openDocumentDialog, openWorkspaceDocumentFromPath]);

  const createNewWorkspaceDocument = useCallback(() => {
    const hasUnsavedChanges =
      serializeWorkspaceStateForDocument(workspaceRef.current) !== documentBaselineRef.current;

    if (hasUnsavedChanges && !window.confirm("Perubahan belum disimpan. Buat dokumen baru?")) {
      return;
    }

    const nextWorkspace = createDefaultWorkspaceState();
    documentBaselineRef.current = serializeWorkspaceStateForDocument(nextWorkspace);
    setWorkspaceState(nextWorkspace);
    setDocumentMeta(createDefaultWorkspaceDocumentMeta());
    void claimCurrentWorkspaceDocumentPath(null);
    showActionNotice(nextWorkspace.activeSheetId, {
      tone: "info",
      message: "Dokumen baru dibuat.",
    });
  }, [claimCurrentWorkspaceDocumentPath]);

  const saveCurrentWorkspaceDocument = useCallback(async () => {
    if (documentMeta.path) {
      return saveWorkspaceDocumentToPath(documentMeta.path);
    }

    try {
      const pickedPath = await pickWorkspaceDocumentPath("save", documentMeta.name);
      if (!pickedPath) {
        return false;
      }

      return saveWorkspaceDocumentToPath(pickedPath);
    } catch {
      openDocumentDialog("saveAs");
    }

    return false;
  }, [documentMeta.name, documentMeta.path, openDocumentDialog, saveWorkspaceDocumentToPath]);

  const saveWorkspaceDocumentAs = useCallback(async () => {
    try {
      const pickedPath = await pickWorkspaceDocumentPath("save", documentMeta.name);
      if (!pickedPath) {
        return false;
      }

      return saveWorkspaceDocumentToPath(pickedPath);
    } catch {
      openDocumentDialog("saveAs");
      return false;
    }
  }, [documentMeta.name, openDocumentDialog, saveWorkspaceDocumentToPath]);

  const createNewWorkspaceWindow = useCallback(async () => {
    const result = await Promise.resolve(
      invoke<WorkspaceDocumentClaimResult>("create_workspace_window", {
        documentPath: null,
      })
    );

    if (result.status === "alreadyOpen") {
      showActionNotice(workspaceRef.current.activeSheetId, {
        tone: "info",
        message: "Dokumen itu sudah terbuka di jendela lain.",
      });
    }
  }, []);

  const openWorkspaceInNewWindow = useCallback(async () => {
    try {
      const pickedPath = await pickWorkspaceDocumentPath("open");
      if (!pickedPath) {
        return;
      }

      const result = await Promise.resolve(
        invoke<WorkspaceDocumentClaimResult>("create_workspace_window", {
          documentPath: pickedPath,
        })
      );

      if (result.status === "alreadyOpen") {
        showActionNotice(workspaceRef.current.activeSheetId, {
          tone: "info",
          message: "Dokumen itu sudah terbuka di jendela lain.",
        });
      } else {
        setRecentWorkspaceDocuments((current) =>
          pushRecentWorkspaceDocument(current, pickedPath)
        );
      }
    } catch {
      showActionNotice(workspaceRef.current.activeSheetId, {
        tone: "error",
        message: "Gagal membuka pemilih file untuk jendela baru.",
      });
    }
  }, []);

  const submitDocumentDialog = useCallback(async () => {
    if (documentDialogMode === "open") {
      const didOpen = await openWorkspaceDocumentFromPath(documentPathDraft);
      if (didOpen) {
        closeDocumentDialog();
      }
      return;
    }

    if (documentDialogMode === "saveAs") {
      const didSave = await saveWorkspaceDocumentToPath(documentPathDraft);
      if (didSave) {
        closeDocumentDialog();
      }
    }
  }, [
    closeDocumentDialog,
    documentDialogMode,
    documentPathDraft,
    openWorkspaceDocumentFromPath,
    saveWorkspaceDocumentToPath,
  ]);

  useEffect(() => {
    if (
      !isAutosaveActive ||
      !documentMeta.path ||
      !documentMeta.isDirty ||
      documentSaveInFlightRef.current
    ) {
      return;
    }

    const autosavePath = documentMeta.path;

    if (documentAutosaveTimeoutRef.current !== null) {
      window.clearTimeout(documentAutosaveTimeoutRef.current);
    }

    documentAutosaveTimeoutRef.current = window.setTimeout(() => {
      void saveWorkspaceDocumentToPath(autosavePath, { silent: true });
      documentAutosaveTimeoutRef.current = null;
    }, 700);

    return () => {
      if (documentAutosaveTimeoutRef.current !== null) {
        window.clearTimeout(documentAutosaveTimeoutRef.current);
        documentAutosaveTimeoutRef.current = null;
      }
    };
  }, [
    isAutosaveActive,
    documentMeta.isDirty,
    documentMeta.path,
    saveWorkspaceDocumentToPath,
    workspaceState,
  ]);

  useEffect(() => {
    const handleDocumentShortcuts = (event: globalThis.KeyboardEvent) => {
      const isModifierPressed = event.metaKey || event.ctrlKey;
      if (!isModifierPressed || event.key.toLowerCase() !== "s") {
        return;
      }

      event.preventDefault();
      if (event.shiftKey) {
        openDocumentDialog("saveAs");
        return;
      }

      void saveCurrentWorkspaceDocument();
    };

    window.addEventListener("keydown", handleDocumentShortcuts);

    return () => {
      window.removeEventListener("keydown", handleDocumentShortcuts);
    };
  }, [openDocumentDialog, saveCurrentWorkspaceDocument]);

  useEffect(() => {
    void Promise.resolve(
      invoke<WorkspaceWindowLaunchRequest | null>("take_pending_workspace_window_request")
    )
      .then((request) => {
        if (!request) {
          return;
        }

        if (request.documentPath) {
          void openWorkspaceDocumentFromPath(request.documentPath);
          return;
        }

        if (request.startFresh) {
          const nextWorkspace = createDefaultWorkspaceState();
          documentBaselineRef.current = serializeWorkspaceStateForDocument(nextWorkspace);
          setWorkspaceState(nextWorkspace);
          setDocumentMeta(createDefaultWorkspaceDocumentMeta());
        }
      })
      .catch(() => {
        // Ignore launch request failures for the primary window.
      });
  }, [openWorkspaceDocumentFromPath]);

  useEffect(() => {
    if (!documentMeta.path) {
      return;
    }

    void claimCurrentWorkspaceDocumentPath(documentMeta.path);
  }, [claimCurrentWorkspaceDocumentPath, documentMeta.path]);

  const resolvePendingWindowClose = useCallback(
    async (action: "cancel" | "discard") => {
      await Promise.resolve(
        invoke("resolve_window_close_request", {
          action,
        })
      );
      setPendingWindowCloseRequest(null);
    },
    []
  );

  const cancelPendingWindowClose = useCallback(() => {
    setIsResolvingWindowClose(true);
    void resolvePendingWindowClose("cancel").finally(() => {
      setIsResolvingWindowClose(false);
    });
  }, [resolvePendingWindowClose]);

  const discardPendingWindowClose = useCallback(() => {
    setIsResolvingWindowClose(true);
    void resolvePendingWindowClose("discard").finally(() => {
      setIsResolvingWindowClose(false);
    });
  }, [resolvePendingWindowClose]);

  const saveAndCloseWindow = useCallback(() => {
    setIsResolvingWindowClose(true);
    void saveCurrentWorkspaceDocument()
      .then((didSave) => {
        if (!didSave) {
          return;
        }

        return resolvePendingWindowClose("discard");
      })
      .finally(() => {
        setIsResolvingWindowClose(false);
      });
  }, [resolvePendingWindowClose, saveCurrentWorkspaceDocument]);

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

  const previewTrackingSource = useCallback(
    (trackingSource: TrackingSource) => {
      previewServiceConfig((current) => ({
        ...current,
        trackingSource,
      }));
    },
    [previewServiceConfig]
  );

  const previewExternalApiBaseUrl = useCallback(
    (externalApiBaseUrl: string) => {
      previewServiceConfig((current) => ({
        ...current,
        externalApiBaseUrl,
      }));
    },
    [previewServiceConfig]
  );

  const previewExternalApiAuthToken = useCallback(
    (externalApiAuthToken: string) => {
      previewServiceConfig((current) => ({
        ...current,
        externalApiAuthToken,
      }));
    },
    [previewServiceConfig]
  );

  const previewAllowInsecureExternalApiHttp = useCallback(
    (allowInsecureExternalApiHttp: boolean) => {
      previewServiceConfig((current) => ({
        ...current,
        allowInsecureExternalApiHttp,
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

  const armDeleteSelected = useCallback(() => {
    const targetSheetId = activeSheetId;
    deleteSelectedArmedSheetIdRef.current = targetSheetId;
    setDeleteSelectedArmedSheetId(targetSheetId);

    if (deleteSelectedTimeoutRef.current !== null) {
      window.clearTimeout(deleteSelectedTimeoutRef.current);
    }

    deleteSelectedTimeoutRef.current = window.setTimeout(() => {
      deleteSelectedArmedSheetIdRef.current = null;
      setDeleteSelectedArmedSheetId(null);
      deleteSelectedTimeoutRef.current = null;
    }, 2000);
  }, [activeSheetId]);

  const disarmDeleteSelected = useCallback(() => {
    if (deleteSelectedTimeoutRef.current !== null) {
      window.clearTimeout(deleteSelectedTimeoutRef.current);
      deleteSelectedTimeoutRef.current = null;
    }
    deleteSelectedArmedSheetIdRef.current = null;
    setDeleteSelectedArmedSheetId(null);
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

  const showActionNotice = useCallback((_sheetId: string, notice: ActionNotice) => {
    const noticeId = notice.id || createRequestId();

    setActionNotices((current) => [...current, { ...notice, id: noticeId }].slice(-5));

    const timeoutId = window.setTimeout(() => {
      setActionNotices((current) =>
        current.filter((currentNotice) => currentNotice.id !== noticeId)
      );
      actionNoticeTimeoutsRef.current.delete(noticeId);
    }, 2200);

    actionNoticeTimeoutsRef.current.set(noticeId, timeoutId);
  }, []);

  const openShipFlowServiceApp = useCallback(async () => {
    try {
      await invoke("open_shipflow_service_app");
    } catch {
      showActionNotice(workspaceRef.current.activeSheetId, {
        tone: "error",
        message: "Gagal membuka ShipFlow Service.",
      });
    }
  }, [showActionNotice]);

  const applyServiceConfig = useCallback(
    async (nextConfig: ServiceConfig) => {
      try {
        const status = await invoke<ApiServiceStatus>("configure_api_service", {
          config: nextConfig,
        });
        serviceConfigRef.current = nextConfig;
        setServiceConfig(nextConfig);
        setApiServiceStatus(status);
        return true;
      } catch (error) {
        setApiServiceStatus({
          status: "error",
          enabled: nextConfig.enabled,
          mode: nextConfig.mode,
          bindAddress: nextConfig.mode === "lan" ? "0.0.0.0" : "127.0.0.1",
          port: nextConfig.port,
          errorMessage:
            error instanceof Error ? error.message : "Gagal mengonfigurasi akses API eksternal.",
        });
        showActionNotice(workspaceRef.current.activeSheetId, {
          tone: "error",
          message:
            error instanceof Error ? error.message : "Gagal mengonfigurasi akses API eksternal.",
        });
        return false;
      }
    },
    [showActionNotice]
  );

  const confirmSettings = useCallback(async () => {
    const nextServiceConfig = serviceConfigPreview
      ? {
          ...serviceConfigPreview,
          keepRunningInTray: true,
          lastUpdatedAt: new Date().toISOString(),
        }
      : null;

    if (nextServiceConfig) {
      try {
        await invoke("validate_tracking_source_config", { config: nextServiceConfig });
      } catch (error) {
        showActionNotice(workspaceRef.current.activeSheetId, {
          tone: "error",
          message:
            error instanceof Error
              ? error.message
              : "Konfigurasi sumber tracking tidak valid.",
        });
        return false;
      }
    }

    if (nextServiceConfig) {
      const didApply = await applyServiceConfig(nextServiceConfig);
      if (!didApply) {
        return false;
      }
    }

    setDisplayScale((current) => displayScalePreview ?? current);
    setDisplayScalePreview(null);
    setServiceConfigPreview(null);
    return true;
  }, [applyServiceConfig, displayScalePreview, serviceConfigPreview, showActionNotice]);

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
            : "Gagal membaca status akses API eksternal.",
      });
    }
  }, []);

  useEffect(() => {
    if (!hasLoadedServiceConfig) {
      return;
    }

    void refreshApiServiceStatus();
  }, [hasLoadedServiceConfig, refreshApiServiceStatus]);

  useEffect(() => {
    if (!hasLoadedServiceConfig) {
      return;
    }

    const syncFromService = () => {
      void syncServiceConfigFromBackend();
      void refreshApiServiceStatus();
    };

    const intervalId = window.setInterval(syncFromService, 5000);
    window.addEventListener("focus", syncFromService);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", syncFromService);
    };
  }, [hasLoadedServiceConfig, refreshApiServiceStatus, syncServiceConfigFromBackend]);

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
          message: "Gagal membuka sumber tracking.",
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

  const retryFailedEntries = useMemo(
    () =>
      activeSheet.rows
        .filter(
          (row) =>
            row.trackingInput.trim() !== "" &&
            !row.loading &&
            (row.error !== "" || row.stale || row.dirty)
        )
        .map((row) => ({
          key: row.key,
          value: row.trackingInput.trim(),
        })),
    [activeSheet.rows]
  );

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

        const targetRow = targetSheet.rows.find((row) => row.key === rowKey);
        if (
          !targetRow ||
          sanitizeTrackingInput(targetRow.trackingInput) !== normalizedId
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

        const targetRow = targetSheet.rows.find((row) => row.key === rowKey);
        if (
          !targetRow ||
          sanitizeTrackingInput(targetRow.trackingInput) !== normalizedId
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
        shipmentIdOverride !== undefined
          ? sanitizeTrackingInput(shipmentIdOverride)
          : workspaceRef.current.sheetsById[sheetId]?.rows.find(
              (row) => row.key === rowKey
            )?.trackingInput ?? "";

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
      event.stopPropagation();
      if ("stopImmediatePropagation" in event.nativeEvent) {
        event.nativeEvent.stopImmediatePropagation();
      }

      const hasSelectedText =
        typeof currentInput.selectionStart === "number" &&
        typeof currentInput.selectionEnd === "number" &&
        currentInput.selectionStart !== currentInput.selectionEnd;

      if (event.key === "Enter") {
        event.preventDefault();
        if (hasSelectedText) {
          return;
        }
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
    [fetchRow, focusTrackingInputRelative, handleTrackingInputChange]
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
    [abortRowTrackingWork, disarmDeleteAll, runBulkPasteFetches, updateSheet]
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

    void writeClipboardText(selectedTrackingIds.join("\n"))
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

    void writeClipboardText(allTrackingIds.join("\n"))
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

      void writeClipboardText(trackingId)
        .catch(() =>
          showActionNotice(activeSheetId, {
            tone: "error",
            message: "Gagal menyalin ID kiriman.",
          })
        );
    },
    [activeSheetId, showActionNotice]
  );

  const copyServiceEndpoint = useCallback(
    (endpoint: string) => {
      if (!endpoint.trim()) {
        return;
      }

      void writeClipboardText(endpoint)
        .then(() =>
          showActionNotice(activeSheetId, {
            tone: "success",
            message: "Endpoint API berhasil disalin.",
          })
        )
        .catch(() =>
          showActionNotice(activeSheetId, {
            tone: "error",
            message: "Gagal menyalin endpoint API.",
          })
        );
    },
    [activeSheetId, showActionNotice]
  );

  const copyServiceToken = useCallback(
    (token: string) => {
      if (!token.trim()) {
        return;
      }

      void writeClipboardText(token)
        .then(() =>
          showActionNotice(activeSheetId, {
            tone: "success",
            message: "Auth token berhasil disalin.",
          })
        )
        .catch(() =>
          showActionNotice(activeSheetId, {
            tone: "error",
            message: "Gagal menyalin auth token.",
          })
        );
    },
    [activeSheetId, showActionNotice]
  );

  const testExternalTrackingSource = useCallback(async (config: ServiceConfig) => {
    return invoke<string>("test_external_tracking_source", { config });
  }, []);

  const clearSelection = useCallback(() => {
    disarmDeleteSelected();
    updateActiveSheet((current) => clearSelectionInSheet(current));
  }, [disarmDeleteSelected, updateActiveSheet]);

  const transferSelectedIdsToNewSheet = useCallback((mode: SelectionTransferMode) => {
    if (selectedTrackingIds.length === 0) {
      return;
    }

    disarmDeleteAll();
    disarmDeleteSelected();
    setHoveredColumn(null);

    if (mode === "move") {
      abortRowTrackingWork(activeSheetId, selectedVisibleRowKeys, "selected_rows_deleted");
    }

    const currentWorkspace = workspaceRef.current;
    const result =
      mode === "move"
        ? moveTrackingIdsToNewSheetInWorkspace(
            currentWorkspace,
            activeSheetId,
            selectedVisibleRowKeys,
            selectedTrackingIds
          )
        : createSheetWithTrackingIdsInWorkspace(currentWorkspace, selectedTrackingIds);

    setWorkspaceState(result.workspaceState);

    if (result.targetKeys.length === 0) {
      return;
    }

    showActionNotice(result.sheetId, {
      tone: "success",
      message:
        mode === "move"
          ? `${selectedTrackingIds.length} ID dipindahkan ke sheet baru.`
          : `${selectedTrackingIds.length} ID disalin ke sheet baru.`,
    });

    void runBulkPasteFetches(
      result.sheetId,
      result.targetKeys.map((key, index) => ({
        key,
        value: selectedTrackingIds[index],
      }))
    );
  }, [
    abortRowTrackingWork,
    activeSheetId,
    disarmDeleteAll,
    disarmDeleteSelected,
    runBulkPasteFetches,
    selectedTrackingIds,
    selectedVisibleRowKeys,
    showActionNotice,
  ]);

  const beginSelectedIdsDrag = useCallback(
    (event: ReactDragEvent<HTMLButtonElement>) => {
      if (selectedTrackingIds.length === 0) {
        event.preventDefault();
        return;
      }

      const payload = JSON.stringify({
        sourceSheetId: activeSheetId,
        rowKeys: selectedVisibleRowKeys,
        trackingIds: selectedTrackingIds,
      });

      event.dataTransfer.setData("application/x-shipflow-selected-ids", payload);
      event.dataTransfer.setData("text/plain", selectedTrackingIds.join("\n"));
      event.dataTransfer.effectAllowed = "copyMove";
      setIsSheetTransferDragActive(true);
    },
    [activeSheetId, selectedTrackingIds, selectedVisibleRowKeys]
  );

  const endSelectedIdsDrag = useCallback(() => {
    setIsSheetTransferDragActive(false);
  }, []);

  const transferSelectedIdsToExistingSheet = useCallback(
    (mode: SelectionTransferMode, targetSheetId: string) => {
      if (selectedTrackingIds.length === 0) {
        return;
      }

      disarmDeleteAll();
      disarmDeleteSelected();

      if (mode === "move") {
        abortRowTrackingWork(activeSheetId, selectedVisibleRowKeys, "selected_rows_deleted");
      }

      const currentWorkspace = workspaceRef.current;
      const targetSheetName =
        currentWorkspace.sheetMetaById[targetSheetId]?.name ?? "Sheet";
      const result =
        mode === "move"
          ? moveTrackingIdsToExistingSheetInWorkspace(
              currentWorkspace,
              activeSheetId,
              targetSheetId,
              selectedVisibleRowKeys,
              selectedTrackingIds
            )
          : appendTrackingIdsToExistingSheetInWorkspace(
              currentWorkspace,
              targetSheetId,
              selectedTrackingIds
            );

      setWorkspaceState(result.workspaceState);

      if (result.targetKeys.length === 0) {
        return;
      }

      showActionNotice(activeSheetId, {
        tone: "success",
        message:
          mode === "move"
            ? `${selectedTrackingIds.length} ID dipindahkan ke ${targetSheetName}.`
            : `${selectedTrackingIds.length} ID ditambahkan ke ${targetSheetName}.`,
      });

      void runBulkPasteFetches(
        targetSheetId,
        result.targetKeys.map((key, index) => ({
          key,
          value: selectedTrackingIds[index],
        }))
      );
    },
    [
      abortRowTrackingWork,
      activeSheetId,
      disarmDeleteAll,
      disarmDeleteSelected,
      runBulkPasteFetches,
      selectedTrackingIds,
      selectedVisibleRowKeys,
      showActionNotice,
    ]
  );

  const dropSelectedIdsToExistingSheet = useCallback(
    (targetSheetId: string, mode: SelectionTransferMode) => {
      setIsSheetTransferDragActive(false);
      transferSelectedIdsToExistingSheet(mode, targetSheetId);
    },
    [transferSelectedIdsToExistingSheet]
  );

  const dropSelectedIdsToNewSheet = useCallback(
    (mode: SelectionTransferMode) => {
      setIsSheetTransferDragActive(false);
      transferSelectedIdsToNewSheet(mode);
    },
    [transferSelectedIdsToNewSheet]
  );

  const clearAllFilters = useCallback(() => {
    updateActiveSheet((current) => clearFiltersInSheet(current));
  }, [updateActiveSheet]);

  const retryFailedRows = useCallback(() => {
    if (retryFailedEntries.length === 0) {
      return;
    }

    disarmDeleteAll();
    void runBulkPasteFetches(activeSheetId, retryFailedEntries);
    showActionNotice(activeSheetId, {
      tone: "info",
      message: "Proses lacak ulang dimulai.",
    });
  }, [activeSheetId, disarmDeleteAll, retryFailedEntries, runBulkPasteFetches, showActionNotice]);

  useEffect(() => {
    if (selectedTrackingIds.length === 0 || appendTargetSheets.length === 0) {
      setIsSheetTransferDragActive(false);
    }
  }, [appendTargetSheets.length, selectedTrackingIds.length]);

  const clearHiddenFilters = useCallback(() => {
    updateActiveSheet((current) =>
      clearHiddenFiltersInSheet(current, visibleColumnPathSet)
    );
  }, [updateActiveSheet, visibleColumnPathSet]);

  const deleteSelectedRows = useCallback(() => {
    if (selectedVisibleRowKeys.length === 0) {
      disarmDeleteSelected();
      return;
    }

    if (deleteSelectedArmedSheetId !== activeSheetId) {
      armDeleteSelected();
      return;
    }

    abortRowTrackingWork(activeSheetId, selectedVisibleRowKeys, "selected_rows_deleted");

    updateActiveSheet((current) =>
      clearSelectionInSheet(deleteRowsInSheet(current, selectedVisibleRowKeys))
    );
    disarmDeleteSelected();
  }, [
    activeSheetId,
    armDeleteSelected,
    abortRowTrackingWork,
    deleteSelectedArmedSheetId,
    disarmDeleteSelected,
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
      message: "Proses lacak ulang dimulai.",
    });

    void runBulkPasteFetches(targetSheetId, retrackableRows).then(() => {
      const refreshedRows =
        workspaceRef.current.sheetsById[targetSheetId]?.rows.filter((row) =>
          retrackableKeySet.has(row.key)
        ) ?? [];
      const failedCount = refreshedRows.filter((row) => row.error).length;

      showActionNotice(targetSheetId, {
        tone: failedCount > 0 ? "error" : "success",
        message: failedCount > 0 ? "Lacak ulang gagal." : "Lacak ulang berhasil.",
      });
    });
  }, [activeSheetId, retrackableRows, runBulkPasteFetches, showActionNotice]);

  const activateSheet = useCallback((sheetId: string) => {
    disarmDeleteAll();
    disarmDeleteSelected();
    if (highlightedColumnTimeoutRef.current !== null) {
      window.clearTimeout(highlightedColumnTimeoutRef.current);
      highlightedColumnTimeoutRef.current = null;
      highlightedColumnSheetIdRef.current = null;
    }
    setHoveredColumn(null);
    setWorkspaceState((current) => setActiveSheetInWorkspace(current, sheetId));
  }, [disarmDeleteAll, disarmDeleteSelected]);

  const createSheet = useCallback(() => {
    disarmDeleteAll();
    disarmDeleteSelected();
    setHoveredColumn(null);
    setWorkspaceState((current) => createSheetInWorkspace(current));
  }, [disarmDeleteAll, disarmDeleteSelected]);

  const duplicateSheet = useCallback((sheetId: string) => {
    disarmDeleteAll();
    disarmDeleteSelected();
    setHoveredColumn(null);
    setWorkspaceState((current) =>
      createSheetInWorkspace(current, {
        sourceSheetId: sheetId,
      })
    );
  }, [disarmDeleteAll, disarmDeleteSelected]);

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
      if (deleteSelectedArmedSheetIdRef.current === sheetId) {
        if (deleteSelectedTimeoutRef.current !== null) {
          window.clearTimeout(deleteSelectedTimeoutRef.current);
          deleteSelectedTimeoutRef.current = null;
        }
        deleteSelectedArmedSheetIdRef.current = null;
        setDeleteSelectedArmedSheetId(null);
      }
      setHoveredColumn(null);
      setWorkspaceState((current) => deleteSheetInWorkspace(current, sheetId));
    },
    [invalidateSheetTrackingWork]
  );

  useEffect(() => {
    if (deleteSelectedArmedSheetIdRef.current !== activeSheetId) {
      return;
    }

    if (selectedVisibleRowKeys.length === 0) {
      disarmDeleteSelected();
    }
  }, [activeSheetId, disarmDeleteSelected, selectedVisibleRowKeys.length]);

  useEffect(() => {
    if (deleteSelectedArmedSheetIdRef.current !== activeSheetId) {
      return;
    }

    disarmDeleteSelected();
  }, [activeSheetId, disarmDeleteSelected, selectedVisibleRowKeys.join("|")]);

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
    const hasActiveTextSelection = () => {
      const selection = document.getSelection();
      return !!selection && selection.type === "Range" && selection.toString().trim().length > 0;
    };

    const isEditableNode = (node: EventTarget | null) => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }

      if (
        node instanceof HTMLInputElement ||
        node instanceof HTMLTextAreaElement ||
        node.isContentEditable
      ) {
        return true;
      }

      return !!node.closest('input, textarea, [contenteditable="true"]');
    };

    const isEditableEventTarget = (event: Event) => {
      if (isEditableNode(event.target)) {
        return true;
      }

      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      return path.some((node) => isEditableNode(node));
    };

    const hasSelectedTextInFormControl = (target: EventTarget | null) => {
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return (
          typeof target.selectionStart === "number" &&
          typeof target.selectionEnd === "number" &&
          target.selectionStart !== target.selectionEnd
        );
      }

      return false;
    };

    const isSafeGlobalShortcutContext = () => {
      const activeElement = document.activeElement;

      return (
        !activeElement ||
        activeElement === document.body ||
        activeElement === document.documentElement
      );
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      const isDeleteKey = event.key === "Delete" || event.key === "Backspace";
      if (document.querySelector('.settings-modal[role="dialog"][aria-modal="true"]')) {
        if (isDeleteKey) {
          event.preventDefault();
        }
        return;
      }

      const activeElement = document.activeElement;
      const hasSelectedTextInActiveControl =
        activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement
          ? typeof activeElement.selectionStart === "number" &&
            typeof activeElement.selectionEnd === "number" &&
            activeElement.selectionStart !== activeElement.selectionEnd
          : false;

      if (
        isEditableEventTarget(event) ||
        hasSelectedTextInFormControl(event.target) ||
        hasSelectedTextInActiveControl
      ) {
        return;
      }

      if (!isSafeGlobalShortcutContext()) {
        if (isDeleteKey) {
          event.preventDefault();
        }
        return;
      }

      const activeTag = activeElement?.tagName;
      if (
        activeTag === "INPUT" ||
        activeTag === "TEXTAREA" ||
        (document.activeElement instanceof HTMLElement &&
          document.activeElement.isContentEditable)
      ) {
        return;
      }

      if (hasActiveTextSelection()) {
        return;
      }

      if (isDeleteKey) {
        event.preventDefault();
        return;
      }

      if (selectedVisibleRowKeys.length === 0) {
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
        if (selectedTrackingIds.length === 0) {
          return;
        }

        event.preventDefault();
        copySelectedTrackingIds();
      }

    };

    const handleCopy = (event: globalThis.ClipboardEvent) => {
      if (document.querySelector('.settings-modal[role="dialog"][aria-modal="true"]')) {
        return;
      }

      if (selectedVisibleRowKeys.length === 0) {
        return;
      }

      const activeElement = document.activeElement;
      const hasSelectedTextInActiveControl =
        activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement
          ? typeof activeElement.selectionStart === "number" &&
            typeof activeElement.selectionEnd === "number" &&
            activeElement.selectionStart !== activeElement.selectionEnd
          : false;

      if (
        isEditableEventTarget(event) ||
        hasSelectedTextInFormControl(event.target) ||
        hasSelectedTextInActiveControl
      ) {
        return;
      }

      if (!isSafeGlobalShortcutContext()) {
        return;
      }

      const activeTag = activeElement?.tagName;
      if (
        activeTag === "INPUT" ||
        activeTag === "TEXTAREA" ||
        (document.activeElement instanceof HTMLElement &&
          document.activeElement.isContentEditable)
      ) {
        return;
      }

      if (hasActiveTextSelection()) {
        return;
      }

      if (selectedTrackingIds.length === 0) {
        return;
      }

      event.preventDefault();
      event.clipboardData?.setData("text/plain", selectedTrackingIds.join("\n"));
    };

    window.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("copy", handleCopy);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("copy", handleCopy);
    };
  }, [
    copySelectedTrackingIds,
    selectedTrackingIds,
    selectedVisibleRowKeys.length,
  ]);

  return (
    <>
      {actionNotices.length > 0 ? (
        <div className="action-toast-stack" aria-live="polite">
          {actionNotices.map((notice) => (
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
          recentDocuments={recentDocumentItems}
          canUseAutosave={canUseAutosave}
          isAutosaveEnabled={isAutosaveActive}
          serviceConfig={effectiveServiceConfig}
          serviceStatus={apiServiceStatus}
          hasPendingServiceConfigChanges={hasPendingServiceConfigChanges}
          onToggleAutosave={() => {
            if (!canUseAutosave) {
              return;
            }
            setAutosaveEnabled((current) => !current);
          }}
          onCreateDocument={createNewWorkspaceDocument}
          onOpenDocument={() => {
            void openWorkspaceDocumentWithPicker();
          }}
          onSaveDocument={() => {
            void saveCurrentWorkspaceDocument();
          }}
          onSaveDocumentAs={() => {
            void saveWorkspaceDocumentAs();
          }}
          onCreateDocumentWindow={() => {
            void createNewWorkspaceWindow();
          }}
          onOpenDocumentInNewWindow={() => {
            void openWorkspaceInNewWindow();
          }}
          onOpenServiceSettings={() => {
            void openShipFlowServiceApp();
          }}
          onOpenRecentDocument={(path) => {
            void openWorkspaceDocumentFromPath(path);
          }}
          onActivateSheet={activateSheet}
          onCreateSheet={createSheet}
          onDuplicateSheet={duplicateSheet}
          onRenameSheet={renameActiveSheet}
          onDeleteSheet={deleteActiveSheet}
          onPreviewDisplayScale={previewDisplayScale}
          onPreviewServiceEnabled={previewServiceEnabled}
          onPreviewServiceMode={previewServiceMode}
          onPreviewServicePort={previewServicePort}
          onPreviewTrackingSource={previewTrackingSource}
          onPreviewExternalApiBaseUrl={previewExternalApiBaseUrl}
          onPreviewExternalApiAuthToken={previewExternalApiAuthToken}
          onPreviewAllowInsecureExternalApiHttp={previewAllowInsecureExternalApiHttp}
          onGenerateServiceToken={previewGenerateServiceToken}
          onRegenerateServiceToken={previewRegenerateServiceToken}
          onCopyServiceEndpoint={copyServiceEndpoint}
          onCopyServiceToken={copyServiceToken}
          onTestExternalTrackingSource={testExternalTrackingSource}
          onConfirmSettings={confirmSettings}
          onCancelSettings={cancelSettingsPreview}
          isSelectionDragActive={isSheetTransferDragActive}
          selectionDragSourceSheetId={isSheetTransferDragActive ? activeSheetId : null}
          onDropSelectionToSheet={dropSelectedIdsToExistingSheet}
          onDropSelectionToNewSheet={dropSelectedIdsToNewSheet}
        />
        <section className="sheet-panel">
          <SheetActionBar
            loadedCount={loadedCount}
            totalShipmentCount={totalShipmentCount}
            loadingCount={loadingCount}
            retrackableRowsCount={retrackableRows.length}
            retryFailedRowsCount={retryFailedEntries.length}
            deleteAllArmed={activeSheet.deleteAllArmed}
            exportableRowsCount={exportableRows.length}
            activeFilterCount={activeFilterCount}
            selectedRowCount={selectedVisibleRowKeys.length}
            deleteSelectedArmed={deleteSelectedArmedSheetId === activeSheetId}
            ignoredHiddenFilterCount={ignoredHiddenFilterCount}
            columnShortcuts={columnShortcuts}
            onRetrackAll={retrackAllRows}
            onRetryFailedRows={retryFailedRows}
            onExportCsv={exportCsv}
            onCopyAllIds={copyAllTrackingIds}
            onDeleteAllRows={deleteAllRows}
            onClearSelection={clearSelection}
            onTransferSelectedIdsToNewSheet={transferSelectedIdsToNewSheet}
            targetSheetOptions={appendTargetSheets}
            onTransferSelectedIdsToSheet={transferSelectedIdsToExistingSheet}
            onClearFilter={clearAllFilters}
            onCopySelectedIds={copySelectedTrackingIds}
            onDeleteSelectedRows={deleteSelectedRows}
            onClearHiddenFilters={clearHiddenFilters}
            onScrollToColumn={scrollToColumn}
            onStartSelectedIdsDrag={beginSelectedIdsDrag}
            onEndSelectedIdsDrag={endSelectedIdsDrag}
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
      {documentDialogMode ? (
        <div className="document-dialog-backdrop">
          <div
            className="document-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Dokumen"
          >
            <div className="document-dialog-header">
              <h3>{documentDialogMode === "open" ? "Buka Dokumen" : "Simpan Dokumen"}</h3>
              <p>
                {documentDialogMode === "open"
                  ? "Masukkan lokasi file yang ingin dibuka."
                  : "Masukkan lokasi file tujuan untuk dokumen ini."}
              </p>
            </div>
            <label className="settings-text-field">
              <span className="settings-input-label">Lokasi File</span>
              <input
                type="text"
                aria-label="Lokasi File"
                value={documentPathDraft}
                placeholder="~/Documents/dokumen.shipflow"
                onChange={(event) => setDocumentPathDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void submitDocumentDialog();
                  }
                }}
                autoFocus
              />
            </label>
            <div className="document-dialog-actions">
              <button type="button" className="sheet-tab-action" onClick={closeDocumentDialog}>
                Batal
              </button>
              <button
                type="button"
                className="sheet-tab-action"
                onClick={() => {
                  void submitDocumentDialog();
                }}
                disabled={!documentPathDraft.trim()}
              >
                {documentDialogMode === "open" ? "Buka" : "Simpan"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {pendingWindowCloseRequest ? (
        <div className="document-dialog-backdrop">
          <div
            className="document-dialog document-close-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Tutup Dokumen"
          >
            <div className="document-dialog-header">
              <h3>Tutup Dokumen?</h3>
              <p>
                Perubahan pada <strong>{pendingWindowCloseRequest.documentName}</strong> belum
                disimpan. Jika keluar sekarang, perubahan ini tidak akan tersimpan.
              </p>
            </div>
            <div className="document-dialog-actions">
              <button
                type="button"
                className="sheet-tab-action"
                onClick={cancelPendingWindowClose}
                disabled={isResolvingWindowClose}
              >
                Batal
              </button>
              <button
                type="button"
                className="sheet-tab-action"
                onClick={discardPendingWindowClose}
                disabled={isResolvingWindowClose}
              >
                Jangan Simpan
              </button>
              <button
                type="button"
                className="sheet-tab-action"
                onClick={saveAndCloseWindow}
                disabled={isResolvingWindowClose || documentMeta.persistenceStatus === "saving"}
              >
                Simpan & Tutup
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function ServiceSettingsApp() {
  const [serviceConfig, setServiceConfig] = useState<ServiceConfig>(DEFAULT_SERVICE_CONFIG);
  const [serviceConfigPreview, setServiceConfigPreview] = useState<ServiceConfig | null>(null);
  const [hasLoadedServiceConfig, setHasLoadedServiceConfig] = useState(false);
  const [apiServiceStatus, setApiServiceStatus] = useState<ApiServiceStatus>(
    DEFAULT_API_SERVICE_STATUS
  );
  const [actionNotices, setActionNotices] = useState<ActionNotice[]>([]);
  const serviceConfigRef = useRef(serviceConfig);
  const actionNoticeTimeoutsRef = useRef(new Map<string, number>());
  const effectiveServiceConfig = serviceConfigPreview ?? serviceConfig;
  const hasPendingServiceConfigChanges = serviceConfigPreview !== null;

  useEffect(() => {
    return () => {
      actionNoticeTimeoutsRef.current.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      actionNoticeTimeoutsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    serviceConfigRef.current = serviceConfig;
  }, [serviceConfig]);

  const showActionNotice = useCallback((notice: ActionNotice) => {
    const noticeId = notice.id || createRequestId();

    setActionNotices((current) => [...current, { ...notice, id: noticeId }].slice(-5));

    const timeoutId = window.setTimeout(() => {
      setActionNotices((current) =>
        current.filter((currentNotice) => currentNotice.id !== noticeId)
      );
      actionNoticeTimeoutsRef.current.delete(noticeId);
    }, 2200);

    actionNoticeTimeoutsRef.current.set(noticeId, timeoutId);
  }, []);

  const syncServiceConfigFromBackend = useCallback(
    async (options?: { preservePreview?: boolean }) => {
      const preservePreview = options?.preservePreview ?? true;

      try {
        const savedConfig = await invoke<ServiceConfig | null>("load_saved_api_service_config");
        const nextConfig = savedConfig
          ? {
              ...savedConfig,
              keepRunningInTray: true,
            }
          : DEFAULT_SERVICE_CONFIG;

        if (!preservePreview || serviceConfigPreview === null) {
          if (!areServiceConfigsEqual(serviceConfigRef.current, nextConfig)) {
            serviceConfigRef.current = nextConfig;
            setServiceConfig(nextConfig);
          }
        }

        return nextConfig;
      } catch {
        if (!preservePreview || serviceConfigPreview === null) {
          if (!areServiceConfigsEqual(serviceConfigRef.current, DEFAULT_SERVICE_CONFIG)) {
            serviceConfigRef.current = DEFAULT_SERVICE_CONFIG;
            setServiceConfig(DEFAULT_SERVICE_CONFIG);
          }
        }

        return DEFAULT_SERVICE_CONFIG;
      }
    },
    [serviceConfigPreview]
  );

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
            : "Gagal membaca status akses API eksternal.",
      });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    void syncServiceConfigFromBackend({ preservePreview: false }).finally(() => {
      if (!cancelled) {
        setHasLoadedServiceConfig(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [syncServiceConfigFromBackend]);

  useEffect(() => {
    if (!hasLoadedServiceConfig) {
      return;
    }

    void refreshApiServiceStatus();
  }, [hasLoadedServiceConfig, refreshApiServiceStatus]);

  useEffect(() => {
    if (!hasLoadedServiceConfig) {
      return;
    }

    const syncFromService = () => {
      void syncServiceConfigFromBackend();
      void refreshApiServiceStatus();
    };

    const intervalId = window.setInterval(syncFromService, 5000);
    window.addEventListener("focus", syncFromService);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", syncFromService);
    };
  }, [hasLoadedServiceConfig, refreshApiServiceStatus, syncServiceConfigFromBackend]);

  const previewServiceConfig = useCallback((updater: (config: ServiceConfig) => ServiceConfig) => {
    setServiceConfigPreview((current) => {
      const base = current ?? serviceConfigRef.current;
      return updater(base);
    });
  }, []);

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

  const previewTrackingSource = useCallback(
    (trackingSource: TrackingSource) => {
      previewServiceConfig((current) => ({
        ...current,
        trackingSource,
      }));
    },
    [previewServiceConfig]
  );

  const previewExternalApiBaseUrl = useCallback(
    (externalApiBaseUrl: string) => {
      previewServiceConfig((current) => ({
        ...current,
        externalApiBaseUrl,
      }));
    },
    [previewServiceConfig]
  );

  const previewExternalApiAuthToken = useCallback(
    (externalApiAuthToken: string) => {
      previewServiceConfig((current) => ({
        ...current,
        externalApiAuthToken,
      }));
    },
    [previewServiceConfig]
  );

  const previewAllowInsecureExternalApiHttp = useCallback(
    (allowInsecureExternalApiHttp: boolean) => {
      previewServiceConfig((current) => ({
        ...current,
        allowInsecureExternalApiHttp,
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

  const cancelSettingsPreview = useCallback(() => {
    setServiceConfigPreview(null);
  }, []);

  const applyServiceConfig = useCallback(
    async (nextConfig: ServiceConfig) => {
      try {
        const status = await invoke<ApiServiceStatus>("configure_api_service", {
          config: nextConfig,
        });
        serviceConfigRef.current = nextConfig;
        setServiceConfig(nextConfig);
        setApiServiceStatus(status);
        return true;
      } catch (error) {
        setApiServiceStatus({
          status: "error",
          enabled: nextConfig.enabled,
          mode: nextConfig.mode,
          bindAddress: nextConfig.mode === "lan" ? "0.0.0.0" : "127.0.0.1",
          port: nextConfig.port,
          errorMessage:
            error instanceof Error ? error.message : "Gagal mengonfigurasi akses API eksternal.",
        });
        showActionNotice({
          tone: "error",
          message:
            error instanceof Error ? error.message : "Gagal mengonfigurasi akses API eksternal.",
        });
        return false;
      }
    },
    [showActionNotice]
  );

  const confirmSettings = useCallback(async () => {
    const nextServiceConfig = serviceConfigPreview
      ? {
          ...serviceConfigPreview,
          keepRunningInTray: true,
          lastUpdatedAt: new Date().toISOString(),
        }
      : null;

    if (nextServiceConfig) {
      try {
        await invoke("validate_tracking_source_config", { config: nextServiceConfig });
      } catch (error) {
        showActionNotice({
          tone: "error",
          message:
            error instanceof Error
              ? error.message
              : "Konfigurasi sumber tracking tidak valid.",
        });
        return false;
      }
    }

    if (nextServiceConfig) {
      const didApply = await applyServiceConfig(nextServiceConfig);
      if (!didApply) {
        return false;
      }
    }

    setServiceConfigPreview(null);
    return true;
  }, [applyServiceConfig, serviceConfigPreview, showActionNotice]);

  const copyServiceEndpoint = useCallback(
    (endpoint: string) => {
      if (!endpoint.trim()) {
        return;
      }

      void writeClipboardText(endpoint)
        .then(() =>
          showActionNotice({
            tone: "success",
            message: "Endpoint API berhasil disalin.",
          })
        )
        .catch(() =>
          showActionNotice({
            tone: "error",
            message: "Gagal menyalin endpoint API.",
          })
        );
    },
    [showActionNotice]
  );

  const copyServiceToken = useCallback(
    (token: string) => {
      if (!token.trim()) {
        return;
      }

      void writeClipboardText(token)
        .then(() =>
          showActionNotice({
            tone: "success",
            message: "Token API berhasil disalin.",
          })
        )
        .catch(() =>
          showActionNotice({
            tone: "error",
            message: "Gagal menyalin token API.",
          })
        );
    },
    [showActionNotice]
  );

  const testExternalTrackingSource = useCallback(async (config: ServiceConfig) => {
    return invoke<string>("test_external_tracking_source", { config });
  }, []);

  if (!hasLoadedServiceConfig) {
    return <main className="shell service-settings-shell display-scale-small" />;
  }

  return (
    <>
      {actionNotices.length > 0 ? (
        <div className="action-toast-stack" aria-live="polite">
          {actionNotices.map((notice) => (
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
      <ServiceSettingsWindow
        serviceConfig={effectiveServiceConfig}
        hasPendingServiceConfigChanges={hasPendingServiceConfigChanges}
        onPreviewServiceEnabled={previewServiceEnabled}
        onPreviewServiceMode={previewServiceMode}
        onPreviewServicePort={previewServicePort}
        onPreviewTrackingSource={previewTrackingSource}
        onPreviewExternalApiBaseUrl={previewExternalApiBaseUrl}
        onPreviewExternalApiAuthToken={previewExternalApiAuthToken}
        onPreviewAllowInsecureExternalApiHttp={previewAllowInsecureExternalApiHttp}
        onGenerateServiceToken={previewGenerateServiceToken}
        onRegenerateServiceToken={previewRegenerateServiceToken}
        onCopyServiceEndpoint={copyServiceEndpoint}
        onCopyServiceToken={copyServiceToken}
        onTestExternalTrackingSource={testExternalTrackingSource}
        onConfirmSettings={confirmSettings}
        onCancelSettings={cancelSettingsPreview}
      />
    </>
  );
}

function App() {
  if (resolveShipFlowWindowKind() === "service-settings") {
    return <ServiceSettingsApp />;
  }

  return <WorkspaceApp />;
}

export default App;
