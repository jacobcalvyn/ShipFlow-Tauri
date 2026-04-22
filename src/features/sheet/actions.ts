import {
  COLUMNS,
  INITIAL_ROW_COUNT,
  TRACKING_COLUMN_PATH,
} from "./columns";
import { SheetState } from "./types";
import {
  createEmptyRows,
  ensureRowCapacity,
  ensureTrailingEmptyRows,
} from "./utils";
import {
  sanitizeTextFilters,
  sanitizeValueFilters,
  toggleColumnVisibilityState,
  togglePinnedColumnState,
  toggleValueFilterSelection,
} from "./state";

export function setTrackingInputInSheet(
  sheetState: SheetState,
  rowKey: string,
  value: string
) {
  const nextTrackingInput = value;
  const nextTrackingInputTrimmed = nextTrackingInput.trim();

  return {
    ...sheetState,
    rows: ensureTrailingEmptyRows(
      sheetState.rows.map((row) =>
        row.key === rowKey
          ? {
              ...row,
              trackingInput: nextTrackingInput,
              shipment: nextTrackingInputTrimmed === "" ? null : row.shipment,
              loading: false,
              stale:
                nextTrackingInputTrimmed !== "" &&
                row.shipment !== null &&
                nextTrackingInputTrimmed !== row.trackingInput.trim(),
              dirty:
                nextTrackingInputTrimmed !== "" &&
                row.shipment !== null &&
                nextTrackingInputTrimmed !== row.trackingInput.trim(),
              error: "",
            }
          : row
      )
    ),
  };
}

export function clearRowInSheet(sheetState: SheetState, rowKey: string) {
  return {
    ...sheetState,
    rows: sheetState.rows.map((row) =>
      row.key === rowKey
        ? {
            ...row,
            shipment: null,
            loading: false,
            stale: false,
            dirty: false,
            error: "",
          }
        : row
    ),
  };
}

export function setRowServerUnavailableInSheet(
  sheetState: SheetState,
  rowKey: string,
  error: string
) {
  return {
    ...sheetState,
    rows: sheetState.rows.map((row) =>
      row.key === rowKey
        ? {
            ...row,
            shipment: row.shipment,
            loading: false,
            stale: row.shipment !== null,
            dirty: row.shipment !== null,
            error,
          }
        : row
    ),
  };
}

export function setRowLoadingInSheet(
  sheetState: SheetState,
  rowKey: string,
  trackingInput: string
) {
  return {
    ...sheetState,
    rows: sheetState.rows.map((row) =>
      row.key === rowKey
        ? {
            ...row,
            trackingInput,
            loading: true,
            stale: row.shipment !== null,
            dirty: row.shipment !== null,
            error: "",
          }
        : row
    ),
  };
}

export function setRowSuccessInSheet(
  sheetState: SheetState,
  rowKey: string,
  trackingInput: string,
  shipment: NonNullable<(typeof sheetState.rows)[number]["shipment"]>
) {
  return {
    ...sheetState,
    rows: ensureTrailingEmptyRows(
      sheetState.rows.map((row) =>
        row.key === rowKey
          ? {
              ...row,
              trackingInput,
              shipment,
              loading: false,
              stale: false,
              dirty: false,
              error: "",
            }
          : row
      )
    ),
  };
}

export function clearTrackingCellInSheet(sheetState: SheetState, rowKey: string) {
  return {
    ...sheetState,
    rows: ensureTrailingEmptyRows(
      sheetState.rows.map((row) =>
        row.key === rowKey
          ? {
              ...row,
              trackingInput: "",
              shipment: null,
              loading: false,
              stale: false,
              dirty: false,
              error: "",
            }
          : row
      )
    ),
  };
}

export function setRowErrorInSheet(
  sheetState: SheetState,
  rowKey: string,
  error: string
) {
  return {
    ...sheetState,
    rows: sheetState.rows.map((row) =>
      row.key === rowKey
        ? {
            ...row,
            shipment: row.shipment,
            loading: false,
            stale: row.shipment !== null,
            dirty: row.shipment !== null,
            error,
          }
        : row
    ),
  };
}

