import { COLUMNS } from "../sheet/columns";
import { createDefaultSheetState } from "../sheet/default-state";
import { assertValidSheetState, createEmptyRow, ensureTrailingEmptyRows, isBrowserReady } from "../sheet/utils";
import { TrackResponse } from "../../types";
import { createDefaultWorkspaceState } from "./default-state";
import {
  createDefaultWorkspaceDocumentMeta,
  normalizePersistedWorkspaceDocumentMeta,
  WorkspaceDocumentMeta,
} from "./document";
import { WorkspaceSheetColor, WorkspaceSheetIcon, WorkspaceState } from "./types";

const WORKSPACE_STATE_STORAGE_KEY = "shipflow-workspace-state";
const WORKSPACE_DOCUMENT_META_STORAGE_KEY = "shipflow-workspace-document-meta";
const RECENT_WORKSPACE_DOCUMENTS_STORAGE_KEY = "shipflow-recent-workspaces";
const DOCUMENT_AUTOSAVE_ENABLED_STORAGE_KEY = "shipflow-document-autosave-enabled";

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

export function createStorageSafeWorkspaceState(
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
          importSourceModalKind: null,
          importSourceDrafts: {
            bag: "",
            manifest: "",
          },
          importSourceLookupStates: {
            bag: {
              loading: false,
              rawResponse: "",
              error: "",
              trackingIds: [],
              requestKey: null,
              manifestBagStates: [],
            },
            manifest: {
              loading: false,
              rawResponse: "",
              error: "",
              trackingIds: [],
              requestKey: null,
              manifestBagStates: [],
            },
          },
          rows: sheetState.rows.map((row) => ({
            ...row,
            loading: false,
            shipment:
              mode === "full" && row.shipment ? createStorageSafeTrackResponse(row.shipment) : null,
            stale: mode === "full" ? row.stale : false,
            dirty: mode === "full" ? row.dirty : false,
          })),
        },
      ])
    ),
  };
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

function shouldAssertSheetState() {
  return import.meta.env.DEV || import.meta.env.MODE === "test";
}

export function normalizePersistedWorkspaceState(
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
    workspace.sheetsById && typeof workspace.sheetsById === "object" ? workspace.sheetsById : {};

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
          ? parsedSheets[sheetId]
          : null;
      const parsedRows = Array.isArray((candidate as { rows?: unknown[] } | null)?.rows)
        ? ((candidate as { rows: unknown[] }).rows as unknown[])
        : [];
      const normalizedRows = ensureTrailingEmptyRows(
        parsedRows.length > 0
          ? parsedRows.map((row) => {
              const baseRow = createEmptyRow();
              if (!row || typeof row !== "object") {
                return baseRow;
              }

              const candidateRow = row as Partial<(typeof baseSheet.rows)[number]>;
              const trackingInput =
                typeof candidateRow.trackingInput === "string" ? candidateRow.trackingInput : "";
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

      const nextSheet = {
        ...baseSheet,
        rows: normalizedRows,
        filters:
          candidate && typeof candidate === "object" && "filters" in candidate
            ? Object.fromEntries(
                Object.entries((candidate as { filters?: Record<string, unknown> }).filters ?? {}).filter(
                  (entry): entry is [string, string] => typeof entry[1] === "string"
                )
              )
            : baseSheet.filters,
        valueFilters:
          candidate && typeof candidate === "object" && "valueFilters" in candidate
            ? Object.fromEntries(
                Object.entries(
                  (candidate as { valueFilters?: Record<string, unknown> }).valueFilters ?? {}
                ).map(([path, values]) => [
                  path,
                  Array.isArray(values)
                    ? values.filter((value): value is string => typeof value === "string")
                    : [],
                ])
              )
            : baseSheet.valueFilters,
        sortState:
          candidate &&
          typeof candidate === "object" &&
          typeof (candidate as { sortState?: unknown }).sortState === "object" &&
          (candidate as { sortState?: { path?: unknown; direction?: unknown } }).sortState &&
          (((candidate as { sortState?: { path?: unknown } }).sortState?.path ?? null) === null ||
            typeof (candidate as { sortState?: { path?: unknown } }).sortState?.path === "string") &&
          ((candidate as { sortState?: { direction?: unknown } }).sortState?.direction === "asc" ||
            (candidate as { sortState?: { direction?: unknown } }).sortState?.direction === "desc")
            ? (candidate as { sortState: typeof baseSheet.sortState }).sortState
            : baseSheet.sortState,
        selectedRowKeys:
          candidate && typeof candidate === "object" && Array.isArray((candidate as { selectedRowKeys?: unknown[] }).selectedRowKeys)
            ? (candidate as { selectedRowKeys: unknown[] }).selectedRowKeys.filter(
                (rowKey): rowKey is string => typeof rowKey === "string" && rowKeySet.has(rowKey)
              )
            : baseSheet.selectedRowKeys,
        selectionFollowsVisibleRows: Boolean(
          candidate &&
            typeof candidate === "object" &&
            (candidate as { selectionFollowsVisibleRows?: unknown }).selectionFollowsVisibleRows
        ),
        columnWidths:
          candidate && typeof candidate === "object" && typeof (candidate as { columnWidths?: unknown }).columnWidths === "object"
            ? {
                ...baseSheet.columnWidths,
                ...Object.fromEntries(
                  Object.entries((candidate as { columnWidths?: Record<string, unknown> }).columnWidths ?? {}).filter(
                    (entry): entry is [string, number] =>
                      typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] > 0
                  )
                ),
              }
            : baseSheet.columnWidths,
        hiddenColumnPaths:
          candidate && typeof candidate === "object" && Array.isArray((candidate as { hiddenColumnPaths?: unknown[] }).hiddenColumnPaths)
            ? (candidate as { hiddenColumnPaths: unknown[] }).hiddenColumnPaths.filter(
                (path): path is string =>
                  typeof path === "string" && COLUMNS.some((column) => column.path === path)
              )
            : baseSheet.hiddenColumnPaths,
        pinnedColumnPaths:
          candidate && typeof candidate === "object" && Array.isArray((candidate as { pinnedColumnPaths?: unknown[] }).pinnedColumnPaths)
            ? (candidate as { pinnedColumnPaths: unknown[] }).pinnedColumnPaths.filter(
                (path): path is string =>
                  typeof path === "string" && COLUMNS.some((column) => column.path === path)
              )
            : baseSheet.pinnedColumnPaths,
        openColumnMenuPath: null,
        highlightedColumnPath: null,
        deleteAllArmed: false,
        importSourceModalKind: null,
        importSourceDrafts: {
          bag: "",
          manifest: "",
        },
        importSourceLookupStates: {
          bag: {
            loading: false,
            rawResponse: "",
            error: "",
            trackingIds: [],
            requestKey: null,
            manifestBagStates: [],
          },
          manifest: {
            loading: false,
            rawResponse: "",
            error: "",
            trackingIds: [],
            requestKey: null,
            manifestBagStates: [],
          },
        },
      };

      return [
        sheetId,
        shouldAssertSheetState() ? assertValidSheetState(nextSheet) : nextSheet,
      ];
    })
  ) as WorkspaceState["sheetsById"];

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
  ) as WorkspaceState["sheetMetaById"];

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

