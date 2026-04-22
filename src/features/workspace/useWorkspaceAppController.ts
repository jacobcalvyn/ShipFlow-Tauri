import { ComponentProps } from "react";
import { WorkspaceShellView } from "./components/WorkspaceShellView";
import { useWorkspaceDeleteArmController } from "./useWorkspaceDeleteArmController";
import { useWorkspaceInteractionRefs } from "./useWorkspaceInteractionRefs";
import { useWorkspaceInteractionRuntimeController } from "./useWorkspaceInteractionRuntimeController";
import { useWorkspaceSheetViewModel } from "./useWorkspaceSheetViewModel";
import { useWorkspaceShellSurfaceController } from "./useWorkspaceShellSurfaceController";
import { useWorkspaceShellViewController } from "./useWorkspaceShellViewController";
import { useWorkspaceStateController } from "./useWorkspaceStateController";

export function useWorkspaceAppController(): ComponentProps<
  typeof WorkspaceShellView
> {
  const workspaceState = useWorkspaceStateController();
  const surface = useWorkspaceShellSurfaceController({
    workspaceState: workspaceState.workspaceState,
    setWorkspaceState: workspaceState.setWorkspaceState,
  });
  const deleteArm = useWorkspaceDeleteArmController({
    activeSheetId: workspaceState.activeSheetId,
    updateSheet: workspaceState.updateSheet,
  });
  const sheetViewModel = useWorkspaceSheetViewModel(workspaceState.activeSheet);
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
    exportableRows: sheetViewModel.exportableRows,
    retrackableRows: sheetViewModel.retrackableRows,
    retryFailedEntries: sheetViewModel.retryFailedEntries,
    selectedTrackingIds: sheetViewModel.selectedTrackingIds,
    selectedVisibleRowKeys: sheetViewModel.selectedVisibleRowKeys,
    visibleColumns: sheetViewModel.visibleColumns,
    visibleColumnPathSet: sheetViewModel.visibleColumnPathSet,
    visibleSelectableKeys: sheetViewModel.visibleSelectableKeys,
    effectiveColumnWidths: sheetViewModel.effectiveColumnWidths,
    pinnedColumnSet: sheetViewModel.pinnedColumnSet,
    allVisibleSelected: sheetViewModel.allVisibleSelected,
    showNotice: surface.showActionNotice,
  });

  return useWorkspaceShellViewController({
    activeSheet: workspaceState.activeSheet,
    activeSheetId: workspaceState.activeSheetId,
    workspaceTabs: workspaceState.workspaceTabs,
    surface,
    deleteArm,
    sheetViewModel,
    interactionRefs,
    interactionRuntime,
  });
}
