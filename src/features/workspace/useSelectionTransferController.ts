import {
  DragEvent as ReactDragEvent,
  Dispatch,
  MutableRefObject,
  SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { flushSync } from "react-dom";
import {
  createSheetInWorkspace,
} from "./actions";
import { WorkspaceState } from "./types";
import { clearSelectionInSheet, deleteRowsInSheet } from "../sheet/actions";
import { createDefaultSheetState } from "../sheet/default-state";
import {
  createEngineSheet,
  deleteSheet,
  querySheetRows,
  transferSheetRows,
} from "../workspace-engine/client";

export type SelectionTransferMode = "copy" | "move";

type SheetTransferTab = {
  id: string;
  name: string;
};

type SelectionTransferNotice = {
  tone: "success" | "error" | "info";
  message: string;
};

type UseSelectionTransferControllerOptions = {
  activeSheetId: string;
  workspaceTabs: SheetTransferTab[];
  selectedTrackingIds: string[];
  selectedEngineRowIds: string[];
  selectedVisibleRowKeys: string[];
  workspaceRef: MutableRefObject<WorkspaceState>;
  setWorkspaceState: Dispatch<SetStateAction<WorkspaceState>>;
  setHoveredColumn: Dispatch<SetStateAction<number | null>>;
  disarmDeleteAll: () => void;
  disarmDeleteSelected: () => void;
  abortRowTrackingWork: (
    sheetId: string,
    rowKeys: string[],
    reason: "selected_rows_deleted" | "sheet_invalidation" | "cell_cleared" | "bulk_paste_overwrite"
  ) => void;
  showNotice: (notice: SelectionTransferNotice) => void;
  onWorkspaceEngineMutation?: (sheetIds?: string | string[]) => void;
};

const TRANSFER_ROW_RESOLUTION_LIMIT = 100_000;

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

export function useSelectionTransferController({
  activeSheetId,
  workspaceTabs,
  selectedTrackingIds,
  selectedEngineRowIds,
  selectedVisibleRowKeys,
  workspaceRef,
  setWorkspaceState,
  setHoveredColumn,
  disarmDeleteAll,
  disarmDeleteSelected,
  abortRowTrackingWork,
  showNotice,
  onWorkspaceEngineMutation,
}: UseSelectionTransferControllerOptions) {
  const [isSheetTransferDragActive, setIsSheetTransferDragActive] = useState(false);

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
  const resolveSelectedEngineMutationRowIds = useCallback(async () => {
    const selectedEngineRowIdsMirrorUiKeys =
      selectedEngineRowIds.length === selectedVisibleRowKeys.length &&
      selectedEngineRowIds.every((rowId, index) => rowId === selectedVisibleRowKeys[index]);
    if (
      selectedEngineRowIds.length === selectedTrackingIds.length &&
      selectedEngineRowIds.every((rowId) => rowId.trim() !== "") &&
      !selectedEngineRowIdsMirrorUiKeys
    ) {
      return selectedEngineRowIds;
    }

    const response = await querySheetRows({
      sheetId: activeSheetId,
      offset: 0,
      limit: TRANSFER_ROW_RESOLUTION_LIMIT,
      filters: [],
      sort: [],
    });
    const rowIdsByTrackingId = new Map<string, string[]>();
    for (const row of response.payload.rows) {
      const trackingId = row.displayTrackingId.trim();
      if (!trackingId) {
        continue;
      }

      const rowIds = rowIdsByTrackingId.get(trackingId) ?? [];
      rowIds.push(row.rowId);
      rowIdsByTrackingId.set(trackingId, rowIds);
    }

    const resolvedRowIds = selectedTrackingIds.map((trackingId) => {
      const rowIds = rowIdsByTrackingId.get(trackingId.trim()) ?? [];
      const rowId = rowIds.shift();
      if (!rowId) {
        throw new Error(`Missing engine row for ${trackingId}.`);
      }
      return rowId;
    });

    return resolvedRowIds;
  }, [activeSheetId, selectedEngineRowIds, selectedTrackingIds, selectedVisibleRowKeys]);

  const clearTargetSheetRows = useCallback(
    (workspaceState: WorkspaceState, targetSheetId: string) => {
      const targetSheet = workspaceState.sheetsById[targetSheetId];
      if (!targetSheet) {
        return workspaceState;
      }

      return {
        ...workspaceState,
        sheetsById: {
          ...workspaceState.sheetsById,
          [targetSheetId]: {
            ...targetSheet,
            rows: createDefaultSheetState().rows,
            selectedRowKeys: [],
            selectionFollowsVisibleRows: false,
          },
        },
      };
    },
    []
  );

  const removeSelectedRowsFromSource = useCallback(
    (workspaceState: WorkspaceState) => {
      const sourceSheet = workspaceState.sheetsById[activeSheetId];
      if (!sourceSheet) {
        return workspaceState;
      }

      return {
        ...workspaceState,
        sheetsById: {
          ...workspaceState.sheetsById,
          [activeSheetId]: clearSelectionInSheet(
            deleteRowsInSheet(sourceSheet, selectedVisibleRowKeys)
          ),
        },
      };
    },
    [activeSheetId, selectedVisibleRowKeys]
  );

  const transferSelectedIdsToNewSheet = useCallback(
    async (mode: SelectionTransferMode) => {
      if (selectedTrackingIds.length === 0) {
        return;
      }

      disarmDeleteAll();
      disarmDeleteSelected();
      setHoveredColumn(null);

      if (mode === "move") {
        abortRowTrackingWork(activeSheetId, selectedVisibleRowKeys, "selected_rows_deleted");
      }

      const createdWorkspace = createSheetInWorkspace(workspaceRef.current, {
        sourceSheetId: activeSheetId,
      });
      const targetSheetId = createdWorkspace.activeSheetId;
      const emptyTargetWorkspace = clearTargetSheetRows(
        createdWorkspace,
        targetSheetId
      );

      const nextWorkspaceState =
        mode === "move"
          ? removeSelectedRowsFromSource(emptyTargetWorkspace)
          : emptyTargetWorkspace;
      try {
        const rowIds = await resolveSelectedEngineMutationRowIds();
        const metadata = getEngineSheetMetadata(emptyTargetWorkspace, targetSheetId);
        if (!metadata) {
          throw new Error("Missing target sheet metadata.");
        }
        await createEngineSheet(metadata);
        await transferSheetRows({
          sourceSheetId: activeSheetId,
          targetSheetId,
          rowIds,
          mode,
        });
        flushSync(() => {
          onWorkspaceEngineMutation?.([activeSheetId, targetSheetId]);
        });
      } catch (error) {
        showNotice({
          tone: "error",
          message:
            error instanceof Error
              ? error.message
              : "Gagal memindahkan ID lewat engine.",
        });
        void deleteSheet({ sheetId: targetSheetId }).catch(() => undefined);
        return;
      }

      workspaceRef.current = nextWorkspaceState;
      setWorkspaceState(nextWorkspaceState);

      showNotice({
        tone: "success",
        message:
          mode === "move"
            ? `${selectedTrackingIds.length} ID dipindahkan ke sheet baru.`
            : `${selectedTrackingIds.length} ID disalin ke sheet baru.`,
      });

    },
    [
      abortRowTrackingWork,
      activeSheetId,
      clearTargetSheetRows,
      disarmDeleteAll,
      disarmDeleteSelected,
      removeSelectedRowsFromSource,
      resolveSelectedEngineMutationRowIds,
      selectedTrackingIds,
      selectedVisibleRowKeys,
      setHoveredColumn,
      setWorkspaceState,
      showNotice,
      onWorkspaceEngineMutation,
      workspaceRef,
    ]
  );

  const beginSelectedIdsDrag = useCallback(
    (event: ReactDragEvent<HTMLButtonElement>) => {
      if (selectedTrackingIds.length === 0) {
        event.preventDefault();
        return;
      }

      const payload = JSON.stringify({
        sourceSheetId: activeSheetId,
        rowKeys: selectedVisibleRowKeys,
        engineRowIds: selectedEngineRowIds,
        trackingIds: selectedTrackingIds,
      });

      event.dataTransfer.setData("application/x-shipflow-selected-ids", payload);
      event.dataTransfer.setData("text/plain", selectedTrackingIds.join("\n"));
      event.dataTransfer.effectAllowed = "copyMove";
      setIsSheetTransferDragActive(true);
    },
    [activeSheetId, selectedEngineRowIds, selectedTrackingIds, selectedVisibleRowKeys]
  );

  const endSelectedIdsDrag = useCallback(() => {
    setIsSheetTransferDragActive(false);
  }, []);

  const transferSelectedIdsToExistingSheet = useCallback(
    async (mode: SelectionTransferMode, targetSheetId: string) => {
      if (selectedTrackingIds.length === 0) {
        return;
      }

      disarmDeleteAll();
      disarmDeleteSelected();

      if (mode === "move") {
        abortRowTrackingWork(activeSheetId, selectedVisibleRowKeys, "selected_rows_deleted");
      }

      const currentWorkspace = workspaceRef.current;
      const targetSheetName = currentWorkspace.sheetMetaById[targetSheetId]?.name ?? "Sheet";

      const nextWorkspaceState =
        mode === "move" ? removeSelectedRowsFromSource(currentWorkspace) : currentWorkspace;
      try {
        const rowIds = await resolveSelectedEngineMutationRowIds();
        await transferSheetRows({
          sourceSheetId: activeSheetId,
          targetSheetId,
          rowIds,
          mode,
        });
        flushSync(() => {
          onWorkspaceEngineMutation?.([activeSheetId, targetSheetId]);
        });
      } catch (error) {
        showNotice({
          tone: "error",
          message:
            error instanceof Error
              ? error.message
              : "Gagal memindahkan ID lewat engine.",
        });
        return;
      }

      if (nextWorkspaceState !== currentWorkspace) {
        workspaceRef.current = nextWorkspaceState;
        setWorkspaceState(nextWorkspaceState);
      }

      showNotice({
        tone: "success",
        message:
          mode === "move"
            ? `${selectedTrackingIds.length} ID dipindahkan ke ${targetSheetName}.`
            : `${selectedTrackingIds.length} ID ditambahkan ke ${targetSheetName}.`,
      });

    },
    [
      abortRowTrackingWork,
      activeSheetId,
      disarmDeleteAll,
      disarmDeleteSelected,
      removeSelectedRowsFromSource,
      resolveSelectedEngineMutationRowIds,
      selectedTrackingIds,
      selectedVisibleRowKeys,
      setWorkspaceState,
      showNotice,
      onWorkspaceEngineMutation,
      workspaceRef,
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

  useEffect(() => {
    if (selectedTrackingIds.length === 0 || appendTargetSheets.length === 0) {
      setIsSheetTransferDragActive(false);
    }
  }, [appendTargetSheets.length, selectedTrackingIds.length]);

  return {
    appendTargetSheets,
    beginSelectedIdsDrag,
    dropSelectedIdsToExistingSheet,
    dropSelectedIdsToNewSheet,
    endSelectedIdsDrag,
    isSheetTransferDragActive,
    transferSelectedIdsToExistingSheet,
    transferSelectedIdsToNewSheet,
  };
}
