import { fireEvent, render, screen } from "@testing-library/react";
import { SheetActionBar } from "./SheetActionBar";

describe("SheetActionBar", () => {
  it("renders selection actions and wires callbacks", () => {
    const onPresetNameInputChange = vi.fn();
    const onSelectedPresetChange = vi.fn();
    const onExportCsv = vi.fn();
    const onSavePreset = vi.fn();
    const onApplyPreset = vi.fn();
    const onDeletePreset = vi.fn();
    const onClearSelection = vi.fn();
    const onClearFilter = vi.fn();
    const onCopySelectedIds = vi.fn();
    const onDeleteSelectedRows = vi.fn();
    const onClearHiddenFilters = vi.fn();

    render(
      <SheetActionBar
        loadedCount={12}
        exportableRowsCount={12}
        presetNameInput="Jakarta Only"
        activeFilterCount={2}
        selectedPresetId="preset-1"
        filterPresets={[
          {
            id: "preset-1",
            name: "Jakarta Only",
            textFilters: { "detail.origin_detail.nama_kantor": "KCU" },
            valueFilters: {},
          },
        ]}
        selectedRowCount={3}
        ignoredHiddenFilterCount={1}
        sortLabel="↑"
        onPresetNameInputChange={onPresetNameInputChange}
        onSelectedPresetChange={onSelectedPresetChange}
        onExportCsv={onExportCsv}
        onSavePreset={onSavePreset}
        onApplyPreset={onApplyPreset}
        onDeletePreset={onDeletePreset}
        onClearSelection={onClearSelection}
        onClearFilter={onClearFilter}
        onCopySelectedIds={onCopySelectedIds}
        onDeleteSelectedRows={onDeleteSelectedRows}
        onClearHiddenFilters={onClearHiddenFilters}
      />
    );

    expect(screen.getByText("12 kiriman dimuat")).toBeInTheDocument();
    expect(screen.getByText("3 row dipilih")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Export CSV"));
    expect(onExportCsv).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Preset Filter"));
    fireEvent.change(screen.getByPlaceholderText("Nama preset"), {
      target: { value: "COD" },
    });
    expect(onPresetNameInputChange).toHaveBeenCalledWith("COD");

    fireEvent.click(screen.getByText("Save Current"));
    expect(onSavePreset).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "preset-1" },
    });
    expect(onSelectedPresetChange).toHaveBeenCalledWith("preset-1");

    fireEvent.click(screen.getByText("Terapkan"));
    expect(onApplyPreset).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Hapus Preset"));
    expect(onDeletePreset).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Clear Selection"));
    expect(onClearSelection).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Clear Filter"));
    expect(onClearFilter).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Copy ID Kiriman"));
    expect(onCopySelectedIds).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Hapus"));
    expect(onDeleteSelectedRows).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Filter tersembunyi diabaikan: 1"));
    expect(onClearHiddenFilters).toHaveBeenCalledTimes(1);
  });
});
