import {
  Dispatch,
  MutableRefObject,
  SetStateAction,
  useCallback,
} from "react";
import { flushSync } from "react-dom";
import {
  clearTrackingRunInSheet,
  clearSheetDataPreservingImportStateInSheet,
  closeImportSourceModalInSheet,
  openImportSourceModalInSheet,
  setImportSourceJobInSheet,
  setImportSourceLookupErrorInSheet,
  setImportSourceLookupProgressInSheet,
  setImportSourceLookupSuccessInSheet,
  setImportSourceDraftInSheet,
  startImportSourceLookupInSheet,
  startImportSourceRetryInSheet,
  startTrackingRunInSheet,
} from "../sheet/actions";
import {
  ImportSourceItemLookupState,
  ImportSourceModalKind,
  ImportSourceRetryTargets,
  ManifestBagLookupState,
  SheetState,
} from "../sheet/types";
import { COLUMNS } from "../sheet/columns";
import type {
  SheetTableRow,
  SheetTableRowTrackingEntry,
} from "../sheet/table-row-view";
import { useWorkspaceRuntimeCommandsController } from "./useWorkspaceRuntimeCommandsController";
import { useWorkspaceTableControllers } from "./useWorkspaceTableControllers";
import { WorkspaceState } from "./types";
import {
  clearSheetRows,
  createImportJob,
  getImportJob,
  type ImportJobDetail,
  type ImportJobItem,
  type ImportJobProgressEvent,
  ImportSourcePreviewItem,
  ImportSourcePreviewResult,
  previewImportSource,
  querySheetRows,
  type SheetRowsQuery,
  refreshSheetRowsTrackingWithProgress,
  retryImportJobFailedWithProgress,
  runImportJobWithProgress,
  upsertSheetRows,
  WorkspaceEngineEvent,
} from "../workspace-engine/client";
import {
  applyTrackingRefreshProgressToSheet,
  applyTrackingRefreshRowsToSheet,
} from "./tracking-refresh-state";

type Notice = {
  tone: "success" | "error" | "info";
  message: string;
};

function getRuntimeErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }

  if (typeof error === "string" && error.trim() !== "") {
    return error;
  }

  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim() !== ""
  ) {
    return error.message;
  }

  return "Lookup failed.";
}

function parseImportSourceLookupIds(value: string) {
  const seen = new Set<string>();
  const lookupIds: string[] = [];

  value
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .forEach((lookupId) => {
      if (seen.has(lookupId)) {
        return;
      }

      seen.add(lookupId);
      lookupIds.push(lookupId);
    });

  return lookupIds;
}

function mergeSourceItemStates(
  currentStates: ImportSourceItemLookupState[] | undefined,
  nextStates: ImportSourceItemLookupState[]
) {
  const nextById = new Map(nextStates.map((state) => [state.itemId, state]));
  const merged = (currentStates ?? []).map((state) =>
    nextById.get(state.itemId) ?? state
  );
  const currentIds = new Set((currentStates ?? []).map((state) => state.itemId));

  nextStates.forEach((state) => {
    if (!currentIds.has(state.itemId)) {
      merged.push(state);
    }
  });

  return merged;
}

function mergeManifestBagStates(
  currentStates: ManifestBagLookupState[] | undefined,
  nextStates: ManifestBagLookupState[]
) {
  const nextById = new Map(nextStates.map((state) => [state.bagId, state]));
  const merged = (currentStates ?? []).map((state) =>
    nextById.get(state.bagId) ?? state
  );
  const currentIds = new Set((currentStates ?? []).map((state) => state.bagId));

  nextStates.forEach((state) => {
    if (!currentIds.has(state.bagId)) {
      merged.push(state);
    }
  });

  return merged;
}

function mergeTrackingIds(...trackingIdGroups: Array<string[] | undefined>) {
  const seen = new Set<string>();
  const trackingIds: string[] = [];

  trackingIdGroups.forEach((group) => {
    (group ?? []).forEach((trackingId) => {
      const normalizedTrackingId = trackingId.trim();
      if (!normalizedTrackingId || seen.has(normalizedTrackingId)) {
        return;
      }

      seen.add(normalizedTrackingId);
      trackingIds.push(normalizedTrackingId);
    });
  });

  return trackingIds;
}

function getImportJobTrackingIds(detail: ImportJobDetail) {
  return mergeTrackingIds(
    ...detail.items
      .filter((item) => item.status === "succeeded")
      .map((item) => item.trackingIds)
  );
}

export function getImportJobSheetRowIds(detail: ImportJobDetail) {
  return mergeTrackingIds(
    ...detail.items
      .filter((item) => item.status === "succeeded")
      .map((item) => item.sheetRowIds)
  );
}

