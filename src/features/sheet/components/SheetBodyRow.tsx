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
import QRCode from "qrcode";
import { LATEST_BAG_STATUS_COLUMN_PATH, TRACKING_COLUMN_PATH } from "../columns";
import { ColumnDefinition, SheetRow } from "../types";
import { MAX_TRACKING_INPUT_LENGTH } from "../utils";
import {
  formatHistorySummaryPreview,
  formatColumnValue,
  getLatestBagPrintUrl,
  getColumnToneClass,
  getColumnTypeClass,
  getRawColumnValue,
  getRowStatus,
  getStatusToneClass,
  isHistorySummaryPath,
} from "../utils";

const POD_PHOTO_COLUMN_PATHS = new Set(["pod.photo1_url", "pod.photo2_url"]);
const podImageCache = new Map<string, string>();
const qrImageCache = new Map<string, string>();

export function getPreviewPortalLayout(
  rect: Pick<DOMRect, "top" | "left" | "right" | "height">,
  viewportWidth: number,
  viewportHeight: number,
  preferredWidth: number,
  preferredHeight: number
) {
  const gap = 12;
  const width = Math.max(220, Math.min(preferredWidth, viewportWidth - 32));
  const height = Math.max(220, Math.min(preferredHeight, viewportHeight - 32));
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

  return { top, left, width, height };
}

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
  const [previewLayout, setPreviewLayout] = useState({
    top: 0,
    left: 0,
    width,
    height,
  });

  useEffect(() => {
    if (!isVisible) {
      return;
    }

    const updatePosition = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }

      setPreviewLayout(
        getPreviewPortalLayout(
          rect,
          window.innerWidth,
          window.innerHeight,
          width,
          height
        )
      );
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
        top: `${previewLayout.top}px`,
        left: `${previewLayout.left}px`,
        width: `${previewLayout.width}px`,
        maxHeight: `${previewLayout.height}px`,
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
    const cached = podImageCache.get(source);
    if (cached) {
      setResolvedSrc(cached);
    } else {
      setResolvedSrc("");
    }
  }, [source]);

  useEffect(() => {
    if (!isHovered) {
      return;
    }

    const cached = podImageCache.get(source);
    if (cached) {
      setResolvedSrc(cached);
      return;
    }

    let cancelled = false;

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
  }, [isHovered, source]);

  return (
    <>
      <div
        ref={anchorRef}
        className="pod-photo-cell"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {resolvedSrc ? (
          <img className="pod-photo-thumb" src={resolvedSrc} alt={label} loading="lazy" />
        ) : (
          <span className="pod-photo-empty" aria-label={`${label} placeholder`}>
            Preview
          </span>
        )}
      </div>
      {resolvedSrc ? (
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
      ) : null}
    </>
  );
}

