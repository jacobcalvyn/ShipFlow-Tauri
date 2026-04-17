import {
  appendTrackingIdsToSheet,
  seedTrackingIdsInSheet,
} from "../sheet/actions";
import { createDefaultSheetState } from "../sheet/default-state";
import { SheetState } from "../sheet/types";
import {
  createDefaultSheetName,
  createWorkspaceSheetId,
} from "./default-state";
import { WorkspaceState } from "./types";

function cloneSheetState(sourceSheet: SheetState): SheetState {
  return {
    ...sourceSheet,
    rows: sourceSheet.rows.map((row) => ({
      ...row,
      loading: false,
      error: "",
    })),
    filters: { ...sourceSheet.filters },
    valueFilters: Object.fromEntries(
      Object.entries(sourceSheet.valueFilters).map(([path, values]) => [
        path,
        [...values],
      ])
    ),
    sortState: { ...sourceSheet.sortState },
    selectedRowKeys: [],
    selectionFollowsVisibleRows: false,
    columnWidths: { ...sourceSheet.columnWidths },
    hiddenColumnPaths: [...sourceSheet.hiddenColumnPaths],
    pinnedColumnPaths: [...sourceSheet.pinnedColumnPaths],
    openColumnMenuPath: null,
    highlightedColumnPath: null,
    deleteAllArmed: false,
  };
}

function normalizeSheetName(name: string) {
  return name.trim().toLocaleLowerCase();
}

function getUniqueSheetName(
  workspaceState: WorkspaceState,
  preferredName: string,
  excludedSheetId?: string
) {
  const normalizedName = preferredName.trim() || "Untitled Sheet";
  const existingNames = new Set(
    Object.entries(workspaceState.sheetMetaById)
      .filter(([sheetId]) => sheetId !== excludedSheetId)
      .map(([, sheetMeta]) => normalizeSheetName(sheetMeta.name))
      .filter(Boolean)
  );

  if (!existingNames.has(normalizeSheetName(normalizedName))) {
    return normalizedName;
  }

  let counter = 2;
  while (existingNames.has(normalizeSheetName(`${normalizedName} (${counter})`))) {
    counter += 1;
  }

  return `${normalizedName} (${counter})`;
}

function getNextDefaultSheetName(workspaceState: WorkspaceState) {
  const existingNames = new Set(
    Object.values(workspaceState.sheetMetaById)
      .map((sheetMeta) => normalizeSheetName(sheetMeta.name))
      .filter(Boolean)
  );
  let index = workspaceState.sheetOrder.length + 1;
  let candidate = createDefaultSheetName(index);

  while (existingNames.has(normalizeSheetName(candidate))) {
    index += 1;
    candidate = createDefaultSheetName(index);
  }

  return candidate;
}

export function updateSheetInWorkspace(
  workspaceState: WorkspaceState,
  sheetId: string,
  updater: (sheetState: SheetState) => SheetState
): WorkspaceState {
  const currentSheet = workspaceState.sheetsById[sheetId];

  if (!currentSheet) {
    return workspaceState;
  }

  const nextSheet = updater(currentSheet);

  if (nextSheet === currentSheet) {
    return workspaceState;
  }

  return {
    ...workspaceState,
    sheetsById: {
      ...workspaceState.sheetsById,
      [sheetId]: nextSheet,
    },
  };
}

export function updateActiveSheetInWorkspace(
  workspaceState: WorkspaceState,
  updater: (sheetState: SheetState) => SheetState
): WorkspaceState {
  const activeSheetId =
    workspaceState.sheetsById[workspaceState.activeSheetId]
      ? workspaceState.activeSheetId
      : workspaceState.sheetOrder[0];

  if (!activeSheetId) {
    return workspaceState;
  }

  return updateSheetInWorkspace(workspaceState, activeSheetId, updater);
}

export function setActiveSheetInWorkspace(
  workspaceState: WorkspaceState,
  sheetId: string
): WorkspaceState {
  if (!workspaceState.sheetsById[sheetId]) {
    return workspaceState;
  }

  if (workspaceState.activeSheetId === sheetId) {
    return workspaceState;
  }

  return {
    ...workspaceState,
    activeSheetId: sheetId,
  };
}

