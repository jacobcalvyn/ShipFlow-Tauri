import {
  appendTrackingIdsToSheet,
  clearSelectionInSheet,
  deleteRowsInSheet,
  seedTrackingIdsInSheet,
} from "../sheet/actions";
import { createDefaultSheetState } from "../sheet/default-state";
import { SheetState } from "../sheet/types";
import {
  createDefaultSheetColor,
  createDefaultSheetIcon,
  createDefaultSheetName,
  createWorkspaceSheetId,
} from "./default-state";
import {
  WorkspaceSheetColor,
  WorkspaceSheetIcon,
  WorkspaceState,
} from "./types";

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

function getNextDerivedSheetName(
  workspaceState: WorkspaceState,
  sourceName: string,
  excludedSheetId?: string
) {
  const normalizedSourceName = sourceName.trim() || "Untitled Sheet";
  const existingNames = new Set(
    Object.entries(workspaceState.sheetMetaById)
      .filter(([sheetId]) => sheetId !== excludedSheetId)
      .map(([, sheetMeta]) => normalizeSheetName(sheetMeta.name))
      .filter(Boolean)
  );

  let counter = 1;
  while (
    existingNames.has(normalizeSheetName(`${normalizedSourceName} - ${counter}`))
  ) {
    counter += 1;
  }

  return `${normalizedSourceName} - ${counter}`;
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

function insertSheetIdAfterSource(
  sheetOrder: string[],
  nextSheetId: string,
  sourceSheetId?: string
) {
  if (!sourceSheetId) {
    return [...sheetOrder, nextSheetId];
  }

  const sourceIndex = sheetOrder.indexOf(sourceSheetId);
  if (sourceIndex === -1) {
    return [...sheetOrder, nextSheetId];
  }

  return [
    ...sheetOrder.slice(0, sourceIndex + 1),
    nextSheetId,
    ...sheetOrder.slice(sourceIndex + 1),
  ];
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
  const sourceSheetName = sourceSheet
    ? workspaceState.sheetMetaById[options?.sourceSheetId ?? ""]?.name ?? "Sheet"
    : null;
  const nextSheet = sourceSheet
    ? cloneSheetState(sourceSheet)
    : createDefaultSheetState();
  const nextName = options?.name
    ? getUniqueSheetName(workspaceState, options.name)
    : sourceSheetName
      ? getNextDerivedSheetName(workspaceState, sourceSheetName)
      : getNextDefaultSheetName(workspaceState);
  const nextSheetOrder = insertSheetIdAfterSource(
    workspaceState.sheetOrder,
    nextSheetId,
    options?.sourceSheetId
  );

  return {
    ...workspaceState,
    activeSheetId: options?.activate === false ? workspaceState.activeSheetId : nextSheetId,
    sheetOrder: nextSheetOrder,
    sheetMetaById: {
      ...workspaceState.sheetMetaById,
      [nextSheetId]: {
        name: nextName,
        color: sourceSheet
          ? workspaceState.sheetMetaById[options?.sourceSheetId ?? ""]?.color ??
            createDefaultSheetColor()
          : createDefaultSheetColor(),
        icon: sourceSheet
          ? workspaceState.sheetMetaById[options?.sourceSheetId ?? ""]?.icon ??
            createDefaultSheetIcon()
          : createDefaultSheetIcon(),
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
    sourceSheetId?: string;
  }
) {
  const nextSheetId = createWorkspaceSheetId();
  const seededSheet = seedTrackingIdsInSheet(createDefaultSheetState(), trackingIds);
  const sourceSheetName = options?.sourceSheetId
    ? workspaceState.sheetMetaById[options.sourceSheetId]?.name ?? "Sheet"
    : null;
  const nextName = options?.name
    ? getUniqueSheetName(workspaceState, options.name)
    : sourceSheetName
      ? getNextDerivedSheetName(workspaceState, sourceSheetName)
      : getNextDefaultSheetName(workspaceState);
  const nextSheetOrder = insertSheetIdAfterSource(
    workspaceState.sheetOrder,
    nextSheetId,
    options?.sourceSheetId
  );

  return {
    sheetId: nextSheetId,
    targetKeys: seededSheet.targetKeys,
    workspaceState: {
      ...workspaceState,
      activeSheetId:
        options?.activate === false ? workspaceState.activeSheetId : nextSheetId,
      sheetOrder: nextSheetOrder,
      sheetMetaById: {
        ...workspaceState.sheetMetaById,
        [nextSheetId]: {
          name: nextName,
          color: createDefaultSheetColor(),
          icon: createDefaultSheetIcon(),
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

export function moveTrackingIdsToExistingSheetInWorkspace(
  workspaceState: WorkspaceState,
  sourceSheetId: string,
  targetSheetId: string,
  sourceRowKeys: string[],
  trackingIds: string[]
) {
  if (sourceSheetId === targetSheetId || trackingIds.length === 0) {
    return {
      sheetId: targetSheetId,
      targetKeys: [] as string[],
      workspaceState,
    };
  }

  const appendResult = appendTrackingIdsToExistingSheetInWorkspace(
    workspaceState,
    targetSheetId,
    trackingIds
  );

  const sourceSheet = appendResult.workspaceState.sheetsById[sourceSheetId];
  if (!sourceSheet) {
    return appendResult;
  }

  return {
    sheetId: targetSheetId,
    targetKeys: appendResult.targetKeys,
    workspaceState: {
      ...appendResult.workspaceState,
      sheetsById: {
        ...appendResult.workspaceState.sheetsById,
        [sourceSheetId]: clearSelectionInSheet(
          deleteRowsInSheet(sourceSheet, sourceRowKeys)
        ),
      },
    },
  };
}

export function moveTrackingIdsToNewSheetInWorkspace(
  workspaceState: WorkspaceState,
  sourceSheetId: string,
  sourceRowKeys: string[],
  trackingIds: string[],
  options?: {
    activate?: boolean;
    name?: string;
  }
) {
  const createResult = createSheetWithTrackingIdsInWorkspace(
    workspaceState,
    trackingIds,
    {
      ...options,
      sourceSheetId,
    }
  );
  const sourceSheet = createResult.workspaceState.sheetsById[sourceSheetId];

  if (!sourceSheet || trackingIds.length === 0) {
    return createResult;
  }

  return {
    sheetId: createResult.sheetId,
    targetKeys: createResult.targetKeys,
    workspaceState: {
      ...createResult.workspaceState,
      sheetsById: {
        ...createResult.workspaceState.sheetsById,
        [sourceSheetId]: clearSelectionInSheet(
          deleteRowsInSheet(sourceSheet, sourceRowKeys)
        ),
      },
    },
  };
}

export function updateSheetStyleInWorkspace(
  workspaceState: WorkspaceState,
  sheetId: string,
  style: {
    color: WorkspaceSheetColor;
    icon: WorkspaceSheetIcon;
  }
): WorkspaceState {
  const currentMeta = workspaceState.sheetMetaById[sheetId];
  if (!currentMeta) {
    return workspaceState;
  }

  if (currentMeta.color === style.color && currentMeta.icon === style.icon) {
    return workspaceState;
  }

  return {
    ...workspaceState,
    sheetMetaById: {
      ...workspaceState.sheetMetaById,
      [sheetId]: {
        ...currentMeta,
        color: style.color,
        icon: style.icon,
      },
    },
  };
}

export function mergeSheetIntoExistingSheetInWorkspace(
  workspaceState: WorkspaceState,
  sourceSheetId: string,
  targetSheetId: string
) {
  if (sourceSheetId === targetSheetId) {
    return {
      targetSheetId,
      targetKeys: [] as string[],
      appendedTrackingIds: [] as string[],
      skippedCount: 0,
      workspaceState,
    };
  }

  const sourceSheet = workspaceState.sheetsById[sourceSheetId];
  const targetSheet = workspaceState.sheetsById[targetSheetId];
  if (!sourceSheet || !targetSheet) {
    return {
      targetSheetId,
      targetKeys: [] as string[],
      appendedTrackingIds: [] as string[],
      skippedCount: 0,
      workspaceState,
    };
  }

  const sourceTrackingIds = sourceSheet.rows
    .map((row) => row.trackingInput.trim())
    .filter(Boolean);
  const targetTrackingIdSet = new Set(
    targetSheet.rows.map((row) => row.trackingInput.trim()).filter(Boolean)
  );
  const appendedTrackingIds = sourceTrackingIds.filter(
    (trackingId) => !targetTrackingIdSet.has(trackingId)
  );
  const skippedCount = sourceTrackingIds.length - appendedTrackingIds.length;
  const appendResult = appendTrackingIdsToExistingSheetInWorkspace(
    workspaceState,
    targetSheetId,
    appendedTrackingIds
  );

  return {
    targetSheetId,
    targetKeys: appendResult.targetKeys,
    appendedTrackingIds,
    skippedCount,
    workspaceState: deleteSheetInWorkspace(appendResult.workspaceState, sourceSheetId),
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
