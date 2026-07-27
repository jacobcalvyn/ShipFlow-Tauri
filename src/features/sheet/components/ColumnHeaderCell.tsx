import {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  memo,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  LATEST_DELIVERY_COLUMN_PATH,
  TRACKING_COLUMN_PATH,
  canUseColumnValueFilter,
} from "../columns";
import { ColumnDefinition, ValueFilterOption } from "../types";
import { getColumnToneClass, getColumnTypeClass } from "../utils";

const WIDE_FILTER_MENU_PATHS = new Set([
  "detail.actors.pengirim.nama",
  "detail.actors.pengirim.alamat",
  "detail.actors.penerima.nama",
  "detail.actors.penerima.alamat",
  LATEST_DELIVERY_COLUMN_PATH,
]);

const COLUMN_MENU_MARGIN = 12;
const COLUMN_MENU_GAP = 6;
const COLUMN_MENU_WIDTH = 390;
const COLUMN_MENU_WIDE_WIDTH = 520;
const VALUE_FILTER_OPTION_LIMIT = 1_000;

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
  availableValueOptions: ValueFilterOption[];
  isMenuOpen: boolean;
  isHighlighted: boolean;
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
  onSetValueFilterSelection: (path: string, values: string[]) => void;
  onClearValueFilter: (path: string) => void;
  onCloseMenu: () => void;
  onMenuRef: (path: string, element: HTMLDivElement | null) => void;
};

export const ColumnHeaderCell = memo(function ColumnHeaderCell({
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
  isHighlighted,
  onHoverColumn,
  onToggleMenu,
  onResizeStart,
  onSetSort,
  onTogglePinned,
  onToggleVisibility,
  onToggleValueFilter,
  onSetValueFilterSelection,
  onClearValueFilter,
  onCloseMenu,
  onMenuRef,
}: ColumnHeaderCellProps) {
  const isTrackingColumn = column.path === TRACKING_COLUMN_PATH;
  const hasWideFilterMenu = WIDE_FILTER_MENU_PATHS.has(column.path);
  const canUseValueFilter = canUseColumnValueFilter(column);
  const valueOptionsMayBeTruncated =
    availableValueOptions.length >= VALUE_FILTER_OPTION_LIMIT;
  const headerCellRef = useRef<HTMLTableCellElement | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [menuLayout, setMenuLayout] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    if (!isMenuOpen) {
      setMenuLayout(null);
      return;
    }

    const updateMenuLayout = () => {
      const headerCellRect = headerCellRef.current?.getBoundingClientRect();
      const triggerRect = menuTriggerRef.current?.getBoundingClientRect();

      if (!triggerRect) {
        return;
      }

      const preferredWidth = hasWideFilterMenu ? COLUMN_MENU_WIDE_WIDTH : COLUMN_MENU_WIDTH;
      const maxWidth = Math.max(270, window.innerWidth - COLUMN_MENU_MARGIN * 2);
      const width = Math.min(preferredWidth, maxWidth);
      const preferredLeft =
        isPinned && headerCellRect
          ? headerCellRect.left + COLUMN_MENU_MARGIN
          : triggerRect.right - width;
      const left = Math.min(
        Math.max(preferredLeft, COLUMN_MENU_MARGIN),
        window.innerWidth - width - COLUMN_MENU_MARGIN
      );

      setMenuLayout({
        position: "fixed",
        top: triggerRect.bottom + COLUMN_MENU_GAP,
        left,
        width,
      });
    };

    updateMenuLayout();
    window.addEventListener("resize", updateMenuLayout);
    window.addEventListener("scroll", updateMenuLayout, true);

    return () => {
      window.removeEventListener("resize", updateMenuLayout);
      window.removeEventListener("scroll", updateMenuLayout, true);
    };
  }, [hasWideFilterMenu, isMenuOpen, isPinned]);

  return (
    <th
      ref={headerCellRef}
      data-column-path={column.path}
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
        isHighlighted ? "is-shortcut-highlighted" : "",
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
            ref={menuTriggerRef}
            type="button"
            className="column-menu-trigger"
            aria-label={`Menu ${column.label}`}
            aria-expanded={isMenuOpen}
            onClick={() => onToggleMenu(column.path)}
          >
            ⋮
          </button>
          {isMenuOpen ? (
            <div
              className={[
                "column-menu-body",
                menuLayout ? "column-menu-body-floating" : "",
                hasWideFilterMenu ? "column-menu-body-wide-filter" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={menuLayout ?? undefined}
            >
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
              {canUseValueFilter ? (
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
                {valueOptionsMayBeTruncated ? (
                  <span className="column-menu-empty" role="status">
                    Daftar nilai mencapai batas 1.000 opsi. Filter kecuali
                    dinonaktifkan agar hasil tidak salah.
                  </span>
                ) : null}
                {availableValueOptions.length > 0 ? (
                  <div className="column-menu-checklist">
                    {availableValueOptions.map((option) => {
                      const optionId = `${column.path}-${option.value}`;
                      const exceptOptions = valueOptionsMayBeTruncated
                        ? []
                        : availableValueOptions
                            .filter(
                              (currentOption) => currentOption.value !== option.value
                            )
                            .map((currentOption) => currentOption.value);

                      return (
                        <div key={option.value} className="column-menu-value-option">
                          <label className="column-menu-checkbox" htmlFor={optionId}>
                            <input
                              id={optionId}
                              aria-label={`${option.value} (${option.count})`}
                              type="checkbox"
                              checked={selectedValueFilters.includes(option.value)}
                              onChange={() => onToggleValueFilter(column.path, option.value)}
                            />
                            <span>
                              {option.value}
                              <span className="column-menu-option-count">
                                {" "}
                                ({option.count})
                              </span>
                            </span>
                          </label>
                          <div className="column-menu-value-actions">
                            <button
                              type="button"
                              className="column-menu-value-action"
                              aria-label={`Filter only ${option.value}`}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                onSetValueFilterSelection(column.path, [option.value]);
                              }}
                            >
                              Filter ini
                            </button>
                            <button
                              type="button"
                              className="column-menu-value-action"
                              aria-label={`Filter except ${option.value}`}
                              disabled={
                                valueOptionsMayBeTruncated || exceptOptions.length === 0
                              }
                              title={
                                valueOptionsMayBeTruncated
                                  ? "Filter kecuali dinonaktifkan karena daftar nilai mencapai batas 1.000 opsi."
                                  : undefined
                              }
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                onSetValueFilterSelection(column.path, exceptOptions);
                              }}
                            >
                              Filter kecuali ini
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <span className="column-menu-empty">No values</span>
                )}
              </div>
              ) : null}
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
});
