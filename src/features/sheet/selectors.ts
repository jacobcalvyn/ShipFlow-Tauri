import {
  COLUMNS,
  LATEST_BAG_STATUS_COLUMN_PATH,
  SELECTOR_COLUMN_WIDTH,
  TRACKING_COLUMN_PATH,
} from "./columns";
import { SheetRow, SheetState } from "./types";
import {
  MAX_TRACKING_INPUT_LENGTH,
  compareRows,
  formatColumnValue,
  getColumnToneClass,
  getColumnValueOptions,
  getEffectiveColumnWidth,
} from "./utils";
import { countActiveTextFilters, countActiveValueFilters } from "./state";

const COLUMN_SHORTCUTS = [
  { path: LATEST_BAG_STATUS_COLUMN_PATH, label: "PID/Kantong" },
  { path: "status_akhir.status", label: "Status Akhir" },
  { path: "detail.actors.pengirim.nama", label: "Nama Pengirim" },
  { path: "detail.actors.penerima.nama", label: "Nama Penerima" },
  { path: "detail.origin_detail.nama_kantor", label: "Kantor Kirim" },
  { path: "detail.package_detail.jenis_layanan", label: "Jenis Layanan" },
  { path: "detail.package_detail.isi_kiriman", label: "Isi Kiriman" },
  { path: "detail.billing_detail.cod_info.is_cod", label: "Is COD" },
  { path: "pod.photo1_url", label: "POD Photo" },
  {
    path: "history_summary.bagging_unbagging",
    label: "History Summary",
  },
] as const;

export function getNonEmptyRows(rows: SheetRow[]) {
  return rows.filter((row) => row.trackingInput.trim() !== "" || row.shipment !== null);
}

export function getVisibleColumns(sheetState: SheetState) {
  const hidden = new Set(sheetState.hiddenColumnPaths);
  const orderedVisibleColumns = COLUMNS.filter((column) => !hidden.has(column.path));
  const pinnedColumns = sheetState.pinnedColumnPaths
    .map((path) =>
      orderedVisibleColumns.find((column) => column.path === path) ?? null
    )
    .filter((column): column is (typeof COLUMNS)[number] => column !== null);
  const pinnedPaths = new Set(pinnedColumns.map((column) => column.path));

  return [
    ...pinnedColumns,
    ...orderedVisibleColumns.filter((column) => !pinnedPaths.has(column.path)),
  ];
}

export function getVisibleColumnPathSet(
  visibleColumns: ReturnType<typeof getVisibleColumns>
) {
  return new Set(visibleColumns.map((column) => column.path));
}

export function getPinnedColumnSet(sheetState: SheetState) {
  return new Set(sheetState.pinnedColumnPaths);
}

export function getTrackingColumnAutoWidth(rows: SheetRow[]) {
  const longestTrackingValue = rows.reduce((longest, row) => {
    const candidate =
      row.trackingInput.trim() ||
      row.shipment?.detail?.shipment_header?.nomor_kiriman ||
      "";
    const boundedCandidate = candidate.slice(0, MAX_TRACKING_INPUT_LENGTH);

    return boundedCandidate.length > longest.length ? boundedCandidate : longest;
  }, "");

  if (!longestTrackingValue) {
    return 0;
  }

  const estimatedTextWidth = longestTrackingValue.length * 8.7;
  const trackingCellChromeWidth = 118;
  return Math.ceil(estimatedTextWidth + trackingCellChromeWidth);
}

export function getEffectiveColumnWidths(
  visibleColumns: ReturnType<typeof getVisibleColumns>,
  columnWidths: SheetState["columnWidths"],
  trackingColumnAutoWidth: number
) {
  return Object.fromEntries(
    visibleColumns.map((column) => [
      column.path,
      Math.max(
        getEffectiveColumnWidth(column, columnWidths),
        column.path === TRACKING_COLUMN_PATH ? trackingColumnAutoWidth : 0
      ),
    ])
  );
}

export function getPinnedLeftMap(
  visibleColumns: ReturnType<typeof getVisibleColumns>,
  pinnedColumnSet: Set<string>,
  effectiveColumnWidths: Record<string, number>
) {
  let currentLeft = SELECTOR_COLUMN_WIDTH;
  const nextMap: Record<string, number> = {};

  visibleColumns.forEach((column) => {
    if (!pinnedColumnSet.has(column.path)) {
      return;
    }

    nextMap[column.path] = currentLeft;
    currentLeft += effectiveColumnWidths[column.path];
  });

  return nextMap;
}

export function getActiveFilterCount(
  sheetState: SheetState,
  visibleColumnPathSet: Set<string>
) {
  return (
    countActiveTextFilters(sheetState.filters, visibleColumnPathSet) +
    countActiveValueFilters(sheetState.valueFilters, visibleColumnPathSet)
  );
}

export function getIgnoredHiddenFilterCount(
  sheetState: SheetState,
  activeFilterCount: number
) {
  return (
    countActiveTextFilters(sheetState.filters) +
    countActiveValueFilters(sheetState.valueFilters) -
    activeFilterCount
  );
}

