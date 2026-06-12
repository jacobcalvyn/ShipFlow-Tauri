import { ComponentProps, useCallback, useEffect, useState } from "react";
import { listEngineSheets } from "../workspace-engine/client";
import { reconcileWorkspaceSheetsFromEngine } from "./actions";
import { WorkspaceShellView } from "./components/WorkspaceShellView";
import { useWorkspaceDeleteArmController } from "./useWorkspaceDeleteArmController";
import { useWorkspaceInteractionRefs } from "./useWorkspaceInteractionRefs";
import { useWorkspaceInteractionRuntimeController } from "./useWorkspaceInteractionRuntimeController";
import { useWorkspaceSheetViewModel } from "./useWorkspaceSheetViewModel";
import { useWorkspaceShellSurfaceController } from "./useWorkspaceShellSurfaceController";
import { useWorkspaceShellViewController } from "./useWorkspaceShellViewController";
import { useWorkspaceStateController } from "./useWorkspaceStateController";

type WorkspaceEngineMutationScope = string | string[] | undefined;

export function useWorkspaceAppController(): ComponentProps<
  typeof WorkspaceShellView
> {
  const workspaceState = useWorkspaceStateController();
  const [
    workspaceEngineGlobalMutationRevision,
    setWorkspaceEngineGlobalMutationRevision,
  ] =
    useState(0);
  const [
    workspaceEngineSheetMutationRevisionById,
    setWorkspaceEngineSheetMutationRevisionById,
  ] = useState<Record<string, number>>({});
  const markWorkspaceEngineMutation = useCallback((scope?: WorkspaceEngineMutationScope) => {
    const sheetIds = typeof scope === "string" ? [scope] : scope;
    const normalizedSheetIds = Array.from(
      new Set((sheetIds ?? []).map((sheetId) => sheetId.trim()).filter(Boolean))
    );

    if (normalizedSheetIds.length === 0) {
      setWorkspaceEngineGlobalMutationRevision((current) => current + 1);
      return;
    }

    setWorkspaceEngineSheetMutationRevisionById((current) => {
      const next = {
        ...current,
      };
      normalizedSheetIds.forEach((sheetId) => {
        next[sheetId] = (next[sheetId] ?? 0) + 1;
      });
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    void listEngineSheets()
      .then((response) => {
        if (cancelled) {
          return;
        }

        const engineSheets =
          response?.type === "sheets" && Array.isArray(response.payload)
            ? response.payload
            : null;
        if (!engineSheets) {
          return;
        }

        workspaceState.setWorkspaceState((current) => {
          const next = reconcileWorkspaceSheetsFromEngine(current, engineSheets);
          workspaceState.workspaceRef.current = next;
          return next;
        });
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [workspaceState.setWorkspaceState, workspaceState.workspaceRef]);

  const surface = useWorkspaceShellSurfaceController({
    workspaceState: workspaceState.workspaceState,
    setWorkspaceState: workspaceState.setWorkspaceState,
  });
  const deleteArm = useWorkspaceDeleteArmController({
    activeSheetId: workspaceState.activeSheetId,
    updateSheet: workspaceState.updateSheet,
  });
  const workspaceEngineActiveSheetMutationRevision =
    workspaceEngineGlobalMutationRevision +
    (workspaceEngineSheetMutationRevisionById[workspaceState.activeSheetId] ?? 0);
  const sheetViewModel = useWorkspaceSheetViewModel(
    workspaceState.activeSheet,
    workspaceState.activeSheetId,
    surface.workspaceEngineSyncGeneration +
      workspaceEngineActiveSheetMutationRevision,
    workspaceEngineActiveSheetMutationRevision
  );
  const interactionRefs = useWorkspaceInteractionRefs();
  const interactionRuntime = useWorkspaceInteractionRuntimeController({
    activeSheet: workspaceState.activeSheet,
    activeSheetId: workspaceState.activeSheetId,
    workspaceTabs: workspaceState.workspaceTabs,
    workspaceRef: workspaceState.workspaceRef,
    setWorkspaceState: workspaceState.setWorkspaceState,
    updateActiveSheet: workspaceState.updateActiveSheet,
    updateSheet: workspaceState.updateSheet,
    setHoveredColumn: interactionRefs.setHoveredColumn,
    deleteAllTimeoutRef: deleteArm.deleteAllTimeoutRef,
    deleteAllArmedSheetIdRef: deleteArm.deleteAllArmedSheetIdRef,
    deleteSelectedTimeoutRef: deleteArm.deleteSelectedTimeoutRef,
    deleteSelectedArmedSheetIdRef: deleteArm.deleteSelectedArmedSheetIdRef,
    deleteSelectedArmedSheetId: deleteArm.deleteSelectedArmedSheetId,
    setDeleteSelectedArmedSheetId: deleteArm.setDeleteSelectedArmedSheetId,
    armDeleteAll: deleteArm.armDeleteAll,
    disarmDeleteAll: deleteArm.disarmDeleteAll,
    armDeleteSelected: deleteArm.armDeleteSelected,
    disarmDeleteSelected: deleteArm.disarmDeleteSelected,
    resizeStateRef: interactionRefs.resizeStateRef,
    sheetScrollRef: interactionRefs.sheetScrollRef,
    sheetScrollPositionsRef: interactionRefs.sheetScrollPositionsRef,
    columnMenuRefs: interactionRefs.columnMenuRefs,
    highlightedColumnTimeoutRef: interactionRefs.highlightedColumnTimeoutRef,
    highlightedColumnSheetIdRef: interactionRefs.highlightedColumnSheetIdRef,
    activeFilterCount: sheetViewModel.activeFilterCount,
    allTrackingIds: sheetViewModel.allTrackingIds,
    exportableTableRows: sheetViewModel.exportableTableRows,
    rustExportRowsQuery: sheetViewModel.rustExportRowsQuery,
    retrackableRows: sheetViewModel.retrackableRows,
    retryFailedEntries: sheetViewModel.retryFailedEntries,
    selectedEngineRowIds: sheetViewModel.selectedEngineRowIds,
    selectedTrackingIds: sheetViewModel.selectedTrackingIds,
    selectedVisibleRowKeys: sheetViewModel.selectedVisibleRowKeys,
    visibleColumns: sheetViewModel.visibleColumns,
    visibleColumnPathSet: sheetViewModel.visibleColumnPathSet,
    visibleSelectableKeys: sheetViewModel.visibleSelectableKeys,
    effectiveColumnWidths: sheetViewModel.effectiveColumnWidths,
    pinnedColumnSet: sheetViewModel.pinnedColumnSet,
    allVisibleSelected: sheetViewModel.allVisibleSelected,
    showNotice: surface.showActionNotice,
    onWorkspaceEngineMutation: markWorkspaceEngineMutation,
  });

  return useWorkspaceShellViewController({
    activeSheet: workspaceState.activeSheet,
    activeSheetId: workspaceState.activeSheetId,
    workspaceTabs: workspaceState.workspaceTabs,
    updateActiveSheet: workspaceState.updateActiveSheet,
    surface,
    deleteArm,
    sheetViewModel,
    interactionRefs,
    interactionRuntime,
  });
}
