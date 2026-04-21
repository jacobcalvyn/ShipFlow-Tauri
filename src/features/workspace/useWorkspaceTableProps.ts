import { ComponentProps } from "react";
import { SheetTable } from "../sheet/components/SheetTable";

type UseWorkspaceTablePropsOptions = {
  activeSheetId: string;
  effectiveDisplayScale: ComponentProps<typeof SheetTable>["displayScale"];
  displayedRows: ComponentProps<typeof SheetTable>["displayedRows"];
  visibleColumns: ComponentProps<typeof SheetTable>["visibleColumns"];
  hiddenColumns: ComponentProps<typeof SheetTable>["hiddenColumns"];
  effectiveColumnWidths: ComponentProps<typeof SheetTable>["columnWidths"];
  pinnedColumnSet: ComponentProps<typeof SheetTable>["pinnedColumnSet"];
  pinnedLeftMap: ComponentProps<typeof SheetTable>["pinnedLeftMap"];
  hoveredColumn: ComponentProps<typeof SheetTable>["hoveredColumn"];
  allVisibleSelected: ComponentProps<typeof SheetTable>["allVisibleSelected"];
  selectedRowKeySet: ComponentProps<typeof SheetTable>["selectedRowKeySet"];
  filters: ComponentProps<typeof SheetTable>["filters"];
  valueFilters: ComponentProps<typeof SheetTable>["valueFilters"];
  valueOptionsByPath: ComponentProps<typeof SheetTable>["valueOptionsByPath"];
  openColumnMenuPath: ComponentProps<typeof SheetTable>["openColumnMenuPath"];
  highlightedColumnPath: ComponentProps<typeof SheetTable>["highlightedColumnPath"];
  sheetScrollRef: ComponentProps<typeof SheetTable>["scrollContainerRef"];
  handleSheetScroll: ComponentProps<typeof SheetTable>["onScrollContainer"];
  getColumnSortDirection: ComponentProps<typeof SheetTable>["sortDirectionForPath"];
  setHoveredColumn: (index: number | null) => void;
  toggleVisibleSelection: ComponentProps<typeof SheetTable>["onToggleVisibleSelection"];
  toggleRowSelection: ComponentProps<typeof SheetTable>["onToggleRowSelection"];
  openSourceLink: ComponentProps<typeof SheetTable>["onOpenSourceLink"];
  copyTrackingId: ComponentProps<typeof SheetTable>["onCopyTrackingId"];
  clearTrackingCell: ComponentProps<typeof SheetTable>["onClearTrackingCell"];
  handleTrackingInputChange: ComponentProps<typeof SheetTable>["onTrackingInputChange"];
  handleTrackingInputBlur: ComponentProps<typeof SheetTable>["onTrackingInputBlur"];
  handleTrackingInputKeyDown: ComponentProps<typeof SheetTable>["onTrackingInputKeyDown"];
  handleTrackingInputPaste: ComponentProps<typeof SheetTable>["onTrackingInputPaste"];
  handleFilterChange: ComponentProps<typeof SheetTable>["onFilterChange"];
  handleResizeStart: ComponentProps<typeof SheetTable>["onResizeStart"];
  toggleColumnMenu: ComponentProps<typeof SheetTable>["onToggleColumnMenu"];
  setColumnSort: ComponentProps<typeof SheetTable>["onSetColumnSort"];
  togglePinnedColumn: ComponentProps<typeof SheetTable>["onTogglePinnedColumn"];
  toggleColumnVisibility: ComponentProps<typeof SheetTable>["onToggleColumnVisibility"];
  toggleColumnValueFilter: ComponentProps<typeof SheetTable>["onToggleValueFilter"];
  clearColumnValueFilter: ComponentProps<typeof SheetTable>["onClearValueFilter"];
  closeColumnMenu: ComponentProps<typeof SheetTable>["onCloseColumnMenu"];
  handleColumnMenuRef: ComponentProps<typeof SheetTable>["onColumnMenuRef"];
};

export function useWorkspaceTableProps({
  activeSheetId,
  effectiveDisplayScale,
  displayedRows,
  visibleColumns,
  hiddenColumns,
  effectiveColumnWidths,
  pinnedColumnSet,
  pinnedLeftMap,
  hoveredColumn,
  allVisibleSelected,
  selectedRowKeySet,
  filters,
  valueFilters,
  valueOptionsByPath,
  openColumnMenuPath,
  highlightedColumnPath,
  sheetScrollRef,
  handleSheetScroll,
  getColumnSortDirection,
  setHoveredColumn,
  toggleVisibleSelection,
  toggleRowSelection,
  openSourceLink,
  copyTrackingId,
  clearTrackingCell,
  handleTrackingInputChange,
  handleTrackingInputBlur,
  handleTrackingInputKeyDown,
  handleTrackingInputPaste,
  handleFilterChange,
  handleResizeStart,
  toggleColumnMenu,
  setColumnSort,
  togglePinnedColumn,
  toggleColumnVisibility,
  toggleColumnValueFilter,
  clearColumnValueFilter,
  closeColumnMenu,
  handleColumnMenuRef,
}: UseWorkspaceTablePropsOptions): ComponentProps<typeof SheetTable> {
  return {
    sheetId: activeSheetId,
    displayScale: effectiveDisplayScale,
    displayedRows,
    visibleColumns,
    hiddenColumns,
    columnWidths: effectiveColumnWidths,
    pinnedColumnSet,
    pinnedLeftMap,
    hoveredColumn,
    allVisibleSelected,
    selectedRowKeySet,
    filters,
    valueFilters,
    valueOptionsByPath,
    openColumnMenuPath,
    highlightedColumnPath,
    scrollContainerRef: sheetScrollRef,
    onScrollContainer: handleSheetScroll,
    sortDirectionForPath: getColumnSortDirection,
    onMouseLeaveTable: () => setHoveredColumn(null),
    onHoverColumn: setHoveredColumn,
    onToggleVisibleSelection: toggleVisibleSelection,
    onToggleRowSelection: toggleRowSelection,
    onOpenSourceLink: openSourceLink,
    onCopyTrackingId: copyTrackingId,
    onClearTrackingCell: clearTrackingCell,
    onTrackingInputChange: handleTrackingInputChange,
    onTrackingInputBlur: handleTrackingInputBlur,
    onTrackingInputKeyDown: handleTrackingInputKeyDown,
    onTrackingInputPaste: handleTrackingInputPaste,
    onFilterChange: handleFilterChange,
    onResizeStart: handleResizeStart,
    onToggleColumnMenu: toggleColumnMenu,
    onSetColumnSort: setColumnSort,
    onTogglePinnedColumn: togglePinnedColumn,
    onToggleColumnVisibility: toggleColumnVisibility,
    onToggleValueFilter: toggleColumnValueFilter,
    onClearValueFilter: clearColumnValueFilter,
    onCloseColumnMenu: closeColumnMenu,
    onColumnMenuRef: handleColumnMenuRef,
  };
}
