import { invoke } from "@tauri-apps/api/core";
import { Dispatch, MutableRefObject, SetStateAction, useCallback } from "react";
import { flushSync } from "react-dom";
import {
  appendTrackingIdsToSheet,
  clearSheetDataPreservingImportStateInSheet,
  closeImportSourceModalInSheet,
  openImportSourceModalInSheet,
  setManifestBagLookupErrorInSheet,
  setManifestBagLookupSuccessInSheet,
  seedTrackingIdsInSheet,
  setImportSourceLookupErrorInSheet,
  setImportSourceLookupSuccessInSheet,
  setImportSourceDraftInSheet,
  startImportSourceLookupInSheet,
} from "../sheet/actions";
import { ImportSourceModalKind, SheetState } from "../sheet/types";
import { COLUMNS } from "../sheet/columns";
import { useWorkspaceRuntimeCommandsController } from "./useWorkspaceRuntimeCommandsController";
import { useWorkspaceTableControllers } from "./useWorkspaceTableControllers";
import { WorkspaceState } from "./types";
import { BagResponse, ManifestResponse } from "../../types";

type Notice = {
  tone: "success" | "error" | "info";
  message: string;
};

const MAX_CONCURRENT_MANIFEST_BAG_LOOKUPS = 4;

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

function extractBagTrackingIds(response: BagResponse) {
  const seen = new Set<string>();
  const trackingIds: string[] = [];

  response.items.forEach((item) => {
    const trackingId = item.no_resi?.trim() ?? "";
    if (!trackingId || seen.has(trackingId)) {
      return;
    }

    seen.add(trackingId);
    trackingIds.push(trackingId);
  });

  return trackingIds;
}

function extractManifestBagIds(response: ManifestResponse) {
  const seen = new Set<string>();
  const bagIds: string[] = [];

  response.items.forEach((item) => {
    const bagId = item.nomor_kantung?.trim() ?? "";
    if (!bagId || seen.has(bagId)) {
      return;
    }

    seen.add(bagId);
    bagIds.push(bagId);
  });

  return bagIds;
}

