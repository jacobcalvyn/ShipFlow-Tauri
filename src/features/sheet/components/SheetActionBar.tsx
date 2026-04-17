import { createPortal } from "react-dom";
import { ReactNode, useEffect, useRef, useState } from "react";

type SheetActionBarProps = {
  loadedCount: number;
  totalShipmentCount: number;
  loadingCount: number;
  retrackableRowsCount: number;
  deleteAllArmed: boolean;
  exportableRowsCount: number;
  activeFilterCount: number;
  selectedRowCount: number;
  deleteSelectedArmed: boolean;
  ignoredHiddenFilterCount: number;
  columnShortcuts: Array<{
    path: string;
    label: string;
    disabled: boolean;
    toneClass: string;
  }>;
  onRetrackAll: () => void;
  onExportCsv: () => void;
  onCopyAllIds: () => void;
  onDeleteAllRows: () => void;
  onClearSelection: () => void;
  onCreateSheetFromSelectedIds: () => void;
  targetSheetOptions: Array<{
    id: string;
    name: string;
  }>;
  onAppendSelectedIdsToSheet: (sheetId: string) => void;
  onClearFilter: () => void;
  onCopySelectedIds: () => void;
  onDeleteSelectedRows: () => void;
  onClearHiddenFilters: () => void;
  onScrollToColumn: (path: string) => void;
};

function ActionIcon({ children }: { children: ReactNode }) {
  return <span className="action-button-icon" aria-hidden="true">{children}</span>;
}

function ActionLabel({ children }: { children: ReactNode }) {
  return <span className="action-button-label">{children}</span>;
}

function SheetTargetHoverAction({
  disabled,
  options,
  onSelect,
}: {
  disabled: boolean;
  options: Array<{ id: string; name: string }>;
  onSelect: (sheetId: string) => void;
}) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const closeTimeoutRef = useRef<number | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [layout, setLayout] = useState({ top: 0, left: 0, minWidth: 240 });

  const clearCloseTimeout = () => {
    if (closeTimeoutRef.current !== null) {
      window.clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
  };

  const openMenu = () => {
    if (disabled) {
      return;
    }
    clearCloseTimeout();
    setIsOpen(true);
  };

  const scheduleClose = () => {
    clearCloseTimeout();
    closeTimeoutRef.current = window.setTimeout(() => {
      setIsOpen(false);
      closeTimeoutRef.current = null;
    }, 120);
  };

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const updateLayout = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }

      const minWidth = Math.max(240, rect.width);
      let left = rect.left;
      if (left + minWidth > window.innerWidth - 16) {
        left = Math.max(16, window.innerWidth - minWidth - 16);
      }

      setLayout({
        top: rect.bottom + 8,
        left,
        minWidth,
      });
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    updateLayout();
    window.addEventListener("resize", updateLayout);
    window.addEventListener("scroll", updateLayout, true);
    document.addEventListener("keydown", handleEscape);

    return () => {
      window.removeEventListener("resize", updateLayout);
      window.removeEventListener("scroll", updateLayout, true);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen]);

  useEffect(() => {
    return () => {
      clearCloseTimeout();
    };
  }, []);

  return (
    <div
      ref={anchorRef}
      className="sheet-target-hover-action"
      onMouseEnter={openMenu}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        className="action-button action-button-accent-alt"
        disabled={disabled}
        title="ID Terselect ke Sheet Lain"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onFocus={openMenu}
        onBlur={scheduleClose}
        onClick={() => {
          if (!disabled) {
            setIsOpen((current) => !current);
          }
        }}
      >
        <ActionIcon>
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h5A1.5 1.5 0 0 1 12 5.5v9A1.5 1.5 0 0 1 10.5 16h-5A1.5 1.5 0 0 1 4 14.5z" />
            <path d="M8 7.5h7.5A1.5 1.5 0 0 1 17 9v6A1.5 1.5 0 0 1 15.5 16.5H9" />
            <path d="M10 10.5h3.5" />
            <path d="m12 8.5 2 2-2 2" />
          </svg>
        </ActionIcon>
        ID Terselect ke Sheet Lain
      </button>
      {isOpen
        ? createPortal(
            <div
              className="sheet-target-hover-menu"
              role="menu"
              style={{
                top: `${layout.top}px`,
                left: `${layout.left}px`,
                minWidth: `${layout.minWidth}px`,
              }}
              onMouseEnter={openMenu}
              onMouseLeave={scheduleClose}
            >
              <div className="sheet-target-hover-menu-title">Pilih Sheet Tujuan</div>
              <div className="sheet-target-hover-menu-list">
                {options.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className="sheet-target-hover-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setIsOpen(false);
                      onSelect(option.id);
                    }}
                  >
                    {option.name}
                  </button>
                ))}
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

