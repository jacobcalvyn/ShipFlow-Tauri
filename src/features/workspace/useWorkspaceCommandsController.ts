import { Dispatch, MutableRefObject, SetStateAction, useCallback, useEffect } from "react";
import { COLUMNS } from "../sheet/columns";
import {
  clearAllDataInSheet,
  clearFiltersInSheet,
  clearHiddenFiltersInSheet,
  clearSelectionInSheet,
  deleteRowsInSheet,
} from "../sheet/actions";
import { formatColumnValue, buildCsvValue } from "../sheet/utils";
import { SheetState } from "../sheet/types";
import {
  createSheetInWorkspace,
  deleteSheetInWorkspace,
  renameSheetInWorkspace,
  setActiveSheetInWorkspace,
} from "./actions";
import { WorkspaceState } from "./types";

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

type UseWorkspaceCommandsControllerOptions = {
  activeSheetId: string;
  activeSheetDeleteAllArmed: boolean;
  allTrackingIds: string[];
  exportableRows: SheetState["rows"];
  retrackableRows: Array<{ key: string; value: string }>;
  retryFailedEntries: Array<{ key: string; value: string }>;
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
  runBulkPasteFetches: (
    sheetId: string,
    entries: Array<{ key: string; value: string }>
  ) => Promise<void>;
};

export function useWorkspaceCommandsController({
  activeSheetId,
  activeSheetDeleteAllArmed,
  allTrackingIds,
  exportableRows,
  retrackableRows,
  retryFailedEntries,
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
  runBulkPasteFetches,
}: UseWorkspaceCommandsControllerOptions) {
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
    if (allTrackingIds.length === 0) {
      return;
    }

    void copyText(allTrackingIds.join("\n")).catch(() =>
      showNotice({
        tone: "error",
        message: "Gagal menyalin seluruh ID kiriman.",
      })
    );
  }, [allTrackingIds, copyText, showNotice]);

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
    void runBulkPasteFetches(activeSheetId, retryFailedEntries);
    showNotice({
      tone: "info",
      message: "Proses lacak ulang dimulai.",
    });
  }, [
    activeSheetId,
    disarmDeleteAll,
    retryFailedEntries,
    runBulkPasteFetches,
    showNotice,
  ]);

  const clearHiddenFilters = useCallback(() => {
    updateActiveSheet((current) => clearHiddenFiltersInSheet(current, visibleColumnPathSet));
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
    abortRowTrackingWork,
    activeSheetId,
    armDeleteSelected,
    deleteSelectedArmedSheetId,
    disarmDeleteSelected,
    selectedVisibleRowKeys,
    updateActiveSheet,
  ]);

  const deleteAllRows = useCallback(() => {
    if (allTrackingIds.length === 0) {
      return;
    }

    if (!activeSheetDeleteAllArmed) {
      armDeleteAll();
      return;
    }

    disarmDeleteAll();
    invalidateSheetTrackingWork(activeSheetId);
    updateActiveSheet((current) => clearAllDataInSheet(current));
    focusFirstTrackingInput();
  }, [
    activeSheetDeleteAllArmed,
    activeSheetId,
    allTrackingIds.length,
    armDeleteAll,
    disarmDeleteAll,
    focusFirstTrackingInput,
    invalidateSheetTrackingWork,
    updateActiveSheet,
  ]);

  const exportCsv = useCallback(() => {
    if (exportableRows.length === 0) {
      return;
    }

    const exportColumns = visibleColumns.filter(
      (column) => !CSV_EXCLUDED_COLUMN_PATHS.has(column.path)
    );

    if (exportColumns.length === 0) {
      return;
    }

    const header = exportColumns.map((column) => buildCsvValue(column.label));
    const lines = exportableRows.map((row) =>
      exportColumns
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
    showNotice({
      tone: "success",
      message: `${exportableRows.length} row berhasil diexport ke CSV.`,
    });
  }, [exportableRows, selectedVisibleRowKeys.length, showNotice, visibleColumns]);

  const retrackAllRows = useCallback(() => {
    if (retrackableRows.length === 0) {
      return;
    }

    const targetSheetId = activeSheetId;
    const retrackableKeySet = new Set(retrackableRows.map((row) => row.key));

    showNotice({
      tone: "info",
      message: "Proses lacak ulang dimulai.",
    });

    void runBulkPasteFetches(targetSheetId, retrackableRows).then(() => {
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
  }, [activeSheetId, retrackableRows, runBulkPasteFetches, showNotice, workspaceRef]);

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
    setWorkspaceState((current) => createSheetInWorkspace(current));
  }, [disarmDeleteAll, disarmDeleteSelected, setHoveredColumn, setWorkspaceState]);

  const duplicateSheet = useCallback(
    (sheetId: string) => {
      disarmDeleteAll();
      disarmDeleteSelected();
      setHoveredColumn(null);
      setWorkspaceState((current) =>
        createSheetInWorkspace(current, {
          sourceSheetId: sheetId,
        })
      );
    },
    [disarmDeleteAll, disarmDeleteSelected, setHoveredColumn, setWorkspaceState]
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

      setWorkspaceState((current) => renameSheetInWorkspace(current, sheetId, name));
    },
    [setWorkspaceState, showNotice]
  );

  const deleteActiveSheet = useCallback(
    (sheetId: string) => {
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