export function applyBulkPasteToSheet(
  sheetState: SheetState,
  startIndex: number,
  values: string[]
) {
  const requiredLength = startIndex + values.length;
  const expandedRows = ensureRowCapacity([...sheetState.rows], requiredLength);
  const targetKeys: string[] = [];

  for (let offset = 0; offset < values.length; offset += 1) {
    const row = expandedRows[startIndex + offset];
    targetKeys.push(row.key);
    expandedRows[startIndex + offset] = {
      ...row,
      trackingInput: values[offset],
      shipment: null,
      loading: false,
      stale: false,
      dirty: false,
      error: "",
    };
  }

  return {
    sheetState: {
      ...sheetState,
      rows: ensureTrailingEmptyRows(expandedRows),
      selectedRowKeys: Array.from(new Set([...sheetState.selectedRowKeys, ...targetKeys])),
    },
    targetKeys,
  };
}

export function seedTrackingIdsInSheet(sheetState: SheetState, values: string[]) {
  const requiredLength = values.length;
  const expandedRows = ensureRowCapacity([...sheetState.rows], requiredLength);
  const targetKeys: string[] = [];

  for (let index = 0; index < values.length; index += 1) {
    const row = expandedRows[index];
    targetKeys.push(row.key);
    expandedRows[index] = {
      ...row,
      trackingInput: values[index],
      shipment: null,
      loading: false,
      stale: false,
      dirty: false,
      error: "",
    };
  }

  return {
    sheetState: {
      ...sheetState,
      rows: ensureTrailingEmptyRows(expandedRows),
      selectedRowKeys: [],
      selectionFollowsVisibleRows: false,
    },
    targetKeys,
  };
}

export function appendTrackingIdsToSheet(sheetState: SheetState, values: string[]) {
  if (values.length === 0) {
    return {
      sheetState,
      targetKeys: [] as string[],
    };
  }

  let appendStartIndex = 0;
  for (let index = 0; index < sheetState.rows.length; index += 1) {
    const row = sheetState.rows[index];
    if (row.trackingInput.trim() !== "" || row.shipment !== null) {
      appendStartIndex = index + 1;
    }
  }

  const expandedRows = ensureRowCapacity(
    [...sheetState.rows],
    appendStartIndex + values.length
  );
  const targetKeys: string[] = [];

  for (let offset = 0; offset < values.length; offset += 1) {
    const rowIndex = appendStartIndex + offset;
    const row = expandedRows[rowIndex];
    targetKeys.push(row.key);
    expandedRows[rowIndex] = {
      ...row,
      trackingInput: values[offset],
      shipment: null,
      loading: false,
      stale: false,
      dirty: false,
      error: "",
    };
  }

  return {
    sheetState: {
      ...sheetState,
      rows: ensureTrailingEmptyRows(expandedRows),
      selectedRowKeys: sheetState.selectedRowKeys.filter(
        (key) => !targetKeys.includes(key)
      ),
    },
    targetKeys,
  };
}

export function setTextFilterInSheet(
  sheetState: SheetState,
  path: string,
  value: string
) {
  return {
    ...sheetState,
    filters: {
      ...sheetState.filters,
      [path]: value,
    },
  };
}

export function toggleValueFilterInSheet(
  sheetState: SheetState,
  path: string,
  value: string
) {
  return {
    ...sheetState,
    valueFilters: toggleValueFilterSelection(sheetState.valueFilters, path, value),
  };
}

export function clearValueFilterInSheet(sheetState: SheetState, path: string) {
  if (!(path in sheetState.valueFilters)) {
    return sheetState;
  }

  const next = { ...sheetState.valueFilters };
  delete next[path];

  return {
    ...sheetState,
    valueFilters: next,
  };
}