export function getValueOptionsByPath(
  nonEmptyRows: SheetRow[],
  visibleColumns: ReturnType<typeof getVisibleColumns>
) {
  return Object.fromEntries(
    visibleColumns.map((column) => [
      column.path,
      getColumnValueOptions(nonEmptyRows, column),
    ])
  );
}

export function getValueOptionsForOpenColumn(
  nonEmptyRows: SheetRow[],
  visibleColumns: ReturnType<typeof getVisibleColumns>,
  openColumnMenuPath: string | null
) {
  if (!openColumnMenuPath) {
    return {};
  }

  const openColumn = visibleColumns.find((column) => column.path === openColumnMenuPath);
  if (!openColumn) {
    return {};
  }

  return {
    [openColumnMenuPath]: getColumnValueOptions(nonEmptyRows, openColumn),
  };
}

export function getDisplayedRows(
  sheetState: SheetState,
  nonEmptyRows: SheetRow[],
  visibleColumns: ReturnType<typeof getVisibleColumns>,
  activeFilterCount: number
) {
  if (nonEmptyRows.length === 0) {
    return sheetState.rows;
  }

  const hasActiveFilters = activeFilterCount > 0;
  const hasSort = sheetState.sortState.path !== null;

  if (!hasActiveFilters && !hasSort) {
    return sheetState.rows;
  }

  let workingRows = nonEmptyRows.filter((row) => {
    return visibleColumns.every((column) => {
      const filterValue = sheetState.filters[column.path]?.trim().toLowerCase();
      const cellValue = formatColumnValue(row, column).toLowerCase();
      const selectedValues = sheetState.valueFilters[column.path] ?? [];

      if (filterValue && !cellValue.includes(filterValue)) {
        return false;
      }

      if (selectedValues.length > 0) {
        return selectedValues.includes(formatColumnValue(row, column));
      }

      return true;
    });
  });

  if (sheetState.sortState.path) {
    const sortColumn = COLUMNS.find(
      (column) => column.path === sheetState.sortState.path
    );

    if (sortColumn) {
      workingRows = [...workingRows].sort((left, right) =>
        compareRows(left, right, sortColumn, sheetState.sortState.direction)
      );
    }
  }

  const alwaysVisibleRows = sheetState.rows.filter(
    (row) =>
      row.trackingInput.trim() !== "" &&
      (row.loading || row.dirty || row.shipment === null)
  );

  const workingRowKeySet = new Set(workingRows.map((row) => row.key));
  for (const row of alwaysVisibleRows) {
    if (!workingRowKeySet.has(row.key)) {
      workingRows.push(row);
    }
  }

  const draftRows = sheetState.rows
    .filter((row) => row.shipment === null && row.trackingInput.trim() === "")
    .slice(0, 5);

  return [...workingRows, ...draftRows];
}

export function getVisibleSelectableKeys(displayedRows: SheetRow[]) {
  return displayedRows
    .filter((row) => row.trackingInput.trim() !== "" || row.shipment !== null)
    .map((row) => row.key);
}

export function getSelectedVisibleRowKeys(
  selectedRowKeys: string[],
  visibleSelectableKeys: string[]
) {
  const visibleSelectableKeySet = new Set(visibleSelectableKeys);
  return selectedRowKeys.filter((key) => visibleSelectableKeySet.has(key));
}

export function getSelectedTrackingIds(
  rows: SheetRow[],
  selectedVisibleRowKeys: string[]
) {
  return rows
    .filter((row) => selectedVisibleRowKeys.includes(row.key))
    .map((row) => row.trackingInput.trim())
    .filter(Boolean);
}

export function getAllTrackingIds(rows: SheetRow[]) {
  return rows
    .map((row) => row.trackingInput.trim())
    .filter((value) => value !== "");
}

export function getExportableRows(
  rows: SheetRow[],
  displayedRows: SheetRow[],
  selectedVisibleRowKeys: string[]
) {
  if (selectedVisibleRowKeys.length > 0) {
    return rows.filter(
      (row) =>
        selectedVisibleRowKeys.includes(row.key) &&
        (row.trackingInput.trim() !== "" || row.shipment !== null)
    );
  }

  return displayedRows.filter(
    (row) => row.trackingInput.trim() !== "" || row.shipment !== null
  );
}

export function getLoadedCount(displayedRows: SheetRow[]) {
  return displayedRows.filter((row) => row.shipment !== null).length;
}

export function getTotalShipmentCount(nonEmptyRows: SheetRow[]) {
  return nonEmptyRows.filter((row) => row.trackingInput.trim() !== "").length;
}

export function getHiddenColumns(sheetState: SheetState) {
  return COLUMNS.filter((column) => sheetState.hiddenColumnPaths.includes(column.path));
}

export function getColumnShortcuts(visibleColumnPathSet: Set<string>) {
  return COLUMN_SHORTCUTS.map((shortcut) => {
    const column = COLUMNS.find((item) => item.path === shortcut.path);
    return {
      ...shortcut,
      disabled: !visibleColumnPathSet.has(shortcut.path),
      toneClass: column ? getColumnToneClass(column) : "",
    };
  });
}