function extractManifestTrackingIds(
  manifestBagStates: SheetState["importSourceLookupStates"]["manifest"]["manifestBagStates"]
) {
  const seen = new Set<string>();
  const trackingIds: string[] = [];

  (manifestBagStates ?? []).forEach((state) => {
    state.trackingIds.forEach((trackingId) => {
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
  exportableRows: SheetState["rows"];
  retrackableRows: Array<{ key: string; value: string }>;
  retryFailedEntries: Array<{ key: string; value: string }>;
  selectedTrackingIds: string[];
  selectedVisibleRowKeys: string[];
  visibleColumns: ReadonlyArray<(typeof COLUMNS)[number]>;
  visibleColumnPathSet: Set<string>;
  visibleSelectableKeys: string[];
  effectiveColumnWidths: Record<string, number>;
  pinnedColumnSet: Set<string>;
  allVisibleSelected: boolean;
  showNotice: (notice: Notice) => void;
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
  exportableRows,
  retrackableRows,
  retryFailedEntries,
  selectedTrackingIds,
  selectedVisibleRowKeys,
  visibleColumns,
  visibleColumnPathSet,
  visibleSelectableKeys,
  effectiveColumnWidths,
  pinnedColumnSet,
  allVisibleSelected,
  showNotice,
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
    exportableRows,
    retrackableRows,
    retryFailedEntries,
    selectedTrackingIds,
    selectedVisibleRowKeys,
    visibleColumns,
    visibleColumnPathSet,
    showNotice,
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
      updateActiveSheet((current) => openImportSourceModalInSheet(current, kind));
    },
    [updateActiveSheet]
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
    async (kind: ImportSourceModalKind) => {
      const targetSheetId = activeSheetId;
      const lookupValue = activeSheet.importSourceDrafts[kind].trim();
      const label = kind === "bag" ? "ID Bag" : "ID Manifest";
      const requestKey = `${kind}:${Date.now()}:${Math.random()
        .toString(36)
        .slice(2)}`;

      if (lookupValue === "") {
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
        startImportSourceLookupInSheet(current, kind, requestKey)
      );

      try {
        const response =
          kind === "bag"
            ? await invoke<BagResponse>("track_bag", {
                bagId: lookupValue,
                forceRefresh: true,
                sheetId: targetSheetId,
                rowKey: "__import_source_bag__",
              })
            : await invoke<ManifestResponse>("track_manifest", {
                manifestId: lookupValue,
                forceRefresh: true,
                sheetId: targetSheetId,
                rowKey: "__import_source_manifest__",
              });

        if (kind === "bag") {
          updateSheet(targetSheetId, (current) =>
            setImportSourceLookupSuccessInSheet(
              current,
              kind,
              JSON.stringify(response, null, 2),
              extractBagTrackingIds(response),
              requestKey
            )
          );
          return;
        }

        const manifestBagIds = extractManifestBagIds(response);

        updateSheet(targetSheetId, (current) =>
          setImportSourceLookupSuccessInSheet(
            current,
            kind,
            JSON.stringify(response, null, 2),
            [],
            requestKey,
            manifestBagIds.map((bagId) => ({
              bagId,
              loading: true,
              error: "",
              trackingIds: [],
            }))
          )
        );

        const queue = [...manifestBagIds];
        const workerCount = Math.min(
          MAX_CONCURRENT_MANIFEST_BAG_LOOKUPS,
          queue.length
        );

        await Promise.allSettled(
          Array.from({ length: workerCount }, async () => {
            while (queue.length > 0) {
              if (
                !isImportSourceLookupCurrent(
                  workspaceRef,
                  targetSheetId,
                  "manifest",
                  requestKey
                )
              ) {
                return;
              }

              const bagId = queue.shift();
              if (!bagId) {
                return;
              }

              try {
                const bagResponse = await invoke<BagResponse>("track_bag", {
                  bagId,
                  forceRefresh: true,
                  sheetId: targetSheetId,
                  rowKey: `__manifest_bag_lookup__:${lookupValue}:${bagId}`,
                });
                updateSheet(targetSheetId, (current) =>
                  setManifestBagLookupSuccessInSheet(
                    current,
                    bagId,
                    extractBagTrackingIds(bagResponse),
                    requestKey
                  )
                );
              } catch (bagError) {
                updateSheet(targetSheetId, (current) =>
                  setManifestBagLookupErrorInSheet(
                    current,
                    bagId,
                    getRuntimeErrorMessage(bagError),
                    requestKey
                  )
                );
              }
            }
          })
        );
      } catch (error) {
        const message = getRuntimeErrorMessage(error);
        updateSheet(targetSheetId, (current) =>
          setImportSourceLookupErrorInSheet(current, kind, message, requestKey)
        );
      }
    },
    [activeSheet.importSourceDrafts, activeSheetId, updateSheet, workspaceRef]
  );

  const importSourceTrackingIds = useCallback(
    (kind: ImportSourceModalKind, mode: "replace" | "append") => {
      const trackingIds =
        kind === "bag"
          ? activeSheet.importSourceLookupStates.bag.trackingIds
          : extractManifestTrackingIds(
              activeSheet.importSourceLookupStates.manifest.manifestBagStates
            );
      const sourceLabel = kind === "bag" ? "Bag" : "Manifest";

      if (trackingIds.length === 0) {
        showNotice({
          tone: "error",
          message: `Belum ada nomor kiriman dari ${sourceLabel} untuk diimpor.`,
        });
        return;
      }

      const nextImportState =
        mode === "replace"
          ? seedTrackingIdsInSheet(
              closeImportSourceModalInSheet(
                clearSheetDataPreservingImportStateInSheet(activeSheet)
              ),
              trackingIds
            )
          : appendTrackingIdsToSheet(
              closeImportSourceModalInSheet(activeSheet),
              trackingIds
            );
      const targetKeys = nextImportState.targetKeys;

      disarmDeleteAll();
      disarmDeleteSelected();

      if (targetKeys.length === 0) {
        return;
      }

      if (mode === "replace") {
        runtimeCommands.invalidateSheetTrackingWork(activeSheetId);
      }

      flushSync(() => {
        updateActiveSheet(() => nextImportState.sheetState);
      });

      showNotice({
        tone: "success",
        message:
          mode === "replace"
            ? `${trackingIds.length} nomor kiriman dari ${sourceLabel} menggantikan data sheet.`
            : `${trackingIds.length} nomor kiriman dari ${sourceLabel} ditambahkan ke sheet.`,
      });

      void runtimeCommands.runBulkPasteFetches(
        activeSheetId,
        targetKeys.map((key, index) => ({
          key,
          value: trackingIds[index],
        }))
      );
    },
    [
      activeSheet.importSourceLookupStates,
      activeSheet,
      activeSheetId,
      disarmDeleteAll,
      disarmDeleteSelected,
      runtimeCommands,
      showNotice,
      updateActiveSheet,
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