export function setSortInSheet(
  sheetState: SheetState,
  path: string,
  direction: "asc" | "desc" | null
) {
  return {
    ...sheetState,
    sortState: {
      path: direction ? path : null,
      direction: direction ?? "asc",
    },
  };
}

export function toggleRowSelectionInSheet(
  sheetState: SheetState,
  rowKey: string
) {
  return {
    ...sheetState,
    selectionFollowsVisibleRows: false,
    selectedRowKeys: sheetState.selectedRowKeys.includes(rowKey)
      ? sheetState.selectedRowKeys.filter((key) => key !== rowKey)
      : [...sheetState.selectedRowKeys, rowKey],
  };
}

export function toggleVisibleSelectionInSheet(
  sheetState: SheetState,
  allVisibleSelected: boolean,
  visibleSelectableKeys: string[]
) {
  return {
    ...sheetState,
    selectionFollowsVisibleRows: !allVisibleSelected,
    selectedRowKeys: allVisibleSelected
      ? sheetState.selectedRowKeys.filter(
          (key) => !visibleSelectableKeys.includes(key)
        )
      : visibleSelectableKeys,
  };
}

export function syncSelectionWithVisibleRowsInSheet(
  sheetState: SheetState,
  visibleSelectableKeys: string[]
) {
  if (!sheetState.selectionFollowsVisibleRows) {
    return sheetState;
  }

  if (
    sheetState.selectedRowKeys.length === visibleSelectableKeys.length &&
    sheetState.selectedRowKeys.every(
      (key, index) => key === visibleSelectableKeys[index]
    )
  ) {
    return sheetState;
  }

  return {
    ...sheetState,
    selectedRowKeys: visibleSelectableKeys,
  };
}

export function forceSelectionToVisibleRowsInSheet(
  sheetState: SheetState,
  visibleSelectableKeys: string[]
) {
  if (
    sheetState.selectionFollowsVisibleRows &&
    sheetState.selectedRowKeys.length === visibleSelectableKeys.length &&
    sheetState.selectedRowKeys.every(
      (key, index) => key === visibleSelectableKeys[index]
    )
  ) {
    return sheetState;
  }

  return {
    ...sheetState,
    selectionFollowsVisibleRows: true,
    selectedRowKeys: visibleSelectableKeys,
  };
}

export function stopSelectionFollowingVisibleRowsInSheet(sheetState: SheetState) {
  if (!sheetState.selectionFollowsVisibleRows) {
    return sheetState;
  }

  return {
    ...sheetState,
    selectionFollowsVisibleRows: false,
  };
}

export function pruneSelectionToVisibleRowsInSheet(
  sheetState: SheetState,
  visibleSelectableKeys: string[]
) {
  const visibleSelectableKeySet = new Set(visibleSelectableKeys);
  const nextSelectedRowKeys = sheetState.selectedRowKeys.filter((key) =>
    visibleSelectableKeySet.has(key)
  );

  if (
    nextSelectedRowKeys.length === sheetState.selectedRowKeys.length &&
    nextSelectedRowKeys.every((key, index) => key === sheetState.selectedRowKeys[index])
  ) {
    return sheetState;
  }

  return {
    ...sheetState,
    selectedRowKeys: nextSelectedRowKeys,
  };
}

export function clearSelectionInSheet(sheetState: SheetState) {
  return {
    ...sheetState,
    selectionFollowsVisibleRows: false,
    selectedRowKeys: [],
  };
}

export function clearFiltersInSheet(sheetState: SheetState) {
  return {
    ...sheetState,
    filters: {},
    valueFilters: {},
  };
}

export function clearHiddenFiltersInSheet(
  sheetState: SheetState,
  visibleColumnPathSet: Set<string>
) {
  return {
    ...sheetState,
    filters: sanitizeTextFilters(sheetState.filters, visibleColumnPathSet),
    valueFilters: sanitizeValueFilters(
      sheetState.valueFilters,
      visibleColumnPathSet
    ),
  };
}