function createImportTrackingRunId(sheetId: string, reason: string) {
  return `${sheetId}:import-${reason}:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

const MAX_CONCURRENT_IMPORT_SOURCE_PREVIEW_LOOKUPS = 4;
const IMPORT_SOURCE_PREVIEW_LOOKUP_TIMEOUT_MS = 30_000;
const IMPORT_COMMIT_QUERY_PAGE_SIZE = 1_000;

function createImportSourcePreviewTimeoutMessage() {
  return `Timeout ambil data setelah ${
    IMPORT_SOURCE_PREVIEW_LOOKUP_TIMEOUT_MS / 1000
  } detik.`;
}

async function withImportSourcePreviewTimeout<T>(promise: Promise<T>) {
  let timeoutId: number | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeoutId = window.setTimeout(() => {
          reject(new Error(createImportSourcePreviewTimeoutMessage()));
        }, IMPORT_SOURCE_PREVIEW_LOOKUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  }
}

function createEmptyImportSourcePreviewResult(
  kind: ImportSourceModalKind
): ImportSourcePreviewResult {
  return {
    kind,
    sourceItems: [],
    manifestBags: [],
    trackingIds: [],
    rawResponse: "",
  };
}

function createFailedImportSourcePreviewResult(
  kind: ImportSourceModalKind,
  sourceId: string,
  message: string
): ImportSourcePreviewResult {
  return {
    kind,
    sourceItems: [
      {
        sourceItemId: sourceId,
        sourceItemKind: kind,
        status: "failed",
        trackingIds: [],
        sheetRowIds: [],
        errorMessage: message,
      },
    ],
    manifestBags: [],
    trackingIds: [],
    rawResponse: "",
  };
}

function mergeImportSourcePreviewItems(
  currentItems: ImportSourcePreviewItem[],
  nextItems: ImportSourcePreviewItem[]
) {
  const merged = [...currentItems];
  const indexByKey = new Map(
    merged.map((item, index) => [
      `${item.sourceItemKind}:${item.sourceItemId}`,
      index,
    ])
  );

  nextItems.forEach((item) => {
    const key = `${item.sourceItemKind}:${item.sourceItemId}`;
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, merged.length);
      merged.push(item);
      return;
    }

    merged[existingIndex] = item;
  });

  return merged;
}

function mergeImportSourcePreviewResults(
  current: ImportSourcePreviewResult,
  next: ImportSourcePreviewResult
): ImportSourcePreviewResult {
  return {
    kind: current.kind,
    sourceItems: mergeImportSourcePreviewItems(
      current.sourceItems,
      next.sourceItems
    ),
    manifestBags: mergeImportSourcePreviewItems(
      current.manifestBags,
      next.manifestBags
    ),
    trackingIds: mergeTrackingIds(current.trackingIds, next.trackingIds),
    rawResponse: mergeImportSourceRawResponses(
      current.rawResponse,
      next.rawResponse
    ),
  };
}

async function runImportSourcePreviewInBatches({
  kind,
  sourceIds,
  onPreview,
}: {
  kind: ImportSourceModalKind;
  sourceIds: string[];
  onPreview: (
    preview: ImportSourcePreviewResult,
    mergedPreview: ImportSourcePreviewResult
  ) => void;
}) {
  let cursor = 0;
  let mergedPreview = createEmptyImportSourcePreviewResult(kind);
  const workerCount = Math.min(
    MAX_CONCURRENT_IMPORT_SOURCE_PREVIEW_LOOKUPS,
    sourceIds.length
  );

  const runWorker = async () => {
    while (cursor < sourceIds.length) {
      const sourceId = sourceIds[cursor];
      cursor += 1;

      let preview: ImportSourcePreviewResult;
      try {
        preview = (
          await withImportSourcePreviewTimeout(
            previewImportSource({
              kind,
              ids: [sourceId],
            })
          )
        ).payload;
      } catch (error) {
        preview = createFailedImportSourcePreviewResult(
          kind,
          sourceId,
          getRuntimeErrorMessage(error)
        );
      }

      mergedPreview = mergeImportSourcePreviewResults(mergedPreview, preview);
      onPreview(preview, mergedPreview);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, runWorker));
  return mergedPreview;
}

function parseImportSourceResponseList(rawResponse: string) {
  if (!rawResponse.trim()) {
    return [] as unknown[];
  }

  try {
    const parsed = JSON.parse(rawResponse) as unknown | unknown[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [] as unknown[];
  }
}

function mergeImportSourceRawResponses(currentRawResponse: string, nextRawResponse: string) {
  if (!currentRawResponse.trim()) {
    return nextRawResponse;
  }

  if (!nextRawResponse.trim()) {
    return currentRawResponse;
  }

  const responses = [
    ...parseImportSourceResponseList(currentRawResponse),
    ...parseImportSourceResponseList(nextRawResponse),
  ];

  return JSON.stringify(responses.length === 1 ? responses[0] : responses, null, 2);
}

function normalizeImportTrackingId(trackingId: string) {
  return trackingId.trim();
}

function dedupeTrackingIds(trackingIds: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];

  trackingIds.forEach((trackingId) => {
    const normalizedTrackingId = normalizeImportTrackingId(trackingId);
    if (!normalizedTrackingId || seen.has(normalizedTrackingId)) {
      return;
    }

    seen.add(normalizedTrackingId);
    result.push(normalizedTrackingId);
  });

  return result;
}

function createImportCommitRows({
  sheetId,
  trackingIds,
  startPosition,
}: {
  sheetId: string;
  trackingIds: string[];
  startPosition: number;
}) {
  const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  return trackingIds.map((displayTrackingId, index) => ({
    rowId: `${sheetId}:import:${batchId}:${index}`,
    position: startPosition + index,
    displayTrackingId,
  }));
}

async function queryAllImportCommitRows(sheetId: string) {
  const firstPage = await querySheetRows({
    sheetId,
    offset: 0,
    limit: IMPORT_COMMIT_QUERY_PAGE_SIZE,
    filters: [],
    valueFilters: [],
    sort: [],
  });

  const rows = [...firstPage.payload.rows];
  let currentPage = firstPage.payload;
  let nextOffset = currentPage.nextOffset ?? rows.length;

  while (
    currentPage.hasMore &&
    nextOffset !== null &&
    rows.length < currentPage.totalCount
  ) {
    const page = await querySheetRows({
      sheetId,
      offset: nextOffset,
      limit: IMPORT_COMMIT_QUERY_PAGE_SIZE,
      filters: [],
      valueFilters: [],
      sort: [],
    });

    currentPage = page.payload;
    if (currentPage.rows.length === 0) {
      break;
    }

    rows.push(...currentPage.rows);
    nextOffset = currentPage.nextOffset ?? nextOffset + currentPage.rows.length;
  }

  return {
    ...currentPage,
    offset: 0,
    limit: rows.length,
    rows,
    hasMore: rows.length < currentPage.totalCount,
    nextOffset: rows.length < currentPage.totalCount ? nextOffset : null,
  };
}

function getImportPreviewItemError(item: ImportSourcePreviewItem) {
  return item.errorMessage?.trim() ?? "";
}

function previewItemToSourceState(
  item: ImportSourcePreviewItem
): ImportSourceItemLookupState {
  const error = getImportPreviewItemError(item);

  return {
    itemId: item.sourceItemId,
    loading: item.status === "pending" || item.status === "running",
    error,
    trackingIds: item.trackingIds,
  };
}

function previewItemToManifestBagState(
  item: ImportSourcePreviewItem
): ManifestBagLookupState {
  const error = getImportPreviewItemError(item);

  return {
    bagId: item.sourceItemId,
    loading: item.status === "pending" || item.status === "running",
    error,
    trackingIds: item.trackingIds,
  };
}

function formatImportPreviewFailures(items: ImportSourcePreviewItem[]) {
  return items
    .filter((item) => getImportPreviewItemError(item) !== "")
    .map((item) => `${item.sourceItemId}: ${getImportPreviewItemError(item)}`);
}

function getManifestPreviewBagFailures(preview: ImportSourcePreviewResult) {
  return formatImportPreviewFailures(preview.manifestBags);
}

function isImportSourceLookupCurrent(
  workspaceRef: MutableRefObject<WorkspaceState>,
  sheetId: string,
  kind: ImportSourceModalKind,
  requestKey: string
) {
  return (
    workspaceRef.current.sheetsById[sheetId]?.importSourceLookupStates[kind].requestKey ===
    requestKey
  );
}

function isImportJobRunningStatus(status: ImportJobProgressEvent["status"]) {
  return status === "pending" || status === "running";
}

function isImportJobItemRunningStatus(status: ImportJobItem["status"]) {
  return status === "pending" || status === "running";
}

export function applyWorkspaceEngineImportJobDetail(
  sheetState: SheetState,
  kind: ImportSourceModalKind,
  requestKey: string,
  detail: ImportJobDetail
) {
  if (sheetState.importSourceLookupStates[kind].requestKey !== requestKey) {
    return sheetState;
  }

  const currentLookupState = sheetState.importSourceLookupStates[kind];
  const sourceItemStates: ImportSourceItemLookupState[] = [];
  const manifestBagStates: ManifestBagLookupState[] = [];
  const trackingIds: string[] = [];

  const appendTrackingIds = (ids: string[]) => {
    ids.forEach((trackingId) => {
      const normalizedTrackingId = trackingId.trim();
      if (normalizedTrackingId && !trackingIds.includes(normalizedTrackingId)) {
        trackingIds.push(normalizedTrackingId);
      }
    });
  };

  detail.items.forEach((item) => {
    const loading = isImportJobItemRunningStatus(item.status);
    const error = item.errorMessage ?? "";

    if (item.sourceItemKind === "bag" && kind === "bag") {
      sourceItemStates.push({
        itemId: item.sourceItemId,
        loading,
        error,
        trackingIds: item.trackingIds,
      });
      appendTrackingIds(item.trackingIds);
      return;
    }

    if (item.sourceItemKind === "manifest" && kind === "manifest") {
      sourceItemStates.push({
        itemId: item.sourceItemId,
        loading,
        error,
        trackingIds: item.trackingIds,
      });
      return;
    }

    if (item.sourceItemKind === "manifest_bag" && kind === "manifest") {
      manifestBagStates.push({
        bagId: item.sourceItemId,
        loading,
        error,
        trackingIds: item.trackingIds,
      });
      appendTrackingIds(item.trackingIds);
    }
  });

  return {
    ...sheetState,
    importSourceLookupStates: {
      ...sheetState.importSourceLookupStates,
      [kind]: {
        ...currentLookupState,
        loading: isImportJobRunningStatus(detail.summary.status),
        error: "",
        trackingIds,
        jobId: detail.summary.jobId,
        sourceItemStates,
        manifestBagStates,
      },
    },
  };
}

function applyWorkspaceEngineImportProgress(
  sheetState: SheetState,
  kind: ImportSourceModalKind,
  requestKey: string,
  event: WorkspaceEngineEvent
) {
  if (
    event.type !== "import_job_progress" ||
    sheetState.importSourceLookupStates[kind].requestKey !== requestKey
  ) {
    return sheetState;
  }

  const currentLookupState = sheetState.importSourceLookupStates[kind];
  const sourceItemStates = [...(currentLookupState.sourceItemStates ?? [])];
  const manifestBagStates = [...(currentLookupState.manifestBagStates ?? [])];
  const trackingIds = [...currentLookupState.trackingIds];
  const sourceItemIndexById = new Map(
    sourceItemStates.map((state, index) => [state.itemId, index])
  );
  const manifestBagIndexById = new Map(
    manifestBagStates.map((state, index) => [state.bagId, index])
  );

  const upsertSourceState = (
    itemId: string,
    state: Omit<ImportSourceItemLookupState, "itemId">
  ) => {
    const existingIndex = sourceItemIndexById.get(itemId);
    const nextState = { itemId, ...state };

    if (existingIndex === undefined) {
      sourceItemIndexById.set(itemId, sourceItemStates.length);
      sourceItemStates.push(nextState);
      return;
    }

    sourceItemStates[existingIndex] = nextState;
  };

  const upsertManifestBagState = (
    bagId: string,
    state: Omit<ManifestBagLookupState, "bagId">
  ) => {
    const existingIndex = manifestBagIndexById.get(bagId);
    const nextState = { bagId, ...state };

    if (existingIndex === undefined) {
      manifestBagIndexById.set(bagId, manifestBagStates.length);
      manifestBagStates.push(nextState);
      return;
    }

    manifestBagStates[existingIndex] = nextState;
  };

  event.payload.itemDeltas.forEach((delta) => {
    const loading = delta.status === "pending" || delta.status === "running";
    const error = delta.errorMessage ?? "";

    if (delta.sourceItemKind === "bag" && kind === "bag") {
      upsertSourceState(delta.sourceItemId, {
        loading,
        error,
        trackingIds: delta.trackingIds,
      });
      delta.trackingIds.forEach((trackingId) => {
        if (!trackingIds.includes(trackingId)) {
          trackingIds.push(trackingId);
        }
      });
      return;
    }

    if (delta.sourceItemKind === "manifest" && kind === "manifest") {
      upsertSourceState(delta.sourceItemId, {
        loading,
        error,
        trackingIds: [],
      });
      delta.trackingIds.forEach((bagId) => {
        upsertManifestBagState(bagId, {
          loading: true,
          error: "",
          trackingIds: [],
        });
      });
      return;
    }

    if (delta.sourceItemKind === "manifest_bag" && kind === "manifest") {
      upsertManifestBagState(delta.sourceItemId, {
        loading,
        error,
        trackingIds: delta.trackingIds,
      });
    }
  });

  return {
    ...sheetState,
    importSourceLookupStates: {
      ...sheetState.importSourceLookupStates,
      [kind]: {
        ...currentLookupState,
        loading: isImportJobRunningStatus(event.payload.status),
        error: "",
        trackingIds,
        jobId: event.payload.jobId,
        sourceItemStates,
        manifestBagStates,
      },
    },
  };
}

type ResizeState = {
  path: string;
  startX: number;
  startWidth: number;
} | null;

type UseWorkspaceInteractionRuntimeControllerOptions = {
  activeSheet: SheetState;
  activeSheetId: string;
  workspaceTabs: Array<{ id: string; name: string }>;
  workspaceRef: MutableRefObject<WorkspaceState>;
  setWorkspaceState: Dispatch<SetStateAction<WorkspaceState>>;
  updateActiveSheet: (updater: (sheetState: SheetState) => SheetState) => void;
  updateSheet: (sheetId: string, updater: (sheetState: SheetState) => SheetState) => void;
  setHoveredColumn: Dispatch<SetStateAction<number | null>>;
  deleteAllTimeoutRef: MutableRefObject<number | null>;
  deleteAllArmedSheetIdRef: MutableRefObject<string | null>;
  deleteSelectedTimeoutRef: MutableRefObject<number | null>;
  deleteSelectedArmedSheetIdRef: MutableRefObject<string | null>;
  deleteSelectedArmedSheetId: string | null;
  setDeleteSelectedArmedSheetId: Dispatch<SetStateAction<string | null>>;
  armDeleteAll: () => void;
  disarmDeleteAll: () => void;
  armDeleteSelected: () => void;
  disarmDeleteSelected: () => void;
  resizeStateRef: MutableRefObject<ResizeState>;
  sheetScrollRef: MutableRefObject<HTMLDivElement | null>;
  sheetScrollPositionsRef: MutableRefObject<Map<string, { left: number; top: number }>>;
  columnMenuRefs: MutableRefObject<Map<string, HTMLDivElement | null>>;
  highlightedColumnTimeoutRef: MutableRefObject<number | null>;
  highlightedColumnSheetIdRef: MutableRefObject<string | null>;
  activeFilterCount: number;
  allTrackingIds: string[];
  exportableTableRows: SheetTableRow[];
  rustExportRowsQuery: SheetRowsQuery | null;
  retrackableRows: SheetTableRowTrackingEntry[];
  retryFailedEntries: SheetTableRowTrackingEntry[];
  selectedEngineRowIds: string[];
  selectedTrackingIds: string[];
  selectedVisibleRowKeys: string[];
  visibleColumns: ReadonlyArray<(typeof COLUMNS)[number]>;
  visibleColumnPathSet: Set<string>;
  visibleSelectableKeys: string[];
  effectiveColumnWidths: Record<string, number>;
  pinnedColumnSet: Set<string>;
  allVisibleSelected: boolean;
  showNotice: (notice: Notice) => void;
  onWorkspaceEngineMutation?: (sheetIds?: string | string[]) => void;
};

export function useWorkspaceInteractionRuntimeController({
  activeSheet,
  activeSheetId,
  workspaceTabs,
  workspaceRef,
  setWorkspaceState,
  updateActiveSheet,
  updateSheet,
  setHoveredColumn,
  deleteAllTimeoutRef,
  deleteAllArmedSheetIdRef,
  deleteSelectedTimeoutRef,
  deleteSelectedArmedSheetIdRef,
  deleteSelectedArmedSheetId,
  setDeleteSelectedArmedSheetId,
  armDeleteAll,
  disarmDeleteAll,
  armDeleteSelected,
  disarmDeleteSelected,
  resizeStateRef,
  sheetScrollRef,
  sheetScrollPositionsRef,
  columnMenuRefs,
  highlightedColumnTimeoutRef,
  highlightedColumnSheetIdRef,
  activeFilterCount,
  allTrackingIds,
  exportableTableRows,
  rustExportRowsQuery,
  retrackableRows,
  retryFailedEntries,
  selectedEngineRowIds,
  selectedTrackingIds,
  selectedVisibleRowKeys,
  visibleColumns,
  visibleColumnPathSet,
  visibleSelectableKeys,
  effectiveColumnWidths,
  pinnedColumnSet,
  allVisibleSelected,
  showNotice,
  onWorkspaceEngineMutation,
}: UseWorkspaceInteractionRuntimeControllerOptions) {
  const runtimeCommands = useWorkspaceRuntimeCommandsController({
    activeSheet,
    activeSheetId,
    workspaceTabs,
    workspaceRef,
    setWorkspaceState,
    setHoveredColumn,
    updateActiveSheet,
    updateSheet,
    deleteAllTimeoutRef,
    deleteAllArmedSheetIdRef,
    deleteSelectedTimeoutRef,
    deleteSelectedArmedSheetIdRef,
    deleteSelectedArmedSheetId,
    setDeleteSelectedArmedSheetId,
    armDeleteAll,
    disarmDeleteAll,
    armDeleteSelected,
    disarmDeleteSelected,
    sheetScrollRef,
    sheetScrollPositionsRef,
    highlightedColumnTimeoutRef,
    highlightedColumnSheetIdRef,
    allTrackingIds,
    exportableTableRows,
    rustExportRowsQuery,
    retrackableRows,
    retryFailedEntries,
    selectedEngineRowIds,
    selectedTrackingIds,
    selectedVisibleRowKeys,
    visibleColumns,
    visibleColumnPathSet,
    showNotice,
    onWorkspaceEngineMutation,
  });

  const tableControllers = useWorkspaceTableControllers({
    activeSheet,
    activeSheetId,
    updateActiveSheet,
    updateSheet,
    resizeStateRef,
    sheetScrollRef,
    sheetScrollPositionsRef,
    columnMenuRefs,
    highlightedColumnTimeoutRef,
    highlightedColumnSheetIdRef,
    hasActiveFilters: activeFilterCount > 0,
    visibleSelectableKeys,
    selectedVisibleRowKeys,
    selectedTrackingIds,
    visibleColumnPathSet,
    effectiveColumnWidths,
    pinnedColumnSet,
    allVisibleSelected,
    fetchRow: runtimeCommands.fetchRow,
    copySelectedTrackingIds: runtimeCommands.copySelectedTrackingIds,
    showNotice,
  });

  const openImportSourceModal = useCallback(
    (kind: ImportSourceModalKind) => {
      const lookupState = activeSheet.importSourceLookupStates[kind];
      const jobId = lookupState.jobId ?? null;
      const requestKey = lookupState.requestKey ?? null;
      updateActiveSheet((current) => openImportSourceModalInSheet(current, kind));

      if (!jobId || !requestKey) {
        return;
      }

      getImportJob(jobId)
        .then((response) => {
          updateSheet(activeSheetId, (current) => {
            const currentLookupState = current.importSourceLookupStates[kind];
            if (
              currentLookupState.jobId !== jobId ||
              currentLookupState.requestKey !== requestKey
            ) {
              return current;
            }

            return applyWorkspaceEngineImportJobDetail(
              current,
              kind,
              requestKey,
              response.payload
            );
          });
        })
        .catch((error) => {
          updateSheet(activeSheetId, (current) => {
            const currentLookupState = current.importSourceLookupStates[kind];
            if (
              currentLookupState.jobId !== jobId ||
              currentLookupState.requestKey !== requestKey
            ) {
              return current;
            }

            return setImportSourceLookupErrorInSheet(
              current,
              kind,
              getRuntimeErrorMessage(error),
              requestKey,
              currentLookupState.sourceItemStates
            );
          });
        });
    },
    [activeSheet.importSourceLookupStates, activeSheetId, updateActiveSheet, updateSheet]
  );

  const closeImportSourceModal = useCallback(() => {
    updateActiveSheet((current) => closeImportSourceModalInSheet(current));
  }, [updateActiveSheet]);

  const setImportSourceDraft = useCallback(
    (kind: ImportSourceModalKind, value: string) => {
      updateActiveSheet((current) => setImportSourceDraftInSheet(current, kind, value));
    },
    [updateActiveSheet]
  );

  const runImportSourceLookup = useCallback(
    async (
      kind: ImportSourceModalKind,
      retryTargets: ImportSourceRetryTargets = {}
    ) => {
      const targetSheetId = activeSheetId;
      const lookupValue = activeSheet.importSourceDrafts[kind].trim();
      const lookupIds = parseImportSourceLookupIds(lookupValue);
      const label = kind === "bag" ? "ID Bag" : "ID Manifest";
      const sourceLabel = kind === "bag" ? "Bag" : "Manifest";
      const retrySourceItemIds = retryTargets.sourceItemIds ?? [];
      const retryManifestBagIds =
        kind === "manifest" ? (retryTargets.manifestBagIds ?? []) : [];
      const isRetry =
        retrySourceItemIds.length > 0 || retryManifestBagIds.length > 0;
      const requestKey = `${kind}:${Date.now()}:${Math.random()
        .toString(36)
        .slice(2)}`;

      if (isRetry) {
        flushSync(() => {
          updateSheet(targetSheetId, (current) =>
            startImportSourceRetryInSheet(
              current,
              kind,
              requestKey,
              retrySourceItemIds,
              retryManifestBagIds
            )
          )
        });

        const retryJobId =
          workspaceRef.current.sheetsById[targetSheetId]?.importSourceLookupStates[
            kind
          ].jobId?.trim() ?? "";
        if (retryJobId) {
          const refreshedRowIds: string[] = [];
          const appendRefreshedRowIds = (rowIds: string[]) => {
            rowIds.forEach((rowId) => {
              const normalizedRowId = rowId.trim();
              if (normalizedRowId && !refreshedRowIds.includes(normalizedRowId)) {
                refreshedRowIds.push(normalizedRowId);
              }
            });
          };

          try {
            const completed = await retryImportJobFailedWithProgress(
              retryJobId,
              (event) => {
                if (event.type === "import_job_progress") {
                  event.payload.itemDeltas
                    .filter((delta) => delta.status === "succeeded")
                    .forEach((delta) => appendRefreshedRowIds(delta.sheetRowIds));
                }

                updateSheet(targetSheetId, (current) =>
                  applyWorkspaceEngineImportProgress(
                    current,
                    kind,
                    requestKey,
                    event
                  )
                );
              }
            );
            onWorkspaceEngineMutation?.(targetSheetId);
            updateSheet(targetSheetId, (current) =>
              applyWorkspaceEngineImportJobDetail(
                current,
                kind,
                requestKey,
                completed.payload
              )
            );

            const refreshRowIds =
              refreshedRowIds.length > 0
                ? refreshedRowIds
                : getImportJobSheetRowIds(completed.payload);
            if (refreshRowIds.length > 0) {
              const trackingRunId = createImportTrackingRunId(targetSheetId, `${kind}-retry`);
              updateSheet(targetSheetId, (current) =>
                startTrackingRunInSheet(current, trackingRunId)
              );
              try {
                const refreshResult = await refreshSheetRowsTrackingWithProgress(
                  {
                    sheetId: targetSheetId,
                    rowIds: refreshRowIds,
                    forceRefresh: true,
                    runId: trackingRunId,
                  },
                  (event) => {
                    if (
                      event.type === "tracking_refresh_progress" &&
                      event.payload.runId === trackingRunId
                    ) {
                      updateSheet(targetSheetId, (current) =>
                        applyTrackingRefreshProgressToSheet(current, event.payload, {
                          runId: trackingRunId,
                        })
                      );
                    }
                  }
                );
                if (
                  refreshResult.payload.runId === trackingRunId &&
                  refreshResult.payload.rows.length > 0
                ) {
                  updateSheet(targetSheetId, (current) =>
                    applyTrackingRefreshRowsToSheet(current, refreshResult.payload.rows, {
                      runId: trackingRunId,
                    })
                  );
                }
              } finally {
                updateSheet(targetSheetId, (current) =>
                  clearTrackingRunInSheet(current, trackingRunId)
                );
              }
              onWorkspaceEngineMutation?.(targetSheetId);
            }

            showNotice({
              tone:
                completed.payload.summary.failedCount > 0 ? "error" : "success",
              message:
                completed.payload.summary.failedCount > 0
                  ? "Sebagian data masih gagal diambil."
                  : "Ambil ulang gagal berhasil.",
            });
          } catch (error) {
            const message = getRuntimeErrorMessage(error);
            updateSheet(targetSheetId, (current) =>
              setImportSourceLookupErrorInSheet(
                current,
                kind,
                message,
                requestKey,
                current.importSourceLookupStates[kind].sourceItemStates
              )
            );
          }
          return;
        }

        try {
          if (kind === "bag") {
            const preview = (
              await previewImportSource({
                kind: "bag",
                ids: retrySourceItemIds,
              })
            ).payload;

            if (
              !isImportSourceLookupCurrent(
                workspaceRef,
                targetSheetId,
                kind,
                requestKey
              )
            ) {
              return;
            }

            const currentState =
              workspaceRef.current.sheetsById[targetSheetId]
                ?.importSourceLookupStates.bag;
            if (!currentState) {
              return;
            }

            const sourceItemStates = mergeSourceItemStates(
              currentState.sourceItemStates,
              preview.sourceItems.map(previewItemToSourceState)
            );
            const trackingIds = mergeTrackingIds(
              currentState.trackingIds,
              preview.trackingIds
            );
            const rawResponse = mergeImportSourceRawResponses(
              currentState.rawResponse,
              preview.rawResponse
            );
            const failures = formatImportPreviewFailures(preview.sourceItems);

            updateSheet(targetSheetId, (current) =>
              setImportSourceLookupSuccessInSheet(
                current,
                kind,
                rawResponse,
                trackingIds,
                requestKey,
                [],
                sourceItemStates
              )
            );
            if (failures.length > 0) {
              showNotice({
                tone: "error",
                message: `${failures.length} ${label} masih gagal diproses: ${failures.join(
                  "; "
                )}`,
              });
            }
            return;
          }

          const currentState =
            workspaceRef.current.sheetsById[targetSheetId]
              ?.importSourceLookupStates.manifest;
          if (!currentState) {
            return;
          }

          let rawResponse = currentState.rawResponse;
          let trackingIds = currentState.trackingIds;
          let sourceItemStates = currentState.sourceItemStates ?? [];
          let manifestBagStates = currentState.manifestBagStates ?? [];
          const failures: string[] = [];

          if (retrySourceItemIds.length > 0) {
            const preview = (
              await previewImportSource({
                kind: "manifest",
                ids: retrySourceItemIds,
              })
            ).payload;

            if (
              !isImportSourceLookupCurrent(
                workspaceRef,
                targetSheetId,
                kind,
                requestKey
              )
            ) {
              return;
            }

            sourceItemStates = mergeSourceItemStates(
              sourceItemStates,
              preview.sourceItems.map(previewItemToSourceState)
            );
            manifestBagStates = mergeManifestBagStates(
              manifestBagStates,
              preview.manifestBags.map(previewItemToManifestBagState)
            );
            trackingIds = mergeTrackingIds(trackingIds, preview.trackingIds);
            rawResponse = mergeImportSourceRawResponses(
              rawResponse,
              preview.rawResponse
            );
            failures.push(...formatImportPreviewFailures(preview.sourceItems));
            failures.push(...getManifestPreviewBagFailures(preview));
          }

          if (retryManifestBagIds.length > 0) {
            const preview = (
              await previewImportSource({
                kind: "bag",
                ids: retryManifestBagIds,
              })
            ).payload;

            if (
              !isImportSourceLookupCurrent(
                workspaceRef,
                targetSheetId,
                kind,
                requestKey
              )
            ) {
              return;
            }

            manifestBagStates = mergeManifestBagStates(
              manifestBagStates,
              preview.sourceItems.map(previewItemToManifestBagState)
            );
            trackingIds = mergeTrackingIds(trackingIds, preview.trackingIds);
            failures.push(...formatImportPreviewFailures(preview.sourceItems));
          }

          updateSheet(targetSheetId, (current) =>
            setImportSourceLookupSuccessInSheet(
              current,
              kind,
              rawResponse,
              trackingIds,
              requestKey,
              manifestBagStates,
              sourceItemStates
            )
          );

          if (failures.length > 0) {
            showNotice({
              tone: "error",
              message: `${failures.length} ${label} masih gagal diproses: ${failures.join(
                "; "
              )}`,
            });
          }
        } catch (error) {
          const message = getRuntimeErrorMessage(error);
          updateSheet(targetSheetId, (current) =>
            setImportSourceLookupErrorInSheet(current, kind, message, requestKey)
          );
        }
        return;
      }

      if (lookupIds.length === 0) {
        updateSheet(targetSheetId, (current) =>
          setImportSourceLookupErrorInSheet(
            startImportSourceLookupInSheet(current, kind, requestKey),
            kind,
            `${label} wajib diisi.`,
            requestKey
          )
        );
        return;
      }

      updateSheet(targetSheetId, (current) =>
        startImportSourceLookupInSheet(current, kind, requestKey, lookupIds)
      );

      try {
        const applyPreviewProgress = (preview: ImportSourcePreviewResult) => {
          updateSheet(targetSheetId, (current) => {
            const currentState = current.importSourceLookupStates[kind];
            if (currentState.requestKey !== requestKey) {
              return current;
            }

            const sourceItemStates = mergeSourceItemStates(
              currentState.sourceItemStates,
              preview.sourceItems.map(previewItemToSourceState)
            );
            const manifestBagStates =
              kind === "manifest"
                ? mergeManifestBagStates(
                    currentState.manifestBagStates,
                    preview.manifestBags.map(previewItemToManifestBagState)
                  )
                : [];
            const trackingIds = mergeTrackingIds(
              currentState.trackingIds,
              preview.trackingIds
            );
            const rawResponse = mergeImportSourceRawResponses(
              currentState.rawResponse,
              preview.rawResponse
            );
            const loading =
              sourceItemStates.some((state) => state.loading) ||
              manifestBagStates.some((state) => state.loading);

            return setImportSourceLookupProgressInSheet(
              current,
              kind,
              rawResponse,
              trackingIds,
              requestKey,
              loading,
              manifestBagStates,
              sourceItemStates
            );
          });
        };

        if (kind === "bag") {
          const preview = await runImportSourcePreviewInBatches({
            kind: "bag",
            sourceIds: lookupIds,
            onPreview: (itemPreview) => {
              if (
                isImportSourceLookupCurrent(
                  workspaceRef,
                  targetSheetId,
                  kind,
                  requestKey
                )
              ) {
                applyPreviewProgress(itemPreview);
              }
            },
          });

          if (
            !isImportSourceLookupCurrent(
              workspaceRef,
              targetSheetId,
              kind,
              requestKey
            )
          ) {
            return;
          }

          const failures = formatImportPreviewFailures(preview.sourceItems);
          const sourceItemStates =
            workspaceRef.current.sheetsById[targetSheetId]?.importSourceLookupStates
              .bag.sourceItemStates ??
            preview.sourceItems.map(previewItemToSourceState);

          if (preview.trackingIds.length === 0 && failures.length > 0) {
            updateSheet(targetSheetId, (current) =>
              setImportSourceLookupErrorInSheet(
                current,
                kind,
                `${failures.length} ${label} gagal diproses: ${failures.join("; ")}`,
                requestKey,
                sourceItemStates
              )
            );
            return;
          }

          updateSheet(targetSheetId, (current) =>
            setImportSourceLookupSuccessInSheet(
              current,
              kind,
              preview.rawResponse,
              preview.trackingIds,
              requestKey,
              [],
              sourceItemStates
            )
          );
          if (failures.length > 0) {
            showNotice({
              tone: "error",
              message: `${failures.length} ${label} gagal diproses; hasil ${sourceLabel} lain tetap dipakai.`,
            });
          }
          return;
        }

        const preview = await runImportSourcePreviewInBatches({
          kind: "manifest",
          sourceIds: lookupIds,
          onPreview: (itemPreview) => {
            if (
              isImportSourceLookupCurrent(
                workspaceRef,
                targetSheetId,
                kind,
                requestKey
              )
            ) {
              applyPreviewProgress(itemPreview);
            }
          },
        });

        if (
          !isImportSourceLookupCurrent(
            workspaceRef,
            targetSheetId,
            kind,
            requestKey
          )
        ) {
          return;
        }

        const manifestFailures = formatImportPreviewFailures(preview.sourceItems);
        const manifestBagFailures = getManifestPreviewBagFailures(preview);
        const currentPreviewState =
          workspaceRef.current.sheetsById[targetSheetId]?.importSourceLookupStates
            .manifest;
        const sourceItemStates =
          currentPreviewState?.sourceItemStates ??
          preview.sourceItems.map(previewItemToSourceState);
        const manifestBagStates =
          currentPreviewState?.manifestBagStates ??
          preview.manifestBags.map(previewItemToManifestBagState);

        if (
          !preview.sourceItems.some((item) => getImportPreviewItemError(item) === "") &&
          manifestFailures.length > 0
        ) {
          updateSheet(targetSheetId, (current) =>
            setImportSourceLookupErrorInSheet(
              current,
              kind,
              `${manifestFailures.length} ${label} gagal diproses: ${manifestFailures.join(
                "; "
              )}`,
              requestKey,
              sourceItemStates
            )
          );
          return;
        }

        updateSheet(targetSheetId, (current) =>
          setImportSourceLookupSuccessInSheet(
            current,
            kind,
            preview.rawResponse,
            preview.trackingIds,
            requestKey,
            manifestBagStates,
            sourceItemStates
          )
        );
        if (manifestFailures.length > 0 || manifestBagFailures.length > 0) {
          const failures = [...manifestFailures, ...manifestBagFailures];
          showNotice({
            tone: "error",
            message: `${failures.length} ${label} gagal diproses; hasil ${sourceLabel} lain tetap dipakai.`,
          });
        }
      } catch (error) {
        const message = getRuntimeErrorMessage(error);
        updateSheet(targetSheetId, (current) =>
          setImportSourceLookupErrorInSheet(current, kind, message, requestKey)
        );
      }
    },
    [
      activeSheet.importSourceDrafts,
      activeSheetId,
      showNotice,
      updateSheet,
      workspaceRef,
    ]
  );

  const importSourceTrackingIds = useCallback(
    async (kind: ImportSourceModalKind, mode: "replace" | "append") => {
      const sourceLabel = kind === "bag" ? "Bag" : "Manifest";
      const currentLookupState =
        workspaceRef.current.sheetsById[activeSheetId]?.importSourceLookupStates[
          kind
        ];
      const trackingIds = dedupeTrackingIds(
        currentLookupState?.trackingIds ?? []
      );

      if (trackingIds.length === 0) {
        showNotice({
          tone: "error",
          message: `Tidak ada nomor kiriman hasil ${sourceLabel} untuk diimpor. Jalankan Ambil Data dulu.`,
        });
        return;
      }

      const commitRequestKey = `${kind}:commit:${Date.now()}:${Math.random()
        .toString(36)
        .slice(2)}`;

      updateSheet(activeSheetId, (current) => {
        const lookupState = current.importSourceLookupStates[kind];
        return {
          ...current,
          importSourceLookupStates: {
            ...current.importSourceLookupStates,
            [kind]: {
              ...lookupState,
              loading: true,
              error: "",
              requestKey: lookupState.requestKey ?? commitRequestKey,
            },
          },
        };
      });

      if (mode === "replace") {
        runtimeCommands.invalidateSheetTrackingWork(activeSheetId);
      }

      try {
        let startPosition = 0;
        let rowIdsToRefresh: string[] = [];
        const existingTrackingIdSet = new Set<string>();
        if (mode === "replace") {
          await clearSheetRows({ sheetId: activeSheetId });
          updateSheet(activeSheetId, (current) =>
            clearSheetDataPreservingImportStateInSheet(current)
          );
        } else {
          const existingRows = await queryAllImportCommitRows(activeSheetId);
          startPosition = existingRows.totalCount;
          const existingRowIdsByTrackingId = new Map<string, string>();
          existingRows.rows.forEach((row) => {
            const normalizedTrackingId = normalizeImportTrackingId(
              row.displayTrackingId
            );
            if (
              normalizedTrackingId &&
              !existingRowIdsByTrackingId.has(normalizedTrackingId)
            ) {
              existingRowIdsByTrackingId.set(normalizedTrackingId, row.rowId);
            }
          });

          rowIdsToRefresh = trackingIds
            .map((trackingId) => {
              const normalizedTrackingId = normalizeImportTrackingId(trackingId);
              const rowId = existingRowIdsByTrackingId.get(normalizedTrackingId);
              if (rowId) {
                existingTrackingIdSet.add(normalizedTrackingId);
              }
              return rowId;
            })
            .filter((rowId): rowId is string => Boolean(rowId));
        }

        const trackingIdsToInsert =
          mode === "append"
            ? trackingIds.filter((trackingId) => {
                const normalizedTrackingId = normalizeImportTrackingId(trackingId);
                return (
                  normalizedTrackingId !== "" &&
                  !existingTrackingIdSet.has(normalizedTrackingId)
                );
              })
            : trackingIds;

        const rows = createImportCommitRows({
          sheetId: activeSheetId,
          trackingIds: trackingIdsToInsert,
          startPosition,
        });
        if (rows.length > 0) {
          await upsertSheetRows({
            sheetId: activeSheetId,
            rows,
          });
        }

        rowIdsToRefresh = [...rowIdsToRefresh, ...rows.map((row) => row.rowId)];
        if (mode === "replace") {
          onWorkspaceEngineMutation?.(activeSheetId);
        }

        if (rowIdsToRefresh.length > 0) {
          const trackingRunId = createImportTrackingRunId(activeSheetId, `${kind}-commit`);
          updateSheet(activeSheetId, (current) =>
            startTrackingRunInSheet(current, trackingRunId)
          );
          try {
            const refreshResult = await refreshSheetRowsTrackingWithProgress(
              {
                sheetId: activeSheetId,
                rowIds: rowIdsToRefresh,
                forceRefresh: true,
                runId: trackingRunId,
              },
              (event) => {
                if (
                  event.type === "tracking_refresh_progress" &&
                  event.payload.runId === trackingRunId
                ) {
                  updateSheet(activeSheetId, (current) =>
                    applyTrackingRefreshProgressToSheet(current, event.payload, {
                      createMissingRow: true,
                      runId: trackingRunId,
                    })
                  );
                }
              }
            );
            if (
              refreshResult.payload.runId === trackingRunId &&
              refreshResult.payload.rows.length > 0
            ) {
              updateSheet(activeSheetId, (current) =>
                applyTrackingRefreshRowsToSheet(current, refreshResult.payload.rows, {
                  createMissingRows: true,
                  runId: trackingRunId,
                })
              );
            }
          } finally {
            updateSheet(activeSheetId, (current) =>
              clearTrackingRunInSheet(current, trackingRunId)
            );
          }
        }

        disarmDeleteAll();
        disarmDeleteSelected();

        flushSync(() => {
          updateSheet(activeSheetId, (current) => {
            const lookupState = current.importSourceLookupStates[kind];
            const settledSheet = {
              ...current,
              importSourceLookupStates: {
                ...current.importSourceLookupStates,
                [kind]: {
                  ...lookupState,
                  loading: false,
                  error: "",
                },
              },
            };

            return closeImportSourceModalInSheet(
              settledSheet
            );
          });
        });
        onWorkspaceEngineMutation?.(activeSheetId);

        showNotice({
          tone: "success",
          message:
            mode === "replace"
              ? `${trackingIds.length} nomor kiriman dari ${sourceLabel} menggantikan data sheet.`
              : rows.length === trackingIds.length
                ? `${trackingIds.length} nomor kiriman dari ${sourceLabel} ditambahkan ke sheet.`
                : rows.length === 0
                  ? `${trackingIds.length} nomor kiriman dari ${sourceLabel} sudah ada dan dilacak ulang.`
                  : `${rows.length} nomor kiriman dari ${sourceLabel} ditambahkan, ${trackingIds.length - rows.length} dilacak ulang.`,
        });
      } catch (error) {
        const message = getRuntimeErrorMessage(error);
        updateSheet(activeSheetId, (current) => {
          const lookupState = current.importSourceLookupStates[kind];
          return {
            ...current,
            importSourceLookupStates: {
              ...current.importSourceLookupStates,
              [kind]: {
                ...lookupState,
                loading: false,
                error: message,
                requestKey: lookupState.requestKey ?? commitRequestKey,
              },
            },
          };
        });
      }
    },
    [
      activeSheetId,
      disarmDeleteAll,
      disarmDeleteSelected,
      runtimeCommands,
      showNotice,
      onWorkspaceEngineMutation,
      updateSheet,
      workspaceRef,
    ]
  );

  const importBagTrackingIds = useCallback(
    (mode: "replace" | "append") => {
      importSourceTrackingIds("bag", mode);
    },
    [importSourceTrackingIds]
  );

  const importManifestTrackingIds = useCallback(
    (mode: "replace" | "append") => {
      importSourceTrackingIds("manifest", mode);
    },
    [importSourceTrackingIds]
  );

  return {
    ...runtimeCommands,
    ...tableControllers,
    closeImportSourceModal,
    importBagTrackingIds,
    importManifestTrackingIds,
    openImportSourceModal,
    runImportSourceLookup,
    setImportSourceDraft,
  };
}
