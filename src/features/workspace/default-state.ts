import { createDefaultSheetState } from "../sheet/default-state";
import { WorkspaceState } from "./types";

let workspaceSheetCounter = 0;

export function createWorkspaceSheetId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `sheet-${Date.now()}-${workspaceSheetCounter++}`;
}

export function createDefaultSheetName(index: number) {
  return `Sheet ${index}`;
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
      },
    },
    sheetsById: {
      [sheetId]: createDefaultSheetState(),
    },
  };
}
