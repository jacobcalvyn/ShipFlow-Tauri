import {
  ClipboardEvent,
  FocusEvent,
  KeyboardEvent,
  memo,
  useEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { createPortal } from "react-dom";
import { TRACKING_COLUMN_PATH } from "../columns";
import { ColumnDefinition, SheetRow } from "../types";
import {
  formatColumnValue,
  getColumnToneClass,
  getColumnTypeClass,
  getRawColumnValue,
  getRowStatus,
  getStatusToneClass,
} from "../utils";

const POD_PHOTO_COLUMN_PATHS = new Set(["pod.photo1_url", "pod.photo2_url"]);
const podImageCache = new Map<string, string>();

function PodPhotoPreview({
  source,
  label,
}: {
  source: string;
  label: string;
}) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [resolvedSrc, setResolvedSrc] = useState(() => podImageCache.get(source) ?? "");
  const [isHovered, setIsHovered] = useState(false);
  const [previewPosition, setPreviewPosition] = useState({ top: 0, left: 0 });

  useEffect(() => {
    let cancelled = false;
    const cached = podImageCache.get(source);
    if (cached) {
      setResolvedSrc(cached);
      return;
    }

    void invoke<string>("resolve_pod_image", { imageSource: source })
      .then((resolved) => {
        if (cancelled || !resolved) {
          return;
        }

        podImageCache.set(source, resolved);
        setResolvedSrc(resolved);
      })
      .catch(() => {
        if (!cancelled) {
          setResolvedSrc("");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [source]);

  useEffect(() => {
    if (!isHovered) {
      return;
    }

    const updatePosition = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }

      const previewWidth = 440;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const gap = 12;
      const maxTop = Math.max(16, viewportHeight - 496);

      let left = rect.right + gap;
      if (left + previewWidth > viewportWidth - 16) {
        left = rect.left - gap - previewWidth;
      }
      if (left < 16) {
        left = 16;
      }

      const top = Math.min(
        Math.max(16, rect.top + rect.height / 2 - 240),
        maxTop
      );

      setPreviewPosition({ top, left });
    };

    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);

    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [isHovered]);

  if (!resolvedSrc) {
    return <span className="pod-photo-empty">-</span>;
  }

  return (
    <>
      <div
        ref={anchorRef}
        className="pod-photo-cell"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <img className="pod-photo-thumb" src={resolvedSrc} alt={label} loading="lazy" />
      </div>
      {isHovered
        ? createPortal(
            <div
              className="pod-photo-hover-preview"
              role="img"
              aria-label={`${label} preview`}
              style={{
                top: `${previewPosition.top}px`,
                left: `${previewPosition.left}px`,
              }}
            >
              <img
                className="pod-photo-preview-image"
                src={resolvedSrc}
                alt={label}
                loading="lazy"
              />
            </div>,
            document.body
          )
        : null}
    </>
  );
}

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
  onClearTrackingCell: (sheetId: string, rowKey: string) => void;
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
  onClearTrackingCell,
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
          onKeyDown={(event) => {
            if (event.key === "Delete" || event.key === "Backspace") {
              event.preventDefault();
              onClearTrackingCell(sheetId, row.key);
            }
          }}
          aria-label={`Select row ${row.trackingInput || row.key}`}
        />
      </td>
      {visibleColumns.map((column, index) => {
        const formattedValue = formatColumnValue(row, column);
        const rawValue = getRawColumnValue(row, column);
        const width = columnWidths[column.path];
        const isPinned = pinnedColumnSet.has(column.path);
        const className = [
          isPinned ? "sticky-col" : "",
          getColumnToneClass(column),
          getColumnTypeClass(column),
          POD_PHOTO_COLUMN_PATHS.has(column.path) ? "has-pod-photo" : "",
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

        if (POD_PHOTO_COLUMN_PATHS.has(column.path)) {
          const imageSource = typeof rawValue === "string" ? rawValue.trim() : "";

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
              {imageSource ? (
                <PodPhotoPreview source={imageSource} label={column.label} />
              ) : (
                <div className="cell-text" title={formattedValue}>
                  {formattedValue}
                </div>
              )}
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
