import { createDefaultSheetState } from "../sheet/default-state";
import { SheetState } from "../sheet/types";
import type { EngineSheet } from "../workspace-engine/client";
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
  const defaultSheet = createDefaultSheetState();

  return {
    ...sourceSheet,
    analytics: {
      ...sourceSheet.analytics,
      rowPaths: [...sourceSheet.analytics.rowPaths],
      columnPaths: [...sourceSheet.analytics.columnPaths],
      valueMetrics: [...sourceSheet.analytics.valueMetrics],
      metricAggregations: sourceSheet.analytics.metricAggregations
        ? { ...sourceSheet.analytics.metricAggregations }
        : undefined,
    },
    rows: defaultSheet.rows,
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
    activeTrackingRunId: null,
    columnWidths: { ...sourceSheet.columnWidths },
    hiddenColumnPaths: [...sourceSheet.hiddenColumnPaths],
    pinnedColumnPaths: [...sourceSheet.pinnedColumnPaths],
    openColumnMenuPath: null,
    highlightedColumnPath: null,
    deleteAllArmed: false,
    importSourceModalKind: null,
    importSourceDrafts: {
      bag: "",
      manifest: "",
    },
    importSourceLookupStates: {
      bag: {
        loading: false,
        rawResponse: "",
        error: "",
        trackingIds: [],
        jobId: null,
        requestKey: null,
        sourceItemStates: [],
        manifestBagStates: [],
      },
      manifest: {
        loading: false,
        rawResponse: "",
        error: "",
        trackingIds: [],
        jobId: null,
        requestKey: null,
        sourceItemStates: [],
        manifestBagStates: [],
      },
    },
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

export function reconcileWorkspaceSheetsFromEngine(
  workspaceState: WorkspaceState,
  engineSheets: EngineSheet[]
): WorkspaceState {
  if (engineSheets.length === 0) {
    return workspaceState;
  }

  const uniqueEngineSheets = Array.from(
    new Map(engineSheets.map((sheet) => [sheet.sheetId, sheet])).values()
  ).sort((left, right) => {
    if (left.position !== right.position) {
      return left.position - right.position;
    }

    return left.sheetId.localeCompare(right.sheetId);
  });
  const localSheetIdSet = new Set(workspaceState.sheetOrder);
  const hasKnownEngineSheet = uniqueEngineSheets.some((sheet) =>
    localSheetIdSet.has(sheet.sheetId)
  );

  if (!hasKnownEngineSheet) {
    return workspaceState;
  }

  const engineSheetIdSet = new Set(
    uniqueEngineSheets.map((sheet) => sheet.sheetId)
  );
  const nextSheetOrder = [
    ...uniqueEngineSheets.map((sheet) => sheet.sheetId),
    ...workspaceState.sheetOrder.filter((sheetId) => !engineSheetIdSet.has(sheetId)),
  ];
  const nextSheetMetaById = { ...workspaceState.sheetMetaById };
  const nextSheetsById = { ...workspaceState.sheetsById };

  for (const sheet of uniqueEngineSheets) {
    nextSheetMetaById[sheet.sheetId] = {
      name: sheet.name.trim() || sheet.sheetId,
      color:
        workspaceState.sheetMetaById[sheet.sheetId]?.color ??
        createDefaultSheetColor(),
      icon:
        workspaceState.sheetMetaById[sheet.sheetId]?.icon ??
        createDefaultSheetIcon(),
    };

    nextSheetsById[sheet.sheetId] =
      workspaceState.sheetsById[sheet.sheetId] ?? createDefaultSheetState();
  }

  const activeSheetId = nextSheetsById[workspaceState.activeSheetId]
    ? workspaceState.activeSheetId
    : nextSheetOrder[0];

  return {
    ...workspaceState,
    activeSheetId,
    sheetOrder: nextSheetOrder,
    sheetMetaById: nextSheetMetaById,
    sheetsById: nextSheetsById,
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
