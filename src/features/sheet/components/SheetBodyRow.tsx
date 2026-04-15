import { ClipboardEvent, FocusEvent, KeyboardEvent, memo } from "react";
import { TRACKING_COLUMN_PATH } from "../columns";
import { ColumnDefinition, SheetRow } from "../types";
import {
  formatColumnValue,
  getColumnToneClass,
  getColumnTypeClass,
  getRowStatus,
  getStatusToneClass,
} from "../utils";

type SheetBodyRowProps = {
  sheetId: string;
  row: SheetRow;
  visibleColumns: ColumnDefinition[];
  columnWidths: Record<string, number>;
  pinnedColumnSet: Set<string>;
  pinnedLeftMap: Record<string, number>;
  hoveredColumn: number | null;
  isSelected: boolean;
  onToggleSelection: (rowKey: string) => void;
  onHoverColumn: (columnIndex: number | null) => void;
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
};

export const SheetBodyRow = memo(function SheetBodyRow({
  sheetId,
  row,
  visibleColumns,
  columnWidths,
  pinnedColumnSet,
  pinnedLeftMap,
  hoveredColumn,
  isSelected,
  onToggleSelection,
  onHoverColumn,
  onTrackingInputChange,
  onTrackingInputBlur,
  onTrackingInputKeyDown,
  onTrackingInputPaste,
}: SheetBodyRowProps) {
  const status = getRowStatus(row);

  return (
    <tr className={status === "Error" ? "row-error" : ""}>
      <td className="selector-col align-center">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => onToggleSelection(row.key)}
          aria-label={`Select row ${row.trackingInput || row.key}`}
        />
      </td>
      {visibleColumns.map((column, index) => {
        const formattedValue = formatColumnValue(row, column);
        const width = columnWidths[column.path];
        const isPinned = pinnedColumnSet.has(column.path);
        const className = [
          isPinned ? "sticky-col" : "",
          getColumnToneClass(column),
          getColumnTypeClass(column),
          hoveredColumn === index ? "column-hover" : "",
        ]
          .filter(Boolean)
          .join(" ");

        if (column.path === TRACKING_COLUMN_PATH) {
          return (
            <td
              key={`${row.key}-${column.path}`}
              style={{
                width,
                minWidth: width,
                maxWidth: width,
                left: isPinned ? pinnedLeftMap[column.path] : undefined,
              }}
              className={className}
              onMouseEnter={() => onHoverColumn(index)}
            >
              <div className="tracking-cell">
                <input
                  className="sheet-input"
                  value={row.trackingInput}
                  onChange={(event) =>
                    onTrackingInputChange(sheetId, row.key, event.target.value)
                  }
                  onBlur={(event) => onTrackingInputBlur(event, sheetId, row.key)}
                  onKeyDown={(event) => onTrackingInputKeyDown(event, sheetId, row.key)}
                  onPaste={(event) => onTrackingInputPaste(event, sheetId, row.key)}
                  placeholder="Masukkan ID"
                />
                <span
                  className={`row-status-dot ${getStatusToneClass(status)}`}
                  title={row.error || status}
                  aria-label={`Row status ${status}`}
                />
              </div>
            </td>
          );
        }

        return (
          <td
            key={`${row.key}-${column.path}`}
            style={{
              width,
              minWidth: width,
              maxWidth: width,
              left: isPinned ? pinnedLeftMap[column.path] : undefined,
            }}
            className={className}
            onMouseEnter={() => onHoverColumn(index)}
          >
            <div className="cell-text" title={formattedValue}>
              {formattedValue}
            </div>
          </td>
        );
      })}
    </tr>
  );
});