export function createSheetInWorkspace(
  workspaceState: WorkspaceState,
  options?: {
    sourceSheetId?: string;
    activate?: boolean;
    name?: string;
  }
): WorkspaceState {
  const nextSheetId = createWorkspaceSheetId();
  const sourceSheet =
    options?.sourceSheetId
      ? workspaceState.sheetsById[options.sourceSheetId]
      : null;
  const nextSheet = sourceSheet
    ? cloneSheetState(sourceSheet)
    : createDefaultSheetState();
  const baseName =
    options?.name ??
    (sourceSheet
      ? `${workspaceState.sheetMetaById[options?.sourceSheetId ?? ""]?.name ?? "Sheet"} Copy`
      : getNextDefaultSheetName(workspaceState));
  const nextName = getUniqueSheetName(workspaceState, baseName);

  return {
    ...workspaceState,
    activeSheetId: options?.activate === false ? workspaceState.activeSheetId : nextSheetId,
    sheetOrder: [...workspaceState.sheetOrder, nextSheetId],
    sheetMetaById: {
      ...workspaceState.sheetMetaById,
      [nextSheetId]: {
        name: nextName,
      },
    },
    sheetsById: {
      ...workspaceState.sheetsById,
      [nextSheetId]: nextSheet,
    },
  };
}

export function createSheetWithTrackingIdsInWorkspace(
  workspaceState: WorkspaceState,
  trackingIds: string[],
  options?: {
    activate?: boolean;
    name?: string;
  }
) {
  const nextSheetId = createWorkspaceSheetId();
  const seededSheet = seedTrackingIdsInSheet(createDefaultSheetState(), trackingIds);
  const nextName = getUniqueSheetName(
    workspaceState,
    options?.name ?? getNextDefaultSheetName(workspaceState)
  );

  return {
    sheetId: nextSheetId,
    targetKeys: seededSheet.targetKeys,
    workspaceState: {
      ...workspaceState,
      activeSheetId:
        options?.activate === false ? workspaceState.activeSheetId : nextSheetId,
      sheetOrder: [...workspaceState.sheetOrder, nextSheetId],
      sheetMetaById: {
        ...workspaceState.sheetMetaById,
        [nextSheetId]: {
          name: nextName,
        },
      },
      sheetsById: {
        ...workspaceState.sheetsById,
        [nextSheetId]: seededSheet.sheetState,
      },
    },
  };
}

export function appendTrackingIdsToExistingSheetInWorkspace(
  workspaceState: WorkspaceState,
  sheetId: string,
  trackingIds: string[]
) {
  const targetSheet = workspaceState.sheetsById[sheetId];
  if (!targetSheet || trackingIds.length === 0) {
    return {
      sheetId,
      targetKeys: [] as string[],
      workspaceState,
    };
  }

  const appendedSheet = appendTrackingIdsToSheet(targetSheet, trackingIds);

  return {
    sheetId,
    targetKeys: appendedSheet.targetKeys,
    workspaceState: {
      ...workspaceState,
      sheetsById: {
        ...workspaceState.sheetsById,
        [sheetId]: appendedSheet.sheetState,
      },
    },
  };
}

export function renameSheetInWorkspace(
  workspaceState: WorkspaceState,
  sheetId: string,
  nextName: string
): WorkspaceState {
  if (!workspaceState.sheetMetaById[sheetId]) {
    return workspaceState;
  }

  const uniqueName = getUniqueSheetName(workspaceState, nextName, sheetId);

  if (workspaceState.sheetMetaById[sheetId].name === uniqueName) {
    return workspaceState;
  }

  return {
    ...workspaceState,
    sheetMetaById: {
      ...workspaceState.sheetMetaById,
      [sheetId]: {
        ...workspaceState.sheetMetaById[sheetId],
        name: uniqueName,
      },
    },
  };
}

export function deleteSheetInWorkspace(
  workspaceState: WorkspaceState,
  sheetId: string
): WorkspaceState {
  if (!workspaceState.sheetsById[sheetId] || workspaceState.sheetOrder.length <= 1) {
    return workspaceState;
  }

  const sheetIndex = workspaceState.sheetOrder.indexOf(sheetId);
  const nextSheetOrder = workspaceState.sheetOrder.filter(
    (currentSheetId) => currentSheetId !== sheetId
  );
  const nextActiveSheetId =
    workspaceState.activeSheetId === sheetId
      ? nextSheetOrder[Math.max(sheetIndex - 1, 0)] ?? nextSheetOrder[0]
      : workspaceState.activeSheetId;

  const { [sheetId]: _removedSheet, ...remainingSheets } = workspaceState.sheetsById;
  const { [sheetId]: _removedMeta, ...remainingMeta } = workspaceState.sheetMetaById;

  return {
    ...workspaceState,
    activeSheetId: nextActiveSheetId,
    sheetOrder: nextSheetOrder,
    sheetMetaById: remainingMeta,
    sheetsById: remainingSheets,
  };
}
