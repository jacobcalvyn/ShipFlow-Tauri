import { SheetState } from "../sheet/types";

export type WorkspaceSheetColor =
  | "slate"
  | "blue"
  | "green"
  | "amber"
  | "rose"
  | "violet";

export type WorkspaceSheetIcon =
  | "sheet"
  | "pin"
  | "stack"
  | "flag"
  | "star";

export type WorkspaceSheetMeta = {
  name: string;
  color: WorkspaceSheetColor;
  icon: WorkspaceSheetIcon;
};

export type WorkspaceState = {
  version: 1;
  activeSheetId: string;
  sheetOrder: string[];
  sheetMetaById: Record<string, WorkspaceSheetMeta>;
  sheetsById: Record<string, SheetState>;
};
