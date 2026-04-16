import {
  ClipboardEvent,
  FocusEvent,
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
  RefObject,
  UIEvent,
  useEffect,
  useMemo,
  useState,
} from "react";
import { ColumnHeaderCell } from "./ColumnHeaderCell";
import { SheetBodyRow } from "./SheetBodyRow";
import { ColumnDefinition, SheetRow } from "../types";
import { getColumnToneClass } from "../utils";

const TABLE_SCALE_METRICS = {
  small: {
    headerHeight: 38,
    filterHeight: 32,
    rowHeight: 66,
  },
  medium: {
    headerHeight: 42,
    filterHeight: 36,
    rowHeight: 74,
  },
  large: {
    headerHeight: 48,
    filterHeight: 40,
    rowHeight: 82,
  },
} as const;

const VIRTUALIZATION_THRESHOLD = 120;
const VIRTUALIZATION_OVERSCAN = 8;

function isShortcutHighlighted(
  columnPath: string,
  highlightedColumnPath: string | null
) {
  if (highlightedColumnPath === columnPath) {
    return true;
  }

  if (
    highlightedColumnPath === "pod.photo1_url" &&
    columnPath === "pod.photo2_url"
  ) {
    return true;
  }

  if (
    highlightedColumnPath === "history_summary.bagging_unbagging" &&
    [
      "history_summary.manifest_r7",
      "history_summary.delivery_runsheet",
    ].includes(columnPath)
  ) {
    return true;
  }

  return false;
}

type SheetTableProps = {
  sheetId: string;
  displayScale: "small" | "medium" | "large";
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
  onOpenSourceLink: (url: string) => void;
  onCopyTrackingId: (value: string) => void;
  onClearTrackingCell: (sheetId: string, rowKey: string) => void;
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
  displayScale,
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
  onOpenSourceLink,
  onCopyTrackingId,
  onClearTrackingCell,
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
  const [virtualScrollTop, setVirtualScrollTop] = useState(0);
  const [scrollViewportHeight, setScrollViewportHeight] = useState(0);
  const scaleMetrics = TABLE_SCALE_METRICS[displayScale];

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      return;
    }

    const syncMetrics = () => {
      setVirtualScrollTop(scrollContainer.scrollTop);
      setScrollViewportHeight(scrollContainer.clientHeight);
    };

    syncMetrics();

    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(syncMetrics)
        : null;

    resizeObserver?.observe(scrollContainer);
    window.addEventListener("resize", syncMetrics);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", syncMetrics);
    };
  }, [displayScale, scrollContainerRef, sheetId, displayedRows.length]);

  const bodyViewportHeight = Math.max(
    scrollViewportHeight - scaleMetrics.headerHeight - scaleMetrics.filterHeight,
    0
  );
  const shouldVirtualize =
    bodyViewportHeight > 0 && displayedRows.length > VIRTUALIZATION_THRESHOLD;
  const bodyScrollTop = Math.max(
    0,
    virtualScrollTop - scaleMetrics.headerHeight - scaleMetrics.filterHeight
  );
  const startIndex = shouldVirtualize
    ? Math.max(
        0,
        Math.floor(bodyScrollTop / scaleMetrics.rowHeight) - VIRTUALIZATION_OVERSCAN
      )
    : 0;
  const visibleRowCount = shouldVirtualize
    ? Math.ceil(bodyViewportHeight / scaleMetrics.rowHeight) + VIRTUALIZATION_OVERSCAN * 2
    : displayedRows.length;
  const endIndex = shouldVirtualize
    ? Math.min(displayedRows.length, startIndex + visibleRowCount)
    : displayedRows.length;
  const renderedRows = useMemo(
    () => displayedRows.slice(startIndex, endIndex),
    [displayedRows, endIndex, startIndex]
  );
  const topSpacerHeight = shouldVirtualize ? startIndex * scaleMetrics.rowHeight : 0;
  const bottomSpacerHeight = shouldVirtualize
    ? Math.max(0, (displayedRows.length - endIndex) * scaleMetrics.rowHeight)
    : 0;

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    setVirtualScrollTop(event.currentTarget.scrollTop);
    onScrollContainer(event);
  };

  return (
    <div
      ref={scrollContainerRef}
      className="sheet-scroll"
      onMouseLeave={onMouseLeaveTable}
      onScroll={handleScroll}
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
                isHighlighted={isShortcutHighlighted(column.path, highlightedColumnPath)}
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
        <tbody onMouseEnter={() => onHoverColumn(null)}>
          {topSpacerHeight > 0 ? (
            <tr aria-hidden="true" className="virtual-spacer-row">
              <td
                colSpan={visibleColumns.length + 1}
                style={{ height: topSpacerHeight }}
              />
            </tr>
          ) : null}
          {renderedRows.map((row) => (
            <SheetBodyRow
              key={row.key}
              sheetId={sheetId}
              row={row}
              visibleColumns={visibleColumns}
              columnWidths={columnWidths}
              pinnedColumnSet={pinnedColumnSet}
              pinnedLeftMap={pinnedLeftMap}
              isSelected={selectedRowKeySet.has(row.key)}
              onToggleSelection={onToggleRowSelection}
              onOpenSourceLink={onOpenSourceLink}
              onCopyTrackingId={onCopyTrackingId}
              onClearTrackingCell={onClearTrackingCell}
              onTrackingInputChange={onTrackingInputChange}
              onTrackingInputBlur={onTrackingInputBlur}
              onTrackingInputKeyDown={onTrackingInputKeyDown}
              onTrackingInputPaste={onTrackingInputPaste}
            />
          ))}
          {bottomSpacerHeight > 0 ? (
            <tr aria-hidden="true" className="virtual-spacer-row">
              <td
                colSpan={visibleColumns.length + 1}
                style={{ height: bottomSpacerHeight }}
              />
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
