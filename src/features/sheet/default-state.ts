import {
  COLUMNS,
  HIDDEN_COLUMNS_STORAGE_KEY,
  INITIAL_ROW_COUNT,
  PINNED_COLUMNS_STORAGE_KEY,
} from "./columns";
import { SheetState } from "./types";
import {
  createEmptyRows,
  getInitialColumnWidths,
  loadStoredStringArray,
} from "./utils";

export function createDefaultSheetState(): SheetState {
  return {
    rows: createEmptyRows(INITIAL_ROW_COUNT),
    filters: {},
    valueFilters: {},
    sortState: {
      path: null,
      direction: "asc",
    },
    selectedRowKeys: [],
    selectionFollowsVisibleRows: false,
    columnWidths: getInitialColumnWidths(),
    hiddenColumnPaths: loadStoredStringArray(HIDDEN_COLUMNS_STORAGE_KEY, []),
    pinnedColumnPaths: loadStoredStringArray(
      PINNED_COLUMNS_STORAGE_KEY,
      COLUMNS.filter((column) => column.sticky).map((column) => column.path)
    ),
    openColumnMenuPath: null,
    highlightedColumnPath: null,
    deleteAllArmed: false,
  };
}