function getScopedStorageKey(baseKey: string, windowLabel: string | null) {
  if (!windowLabel || windowLabel === "main") {
    return baseKey;
  }

  return `${baseKey}:${windowLabel}`;
}

export function loadWorkspaceState(windowLabel: string | null = null): WorkspaceState {
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

export function loadWorkspaceDocumentMeta(windowLabel: string | null = null): WorkspaceDocumentMeta {
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

export function persistWorkspaceDocumentMeta(
  documentMeta: WorkspaceDocumentMeta,
  windowLabel: string | null
) {
  if (!isBrowserReady() || windowLabel === null) {
    return;
  }

  const scopedMetaKey = getScopedStorageKey(WORKSPACE_DOCUMENT_META_STORAGE_KEY, windowLabel);
  if (!documentMeta.path) {
    window.localStorage.removeItem(scopedMetaKey);
    return;
  }

  window.localStorage.setItem(
    scopedMetaKey,
    JSON.stringify({
      path: documentMeta.path,
      lastSavedAt: documentMeta.lastSavedAt,
    })
  );
}

export function loadRecentWorkspaceDocuments() {
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

export function persistRecentWorkspaceDocuments(paths: string[]) {
  if (!isBrowserReady()) {
    return;
  }

  window.localStorage.setItem(RECENT_WORKSPACE_DOCUMENTS_STORAGE_KEY, JSON.stringify(paths));
}

export function loadDocumentAutosaveEnabled() {
  if (!isBrowserReady()) {
    return true;
  }

  return window.localStorage.getItem(DOCUMENT_AUTOSAVE_ENABLED_STORAGE_KEY) !== "false";
}

export function persistDocumentAutosaveEnabled(enabled: boolean) {
  if (!isBrowserReady()) {
    return;
  }

  window.localStorage.setItem(DOCUMENT_AUTOSAVE_ENABLED_STORAGE_KEY, enabled ? "true" : "false");
}

export function persistWorkspaceStateSnapshot(params: {
  workspaceState: WorkspaceState;
  documentMeta: Pick<WorkspaceDocumentMeta, "path" | "isDirty">;
  windowLabel: string | null;
}) {
  const { workspaceState, documentMeta, windowLabel } = params;

  if (!isBrowserReady() || windowLabel === null) {
    return;
  }

  const scopedWorkspaceKey = getScopedStorageKey(WORKSPACE_STATE_STORAGE_KEY, windowLabel);

  if (!documentMeta.path) {
    window.localStorage.removeItem(scopedWorkspaceKey);
    return;
  }

  if (documentMeta.isDirty) {
    return;
  }

  const persistWorkspace = (mode: "full" | "inputs_only") => {
    const serialized = JSON.stringify(createStorageSafeWorkspaceState(workspaceState, mode));
    window.localStorage.setItem(scopedWorkspaceKey, serialized);
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
      console.error("[ShipFlowWorkspace] failed to persist workspace snapshot.", fallbackError);
    }
  }
}

export function serializeWorkspaceStateForDocument(workspaceState: WorkspaceState) {
  return JSON.stringify(createStorageSafeWorkspaceState(workspaceState, "full"));
}

export function buildWorkspaceWindowTitle(documentMeta: WorkspaceDocumentMeta) {
  const dirtyPrefix = documentMeta.isDirty ? "* " : "";
  return `${dirtyPrefix}${documentMeta.name} - ShipFlow Desktop`;
}

export function pushRecentWorkspaceDocument(currentPaths: string[], nextPath: string) {
  return [nextPath, ...currentPaths.filter((path) => path !== nextPath)].slice(0, 8);
}
