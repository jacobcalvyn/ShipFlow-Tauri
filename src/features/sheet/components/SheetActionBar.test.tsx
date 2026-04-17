import { fireEvent, render, screen } from "@testing-library/react";
import { SheetActionBar } from "./SheetActionBar";

describe("SheetActionBar", () => {
  it("renders selection actions and wires callbacks", () => {
    const onRetrackAll = vi.fn();
    const onExportCsv = vi.fn();
    const onCopyAllIds = vi.fn();
    const onDeleteAllRows = vi.fn();
    const onClearSelection = vi.fn();
    const onCreateSheetFromSelectedIds = vi.fn();
    const onAppendSelectedIdsToSheet = vi.fn();
    const onClearFilter = vi.fn();
    const onCopySelectedIds = vi.fn();
    const onDeleteSelectedRows = vi.fn();
    const onClearHiddenFilters = vi.fn();
    const onScrollToColumn = vi.fn();

    render(
      <SheetActionBar
        loadedCount={12}
        totalShipmentCount={16}
        loadingCount={4}
        retrackableRowsCount={12}
        deleteAllArmed={false}
        exportableRowsCount={12}
        activeFilterCount={2}
        selectedRowCount={3}
        deleteSelectedArmed={false}
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
        onCreateSheetFromSelectedIds={onCreateSheetFromSelectedIds}
        targetSheetOptions={[
          { id: "sheet-2", name: "Sheet 2" },
          { id: "sheet-3", name: "Sheet 3" },
        ]}
        onAppendSelectedIdsToSheet={onAppendSelectedIdsToSheet}
        onClearFilter={onClearFilter}
        onCopySelectedIds={onCopySelectedIds}
        onDeleteSelectedRows={onDeleteSelectedRows}
        onClearHiddenFilters={onClearHiddenFilters}
        onScrollToColumn={onScrollToColumn}
      />
    );

    expect(screen.getByText("12/16 kiriman dimuat")).toBeInTheDocument();
    expect(screen.getByText("3 row dipilih")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Lacak Ulang" }));
    expect(onRetrackAll).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(onExportCsv).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Copy ID Kiriman" }));
    expect(onCopyAllIds).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Hapus Semua"));
    expect(onDeleteAllRows).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Status Akhir"));
    expect(onScrollToColumn).toHaveBeenCalledWith("status_akhir.status");

    fireEvent.click(screen.getByRole("button", { name: "Clear Selection" }));
    expect(onClearSelection).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("ID Terselect ke Sheet Baru"));
    expect(onCreateSheetFromSelectedIds).toHaveBeenCalledTimes(1);

    fireEvent.mouseEnter(screen.getByRole("button", { name: "ID Terselect ke Sheet Lain" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sheet 2" }));
    expect(onAppendSelectedIdsToSheet).toHaveBeenCalledWith("sheet-2");

    fireEvent.click(screen.getByText("Clear Filter"));
    expect(onClearFilter).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Copy ID Kiriman Terselect"));
    expect(onCopySelectedIds).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Hapus Terselect"));
    expect(onDeleteSelectedRows).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Filter tersembunyi diabaikan: 1"));
    expect(onClearHiddenFilters).toHaveBeenCalledTimes(1);
  });

  it("keeps selection row visible and disabled when nothing is selected", () => {
    render(
      <SheetActionBar
        loadedCount={0}
        totalShipmentCount={0}
        loadingCount={0}
        retrackableRowsCount={0}
        deleteAllArmed={false}
        exportableRowsCount={0}
        activeFilterCount={0}
        selectedRowCount={0}
        deleteSelectedArmed={false}
        ignoredHiddenFilterCount={0}
        columnShortcuts={[]}
        onRetrackAll={vi.fn()}
        onExportCsv={vi.fn()}
        onCopyAllIds={vi.fn()}
        onDeleteAllRows={vi.fn()}
        onClearSelection={vi.fn()}
        onCreateSheetFromSelectedIds={vi.fn()}
        targetSheetOptions={[]}
        onAppendSelectedIdsToSheet={vi.fn()}
        onClearFilter={vi.fn()}
        onCopySelectedIds={vi.fn()}
        onDeleteSelectedRows={vi.fn()}
        onClearHiddenFilters={vi.fn()}
        onScrollToColumn={vi.fn()}
      />
    );

    expect(screen.getByText("0 row dipilih")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear Selection" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "ID Terselect ke Sheet Baru" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "ID Terselect ke Sheet Lain" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copy ID Kiriman Terselect" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Hapus Terselect" })).toBeDisabled();
  });
});
