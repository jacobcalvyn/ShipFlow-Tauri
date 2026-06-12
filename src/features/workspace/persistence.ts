import { COLUMNS } from "../sheet/columns";
import {
  getDefaultSheetAnalyticsMetricAggregation,
  getSheetAnalyticsGroupByOptions,
  getSheetAnalyticsMetricOptions,
  isValidSheetAnalyticsMetricAggregation,
} from "../sheet/analytics";
import {
  createDefaultSheetAnalyticsState,
  createDefaultSheetState,
} from "../sheet/default-state";
import type {
  SheetAnalyticsMetric,
  SheetAnalyticsMetricAggregation,
} from "../sheet/types";
import { assertValidSheetState, createEmptyRow, ensureTrailingEmptyRows, isBrowserReady } from "../sheet/utils";
import { TrackResponse } from "../../types";
import {
  DEFAULT_WORKSPACE_SHEET_ID,
  createDefaultWorkspaceState,
} from "./default-state";
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
              jobId: null,
              requestKey: null,
              sourceItemStates: [],
              manifestBagStates: [],
            },
            manifest: {
              loading: false,
              rawResponse: "",
              error: "",
              trackingIds: [],
              jobId: null,
              requestKey: null,
              sourceItemStates: [],
              manifestBagStates: [],
            },
          },
          rows: sheetState.rows.map((row) => ({
            ...row,
            loading: false,
            queued: false,
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

function normalizeStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function dedupeStrings(values: string[]) {
  const nextValues: string[] = [];
  for (const value of values) {
    if (!nextValues.includes(value)) {
      nextValues.push(value);
    }
  }
  return nextValues;
}

function normalizePersistedSheetAnalyticsState(candidate: unknown) {
  const fallback = createDefaultSheetAnalyticsState();
  if (!candidate || typeof candidate !== "object") {
    return fallback;
  }

  const record = candidate as Record<string, unknown>;
  const sourceScope =
    record.sourceScope === "all_rows" ||
    record.sourceScope === "filtered_rows" ||
    record.sourceScope === "selected_rows"
      ? record.sourceScope
      : fallback.sourceScope;
  const chartType =
    record.chartType === "bar" ||
    record.chartType === "donut" ||
    record.chartType === "pivot"
      ? record.chartType
      : fallback.chartType;
  const validPathSet = new Set(getSheetAnalyticsGroupByOptions().map((option) => option.path));
  const normalizePathList = (value: unknown) =>
    dedupeStrings(normalizeStringArray(value).filter((path) => validPathSet.has(path)));
  const rawRowPaths = normalizeStringArray(record.rowPaths);
  const persistedRowPaths = normalizePathList(record.rowPaths);
  const rawGroupByPaths = normalizeStringArray(record.groupByPaths);
  const persistedGroupByPaths = normalizePathList(record.groupByPaths);
  const legacyGroupByPath =
    typeof record.groupByPath === "string" && validPathSet.has(record.groupByPath)
      ? record.groupByPath
      : null;
  const rowPaths: string[] =
    Array.isArray(record.rowPaths) &&
    (rawRowPaths.length === 0 || persistedRowPaths.length > 0)
      ? persistedRowPaths
      : Array.isArray(record.groupByPaths) &&
          (rawGroupByPaths.length === 0 || persistedGroupByPaths.length > 0)
        ? persistedGroupByPaths
        : legacyGroupByPath
          ? [legacyGroupByPath]
          : fallback.rowPaths;
  const rawColumnPaths = normalizeStringArray(record.columnPaths);
  const persistedColumnPaths = normalizePathList(record.columnPaths);
  const validMetricSet = new Set(getSheetAnalyticsMetricOptions().map((option) => option.key));
  const normalizeMetricKey = (metric: string) =>
    metric === "cod_total" ? "detail.billing_detail.cod_info.total_cod" : metric;
  const rawValueMetrics = normalizeStringArray(record.valueMetrics).map(normalizeMetricKey);
  const persistedValueMetrics = dedupeStrings(rawValueMetrics).filter((metric) =>
    validMetricSet.has(metric)
  );
  const rawMetrics = normalizeStringArray(record.metrics).map(normalizeMetricKey);
  const persistedMetrics = dedupeStrings(rawMetrics).filter((metric) =>
    validMetricSet.has(metric)
  );
  const rawMetricAggregations =
    record.metricAggregations && typeof record.metricAggregations === "object"
      ? (record.metricAggregations as Record<string, unknown>)
      : {};
  const metricOptionMap = new Map(
    getSheetAnalyticsMetricOptions().map((option) => [option.key, option])
  );
  const legacyPivotColumnPaths =
    chartType === "pivot" && !Array.isArray(record.valueMetrics)
      ? persistedMetrics.filter((metric) => {
          const metricOption = metricOptionMap.get(metric);
          const selectedAggregation =
            rawMetricAggregations[metric] ??
            (metric === "detail.billing_detail.cod_info.total_cod"
              ? rawMetricAggregations.cod_total
              : undefined);
          const aggregation =
            metricOption &&
            isValidSheetAnalyticsMetricAggregation(metricOption, selectedAggregation)
              ? selectedAggregation
              : metricOption
                ? getDefaultSheetAnalyticsMetricAggregation(metricOption)
                : null;
          return (
            !!metricOption?.path &&
            metricOption.format === "text" &&
            aggregation === "unique_list"
          );
        })
      : [];
  const columnPaths: string[] =
    Array.isArray(record.columnPaths) &&
    (rawColumnPaths.length === 0 || persistedColumnPaths.length > 0)
      ? persistedColumnPaths
      : legacyPivotColumnPaths.filter((path) => validPathSet.has(path));
  const legacyMetric: SheetAnalyticsMetric | null =
    record.metric === "cod_total"
      ? "detail.billing_detail.cod_info.total_cod"
      : typeof record.metric === "string" && validMetricSet.has(record.metric)
        ? record.metric
        : null;
  const legacyValueMetrics = persistedMetrics.filter(
    (metric) => !legacyPivotColumnPaths.includes(metric)
  );
  const valueMetrics: SheetAnalyticsMetric[] =
    Array.isArray(record.valueMetrics) &&
    (rawValueMetrics.length === 0 || persistedValueMetrics.length > 0)
      ? persistedValueMetrics
      : Array.isArray(record.metrics) &&
          (rawMetrics.length === 0 || legacyValueMetrics.length > 0)
        ? legacyValueMetrics
        : legacyMetric
          ? [legacyMetric]
          : fallback.valueMetrics;
  const metricAggregations: Partial<
    Record<SheetAnalyticsMetric, SheetAnalyticsMetricAggregation>
  > = {};
  for (const metric of valueMetrics) {
    const metricOption = metricOptionMap.get(metric);
    if (!metricOption) {
      continue;
    }

    const selectedAggregation =
      rawMetricAggregations[metric] ??
      (metric === "detail.billing_detail.cod_info.total_cod"
        ? rawMetricAggregations.cod_total
        : undefined);
    metricAggregations[metric] = isValidSheetAnalyticsMetricAggregation(
      metricOption,
      selectedAggregation
    )
      ? selectedAggregation
      : getDefaultSheetAnalyticsMetricAggregation(metricOption);
  }

  return {
    sourceScope,
    rowPaths,
    columnPaths,
    valueMetrics,
    metricAggregations,
    chartType,
  };
}

export function normalizePersistedWorkspaceState(
  workspace: Partial<WorkspaceState> | null | undefined,
  options?: {
    migratePrimarySheetToDefault?: boolean;
  }
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

  const normalizedSheetOrder = dedupeStrings(
    parsedSheetOrder.filter((sheetId) => sheetId in parsedMeta && sheetId in parsedSheets)
  );

  if (normalizedSheetOrder.length === 0) {
    return fallback;
  }
  const shouldMigratePrimarySheetToDefault =
    options?.migratePrimarySheetToDefault ?? true;
  const hasDefaultSheetId = normalizedSheetOrder.includes(DEFAULT_WORKSPACE_SHEET_ID);
  const sheetIdMappings = normalizedSheetOrder.map((sourceSheetId, index) => ({
    sourceSheetId,
    sheetId:
      shouldMigratePrimarySheetToDefault && index === 0 && !hasDefaultSheetId
        ? DEFAULT_WORKSPACE_SHEET_ID
        : sourceSheetId,
  }));
  const canonicalSheetOrder = sheetIdMappings.map(({ sheetId }) => sheetId);
  const canonicalSheetIdBySourceSheetId = new Map(
    sheetIdMappings.map(({ sourceSheetId, sheetId }) => [sourceSheetId, sheetId])
  );

  const sheetsById = Object.fromEntries(
    sheetIdMappings.map(({ sourceSheetId, sheetId }) => {
      const baseSheet = createDefaultSheetState();
      const candidate =
        parsedSheets[sourceSheetId] && typeof parsedSheets[sourceSheetId] === "object"
          ? parsedSheets[sourceSheetId]
          : null;
      const parsedRows = Array.isArray((candidate as { rows?: unknown[] } | null)?.rows)
        ? ((candidate as { rows: unknown[] }).rows as unknown[])
        : [];
      const usedRowKeys = new Set<string>();
      const getUniqueRowKey = (preferredKey: string, fallbackKey: string) => {
        let nextKey = preferredKey && !usedRowKeys.has(preferredKey)
          ? preferredKey
          : fallbackKey;

        while (usedRowKeys.has(nextKey)) {
          nextKey = createEmptyRow().key;
        }

        usedRowKeys.add(nextKey);
        return nextKey;
      };
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
              const uniqueRowKey = getUniqueRowKey(rowKey, baseRow.key);

              if (trackingInput.trim() === "") {
                return {
                  ...baseRow,
                  key: uniqueRowKey,
                };
              }

              return {
                key: uniqueRowKey,
                trackingInput,
                shipment,
                loading: false,
                queued: false,
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
        activeMode:
          candidate &&
          typeof candidate === "object" &&
          (candidate as { activeMode?: unknown }).activeMode === "analytics"
            ? "analytics" as const
            : "workspace" as const,
        analytics: normalizePersistedSheetAnalyticsState(
          candidate && typeof candidate === "object"
            ? (candidate as { analytics?: unknown }).analytics
            : null
        ),
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
            ? dedupeStrings(
                (candidate as { selectedRowKeys: unknown[] }).selectedRowKeys.filter(
                  (rowKey): rowKey is string =>
                    typeof rowKey === "string" && rowKeySet.has(rowKey)
                )
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
            jobId: null,
            requestKey: null,
            sourceItemStates: [],
            manifestBagStates: [],
          },
          manifest: {
            loading: false,
            rawResponse: "",
            error: "",
            trackingIds: [],
            jobId: null,
            requestKey: null,
            sourceItemStates: [],
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
    sheetIdMappings.map(({ sourceSheetId, sheetId }, index) => [
      sheetId,
      {
        name:
          parsedMeta[sourceSheetId] &&
          typeof parsedMeta[sourceSheetId] === "object" &&
          typeof (parsedMeta[sourceSheetId] as { name?: unknown }).name === "string" &&
          (parsedMeta[sourceSheetId] as { name: string }).name.trim()
            ? (parsedMeta[sourceSheetId] as { name: string }).name
            : `Sheet ${index + 1}`,
        color:
          parsedMeta[sourceSheetId] &&
          typeof parsedMeta[sourceSheetId] === "object" &&
          isWorkspaceSheetColor((parsedMeta[sourceSheetId] as { color?: unknown }).color)
            ? (parsedMeta[sourceSheetId] as { color: WorkspaceSheetColor }).color
            : "slate",
        icon:
          parsedMeta[sourceSheetId] &&
          typeof parsedMeta[sourceSheetId] === "object" &&
          isWorkspaceSheetIcon((parsedMeta[sourceSheetId] as { icon?: unknown }).icon)
            ? (parsedMeta[sourceSheetId] as { icon: WorkspaceSheetIcon }).icon
            : "sheet",
      },
    ])
  ) as WorkspaceState["sheetMetaById"];

  const activeSheetId =
    typeof workspace.activeSheetId === "string" &&
    canonicalSheetIdBySourceSheetId.has(workspace.activeSheetId)
      ? canonicalSheetIdBySourceSheetId.get(workspace.activeSheetId)!
      : canonicalSheetOrder[0];

  return {
    version: 1,
    activeSheetId,
    sheetOrder: canonicalSheetOrder,
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

  try {
    const serialized = JSON.stringify(
      createStorageSafeWorkspaceState(workspaceState, "inputs_only")
    );
    window.localStorage.setItem(scopedWorkspaceKey, serialized);
  } catch (error) {
    console.error("[ShipFlowWorkspace] failed to persist workspace snapshot.", error);
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
