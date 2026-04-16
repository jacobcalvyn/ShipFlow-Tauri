type SheetActionBarProps = {
  loadedCount: number;
  totalShipmentCount: number;
  loadingCount: number;
  retrackableRowsCount: number;
  deleteAllArmed: boolean;
  exportableRowsCount: number;
  activeFilterCount: number;
  selectedRowCount: number;
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
  onClearFilter: () => void;
  onCopySelectedIds: () => void;
  onDeleteSelectedRows: () => void;
  onClearHiddenFilters: () => void;
  onScrollToColumn: (path: string) => void;
};

function ActionIcon({ children }: { children: React.ReactNode }) {
  return <span className="action-button-icon" aria-hidden="true">{children}</span>;
}

function ActionLabel({ children }: { children: React.ReactNode }) {
  return <span className="action-button-label">{children}</span>;
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
  ignoredHiddenFilterCount,
  columnShortcuts,
  onRetrackAll,
  onExportCsv,
  onCopyAllIds,
  onDeleteAllRows,
  onClearSelection,
  onCreateSheetFromSelectedIds,
  onClearFilter,
  onCopySelectedIds,
  onDeleteSelectedRows,
  onClearHiddenFilters,
  onScrollToColumn,
}: SheetActionBarProps) {
  const hasSelection = selectedRowCount > 0;
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
            className="action-button"
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
            title="Hapus Terselect"
          >
            <ActionIcon>
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M4.5 6h11" />
                <path d="M7.5 6V4.5h5V6" />
                <path d="M6.5 6l.7 9h5.6l.7-9" />
              </svg>
            </ActionIcon>
            Hapus Terselect
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
