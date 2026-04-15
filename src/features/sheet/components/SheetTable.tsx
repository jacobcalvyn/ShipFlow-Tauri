import {
  ClipboardEvent,
  FocusEvent,
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
  RefObject,
  UIEvent,
} from "react";
import { ColumnHeaderCell } from "./ColumnHeaderCell";
import { SheetBodyRow } from "./SheetBodyRow";
import { ColumnDefinition, SheetRow } from "../types";
import { getColumnToneClass } from "../utils";

type SheetTableProps = {
  sheetId: string;
  displayedRows: SheetRow[];
  visibleColumns: ColumnDefinition[];
  hiddenColumns: ColumnDefinition[];
  columnWidths: Record<string, number>;
  pinnedColumnSet: Set<string>;
  pinnedLeftMap: Record<string, number>;
  hoveredColumn: number | null;
  allVisibleSelected: boolean;
  selectedRowKeySet: Set<string>;
  filters: Record<string, string>;
  valueFilters: Record<string, string[]>;
  valueOptionsByPath: Record<string, string[]>;
  openColumnMenuPath: string | null;
  highlightedColumnPath: string | null;
  scrollContainerRef: RefObject<HTMLDivElement>;
  onScrollContainer: (event: UIEvent<HTMLDivElement>) => void;
  sortDirectionForPath: (path: string) => "asc" | "desc" | null;
  onMouseLeaveTable: () => void;
  onHoverColumn: (columnIndex: number | null) => void;
  onToggleVisibleSelection: () => void;
  onToggleRowSelection: (rowKey: string) => void;
  onTrackingInputChange: (sheetId: string, rowKey: string, value: string) => void;
  onTrackingInputBlur: (
    event: FocusEvent<HTMLInputElement>,
    sheetId: string,
    rowKey: string
  ) => void;
  onTrackingInputKeyDown: (
    event: KeyboardEvent<HTMLInputElement>,
    sheetId: string,
    rowKey: string
  ) => void;
  onTrackingInputPaste: (
    event: ClipboardEvent<HTMLInputElement>,
    sheetId: string,
    rowKey: string
  ) => void;
  onFilterChange: (path: string, value: string) => void;
  onResizeStart: (
    event: ReactMouseEvent<HTMLSpanElement>,
    column: ColumnDefinition
  ) => void;
  onToggleColumnMenu: (path: string) => void;
  onSetColumnSort: (path: string, direction: "asc" | "desc" | null) => void;
  onTogglePinnedColumn: (path: string) => void;
  onToggleColumnVisibility: (path: string) => void;
  onToggleValueFilter: (path: string, value: string) => void;
  onClearValueFilter: (path: string) => void;
  onCloseColumnMenu: () => void;
  onColumnMenuRef: (path: string, element: HTMLDivElement | null) => void;
};

export function SheetTable({
  sheetId,
  displayedRows,
  visibleColumns,
  hiddenColumns,
  columnWidths,
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
  scrollContainerRef,
  onScrollContainer,
  sortDirectionForPath,
  onMouseLeaveTable,
  onHoverColumn,
  onToggleVisibleSelection,
  onToggleRowSelection,
  onTrackingInputChange,
  onTrackingInputBlur,
  onTrackingInputKeyDown,
  onTrackingInputPaste,
  onFilterChange,
  onResizeStart,
  onToggleColumnMenu,
  onSetColumnSort,
  onTogglePinnedColumn,
  onToggleColumnVisibility,
  onToggleValueFilter,
  onClearValueFilter,
  onCloseColumnMenu,
  onColumnMenuRef,
}: SheetTableProps) {
  return (
    <div
      ref={scrollContainerRef}
      className="sheet-scroll"
      onMouseLeave={onMouseLeaveTable}
      onScroll={onScrollContainer}
    >
      <table className="sheet-table">
        <thead>
          <tr>
            <th className="selector-col selector-head align-center">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onChange={onToggleVisibleSelection}
                aria-label="Select visible rows"
              />
            </th>
            {visibleColumns.map((column, index) => (
              <ColumnHeaderCell
                key={column.path}
                column={column}
                columnIndex={index}
                width={columnWidths[column.path]}
                isPinned={pinnedColumnSet.has(column.path)}
                left={
                  pinnedColumnSet.has(column.path)
                    ? pinnedLeftMap[column.path]
                    : undefined
                }
                hoveredColumn={hoveredColumn}
                sortDirection={sortDirectionForPath(column.path)}
                hiddenColumns={hiddenColumns}
                selectedValueFilters={valueFilters[column.path] ?? []}
                availableValueOptions={valueOptionsByPath[column.path] ?? []}
                isMenuOpen={openColumnMenuPath === column.path}
                isHighlighted={highlightedColumnPath === column.path}
                onHoverColumn={onHoverColumn}
                onToggleMenu={onToggleColumnMenu}
                onResizeStart={onResizeStart}
                onSetSort={onSetColumnSort}
                onTogglePinned={onTogglePinnedColumn}
                onToggleVisibility={onToggleColumnVisibility}
                onToggleValueFilter={onToggleValueFilter}
                onClearValueFilter={onClearValueFilter}
                onCloseMenu={onCloseColumnMenu}
                onMenuRef={onColumnMenuRef}
              />
            ))}
          </tr>
          <tr className="filter-row">
            <th className="selector-col selector-head" />
            {visibleColumns.map((column, index) => {
              const width = columnWidths[column.path];
              const isPinned = pinnedColumnSet.has(column.path);

              return (
                <th
                  key={`filter-${column.path}`}
                  style={{
                    width,
                    minWidth: width,
                    maxWidth: width,
                    left: isPinned ? pinnedLeftMap[column.path] : undefined,
                  }}
                  className={[
                    isPinned ? "sticky-col" : "",
                    getColumnToneClass(column),
                    hoveredColumn === index ? "column-hover" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onMouseEnter={() => onHoverColumn(index)}
                >
                  <input
                    className="filter-input"
                    value={filters[column.path] ?? ""}
                    onChange={(event) =>
                      onFilterChange(column.path, event.target.value)
                    }
                    placeholder="Filter"
                  />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {displayedRows.map((row) => (
            <SheetBodyRow
              key={row.key}
              sheetId={sheetId}
              row={row}
              visibleColumns={visibleColumns}
              columnWidths={columnWidths}
              pinnedColumnSet={pinnedColumnSet}
              pinnedLeftMap={pinnedLeftMap}
              hoveredColumn={hoveredColumn}
              isSelected={selectedRowKeySet.has(row.key)}
              onToggleSelection={onToggleRowSelection}
              onHoverColumn={onHoverColumn}
              onTrackingInputChange={onTrackingInputChange}
              onTrackingInputBlur={onTrackingInputBlur}
              onTrackingInputKeyDown={onTrackingInputKeyDown}
              onTrackingInputPaste={onTrackingInputPaste}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
