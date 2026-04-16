import {
  ClipboardEvent,
  FocusEvent,
  KeyboardEvent,
  ReactNode,
  RefObject,
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
  formatHistorySummaryPreview,
  formatColumnValue,
  getColumnToneClass,
  getColumnTypeClass,
  getRawColumnValue,
  getRowStatus,
  getStatusToneClass,
  isHistorySummaryPath,
} from "../utils";

const POD_PHOTO_COLUMN_PATHS = new Set(["pod.photo1_url", "pod.photo2_url"]);
const podImageCache = new Map<string, string>();

function HoverPreviewPortal({
  anchorRef,
  isVisible,
  className,
  width,
  height,
  children,
}: {
  anchorRef: RefObject<HTMLDivElement | null>;
  isVisible: boolean;
  className: string;
  width: number;
  height: number;
  children: ReactNode;
}) {
  const [previewPosition, setPreviewPosition] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!isVisible) {
      return;
    }

    const updatePosition = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }

      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const gap = 12;
      const maxTop = Math.max(16, viewportHeight - height - 16);

      let left = rect.right + gap;
      if (left + width > viewportWidth - 16) {
        left = rect.left - gap - width;
      }
      if (left < 16) {
        left = 16;
      }

      const top = Math.min(
        Math.max(16, rect.top + rect.height / 2 - height / 2),
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
  }, [anchorRef, height, isVisible, width]);

  if (!isVisible) {
    return null;
  }

  return createPortal(
    <div
      className={className}
      style={{
        top: `${previewPosition.top}px`,
        left: `${previewPosition.left}px`,
      }}
    >
      {children}
    </div>,
    document.body
  );
}

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
      <HoverPreviewPortal
        anchorRef={anchorRef}
        isVisible={isHovered}
        className="pod-photo-hover-preview"
        width={440}
        height={480}
      >
        <div role="img" aria-label={`${label} preview`}>
          <img
            className="pod-photo-preview-image"
            src={resolvedSrc}
            alt={label}
            loading="lazy"
          />
        </div>
      </HoverPreviewPortal>
    </>
  );
}

function HistorySummaryPreview({
  rawValue,
  summary,
  label,
}: {
  rawValue: unknown;
  summary: string;
  label: string;
}) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const preview = formatHistorySummaryPreview(rawValue);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }

      if (anchorRef.current?.contains(target) || popupRef.current?.contains(target)) {
        return;
      }

      setIsOpen(false);
    };

    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen]);

  return (
    <>
      <div
        ref={anchorRef}
        className="history-summary-cell"
      >
        <button
          type="button"
          className="history-summary-trigger"
          onClick={() => setIsOpen((current) => !current)}
        >
          <span className="cell-text">{summary}</span>
        </button>
      </div>
      <HoverPreviewPortal
        anchorRef={anchorRef}
        isVisible={isOpen}
        className="history-summary-hover-preview"
        width={520}
        height={420}
      >
        <div ref={popupRef} className="history-summary-hover-body">
          <div className="history-summary-hover-title">{label}</div>
          <pre className="history-summary-hover-pre">{preview}</pre>
        </div>
      </HoverPreviewPortal>
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
  onOpenSourceLink: (url: string) => void;
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
  onOpenSourceLink,
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
        const isHistorySummary = isHistorySummaryPath(column.path);
        const className = [
          isPinned ? "sticky-col" : "",
          getColumnToneClass(column),
          getColumnTypeClass(column),
          POD_PHOTO_COLUMN_PATHS.has(column.path) ? "has-pod-photo" : "",
          isHistorySummary ? "has-history-summary" : "",
          hoveredColumn === index ? "column-hover" : "",
        ]
          .filter(Boolean)
          .join(" ");

        if (column.path === TRACKING_COLUMN_PATH) {
          const sourceUrl = row.shipment?.url?.trim() ?? "";

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
                {sourceUrl ? (
                  <button
                    type="button"
                    className="tracking-source-link"
                    title="Buka sumber scrap"
                    aria-label={`Buka sumber scrap untuk ${row.trackingInput || "row"}`}
                    onClick={() => {
                      onOpenSourceLink(sourceUrl);
                    }}
                  >
                    <svg
                      viewBox="0 0 20 20"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M11.5 3.75H16.25V8.5"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <path
                        d="M8.5 11.5L16.25 3.75"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <path
                        d="M16.25 11.25V14.25C16.25 15.3546 15.3546 16.25 14.25 16.25H5.75C4.64543 16.25 3.75 15.3546 3.75 14.25V5.75C3.75 4.64543 4.64543 3.75 5.75 3.75H8.75"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                ) : null}
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

        if (isHistorySummary) {
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
              <HistorySummaryPreview
                rawValue={rawValue}
                summary={formattedValue}
                label={column.label}
              />
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
