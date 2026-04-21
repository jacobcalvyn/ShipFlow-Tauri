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
import {
  appendTrackingIdsToExistingSheetInWorkspace,
  createSheetWithTrackingIdsInWorkspace,
  moveTrackingIdsToExistingSheetInWorkspace,
  moveTrackingIdsToNewSheetInWorkspace,
} from "./actions";
import { WorkspaceState } from "./types";

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
  runBulkPasteFetches: (
    sheetId: string,
    entries: Array<{ key: string; value: string }>
  ) => Promise<void>;
  showNotice: (notice: SelectionTransferNotice) => void;
};

export function useSelectionTransferController({
  activeSheetId,
  workspaceTabs,
  selectedTrackingIds,
  selectedVisibleRowKeys,
  workspaceRef,
  setWorkspaceState,
  setHoveredColumn,
  disarmDeleteAll,
  disarmDeleteSelected,
  abortRowTrackingWork,
  runBulkPasteFetches,
  showNotice,
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

  const transferSelectedIdsToNewSheet = useCallback(
    (mode: SelectionTransferMode) => {
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
          : createSheetWithTrackingIdsInWorkspace(currentWorkspace, selectedTrackingIds, {
              sourceSheetId: activeSheetId,
            });

      setWorkspaceState(result.workspaceState);

      if (result.targetKeys.length === 0) {
        return;
      }

      showNotice({
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
    },
    [
      abortRowTrackingWork,
      activeSheetId,
      disarmDeleteAll,
      disarmDeleteSelected,
      runBulkPasteFetches,
      selectedTrackingIds,
      selectedVisibleRowKeys,
      setHoveredColumn,
      setWorkspaceState,
      showNotice,
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
      const targetSheetName = currentWorkspace.sheetMetaById[targetSheetId]?.name ?? "Sheet";
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

      showNotice({
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
      setWorkspaceState,
      showNotice,
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