function TrackingQrPreview({
  value,
}: {
  value: string;
}) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [qrSource, setQrSource] = useState(() => qrImageCache.get(value) ?? "");

  useEffect(() => {
    setQrSource(qrImageCache.get(value) ?? "");
  }, [value]);

  useEffect(() => {
    if (!isHovered) {
      return;
    }

    const cached = qrImageCache.get(value);
    if (cached) {
      setQrSource(cached);
      return;
    }

    let cancelled = false;

    void QRCode.toDataURL(value, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 240,
      color: {
        dark: "#0f172a",
        light: "#ffffff",
      },
    })
      .then((nextQrSource) => {
        if (!cancelled) {
          qrImageCache.set(value, nextQrSource);
          setQrSource(nextQrSource);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setQrSource("");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isHovered, value]);

  return (
    <>
      <div
        ref={anchorRef}
        className="tracking-qr-cell"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <button
          type="button"
          className="tracking-qr-trigger"
          title="Lihat QR code"
          aria-label={`Lihat QR code untuk ${value}`}
          onFocus={() => setIsHovered(true)}
          onBlur={() => setIsHovered(false)}
        >
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path
              d="M4 4.75A.75.75 0 0 1 4.75 4h3.5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-.75.75h-3.5A.75.75 0 0 1 4 8.25v-3.5Z"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path
              d="M11 4.75A.75.75 0 0 1 11.75 4h3.5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-.75.75h-3.5a.75.75 0 0 1-.75-.75v-3.5Z"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path
              d="M4 11.75A.75.75 0 0 1 4.75 11h3.5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-.75.75h-3.5a.75.75 0 0 1-.75-.75v-3.5Z"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path
              d="M11.5 11H13v1.5h1.5V14H13v1.5h-1.5V14H10v-1.5h1.5V11Z"
              fill="currentColor"
            />
            <path
              d="M15.5 15.5h-1.75V13.75H15.5V15.5Z"
              fill="currentColor"
            />
          </svg>
        </button>
      </div>
      <HoverPreviewPortal
        anchorRef={anchorRef}
        isVisible={isHovered}
        className="tracking-qr-hover-preview"
        width={280}
        height={320}
      >
        <div className="tracking-qr-hover-body">
          <div className="tracking-qr-hover-title">QR Code</div>
          {qrSource ? (
            <img
              className="tracking-qr-image"
              src={qrSource}
              alt={`QR code ${value}`}
              loading="lazy"
            />
          ) : (
            <div className="tracking-qr-fallback">QR tidak tersedia</div>
          )}
          <div className="tracking-qr-value">{value}</div>
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
  isSelected: boolean;
  onToggleSelection: (rowKey: string) => void;
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
};

export const SheetBodyRow = memo(function SheetBodyRow({
  sheetId,
  row,
  visibleColumns,
  columnWidths,
  pinnedColumnSet,
  pinnedLeftMap,
  isSelected,
  onToggleSelection,
  onOpenSourceLink,
  onCopyTrackingId,
  onClearTrackingCell,
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
      {visibleColumns.map((column) => {
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
            >
              <div className="tracking-cell">
                <input
                  className="sheet-input"
                  maxLength={MAX_TRACKING_INPUT_LENGTH}
                  value={row.trackingInput}
                  onChange={(event) =>
                    onTrackingInputChange(sheetId, row.key, event.target.value)
                  }
                  onBlur={(event) => onTrackingInputBlur(event, sheetId, row.key)}
                  onKeyDown={(event) => onTrackingInputKeyDown(event, sheetId, row.key)}
                  onPaste={(event) => onTrackingInputPaste(event, sheetId, row.key)}
                  placeholder="Masukkan ID"
                />
                {row.trackingInput.trim() ? (
                  <TrackingQrPreview value={row.trackingInput.trim()} />
                ) : null}
                {row.trackingInput.trim() ? (
                  <button
                    type="button"
                    className="tracking-copy-link"
                    title="Salin ID kiriman"
                    aria-label={`Salin ID kiriman ${row.trackingInput.trim()}`}
                    onClick={() => onCopyTrackingId(row.trackingInput.trim())}
                  >
                    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                      <rect
                        x="7"
                        y="4"
                        width="9"
                        height="11"
                        rx="2"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      />
                      <path
                        d="M5.5 12.5H5A2 2 0 0 1 3 10.5v-6A2 2 0 0 1 5 2.5h5A2 2 0 0 1 12 4.5V5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                ) : null}
                {sourceUrl ? (
                  <button
                    type="button"
                    className="tracking-source-link"
                    title="Buka sumber tracking"
                    aria-label={`Buka sumber tracking untuk ${row.trackingInput || "row"}`}
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

        if (column.path === LATEST_BAG_STATUS_COLUMN_PATH) {
          const printUrl = row.shipment
            ? getLatestBagPrintUrl(row.shipment.history_summary)
            : null;

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
            >
              <div className="bag-status-cell">
                <div className="cell-text" title={formattedValue}>
                  {formattedValue}
                </div>
                {printUrl ? (
                  <button
                    type="button"
                    className="bag-print-link"
                    title="Cetak PID/Kantong"
                    aria-label={`Cetak PID/Kantong ${formattedValue.split(" - ")[0]}`}
                    onClick={() => onOpenSourceLink(printUrl)}
                  >
                    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                      <path
                        d="M6.25 6V4.75C6.25 4.05964 6.80964 3.5 7.5 3.5H12.5C13.1904 3.5 13.75 4.05964 13.75 4.75V6"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <path
                        d="M5.5 14.5H4.75C4.05964 14.5 3.5 13.9404 3.5 13.25V8.25C3.5 7.55964 4.05964 7 4.75 7H15.25C15.9404 7 16.5 7.55964 16.5 8.25V13.25C16.5 13.9404 15.9404 14.5 15.25 14.5H14.5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <path
                        d="M6.25 11.5H13.75V15.25C13.75 15.9404 13.1904 16.5 12.5 16.5H7.5C6.80964 16.5 6.25 15.9404 6.25 15.25V11.5Z"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinejoin="round"
                      />
                      <circle cx="13.5" cy="9.5" r="0.75" fill="currentColor" />
                    </svg>
                  </button>
                ) : null}
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
