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
        <>
          <span className="selection-count">{progressLabel}</span>
          <span className="action-divider" aria-hidden="true" />
        </>
        <button
          type="button"
          className="action-button"
          onClick={onRetrackAll}
          disabled={retrackableRowsCount === 0}
        >
          Lacak Ulang
        </button>
        <button
          type="button"
          className="action-button"
          onClick={onExportCsv}
          disabled={exportableRowsCount === 0}
        >
          Export CSV
        </button>
        <button
          type="button"
          className="action-button"
          onClick={onCopyAllIds}
          disabled={retrackableRowsCount === 0}
        >
          Copy ID Kiriman
        </button>
        <button
          type="button"
          className="action-button"
          onClick={onClearFilter}
          disabled={!hasFilterState}
        >
          Clear Filter
        </button>
        <button
          type="button"
          className="action-button action-button-danger"
          onClick={onDeleteAllRows}
          disabled={retrackableRowsCount === 0}
        >
          {deleteAllArmed ? "Konfirmasi Hapus Semua" : "Hapus Semua"}
        </button>

        {hasSelection ? (
          <>
            <span className="action-divider" aria-hidden="true" />
            <span className="selection-count">{selectedRowCount} row dipilih</span>
            <button
              type="button"
              className="action-button"
              onClick={onClearSelection}
            >
              Clear Selection
            </button>
            <button
              type="button"
              className="action-button"
              onClick={onCreateSheetFromSelectedIds}
            >
              ID Terselect ke Sheet Baru
            </button>
            <button
              type="button"
              className="action-button"
              onClick={onCopySelectedIds}
            >
              Copy ID Kiriman Terselect
            </button>
            <button
              type="button"
              className="action-button action-button-danger"
              onClick={onDeleteSelectedRows}
            >
              Hapus Terselect
            </button>
          </>
        ) : null}

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