export function SheetActionBar({
  loadedCount,
  totalShipmentCount,
  loadingCount,
  retrackableRowsCount,
  deleteAllArmed,
  exportableRowsCount,
  activeFilterCount,
  selectedRowCount,
  deleteSelectedArmed,
  ignoredHiddenFilterCount,
  columnShortcuts,
  onRetrackAll,
  onExportCsv,
  onCopyAllIds,
  onDeleteAllRows,
  onClearSelection,
  onCreateSheetFromSelectedIds,
  targetSheetOptions,
  onAppendSelectedIdsToSheet,
  onClearFilter,
  onCopySelectedIds,
  onDeleteSelectedRows,
  onClearHiddenFilters,
  onScrollToColumn,
}: SheetActionBarProps) {
  const hasSelection = selectedRowCount > 0;
  const hasAppendTarget = targetSheetOptions.length > 0;
  const hasFilterState = activeFilterCount > 0 || ignoredHiddenFilterCount > 0;
  const progressLabel =
    loadingCount > 0
      ? `${loadedCount}/${totalShipmentCount} kiriman dimuat`
      : `Total ${totalShipmentCount} kiriman`;

  return (
    <>
      <div className="selection-actions">
        <div className="selection-actions-row">
          <span className="selection-count">{progressLabel}</span>
          <span className="action-divider" aria-hidden="true" />
          <button
            type="button"
            className="action-button"
            onClick={onRetrackAll}
            disabled={retrackableRowsCount === 0}
            title="Lacak Ulang"
          >
            <ActionIcon>
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M16 10a6 6 0 1 1-1.757-4.243" />
                <path d="M16 4v4h-4" />
              </svg>
            </ActionIcon>
            <ActionLabel>Lacak Ulang</ActionLabel>
          </button>
          <button
            type="button"
            className="action-button"
            onClick={onExportCsv}
            disabled={exportableRowsCount === 0}
            title="Export CSV"
          >
            <ActionIcon>
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M10 3v8" />
                <path d="m6.5 8.5 3.5 3.5 3.5-3.5" />
                <path d="M4 15.5h12" />
              </svg>
            </ActionIcon>
            <ActionLabel>Export CSV</ActionLabel>
          </button>
          <button
            type="button"
            className="action-button"
            onClick={onCopyAllIds}
            disabled={retrackableRowsCount === 0}
            title="Copy ID Kiriman"
          >
            <ActionIcon>
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="7" y="5" width="8" height="10" rx="1.8" />
                <path d="M5 11V5.8A1.8 1.8 0 0 1 6.8 4H12" />
              </svg>
            </ActionIcon>
            <ActionLabel>Copy ID Kiriman</ActionLabel>
          </button>
          <button
            type="button"
            className="action-button"
            onClick={onClearFilter}
            disabled={!hasFilterState}
            title="Clear Filter"
          >
            <ActionIcon>
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M3.5 4.5h13l-5.2 5.8v4.2l-2.6 1v-5.2z" />
                <path d="m5 15 10-10" />
              </svg>
            </ActionIcon>
            Clear Filter
          </button>
          <button
            type="button"
            className="action-button action-button-danger"
            onClick={onDeleteAllRows}
            disabled={retrackableRowsCount === 0}
            title={deleteAllArmed ? "Konfirmasi Hapus Semua" : "Hapus Semua"}
          >
            <ActionIcon>
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M4.5 6h11" />
                <path d="M7.5 6V4.5h5V6" />
                <path d="M6.5 6l.7 9h5.6l.7-9" />
              </svg>
            </ActionIcon>
            {deleteAllArmed ? "Konfirmasi Hapus Semua" : "Hapus Semua"}
          </button>

          {ignoredHiddenFilterCount > 0 ? (
            <div className="selection-meta">
              <button
                type="button"
                className="sheet-chip chip-button"
                onClick={onClearHiddenFilters}
              >
                Filter tersembunyi diabaikan: {ignoredHiddenFilterCount}
              </button>
            </div>
          ) : null}
        </div>

        <div className="selection-actions-row selection-actions-row-secondary">
          <span className="selection-count">{selectedRowCount} row dipilih</span>
          <span className="action-divider" aria-hidden="true" />
          <button
            type="button"
            className="action-button"
            onClick={onClearSelection}
            disabled={!hasSelection}
            title="Clear Selection"
          >
            <ActionIcon>
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="4.5" y="4.5" width="11" height="11" rx="2" />
                <path d="m7 7 6 6" />
              </svg>
            </ActionIcon>
            <ActionLabel>Clear Selection</ActionLabel>
          </button>
          <button
            type="button"
            className="action-button action-button-accent"
            onClick={onCreateSheetFromSelectedIds}
            disabled={!hasSelection}
            title="ID Terselect ke Sheet Baru"
          >
            <ActionIcon>
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M6 3.5h5l3 3V16a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 5 16V5A1.5 1.5 0 0 1 6.5 3.5" />
                <path d="M11 3.5V7h3" />
                <path d="M10 9v5" />
                <path d="M7.5 11.5h5" />
              </svg>
            </ActionIcon>
            ID Terselect ke Sheet Baru
          </button>
          <SheetTargetHoverAction
            disabled={!hasSelection || !hasAppendTarget}
            options={targetSheetOptions}
            onSelect={onAppendSelectedIdsToSheet}
          />
          <button
            type="button"
            className="action-button"
            onClick={onCopySelectedIds}
            disabled={!hasSelection}
            title="Copy ID Kiriman Terselect"
          >
            <ActionIcon>
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="7" y="5" width="8" height="10" rx="1.8" />
                <path d="M5 11V5.8A1.8 1.8 0 0 1 6.8 4H12" />
              </svg>
            </ActionIcon>
            Copy ID Kiriman Terselect
          </button>
          <button
            type="button"
            className="action-button action-button-danger"
            onClick={onDeleteSelectedRows}
            disabled={!hasSelection}
            title={deleteSelectedArmed ? "Konfirmasi Hapus Terselect" : "Hapus Terselect"}
          >
            <ActionIcon>
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M4.5 6h11" />
                <path d="M7.5 6V4.5h5V6" />
                <path d="M6.5 6l.7 9h5.6l.7-9" />
              </svg>
            </ActionIcon>
            {deleteSelectedArmed ? "Konfirmasi Hapus Terselect" : "Hapus Terselect"}
          </button>
        </div>
      </div>

      <div className="column-shortcuts" aria-label="Column shortcuts">
        {columnShortcuts.map((shortcut) => (
          <button
            key={shortcut.path}
            type="button"
            className={[
              "column-shortcut-button",
              shortcut.toneClass,
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={() => onScrollToColumn(shortcut.path)}
            disabled={shortcut.disabled}
          >
            {shortcut.label}
          </button>
        ))}
      </div>
    </>
  );
}
