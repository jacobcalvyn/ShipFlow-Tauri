import { Dispatch, MutableRefObject, SetStateAction, useCallback, useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { exportWorkspaceCsv } from "../../backend/commands";
import { COLUMNS } from "../sheet/columns";
import {
  clearAllDataInSheet,
  clearFiltersInSheet,
  clearHiddenFiltersInSheet,
  clearSelectionInSheet,
  clearTrackingRunInSheet,
  deleteRowsInSheet,
  startTrackingRunInSheet,
} from "../sheet/actions";
import {
  createSheetTableRowsFromRustWindow,
  getExportableTableRows,
  type SheetTableRow,
  type SheetTableRowTrackingEntry,
} from "../sheet/table-row-view";
import { createDefaultSheetState } from "../sheet/default-state";
import { buildCsvValue } from "../sheet/utils";
import { SheetState } from "../sheet/types";
import {
  createSheetInWorkspace,
  deleteSheetInWorkspace,
  renameSheetInWorkspace,
  setActiveSheetInWorkspace,
} from "./actions";
import { WorkspaceState } from "./types";
import {
  clearSheetRows,
  copySheetRows,
  createEngineSheet,
  deleteSheet,
  deleteSheetRows,
  querySheetRows,
  refreshSheetRowsTrackingWithProgress,
  renameEngineSheet,
  type SheetRowsQuery,
} from "../workspace-engine/client";
import {
  applyTrackingRefreshProgressToSheet,
  applyTrackingRefreshRowsToSheet,
} from "./tracking-refresh-state";

type WorkspaceCommandNotice = {
  tone: "success" | "error" | "info";
  message: string;
};

const CSV_EXCLUDED_COLUMN_PATHS = new Set([
  "pod.photo1_url",
  "pod.photo2_url",
  "history_summary.irregularity",
  "history_summary.bagging_unbagging",
  "history_summary.manifest_r7",
  "history_summary.delivery_runsheet",
]);
const CSV_RUST_EXPORT_WINDOW_LIMIT = 1_000;
const TRACKING_PROGRESS_ENGINE_SYNC_DELAY_MS = 120;

function createWorkspaceTrackingRunId(sheetId: string, reason: string) {
  return `${sheetId}:workspace-${reason}:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

async function collectRustExportRows(query: SheetRowsQuery) {
  const rows: SheetTableRow[] = [];
  let offset = 0;

  while (true) {
    const response = await querySheetRows({
      ...query,
      offset,
      limit: CSV_RUST_EXPORT_WINDOW_LIMIT,
    });
    rows.push(
      ...getExportableTableRows(
        createSheetTableRowsFromRustWindow(response.payload, []),
        []
      )
    );

    if (!response.payload.hasMore || response.payload.nextOffset === null) {
      break;
    }

    if (response.payload.nextOffset <= offset) {
      throw new Error("Rust row export pagination stalled.");
    }

    offset = response.payload.nextOffset;
  }

  return rows;
}

async function collectRustRefreshRowIds(query: SheetRowsQuery) {
  const rowIds: string[] = [];
  let offset = 0;

  while (true) {
    const response = await querySheetRows({
      ...query,
      offset,
      limit: CSV_RUST_EXPORT_WINDOW_LIMIT,
    });
    response.payload.rows.forEach((row) => {
      if (row.rowId.trim() !== "") {
        rowIds.push(row.rowId);
      }
    });

    if (!response.payload.hasMore || response.payload.nextOffset === null) {
      break;
    }

    if (response.payload.nextOffset <= offset) {
      throw new Error("Rust row refresh pagination stalled.");
    }

    offset = response.payload.nextOffset;
  }

  return rowIds;
}

async function collectRustTrackingIds(query: SheetRowsQuery) {
  const trackingIds: string[] = [];
  let offset = 0;

  while (true) {
    const response = await querySheetRows({
      ...query,
      offset,
      limit: CSV_RUST_EXPORT_WINDOW_LIMIT,
    });
    response.payload.rows.forEach((row) => {
      const trackingId = row.displayTrackingId.trim();
      if (trackingId !== "") {
        trackingIds.push(trackingId);
      }
    });

    if (!response.payload.hasMore || response.payload.nextOffset === null) {
      break;
    }

    if (response.payload.nextOffset <= offset) {
      throw new Error("Rust tracking-id copy pagination stalled.");
    }

    offset = response.payload.nextOffset;
  }

  return trackingIds;
}

function hasScopedRustRowQuery(query: SheetRowsQuery) {
  return query.filters.length > 0 || (query.valueFilters?.length ?? 0) > 0;
}

function getEngineSheetMetadata(workspaceState: WorkspaceState, sheetId: string) {
  const meta = workspaceState.sheetMetaById[sheetId];
  const position = workspaceState.sheetOrder.indexOf(sheetId);
  if (!meta || position < 0) {
    return null;
  }

  return {
    sheetId,
    name: meta.name,
    position,
  };
}

type UseWorkspaceCommandsControllerOptions = {
  activeSheetId: string;
  activeSheetDeleteAllArmed: boolean;
  allTrackingIds: string[];
  exportableTableRows: SheetTableRow[];
  rustExportRowsQuery: SheetRowsQuery | null;
  retrackableRows: SheetTableRowTrackingEntry[];
  retryFailedEntries: SheetTableRowTrackingEntry[];
  selectedEngineRowIds: string[];
  selectedTrackingIds: string[];
  selectedVisibleRowKeys: string[];
  deleteSelectedArmedSheetId: string | null;
  visibleColumns: ReadonlyArray<(typeof COLUMNS)[number]>;
  visibleColumnPathSet: Set<string>;
  workspaceRef: MutableRefObject<WorkspaceState>;
  sheetScrollPositionsRef: MutableRefObject<Map<string, { left: number; top: number }>>;
  highlightedColumnTimeoutRef: MutableRefObject<number | null>;
  highlightedColumnSheetIdRef: MutableRefObject<string | null>;
  deleteAllTimeoutRef: MutableRefObject<number | null>;
  deleteAllArmedSheetIdRef: MutableRefObject<string | null>;
  deleteSelectedTimeoutRef: MutableRefObject<number | null>;
  deleteSelectedArmedSheetIdRef: MutableRefObject<string | null>;
  setDeleteSelectedArmedSheetId: Dispatch<SetStateAction<string | null>>;
  setWorkspaceState: Dispatch<SetStateAction<WorkspaceState>>;
  setHoveredColumn: Dispatch<SetStateAction<number | null>>;
  updateActiveSheet: (updater: (sheetState: SheetState) => SheetState) => void;
  copyText: (value: string) => Promise<void>;
  showNotice: (notice: WorkspaceCommandNotice) => void;
  armDeleteAll: () => void;
  disarmDeleteAll: () => void;
  armDeleteSelected: () => void;
  disarmDeleteSelected: () => void;
  focusFirstTrackingInput: () => void;
  abortRowTrackingWork: (
    sheetId: string,
    rowKeys: string[],
    reason: "selected_rows_deleted" | "sheet_invalidation" | "cell_cleared" | "bulk_paste_overwrite"
  ) => void;
  invalidateSheetTrackingWork: (sheetId: string) => void;
  forgetSheetTrackingRuntime: (sheetId: string) => void;
  refreshTrackingRows: (
    sheetId: string,
    entries: SheetTableRowTrackingEntry[],
    options?: { forceRefresh?: boolean }
  ) => Promise<void>;
  onWorkspaceEngineMutation?: (sheetIds?: string | string[]) => void;
};

export function useWorkspaceCommandsController({
  activeSheetId,
  activeSheetDeleteAllArmed,
  allTrackingIds,
  exportableTableRows,
  rustExportRowsQuery,
  retrackableRows,
  retryFailedEntries,
  selectedEngineRowIds,
  selectedTrackingIds,
  selectedVisibleRowKeys,
  deleteSelectedArmedSheetId,
  visibleColumns,
  visibleColumnPathSet,
  workspaceRef,
  sheetScrollPositionsRef,
  highlightedColumnTimeoutRef,
  highlightedColumnSheetIdRef,
  deleteAllTimeoutRef,
  deleteAllArmedSheetIdRef,
  deleteSelectedTimeoutRef,
  deleteSelectedArmedSheetIdRef,
  setDeleteSelectedArmedSheetId,
  setWorkspaceState,
  setHoveredColumn,
  updateActiveSheet,
  copyText,
  showNotice,
  armDeleteAll,
  disarmDeleteAll,
  armDeleteSelected,
  disarmDeleteSelected,
  focusFirstTrackingInput,
  abortRowTrackingWork,
  invalidateSheetTrackingWork,
  forgetSheetTrackingRuntime,
  refreshTrackingRows,
  onWorkspaceEngineMutation,
}: UseWorkspaceCommandsControllerOptions) {
  const trackingProgressEngineSyncTimeoutRef = useRef<number | null>(null);
  const trackingProgressEngineSyncSheetIdsRef = useRef<Set<string>>(new Set());

  const updateSheetById = useCallback(
    (sheetId: string, updater: (sheetState: SheetState) => SheetState) => {
      setWorkspaceState((current) => {
        const sheetState = current.sheetsById[sheetId];
        if (!sheetState) {
          return current;
        }

        const nextSheetState = updater(sheetState);
        if (nextSheetState === sheetState) {
          return current;
        }

        return {
          ...current,
          sheetsById: {
            ...current.sheetsById,
            [sheetId]: nextSheetState,
          },
        };
      });
    },
    [setWorkspaceState]
  );

  const scheduleTrackingProgressEngineSync = useCallback(
    (sheetId: string) => {
      if (!onWorkspaceEngineMutation) {
        return;
      }

      trackingProgressEngineSyncSheetIdsRef.current.add(sheetId);
      if (trackingProgressEngineSyncTimeoutRef.current !== null) {
        return;
      }

      trackingProgressEngineSyncTimeoutRef.current = window.setTimeout(() => {
        trackingProgressEngineSyncTimeoutRef.current = null;
        const sheetIds = Array.from(trackingProgressEngineSyncSheetIdsRef.current);
        trackingProgressEngineSyncSheetIdsRef.current.clear();
        if (sheetIds.length === 0) {
          return;
        }
        onWorkspaceEngineMutation(sheetIds.length === 1 ? sheetIds[0] : sheetIds);
      }, TRACKING_PROGRESS_ENGINE_SYNC_DELAY_MS);
    },
    [onWorkspaceEngineMutation]
  );

  const flushTrackingProgressEngineSync = useCallback(
    (sheetId: string) => {
      if (!onWorkspaceEngineMutation) {
        return;
      }

      trackingProgressEngineSyncSheetIdsRef.current.add(sheetId);
      if (trackingProgressEngineSyncTimeoutRef.current !== null) {
        window.clearTimeout(trackingProgressEngineSyncTimeoutRef.current);
        trackingProgressEngineSyncTimeoutRef.current = null;
      }

      const sheetIds = Array.from(trackingProgressEngineSyncSheetIdsRef.current);
      trackingProgressEngineSyncSheetIdsRef.current.clear();
      if (sheetIds.length === 0) {
        return;
      }
      onWorkspaceEngineMutation(sheetIds.length === 1 ? sheetIds[0] : sheetIds);
    },
    [onWorkspaceEngineMutation]
  );

  useEffect(
    () => () => {
      if (trackingProgressEngineSyncTimeoutRef.current !== null) {
        window.clearTimeout(trackingProgressEngineSyncTimeoutRef.current);
        trackingProgressEngineSyncTimeoutRef.current = null;
      }
      trackingProgressEngineSyncSheetIdsRef.current.clear();
    },
    []
  );

  const copySelectedTrackingIds = useCallback(() => {
    if (selectedTrackingIds.length === 0) {
      return;
    }

    void copyText(selectedTrackingIds.join("\n")).catch(() =>
      showNotice({
        tone: "error",
        message: "Gagal menyalin ID kiriman terselect.",
      })
    );
  }, [copyText, selectedTrackingIds, showNotice]);

  const copyAllTrackingIds = useCallback(() => {
    if (allTrackingIds.length === 0 && !rustExportRowsQuery) {
      return;
    }

    void (async () => {
      const trackingIds = rustExportRowsQuery
        ? await collectRustTrackingIds(rustExportRowsQuery)
        : allTrackingIds;
      if (trackingIds.length === 0) {
        return;
      }

      await copyText(trackingIds.join("\n"));
    })().catch(() =>
      showNotice({
        tone: "error",
        message: "Gagal menyalin seluruh ID kiriman.",
      })
    );
  }, [allTrackingIds, copyText, rustExportRowsQuery, showNotice]);

  const copyTrackingId = useCallback(
    (value: string) => {
      const trackingId = value.trim();
      if (!trackingId) {
        return;
      }

      void copyText(trackingId).catch(() =>
        showNotice({
          tone: "error",
          message: "Gagal menyalin ID.",
        })
      );
    },
    [copyText, showNotice]
  );

  const clearSelection = useCallback(() => {
    disarmDeleteSelected();
    updateActiveSheet((current) => clearSelectionInSheet(current));
  }, [disarmDeleteSelected, updateActiveSheet]);

  const clearAllFilters = useCallback(() => {
    updateActiveSheet((current) => clearFiltersInSheet(current));
  }, [updateActiveSheet]);

  const retryFailedRows = useCallback(() => {
    if (retryFailedEntries.length === 0) {
      return;
    }

    disarmDeleteAll();

    if (rustExportRowsQuery) {
      const targetSheetId = activeSheetId;
      const trackingRunId = createWorkspaceTrackingRunId(targetSheetId, "retry");
      const retryRowIds = retryFailedEntries
        .map((entry) => entry.engineRowId?.trim() ?? "")
        .filter(Boolean);

      if (retryRowIds.length !== retryFailedEntries.length) {
        showNotice({
          tone: "error",
          message: "Lacak ulang gagal: target row Rust belum lengkap.",
        });
        return;
      }

      showNotice({
        tone: "info",
        message: "Proses lacak ulang dimulai.",
      });
      flushSync(() => {
        updateSheetById(targetSheetId, (current) =>
          startTrackingRunInSheet(current, trackingRunId)
        );
      });

      void refreshSheetRowsTrackingWithProgress(
        {
          sheetId: targetSheetId,
          rowIds: Array.from(new Set(retryRowIds)),
          forceRefresh: true,
          runId: trackingRunId,
        },
        (event) => {
          if (
            event.type === "tracking_refresh_progress" &&
            event.payload.runId === trackingRunId
          ) {
            updateSheetById(targetSheetId, (current) =>
              applyTrackingRefreshProgressToSheet(current, event.payload, {
                createMissingRow: true,
                runId: trackingRunId,
              })
            );
            if (event.payload.row.rowStatus !== "pending") {
              scheduleTrackingProgressEngineSync(targetSheetId);
            }
          }
        }
      )
        .then((refreshResult) => {
          if (refreshResult.payload.runId !== trackingRunId) {
            return;
          }
          if (refreshResult.payload.rows.length > 0) {
            updateSheetById(targetSheetId, (current) =>
              applyTrackingRefreshRowsToSheet(
                current,
                refreshResult.payload.rows,
                {
                  createMissingRows: true,
                  runId: trackingRunId,
                }
              )
            );
          }
          flushTrackingProgressEngineSync(targetSheetId);

          showNotice({
            tone: refreshResult.payload.failedCount > 0 ? "error" : "success",
            message:
              refreshResult.payload.failedCount > 0
                ? "Lacak ulang gagal."
                : "Lacak ulang berhasil.",
          });
        })
        .catch((error) => {
          showNotice({
            tone: "error",
            message:
              error instanceof Error ? error.message : "Lacak ulang gagal.",
          });
        })
        .finally(() => {
          updateSheetById(targetSheetId, (current) =>
            clearTrackingRunInSheet(current, trackingRunId)
          );
        });
      return;
    }

    showNotice({
      tone: "info",
      message: "Proses lacak ulang dimulai.",
    });

    void refreshTrackingRows(activeSheetId, retryFailedEntries, {
      forceRefresh: true,
    });
  }, [
    activeSheetId,
    disarmDeleteAll,
    retryFailedEntries,
    refreshTrackingRows,
    flushTrackingProgressEngineSync,
    rustExportRowsQuery,
    scheduleTrackingProgressEngineSync,
    showNotice,
    updateSheetById,
  ]);

  const clearHiddenFilters = useCallback(() => {
    updateActiveSheet((current) => clearHiddenFiltersInSheet(current, visibleColumnPathSet));
  }, [updateActiveSheet, visibleColumnPathSet]);

  const deleteSelectedRows = useCallback(async () => {
    if (selectedVisibleRowKeys.length === 0) {
      disarmDeleteSelected();
      return;
    }

    if (deleteSelectedArmedSheetId !== activeSheetId) {
      armDeleteSelected();
      return;
    }

    const targetSheetId = activeSheetId;
    const selectedRowKeysSnapshot = [...selectedVisibleRowKeys];
    const selectedEngineRowIdsSnapshot = [...selectedEngineRowIds];

    disarmDeleteSelected();
    abortRowTrackingWork(targetSheetId, selectedRowKeysSnapshot, "selected_rows_deleted");

    const engineRowIds =
      selectedEngineRowIdsSnapshot.length > 0
        ? selectedEngineRowIdsSnapshot
        : selectedRowKeysSnapshot;
    try {
      await deleteSheetRows({
        sheetId: targetSheetId,
        rowIds: engineRowIds,
      });
      updateActiveSheet((current) =>
        clearSelectionInSheet(deleteRowsInSheet(current, selectedRowKeysSnapshot))
      );
      onWorkspaceEngineMutation?.(targetSheetId);
    } catch (error) {
      console.error("[ShipFlowWorkspace] failed to delete Rust sheet rows", error);
      showNotice({
        tone: "error",
        message: "Gagal menghapus row. Data tetap dipertahankan.",
      });
    }
  }, [
    abortRowTrackingWork,
    activeSheetId,
    armDeleteSelected,
    deleteSelectedArmedSheetId,
    disarmDeleteSelected,
    selectedEngineRowIds,
    selectedVisibleRowKeys,
    onWorkspaceEngineMutation,
    showNotice,
    updateActiveSheet,
  ]);

  const deleteAllRows = useCallback(async () => {
    if (allTrackingIds.length === 0 && !rustExportRowsQuery) {
      return;
    }

    if (!activeSheetDeleteAllArmed) {
      armDeleteAll();
      return;
    }

    const targetSheetId = activeSheetId;

    disarmDeleteAll();
    disarmDeleteSelected();
    invalidateSheetTrackingWork(targetSheetId);

    try {
      await clearSheetRows({
        sheetId: targetSheetId,
      });
      updateActiveSheet(clearAllDataInSheet);
      focusFirstTrackingInput();
      onWorkspaceEngineMutation?.(targetSheetId);
    } catch (error) {
      console.error("[ShipFlowWorkspace] failed to clear Rust sheet rows", error);
      showNotice({
        tone: "error",
        message: "Gagal menghapus semua row. Data tetap dipertahankan.",
      });
    }
  }, [
    activeSheetDeleteAllArmed,
    activeSheetId,
    allTrackingIds.length,
    armDeleteAll,
    disarmDeleteAll,
    disarmDeleteSelected,
    focusFirstTrackingInput,
    invalidateSheetTrackingWork,
    onWorkspaceEngineMutation,
    rustExportRowsQuery,
    showNotice,
    updateActiveSheet,
  ]);

  const exportCsv = useCallback(() => {
    if (exportableTableRows.length === 0 && !rustExportRowsQuery) {
      return;
    }

    const exportColumns = visibleColumns.filter(
      (column) => !CSV_EXCLUDED_COLUMN_PATHS.has(column.path)
    );

    if (exportColumns.length === 0) {
      return;
    }

    void (async () => {
      const rows =
        selectedVisibleRowKeys.length === 0 && rustExportRowsQuery
          ? await collectRustExportRows(rustExportRowsQuery)
          : exportableTableRows;

      if (rows.length === 0) {
        return;
      }

      const header = exportColumns.map((column) => buildCsvValue(column.label));
      const lines = rows.map((row) =>
        exportColumns
          .map((column) => buildCsvValue(row.getFormattedValue(column)))
          .join(",")
      );

      const csvContent = [header.join(","), ...lines].join("\n");
      const dateSuffix = new Date().toISOString().slice(0, 10);
      const suggestedName =
        selectedVisibleRowKeys.length > 0
          ? `shipflow-selected-${dateSuffix}.csv`
          : `shipflow-view-${dateSuffix}.csv`;

      const result = await exportWorkspaceCsv({
        suggestedName,
        csvContent,
        rowCount: rows.length,
      });

      if (!result) {
        return;
      }

      showNotice({
        tone: "success",
        message: `${result.rowCount} row berhasil diexport ke ${result.path}.`,
      });
    })().catch((error) => {
      showNotice({
        tone: "error",
        message: error instanceof Error ? error.message : "Gagal export CSV.",
      });
    });
  }, [
    exportableTableRows,
    rustExportRowsQuery,
    selectedVisibleRowKeys.length,
    showNotice,
    visibleColumns,
  ]);

  const retrackAllRows = useCallback(() => {
    if (retrackableRows.length === 0 && !rustExportRowsQuery) {
      return;
    }

    const targetSheetId = activeSheetId;

    showNotice({
      tone: "info",
      message: "Proses lacak ulang dimulai.",
    });

    if (rustExportRowsQuery) {
      const trackingRunId = createWorkspaceTrackingRunId(targetSheetId, "retrack");
      const isScopedRustQuery = hasScopedRustRowQuery(rustExportRowsQuery);
      flushSync(() => {
        updateSheetById(targetSheetId, (current) =>
          startTrackingRunInSheet(current, trackingRunId)
        );
      });
      void Promise.resolve(
        isScopedRustQuery ? collectRustRefreshRowIds(rustExportRowsQuery) : []
      )
        .then((rowIds) => {
          if (isScopedRustQuery && rowIds.length === 0) {
            return null;
          }

          return refreshSheetRowsTrackingWithProgress(
            {
              sheetId: targetSheetId,
              rowIds,
              forceRefresh: true,
              runId: trackingRunId,
            },
            (event) => {
              if (
                event.type === "tracking_refresh_progress" &&
                event.payload.runId === trackingRunId
              ) {
                updateSheetById(targetSheetId, (current) =>
                  applyTrackingRefreshProgressToSheet(current, event.payload, {
                    createMissingRow: true,
                    runId: trackingRunId,
                  })
                );
                if (event.payload.row.rowStatus !== "pending") {
                  scheduleTrackingProgressEngineSync(targetSheetId);
                }
              }
            }
          );
        })
        .then((refreshResult) => {
          if (!refreshResult) {
            return;
          }
          if (refreshResult.payload.runId !== trackingRunId) {
            return;
          }
          if (refreshResult.payload.rows.length > 0) {
            updateSheetById(targetSheetId, (current) =>
              applyTrackingRefreshRowsToSheet(
                current,
                refreshResult.payload.rows,
                {
                  createMissingRows: true,
                  runId: trackingRunId,
                }
              )
            );
          }
          flushTrackingProgressEngineSync(targetSheetId);

          showNotice({
            tone: refreshResult.payload.failedCount > 0 ? "error" : "success",
            message:
              refreshResult.payload.failedCount > 0
                ? "Lacak ulang gagal."
                : "Lacak ulang berhasil.",
          });
        })
        .catch((error) => {
          showNotice({
            tone: "error",
            message:
              error instanceof Error ? error.message : "Lacak ulang gagal.",
          });
        })
        .finally(() => {
          updateSheetById(targetSheetId, (current) =>
            clearTrackingRunInSheet(current, trackingRunId)
          );
        });
      return;
    }

    const retrackableKeySet = new Set(retrackableRows.map((row) => row.key));
    void refreshTrackingRows(targetSheetId, retrackableRows, {
      forceRefresh: true,
    }).then(() => {
      const refreshedRows =
        workspaceRef.current.sheetsById[targetSheetId]?.rows.filter((row) =>
          retrackableKeySet.has(row.key)
        ) ?? [];
      const failedCount = refreshedRows.filter((row) => row.error).length;

      showNotice({
        tone: failedCount > 0 ? "error" : "success",
        message: failedCount > 0 ? "Lacak ulang gagal." : "Lacak ulang berhasil.",
      });
    });
  }, [
    activeSheetId,
    retrackableRows,
    refreshTrackingRows,
    flushTrackingProgressEngineSync,
    rustExportRowsQuery,
    scheduleTrackingProgressEngineSync,
    showNotice,
    updateSheetById,
    workspaceRef,
  ]);

  const activateSheet = useCallback(
    (sheetId: string) => {
      disarmDeleteAll();
      disarmDeleteSelected();
      if (highlightedColumnTimeoutRef.current !== null) {
        window.clearTimeout(highlightedColumnTimeoutRef.current);
        highlightedColumnTimeoutRef.current = null;
        highlightedColumnSheetIdRef.current = null;
      }
      setHoveredColumn(null);
      setWorkspaceState((current) => setActiveSheetInWorkspace(current, sheetId));
    },
    [
      disarmDeleteAll,
      disarmDeleteSelected,
      highlightedColumnSheetIdRef,
      highlightedColumnTimeoutRef,
      setHoveredColumn,
      setWorkspaceState,
    ]
  );

  const createSheet = useCallback(() => {
    disarmDeleteAll();
    disarmDeleteSelected();
    setHoveredColumn(null);
    const nextWorkspace = createSheetInWorkspace(workspaceRef.current);
    const targetSheetId = nextWorkspace.activeSheetId;
    const metadata = getEngineSheetMetadata(nextWorkspace, targetSheetId);
    if (!metadata) {
      showNotice({
        tone: "error",
        message: "Gagal membuat sheet.",
      });
      return;
    }

    setWorkspaceState(nextWorkspace);
    void createEngineSheet(metadata).catch((error) => {
      showNotice({
        tone: "error",
        message: error instanceof Error ? error.message : "Gagal membuat sheet.",
      });
      setWorkspaceState((current) => deleteSheetInWorkspace(current, targetSheetId));
    });
  }, [
    disarmDeleteAll,
    disarmDeleteSelected,
    setHoveredColumn,
    setWorkspaceState,
    showNotice,
    workspaceRef,
  ]);

  const duplicateSheet = useCallback(
    async (sheetId: string) => {
      disarmDeleteAll();
      disarmDeleteSelected();
      setHoveredColumn(null);
      const nextWorkspace = createSheetInWorkspace(workspaceRef.current, {
        sourceSheetId: sheetId,
      });
      const targetSheetId = nextWorkspace.activeSheetId;
      const metadata = getEngineSheetMetadata(nextWorkspace, targetSheetId);
      if (!metadata) {
        showNotice({
          tone: "error",
          message: "Gagal menduplikasi sheet.",
        });
        return;
      }
      try {
        await createEngineSheet(metadata);
        await copySheetRows({
          sourceSheetId: sheetId,
          targetSheetId,
        });
        onWorkspaceEngineMutation?.([sheetId, targetSheetId]);
        const targetSheet = nextWorkspace.sheetsById[targetSheetId];
        const nextTargetSheet = targetSheet
          ? {
              ...targetSheet,
              rows: createDefaultSheetState().rows,
              selectedRowKeys: [],
              selectionFollowsVisibleRows: false,
            }
          : targetSheet;

        setWorkspaceState({
          ...nextWorkspace,
          sheetsById: nextTargetSheet
            ? {
                ...nextWorkspace.sheetsById,
                [targetSheetId]: nextTargetSheet,
              }
            : nextWorkspace.sheetsById,
        });
      } catch (error) {
        showNotice({
          tone: "error",
          message:
            error instanceof Error ? error.message : "Gagal menduplikasi sheet.",
        });
        void deleteSheet({ sheetId: targetSheetId }).catch(() => undefined);
      }
    },
    [
      disarmDeleteAll,
      disarmDeleteSelected,
      setHoveredColumn,
      setWorkspaceState,
      showNotice,
      onWorkspaceEngineMutation,
      workspaceRef,
    ]
  );

  const renameActiveSheet = useCallback(
    (sheetId: string, name: string) => {
      const normalizedName = name.trim();
      if (!normalizedName) {
        showNotice({
          tone: "error",
          message: "Nama sheet tidak boleh kosong.",
        });
        return;
      }

      const previousWorkspace = workspaceRef.current;
      const nextWorkspace = renameSheetInWorkspace(workspaceRef.current, sheetId, name);
      const meta = nextWorkspace.sheetMetaById[sheetId];
      if (!meta) {
        return;
      }

      setWorkspaceState(nextWorkspace);
      void renameEngineSheet({
        sheetId,
        name: meta.name,
      }).catch((error) => {
        showNotice({
          tone: "error",
          message:
            error instanceof Error ? error.message : "Gagal mengganti nama sheet.",
        });
        setWorkspaceState(previousWorkspace);
      });
    },
    [setWorkspaceState, showNotice, workspaceRef]
  );

  const deleteActiveSheet = useCallback(
    async (sheetId: string) => {
      invalidateSheetTrackingWork(sheetId);
      forgetSheetTrackingRuntime(sheetId);
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
      try {
        await deleteSheet({ sheetId });
      } catch (error) {
        showNotice({
          tone: "error",
          message: error instanceof Error ? error.message : "Gagal menghapus sheet.",
        });
        return;
      }
      setWorkspaceState((current) => deleteSheetInWorkspace(current, sheetId));
    },
    [
      deleteAllArmedSheetIdRef,
      deleteAllTimeoutRef,
      deleteSelectedArmedSheetIdRef,
      deleteSelectedTimeoutRef,
      forgetSheetTrackingRuntime,
      highlightedColumnSheetIdRef,
      highlightedColumnTimeoutRef,
      invalidateSheetTrackingWork,
      setDeleteSelectedArmedSheetId,
      setHoveredColumn,
      setWorkspaceState,
      showNotice,
      sheetScrollPositionsRef,
    ]
  );

  useEffect(() => {
    if (deleteSelectedArmedSheetIdRef.current !== activeSheetId) {
      return;
    }

    if (selectedVisibleRowKeys.length === 0) {
      disarmDeleteSelected();
    }
  }, [activeSheetId, deleteSelectedArmedSheetIdRef, disarmDeleteSelected, selectedVisibleRowKeys.length]);

  useEffect(() => {
    if (deleteSelectedArmedSheetIdRef.current !== activeSheetId) {
      return;
    }

    disarmDeleteSelected();
  }, [activeSheetId, deleteSelectedArmedSheetIdRef, disarmDeleteSelected, selectedVisibleRowKeys.join("|")]);

  return {
    activateSheet,
    clearAllFilters,
    clearHiddenFilters,
    clearSelection,
    copyAllTrackingIds,
    copySelectedTrackingIds,
    copyTrackingId,
    createSheet,
    deleteActiveSheet,
    deleteAllRows,
    deleteSelectedRows,
    duplicateSheet,
    exportCsv,
    renameActiveSheet,
    retrackAllRows,
    retryFailedRows,
  };
}
