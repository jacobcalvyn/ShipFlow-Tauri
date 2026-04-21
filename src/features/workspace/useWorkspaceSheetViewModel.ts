import { useMemo } from "react";
import {
  getActiveFilterCount,
  getAllTrackingIds,
  getColumnShortcuts,
  getDisplayedRows,
  getEffectiveColumnWidths,
  getExportableRows,
  getHiddenColumns,
  getIgnoredHiddenFilterCount,
  getLoadedCount,
  getNonEmptyRows,
  getPinnedColumnSet,
  getPinnedLeftMap,
  getSelectedTrackingIds,
  getSelectedVisibleRowKeys,
  getTotalShipmentCount,
  getTrackingColumnAutoWidth,
  getValueOptionsForOpenColumn,
  getVisibleColumnPathSet,
  getVisibleColumns,
  getVisibleSelectableKeys,
} from "../sheet/selectors";
import { SheetState } from "../sheet/types";

export function useWorkspaceSheetViewModel(activeSheet: SheetState) {
  const nonEmptyRows = useMemo(() => getNonEmptyRows(activeSheet.rows), [activeSheet.rows]);

  const retrackableRows = useMemo(
    () =>
      nonEmptyRows
        .filter((row) => row.trackingInput.trim() !== "")
        .map((row) => ({ key: row.key, value: row.trackingInput.trim() })),
    [nonEmptyRows]
  );

  const totalShipmentCount = useMemo(
    () => getTotalShipmentCount(nonEmptyRows),
    [nonEmptyRows]
  );

  const visibleColumns = useMemo(() => getVisibleColumns(activeSheet), [activeSheet]);

  const visibleColumnPathSet = useMemo(
    () => getVisibleColumnPathSet(visibleColumns),
    [visibleColumns]
  );

  const pinnedColumnSet = useMemo(
    () => getPinnedColumnSet(activeSheet),
    [activeSheet]
  );

  const trackingColumnAutoWidth = useMemo(
    () => getTrackingColumnAutoWidth(nonEmptyRows),
    [nonEmptyRows]
  );

  const effectiveColumnWidths = useMemo(
    () =>
      getEffectiveColumnWidths(
        visibleColumns,
        activeSheet.columnWidths,
        trackingColumnAutoWidth
      ),
    [activeSheet.columnWidths, trackingColumnAutoWidth, visibleColumns]
  );

  const pinnedLeftMap = useMemo(
    () => getPinnedLeftMap(visibleColumns, pinnedColumnSet, effectiveColumnWidths),
    [effectiveColumnWidths, pinnedColumnSet, visibleColumns]
  );

  const activeFilterCount = useMemo(
    () => getActiveFilterCount(activeSheet, visibleColumnPathSet),
    [activeSheet, visibleColumnPathSet]
  );

  const ignoredHiddenFilterCount = useMemo(
    () => getIgnoredHiddenFilterCount(activeSheet, activeFilterCount),
    [activeFilterCount, activeSheet]
  );

  const valueOptionsByPath = useMemo(
    () =>
      getValueOptionsForOpenColumn(
        nonEmptyRows,
        visibleColumns,
        activeSheet.openColumnMenuPath
      ),
    [activeSheet.openColumnMenuPath, nonEmptyRows, visibleColumns]
  );

  const displayedRows = useMemo(
    () => getDisplayedRows(activeSheet, nonEmptyRows, visibleColumns, activeFilterCount),
    [activeFilterCount, nonEmptyRows, activeSheet, visibleColumns]
  );

  const visibleSelectableKeys = useMemo(
    () => getVisibleSelectableKeys(displayedRows),
    [displayedRows]
  );

  const allVisibleSelected =
    visibleSelectableKeys.length > 0 &&
    visibleSelectableKeys.every((key) => activeSheet.selectedRowKeys.includes(key));

  const selectedVisibleRowKeys = useMemo(
    () => getSelectedVisibleRowKeys(activeSheet.selectedRowKeys, visibleSelectableKeys),
    [activeSheet.selectedRowKeys, visibleSelectableKeys]
  );

  const selectedTrackingIds = useMemo(
    () => getSelectedTrackingIds(activeSheet.rows, selectedVisibleRowKeys),
    [activeSheet.rows, selectedVisibleRowKeys]
  );

  const allTrackingIds = useMemo(
    () => getAllTrackingIds(activeSheet.rows),
    [activeSheet.rows]
  );

  const selectedRowKeySet = useMemo(
    () => new Set(activeSheet.selectedRowKeys),
    [activeSheet.selectedRowKeys]
  );

  const exportableRows = useMemo(
    () => getExportableRows(activeSheet.rows, displayedRows, selectedVisibleRowKeys),
    [displayedRows, activeSheet.rows, selectedVisibleRowKeys]
  );

  const retryFailedEntries = useMemo(
    () =>
      activeSheet.rows
        .filter(
          (row) =>
            row.trackingInput.trim() !== "" &&
            !row.loading &&
            (row.error !== "" || row.stale || row.dirty)
        )
        .map((row) => ({
          key: row.key,
          value: row.trackingInput.trim(),
        })),
    [activeSheet.rows]
  );

  const hiddenColumns = useMemo(
    () => getHiddenColumns(activeSheet),
    [activeSheet]
  );

  const loadedCount = useMemo(
    () => getLoadedCount(displayedRows),
    [displayedRows]
  );

  const loadingCount = useMemo(
    () => displayedRows.filter((row) => row.loading).length,
    [displayedRows]
  );

  const columnShortcuts = useMemo(
    () => getColumnShortcuts(visibleColumnPathSet),
    [visibleColumnPathSet]
  );

  return {
    activeFilterCount,
    allTrackingIds,
    allVisibleSelected,
    columnShortcuts,
    displayedRows,
    effectiveColumnWidths,
    exportableRows,
    hiddenColumns,
    ignoredHiddenFilterCount,
    loadedCount,
    loadingCount,
    nonEmptyRows,
    pinnedColumnSet,
    pinnedLeftMap,
    retrackableRows,
    retryFailedEntries,
    selectedRowKeySet,
    selectedTrackingIds,
    selectedVisibleRowKeys,
    totalShipmentCount,
    valueOptionsByPath,
    visibleColumnPathSet,
    visibleColumns,
    visibleSelectableKeys,
  };
}
