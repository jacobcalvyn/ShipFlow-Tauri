import { SheetState } from "../sheet/types";
import { WorkspaceState } from "./types";

export function getActiveSheet(workspaceState: WorkspaceState): SheetState {
  const activeSheet = workspaceState.sheetsById[workspaceState.activeSheetId];

  if (activeSheet) {
    return activeSheet;
  }

  const firstSheetId = workspaceState.sheetOrder[0];
  if (firstSheetId && workspaceState.sheetsById[firstSheetId]) {
    return workspaceState.sheetsById[firstSheetId];
  }

  throw new Error("Workspace does not contain an active sheet.");
}

export function getActiveSheetName(workspaceState: WorkspaceState): string {
  const activeSheetId =
    workspaceState.sheetsById[workspaceState.activeSheetId]
      ? workspaceState.activeSheetId
      : workspaceState.sheetOrder[0];

  if (!activeSheetId) {
    throw new Error("Workspace does not contain an active sheet.");
  }

  return workspaceState.sheetMetaById[activeSheetId]?.name ?? "Sheet";
}

export function getWorkspaceTabs(workspaceState: WorkspaceState) {
  return workspaceState.sheetOrder
    .filter((sheetId) => workspaceState.sheetsById[sheetId])
    .map((sheetId) => ({
      id: sheetId,
      name: workspaceState.sheetMetaById[sheetId]?.name ?? "Sheet",
      color: workspaceState.sheetMetaById[sheetId]?.color ?? "slate",
      icon: workspaceState.sheetMetaById[sheetId]?.icon ?? "sheet",
      isActive: sheetId === workspaceState.activeSheetId,
    }));
}