export function deleteRowsInSheet(
  sheetState: SheetState,
  rowKeys: string[]
) {
  const remainingRows = sheetState.rows.filter((row) => !rowKeys.includes(row.key));
  const filledRows = remainingRows.filter(
    (row) => row.trackingInput.trim() !== "" || row.shipment !== null
  );
  const emptyRows = remainingRows.filter(
    (row) => row.trackingInput.trim() === "" && row.shipment === null
  );

  return {
    ...sheetState,
    rows: [...filledRows, ...emptyRows, ...createEmptyRows(rowKeys.length)],
    selectedRowKeys: sheetState.selectedRowKeys.filter((key) => !rowKeys.includes(key)),
    selectionFollowsVisibleRows: false,
  };
}

export function clearAllDataInSheet(sheetState: SheetState) {
  return {
    ...sheetState,
    rows: createEmptyRows(INITIAL_ROW_COUNT),
    filters: {},
    valueFilters: {},
    sortState: {
      path: null,
      direction: "asc" as const,
    },
    selectedRowKeys: [],
    selectionFollowsVisibleRows: false,
    openColumnMenuPath: null,
    highlightedColumnPath: null,
    deleteAllArmed: false,
  };
}

export function armDeleteAllInSheet(sheetState: SheetState) {
  return {
    ...sheetState,
    selectionFollowsVisibleRows: false,
    selectedRowKeys: [],
    deleteAllArmed: true,
  };
}

export function disarmDeleteAllInSheet(sheetState: SheetState) {
  if (!sheetState.deleteAllArmed) {
    return sheetState;
  }

  return {
    ...sheetState,
    deleteAllArmed: false,
  };
}

export function setColumnWidthInSheet(
  sheetState: SheetState,
  path: string,
  width: number
) {
  if (sheetState.columnWidths[path] === width) {
    return sheetState;
  }

  return {
    ...sheetState,
    columnWidths: {
      ...sheetState.columnWidths,
      [path]: width,
    },
  };
}

export function setOpenColumnMenuInSheet(
  sheetState: SheetState,
  path: string | null
) {
  return {
    ...sheetState,
    openColumnMenuPath: path,
  };
}

export function setHighlightedColumnInSheet(
  sheetState: SheetState,
  path: string | null
) {
  return {
    ...sheetState,
    highlightedColumnPath: path,
  };
}

export function toggleColumnVisibilityInSheet(
  sheetState: SheetState,
  path: string
) {
  if (path === TRACKING_COLUMN_PATH) {
    return sheetState;
  }

  let nextFilters = sheetState.filters;
  let nextValueFilters = sheetState.valueFilters;
  let nextSortState = sheetState.sortState;

  if (!sheetState.hiddenColumnPaths.includes(path)) {
    if (sheetState.filters[path]) {
      nextFilters = { ...sheetState.filters };
      delete nextFilters[path];
    }

    if (path in sheetState.valueFilters) {
      nextValueFilters = { ...sheetState.valueFilters };
      delete nextValueFilters[path];
    }

    if (sheetState.sortState.path === path) {
      nextSortState = { path: null, direction: "asc" };
    }
  }

  return {
    ...sheetState,
    filters: nextFilters,
    valueFilters: nextValueFilters,
    sortState: nextSortState,
    hiddenColumnPaths: toggleColumnVisibilityState(sheetState.hiddenColumnPaths, path),
  };
}

export function togglePinnedColumnInSheet(
  sheetState: SheetState,
  path: string
) {
  return {
    ...sheetState,
    pinnedColumnPaths: togglePinnedColumnState(sheetState.pinnedColumnPaths, path),
  };
}

export function getSortLabel(sheetState: SheetState, path: string) {
  if (sheetState.sortState.path !== path) {
    return "↕";
  }

  return sheetState.sortState.direction === "asc" ? "↑" : "↓";
}

export function getColumnSortDirection(sheetState: SheetState, path: string) {
  return sheetState.sortState.path === path ? sheetState.sortState.direction : null;
}
