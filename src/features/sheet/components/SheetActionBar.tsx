import { FilterPreset } from "../types";

type SheetActionBarProps = {
  loadedCount: number;
  exportableRowsCount: number;
  presetNameInput: string;
  activeFilterCount: number;
  selectedPresetId: string;
  filterPresets: FilterPreset[];
  selectedRowCount: number;
  ignoredHiddenFilterCount: number;
  sortLabel: string;
  onPresetNameInputChange: (value: string) => void;
  onSelectedPresetChange: (value: string) => void;
  onExportCsv: () => void;
  onSavePreset: () => void;
  onApplyPreset: () => void;
  onDeletePreset: () => void;
  onClearSelection: () => void;
  onClearFilter: () => void;
  onCopySelectedIds: () => void;
  onDeleteSelectedRows: () => void;
  onClearHiddenFilters: () => void;
};

export function SheetActionBar({
  loadedCount,
  exportableRowsCount,
  presetNameInput,
  activeFilterCount,
  selectedPresetId,
  filterPresets,
  selectedRowCount,
  ignoredHiddenFilterCount,
  sortLabel,
  onPresetNameInputChange,
  onSelectedPresetChange,
  onExportCsv,
  onSavePreset,
  onApplyPreset,
  onDeletePreset,
  onClearSelection,
  onClearFilter,
  onCopySelectedIds,
  onDeleteSelectedRows,
  onClearHiddenFilters,
}: SheetActionBarProps) {
  const hasSelection = selectedRowCount > 0;
  const hasFilterState = activeFilterCount > 0 || ignoredHiddenFilterCount > 0;

  return (
    <div className="selection-actions">
      <span className="selection-count">{loadedCount} kiriman dimuat</span>
      <span className="action-divider" aria-hidden="true" />
      <button
        type="button"
        className="action-button"
        onClick={onExportCsv}
        disabled={exportableRowsCount === 0}
      >
        Export CSV
      </button>

      <details className="tool-popover">
        <summary>Preset Filter</summary>
        <div className="tool-popover-body preset-manager">
          <div className="preset-input-row">
            <input
              type="text"
              className="tool-input"
              value={presetNameInput}
              onChange={(event) => onPresetNameInputChange(event.target.value)}
              placeholder="Nama preset"
            />
            <button
              type="button"
              className="action-button"
              onClick={onSavePreset}
              disabled={presetNameInput.trim() === "" || activeFilterCount === 0}
            >
              Save Current
            </button>
          </div>

          <div className="preset-input-row">
            <select
              className="tool-select"
              value={selectedPresetId}
              onChange={(event) => onSelectedPresetChange(event.target.value)}
            >
              <option value="">Pilih preset</option>
              {filterPresets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="action-button"
              onClick={onApplyPreset}
              disabled={selectedPresetId === ""}
            >
              Terapkan
            </button>
            <button
              type="button"
              className="action-button action-button-danger"
              onClick={onDeletePreset}
              disabled={selectedPresetId === ""}
            >
              Hapus Preset
            </button>
          </div>
        </div>
      </details>

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
            onClick={onClearFilter}
            disabled={!hasFilterState}
          >
            Clear Filter
          </button>
          <button
            type="button"
            className="action-button"
            onClick={onCopySelectedIds}
          >
            Copy ID Kiriman
          </button>
          <button
            type="button"
            className="action-button action-button-danger"
            onClick={onDeleteSelectedRows}
          >
            Hapus
          </button>
        </>
      ) : (
        <button
          type="button"
          className="action-button"
          onClick={onClearFilter}
          disabled={!hasFilterState}
        >
          Clear Filter
        </button>
      )}

      <div className="selection-meta">
        <span className="sheet-chip">Filter aktif: {activeFilterCount}</span>
        {ignoredHiddenFilterCount > 0 ? (
          <button
            type="button"
            className="sheet-chip chip-button"
            onClick={onClearHiddenFilters}
          >
            Filter tersembunyi diabaikan: {ignoredHiddenFilterCount}
          </button>
        ) : null}
        <span className="sheet-chip">Sort: {sortLabel}</span>
      </div>
    </div>
  );
}
