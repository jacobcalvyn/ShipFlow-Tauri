import { SheetState } from "../sheet/types";

export type WorkspaceSheetMeta = {
  name: string;
};

export type WorkspaceState = {
  version: 1;
  activeSheetId: string;
  sheetOrder: string[];
  sheetMetaById: Record<string, WorkspaceSheetMeta>;
  sheetsById: Record<string, SheetState>;
};
