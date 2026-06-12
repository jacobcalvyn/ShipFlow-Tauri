import {
  Dispatch,
  MutableRefObject,
  SetStateAction,
  useCallback,
} from "react";
import { flushSync } from "react-dom";
import {
  clearSheetDataPreservingImportStateInSheet,
  closeImportSourceModalInSheet,
  openImportSourceModalInSheet,
  setImportSourceJobInSheet,
  setImportSourceLookupErrorInSheet,
  setImportSourceLookupSuccessInSheet,
  setImportSourceDraftInSheet,
  startImportSourceLookupInSheet,
  startImportSourceRetryInSheet,
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
  createImportJob,
  getImportJob,
  type ImportJobDetail,
  type ImportJobItem,
  ImportSourcePreviewItem,
  ImportSourcePreviewResult,
  previewImportSource,
  type SheetRowsQuery,
  refreshSheetRowsTracking,
  retryImportJobFailedWithProgress,
  runImportJobWithProgress,
  WorkspaceEngineEvent,
} from "../workspace-engine/client";

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

function isImportJobRunningStatus(status: WorkspaceEngineEvent["payload"]["status"]) {
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
  retrackableRows: Array<{ key: string; value: string }>;
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
              await refreshSheetRowsTracking({
                sheetId: targetSheetId,
                rowIds: refreshRowIds,
                forceRefresh: true,
              });
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
        if (kind === "bag") {
          const preview = (
            await previewImportSource({
              kind: "bag",
              ids: lookupIds,
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

          const failures = formatImportPreviewFailures(preview.sourceItems);
          const sourceItemStates = preview.sourceItems.map(
            previewItemToSourceState
          );

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

        const preview = (
          await previewImportSource({
            kind: "manifest",
            ids: lookupIds,
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

        const manifestFailures = formatImportPreviewFailures(preview.sourceItems);
        const manifestBagFailures = getManifestPreviewBagFailures(preview);
        const sourceItemStates = preview.sourceItems.map(previewItemToSourceState);
        const manifestBagStates = preview.manifestBags.map(
          previewItemToManifestBagState
        );

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
      const sourceIds = parseImportSourceLookupIds(
        activeSheet.importSourceDrafts[kind]
      );
      const sourceLabel = kind === "bag" ? "Bag" : "Manifest";
      const requestKey = `${kind}:commit:${Date.now()}:${Math.random()
        .toString(36)
        .slice(2)}`;

      if (sourceIds.length === 0) {
        showNotice({
          tone: "error",
          message: `${kind === "bag" ? "ID Bag" : "ID Manifest"} wajib diisi.`,
        });
        return;
      }

      updateSheet(activeSheetId, (current) =>
        startImportSourceLookupInSheet(current, kind, requestKey, sourceIds)
      );

      try {
        const created = await createImportJob({
          sheetId: activeSheetId,
          kind,
          ids: sourceIds,
          mode,
        });

        const jobId = created.payload.summary.jobId;
        updateSheet(activeSheetId, (current) =>
          applyWorkspaceEngineImportJobDetail(
            setImportSourceJobInSheet(current, kind, requestKey, jobId),
            kind,
            requestKey,
            created.payload
          )
        );

        const completed = await runImportJobWithProgress(jobId, (event) => {
          updateSheet(activeSheetId, (current) =>
            applyWorkspaceEngineImportProgress(current, kind, requestKey, event)
          );
        });
        updateSheet(activeSheetId, (current) =>
          applyWorkspaceEngineImportJobDetail(
            current,
            kind,
            requestKey,
            completed.payload
          )
        );

        const importedTrackingIds = getImportJobTrackingIds(completed.payload);
        const refreshRowIds = getImportJobSheetRowIds(completed.payload);

        if (refreshRowIds.length > 0) {
          await refreshSheetRowsTracking({
            sheetId: activeSheetId,
            rowIds: refreshRowIds,
            forceRefresh: true,
          });
        }

        const importedCount = importedTrackingIds.length;
        if (importedCount === 0) {
          updateSheet(activeSheetId, (current) =>
            setImportSourceLookupErrorInSheet(
              current,
              kind,
              `Tidak ada nomor kiriman dari ${sourceLabel} untuk diimpor.`,
              requestKey,
              current.importSourceLookupStates[kind].sourceItemStates
            )
          );
          return;
        }

        disarmDeleteAll();
        disarmDeleteSelected();

        if (mode === "replace") {
          runtimeCommands.invalidateSheetTrackingWork(activeSheetId);
        }

        flushSync(() => {
          updateSheet(activeSheetId, (current) =>
            closeImportSourceModalInSheet(
              mode === "replace"
                ? clearSheetDataPreservingImportStateInSheet(current)
                : current
            )
          );
        });
        onWorkspaceEngineMutation?.(activeSheetId);

        showNotice({
          tone: "success",
          message:
            mode === "replace"
              ? `${importedCount} nomor kiriman dari ${sourceLabel} menggantikan data sheet.`
              : `${importedCount} nomor kiriman dari ${sourceLabel} ditambahkan ke sheet.`,
        });
      } catch (error) {
        updateSheet(activeSheetId, (current) =>
          setImportSourceLookupErrorInSheet(
            current,
            kind,
            getRuntimeErrorMessage(error),
            requestKey,
            current.importSourceLookupStates[kind].sourceItemStates
          )
        );
      }
    },
    [
      activeSheet,
      activeSheetId,
      disarmDeleteAll,
      disarmDeleteSelected,
      runtimeCommands,
      showNotice,
      onWorkspaceEngineMutation,
      updateSheet,
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
