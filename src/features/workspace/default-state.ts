import { createDefaultSheetState } from "../sheet/default-state";
import {
  WorkspaceSheetColor,
  WorkspaceSheetIcon,
  WorkspaceState,
} from "./types";

let workspaceSheetCounter = 0;

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
  const sheetId = createWorkspaceSheetId();

  return {
    version: 1,
    activeSheetId: sheetId,
    sheetOrder: [sheetId],
    sheetMetaById: {
      [sheetId]: {
        name: createDefaultSheetName(1),
        color: createDefaultSheetColor(),
        icon: createDefaultSheetIcon(),
      },
    },
    sheetsById: {
      [sheetId]: createDefaultSheetState(),
    },
  };
}
