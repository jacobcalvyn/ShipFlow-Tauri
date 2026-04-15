import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { SheetTable } from "./SheetTable";
import { COLUMNS } from "../columns";
import { SheetRow } from "../types";

const visibleColumns = COLUMNS.slice(0, 2);
const columnWidths = Object.fromEntries(
  visibleColumns.map((column) => [column.path, column.defaultWidth])
);

function createRow(): SheetRow {
  return {
    key: "row-1",
    trackingInput: "P2603310114291",
    shipment: null,
    loading: false,
    stale: false,
    dirty: false,
    error: "",
  };
}

describe("SheetTable", () => {
  it("wires core table interactions", async () => {
    const onToggleVisibleSelection = vi.fn();
    const onToggleRowSelection = vi.fn();
    const onTrackingInputChange = vi.fn();
    const onTrackingInputBlur = vi.fn();
    const onTrackingInputKeyDown = vi.fn();
    const onTrackingInputPaste = vi.fn();
    const onFilterChange = vi.fn();
    const onResizeStart = vi.fn();
    const onToggleColumnMenu = vi.fn();
    const onSetColumnSort = vi.fn();
    const onTogglePinnedColumn = vi.fn();
    const onToggleColumnVisibility = vi.fn();
    const onToggleValueFilter = vi.fn();
    const onClearValueFilter = vi.fn();
    const onCloseColumnMenu = vi.fn();
    const onColumnMenuRef = vi.fn();

    render(
      <SheetTable
        sheetId="sheet-1"
        displayedRows={[createRow()]}
        visibleColumns={visibleColumns}
        hiddenColumns={[]}
        columnWidths={columnWidths}
        pinnedColumnSet={new Set([visibleColumns[0].path])}
        pinnedLeftMap={{ [visibleColumns[0].path]: 52 }}
        hoveredColumn={null}
        allVisibleSelected={false}
        selectedRowKeySet={new Set()}
        filters={{}}
        valueFilters={{ [visibleColumns[0].path]: ["P2603310114291"] }}
        valueOptionsByPath={{
          [visibleColumns[0].path]: ["P2603310114291", "P2603310115000"],
          [visibleColumns[1].path]: ["Alice"],
        }}
        openColumnMenuPath={visibleColumns[0].path}
        highlightedColumnPath={visibleColumns[0].path}
        scrollContainerRef={createRef<HTMLDivElement>()}
        onScrollContainer={vi.fn()}
        sortDirectionForPath={() => null}
        onMouseLeaveTable={vi.fn()}
        onHoverColumn={vi.fn()}
        onToggleVisibleSelection={onToggleVisibleSelection}
        onToggleRowSelection={onToggleRowSelection}
        onTrackingInputChange={onTrackingInputChange}
        onTrackingInputBlur={onTrackingInputBlur}
        onTrackingInputKeyDown={onTrackingInputKeyDown}
        onTrackingInputPaste={onTrackingInputPaste}
        onFilterChange={onFilterChange}
        onResizeStart={onResizeStart}
        onToggleColumnMenu={onToggleColumnMenu}
        onSetColumnSort={onSetColumnSort}
        onTogglePinnedColumn={onTogglePinnedColumn}
        onToggleColumnVisibility={onToggleColumnVisibility}
        onToggleValueFilter={onToggleValueFilter}
        onClearValueFilter={onClearValueFilter}
        onCloseColumnMenu={onCloseColumnMenu}
        onColumnMenuRef={onColumnMenuRef}
      />
    );

    fireEvent.click(screen.getByLabelText("Select visible rows"));
    expect(onToggleVisibleSelection).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText("Select row P2603310114291"));
    expect(onToggleRowSelection).toHaveBeenCalledWith("row-1");

    fireEvent.change(screen.getByPlaceholderText("Masukkan ID"), {
      target: { value: "P999" },
    });
    expect(onTrackingInputChange).toHaveBeenCalledWith("sheet-1", "row-1", "P999");

    fireEvent.change(screen.getAllByPlaceholderText("Filter")[0], {
      target: { value: "P2603" },
    });
    expect(onFilterChange).toHaveBeenCalledWith(visibleColumns[0].path, "P2603");

    fireEvent.click(screen.getByLabelText("P2603310114291"));
    expect(onToggleValueFilter).toHaveBeenCalledWith(
      visibleColumns[0].path,
      "P2603310114291"
    );

    fireEvent.click(screen.getByText("Sort Asc"));
    expect(onSetColumnSort).toHaveBeenCalledWith(visibleColumns[0].path, "asc");
    expect(onCloseColumnMenu).toHaveBeenCalled();
  });
});
