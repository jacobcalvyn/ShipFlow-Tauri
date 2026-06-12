import { createDefaultSheetState } from "../sheet/default-state";
import {
  WorkspaceSheetColor,
  WorkspaceSheetIcon,
  WorkspaceState,
} from "./types";

let workspaceSheetCounter = 0;

export const DEFAULT_WORKSPACE_SHEET_ID = "default-sheet";
export const DEFAULT_WORKSPACE_SHEET_NAME = "Sheet 1";

export function createWorkspaceSheetId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `sheet-${Date.now()}-${workspaceSheetCounter++}`;
}

export function createDefaultSheetName(index: number) {
  return `Sheet ${index}`;
}

export function createDefaultSheetColor(): WorkspaceSheetColor {
  return "slate";
}

export function createDefaultSheetIcon(): WorkspaceSheetIcon {
  return "sheet";
}

export function createDefaultWorkspaceState(): WorkspaceState {
  const sheetId = DEFAULT_WORKSPACE_SHEET_ID;

  return {
    version: 1,
    activeSheetId: sheetId,
    sheetOrder: [sheetId],
    sheetMetaById: {
      [sheetId]: {
        name: DEFAULT_WORKSPACE_SHEET_NAME,
        color: createDefaultSheetColor(),
        icon: createDefaultSheetIcon(),
      },
    },
    sheetsById: {
      [sheetId]: createDefaultSheetState(),
    },
  };
}
