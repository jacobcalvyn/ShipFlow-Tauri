import { fireEvent, render, screen } from "@testing-library/react";
import { SheetActionBar } from "./SheetActionBar";

describe("SheetActionBar", () => {
  it("renders selection actions and wires callbacks", () => {
    const onRetrackAll = vi.fn();
    const onExportCsv = vi.fn();
    const onCopyAllIds = vi.fn();
    const onDeleteAllRows = vi.fn();
    const onClearSelection = vi.fn();
    const onClearFilter = vi.fn();
    const onCopySelectedIds = vi.fn();
    const onDeleteSelectedRows = vi.fn();
    const onClearHiddenFilters = vi.fn();
    const onScrollToColumn = vi.fn();

    render(
      <SheetActionBar
        loadedCount={12}
        totalShipmentCount={16}
        retrackableRowsCount={12}
        deleteAllArmed={false}
        exportableRowsCount={12}
        activeFilterCount={2}
        selectedRowCount={3}
        ignoredHiddenFilterCount={1}
        columnShortcuts={[
          {
            path: "status_akhir.status",
            label: "Status Akhir",
            disabled: false,
            toneClass: "tone-status",
          },
        ]}
        onRetrackAll={onRetrackAll}
        onExportCsv={onExportCsv}
        onCopyAllIds={onCopyAllIds}
        onDeleteAllRows={onDeleteAllRows}
        onClearSelection={onClearSelection}
        onClearFilter={onClearFilter}
        onCopySelectedIds={onCopySelectedIds}
        onDeleteSelectedRows={onDeleteSelectedRows}
        onClearHiddenFilters={onClearHiddenFilters}
        onScrollToColumn={onScrollToColumn}
      />
    );

    expect(screen.getByText("12/16 kiriman dimuat")).toBeInTheDocument();
    expect(screen.getByText("3 row dipilih")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Lacak Ulang Semua"));
    expect(onRetrackAll).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Export CSV"));
    expect(onExportCsv).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Copy ID Kiriman Semua"));
    expect(onCopyAllIds).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Hapus Semua"));
    expect(onDeleteAllRows).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Status Akhir"));
    expect(onScrollToColumn).toHaveBeenCalledWith("status_akhir.status");

    fireEvent.click(screen.getByText("Clear Selection"));
    expect(onClearSelection).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Clear Filter"));
    expect(onClearFilter).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Copy ID Kiriman Terselect"));
    expect(onCopySelectedIds).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Hapus Terselect"));
    expect(onDeleteSelectedRows).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Filter tersembunyi diabaikan: 1"));
    expect(onClearHiddenFilters).toHaveBeenCalledTimes(1);
  });
});
