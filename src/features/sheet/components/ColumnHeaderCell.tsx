import { MouseEvent as ReactMouseEvent } from "react";
import { TRACKING_COLUMN_PATH } from "../columns";
import { ColumnDefinition } from "../types";
import { getColumnToneClass, getColumnTypeClass } from "../utils";

type ColumnHeaderCellProps = {
  column: ColumnDefinition;
  columnIndex: number;
  width: number;
  isPinned: boolean;
  left?: number;
  hoveredColumn: number | null;
  sortDirection: "asc" | "desc" | null;
  hiddenColumns: ColumnDefinition[];
  selectedValueFilters: string[];
  availableValueOptions: string[];
  isMenuOpen: boolean;
  onHoverColumn: (columnIndex: number | null) => void;
  onToggleMenu: (path: string) => void;
  onResizeStart: (
    event: ReactMouseEvent<HTMLSpanElement>,
    column: ColumnDefinition
  ) => void;
  onSetSort: (path: string, direction: "asc" | "desc" | null) => void;
  onTogglePinned: (path: string) => void;
  onToggleVisibility: (path: string) => void;
  onToggleValueFilter: (path: string, value: string) => void;
  onClearValueFilter: (path: string) => void;
  onCloseMenu: () => void;
  onMenuRef: (path: string, element: HTMLDivElement | null) => void;
};

export function ColumnHeaderCell({
  column,
  columnIndex,
  width,
  isPinned,
  left,
  hoveredColumn,
  sortDirection,
  hiddenColumns,
  selectedValueFilters,
  availableValueOptions,
  isMenuOpen,
  onHoverColumn,
  onToggleMenu,
  onResizeStart,
  onSetSort,
  onTogglePinned,
  onToggleVisibility,
  onToggleValueFilter,
  onClearValueFilter,
  onCloseMenu,
  onMenuRef,
}: ColumnHeaderCellProps) {
  const isTrackingColumn = column.path === TRACKING_COLUMN_PATH;

  return (
    <th
      title={column.path}
      style={{
        width,
        minWidth: width,
        maxWidth: width,
        left,
      }}
      className={[
        isPinned ? "sticky-col" : "",
        isMenuOpen ? "has-open-menu" : "",
        getColumnToneClass(column),
        getColumnTypeClass(column),
        hoveredColumn === columnIndex ? "column-hover" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onMouseEnter={() => onHoverColumn(columnIndex)}
    >
      <div className="header-cell-bar">
        <div className="header-label-group">
          <span>{column.label}</span>
          {sortDirection ? (
            <span className="sort-indicator is-active">
              {sortDirection === "asc" ? "↑" : "↓"}
            </span>
          ) : null}
        </div>

        <div
          className={`column-menu ${isMenuOpen ? "is-open" : ""}`}
          ref={(element) => onMenuRef(column.path, element)}
        >
          <button
            type="button"
            className="column-menu-trigger"
            aria-label={`Menu ${column.label}`}
            aria-expanded={isMenuOpen}
            onClick={() => onToggleMenu(column.path)}
          >
            ⋮
          </button>
          {isMenuOpen ? (
            <div className="column-menu-body">
              <button
                type="button"
                className="column-menu-item"
                onClick={() => {
                  onSetSort(column.path, "asc");
                  onCloseMenu();
                }}
              >
                Sort Asc
              </button>
              <button
                type="button"
                className="column-menu-item"
                onClick={() => {
                  onSetSort(column.path, "desc");
                  onCloseMenu();
                }}
              >
                Sort Desc
              </button>
              <button
                type="button"
                className="column-menu-item"
                onClick={() => {
                  onSetSort(column.path, null);
                  onCloseMenu();
                }}
                disabled={sortDirection === null}
              >
                Clear Sort
              </button>
              <button
                type="button"
                className="column-menu-item"
                onClick={() => {
                  onTogglePinned(column.path);
                  onCloseMenu();
                }}
              >
                {isPinned ? "Unpin Column" : "Pin Column"}
              </button>
              <button
                type="button"
                className="column-menu-item"
                onClick={() => {
                  onToggleVisibility(column.path);
                  onCloseMenu();
                }}
                disabled={isTrackingColumn}
              >
                Hide Column
              </button>
              <div className="column-menu-group">
                <div className="column-menu-group-header">
                  <span className="column-menu-group-label">Filter by value</span>
                  <button
                    type="button"
                    className="column-menu-link"
                    onClick={() => onClearValueFilter(column.path)}
                    disabled={selectedValueFilters.length === 0}
                  >
                    Clear
                  </button>
                </div>
                {availableValueOptions.length > 0 ? (
                  <div className="column-menu-checklist">
                    {availableValueOptions.map((option) => {
                      const optionId = `${column.path}-${option}`;

                      return (
                        <label key={option} className="column-menu-checkbox" htmlFor={optionId}>
                          <input
                            id={optionId}
                            type="checkbox"
                            checked={selectedValueFilters.includes(option)}
                            onChange={() => onToggleValueFilter(column.path, option)}
                          />
                          <span>{option}</span>
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <span className="column-menu-empty">No values</span>
                )}
              </div>
              {hiddenColumns.length > 0 ? (
                <div className="column-menu-group">
                  <span className="column-menu-group-label">Unhide Columns</span>
                  {hiddenColumns.map((hiddenColumn) => (
                    <button
                      key={hiddenColumn.path}
                      type="button"
                      className="column-menu-item"
                      onClick={() => {
                        onToggleVisibility(hiddenColumn.path);
                        onCloseMenu();
                      }}
                    >
                      {hiddenColumn.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <span
        className="resize-handle"
        onMouseDown={(event) => onResizeStart(event, column)}
      />
    </th>
  );
}
