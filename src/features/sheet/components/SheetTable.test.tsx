import { createRef } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const { mockedInvoke } = vi.hoisted(() => ({
  mockedInvoke: vi.fn().mockResolvedValue("data:image/jpeg;base64,pod"),
}));

const { mockedToDataUrl } = vi.hoisted(() => ({
  mockedToDataUrl: vi.fn().mockResolvedValue("data:image/png;base64,qr"),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockedInvoke,
}));

vi.mock("qrcode", () => ({
  default: {
    toDataURL: mockedToDataUrl,
  },
}));

import { SheetTable } from "./SheetTable";
import { getPreviewPortalLayout } from "./SheetBodyRow";
import { COLUMNS, LATEST_BAG_STATUS_COLUMN_PATH } from "../columns";
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
    const onOpenSourceLink = vi.fn();
    const onCopyTrackingId = vi.fn();
    const onClearTrackingCell = vi.fn();
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
        displayScale="small"
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
        onOpenSourceLink={onOpenSourceLink}
        onCopyTrackingId={onCopyTrackingId}
        onClearTrackingCell={onClearTrackingCell}
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

  it("clamps preview layout to the viewport on small screens", () => {
    const layout = getPreviewPortalLayout(
      {
        top: 40,
        left: 80,
        right: 140,
        height: 36,
      } as DOMRect,
      320,
      280,
      520,
      420
    );

    expect(layout.width).toBeLessThanOrEqual(288);
    expect(layout.height).toBeLessThanOrEqual(248);
    expect(layout.left).toBeGreaterThanOrEqual(16);
    expect(layout.top).toBeGreaterThanOrEqual(16);
  });

  it("lazy-generates QR previews only after the first hover", async () => {
    mockedToDataUrl.mockClear();

    render(
      <SheetTable
        sheetId="sheet-1"
        displayScale="small"
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
        valueFilters={{}}
        valueOptionsByPath={{}}
        openColumnMenuPath={null}
        highlightedColumnPath={null}
        scrollContainerRef={createRef<HTMLDivElement>()}
        onScrollContainer={vi.fn()}
        sortDirectionForPath={() => null}
        onMouseLeaveTable={vi.fn()}
        onHoverColumn={vi.fn()}
        onToggleVisibleSelection={vi.fn()}
        onToggleRowSelection={vi.fn()}
        onOpenSourceLink={vi.fn()}
        onCopyTrackingId={vi.fn()}
        onClearTrackingCell={vi.fn()}
        onTrackingInputChange={vi.fn()}
        onTrackingInputBlur={vi.fn()}
        onTrackingInputKeyDown={vi.fn()}
        onTrackingInputPaste={vi.fn()}
        onFilterChange={vi.fn()}
        onResizeStart={vi.fn()}
        onToggleColumnMenu={vi.fn()}
        onSetColumnSort={vi.fn()}
        onTogglePinnedColumn={vi.fn()}
        onToggleColumnVisibility={vi.fn()}
        onToggleValueFilter={vi.fn()}
        onClearValueFilter={vi.fn()}
        onCloseColumnMenu={vi.fn()}
        onColumnMenuRef={vi.fn()}
      />
    );

    expect(mockedToDataUrl).not.toHaveBeenCalled();

    const qrButton = screen.getByRole("button", {
      name: "Lihat QR code untuk P2603310114291",
    });
    fireEvent.mouseEnter(qrButton.parentElement as HTMLElement);

    await screen.findByText("QR Code");
    expect(mockedToDataUrl).toHaveBeenCalledTimes(1);

    fireEvent.mouseLeave(qrButton.parentElement as HTMLElement);
    fireEvent.mouseEnter(qrButton.parentElement as HTMLElement);

    expect(mockedToDataUrl).toHaveBeenCalledTimes(1);
  });

  it("lazy-resolves POD previews only after the first hover", async () => {
    mockedInvoke.mockClear();

    const podColumns = COLUMNS.filter((column) =>
      ["detail.shipment_header.nomor_kiriman", "pod.photo1_url"].includes(column.path)
    );
    const podColumnWidths = Object.fromEntries(
      podColumns.map((column) => [column.path, column.defaultWidth])
    );
    const podRow: SheetRow = {
      key: "row-pod-1",
      trackingInput: "POD-1",
      shipment: {
        url: "https://example.test/pod",
        detail: {
          shipment_header: {
            nomor_kiriman: "POD-1",
          },
        },
        status_akhir: {
          status: "READY",
        },
        pod: {
          photo1_url: "raw-pod-image",
        },
        history: [],
        history_summary: {
          irregularity: [],
          bagging_unbagging: [],
          manifest_r7: [],
          delivery_runsheet: [],
        },
      } as never,
      loading: false,
      stale: false,
      dirty: false,
      error: "",
    };

    render(
      <SheetTable
        sheetId="sheet-1"
        displayScale="small"
        displayedRows={[podRow]}
        visibleColumns={podColumns}
        hiddenColumns={[]}
        columnWidths={podColumnWidths}
        pinnedColumnSet={new Set([podColumns[0].path])}
        pinnedLeftMap={{ [podColumns[0].path]: 52 }}
        hoveredColumn={null}
        allVisibleSelected={false}
        selectedRowKeySet={new Set()}
        filters={{}}
        valueFilters={{}}
        valueOptionsByPath={{}}
        openColumnMenuPath={null}
        highlightedColumnPath={null}
        scrollContainerRef={createRef<HTMLDivElement>()}
        onScrollContainer={vi.fn()}
        sortDirectionForPath={() => null}
        onMouseLeaveTable={vi.fn()}
        onHoverColumn={vi.fn()}
        onToggleVisibleSelection={vi.fn()}
        onToggleRowSelection={vi.fn()}
        onOpenSourceLink={vi.fn()}
        onCopyTrackingId={vi.fn()}
        onClearTrackingCell={vi.fn()}
        onTrackingInputChange={vi.fn()}
        onTrackingInputBlur={vi.fn()}
        onTrackingInputKeyDown={vi.fn()}
        onTrackingInputPaste={vi.fn()}
        onFilterChange={vi.fn()}
        onResizeStart={vi.fn()}
        onToggleColumnMenu={vi.fn()}
        onSetColumnSort={vi.fn()}
        onTogglePinnedColumn={vi.fn()}
        onToggleColumnVisibility={vi.fn()}
        onToggleValueFilter={vi.fn()}
        onClearValueFilter={vi.fn()}
        onCloseColumnMenu={vi.fn()}
        onColumnMenuRef={vi.fn()}
      />
    );

    expect(mockedInvoke).not.toHaveBeenCalled();
    expect(screen.getByLabelText("POD Photo 1 placeholder")).toBeInTheDocument();

    fireEvent.mouseEnter(screen.getByLabelText("POD Photo 1 placeholder").parentElement as HTMLElement);

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith("resolve_pod_image", {
        imageSource: "raw-pod-image",
      });
    });

    await waitFor(() => {
      expect(screen.getAllByAltText("POD Photo 1")).toHaveLength(2);
    });

    mockedInvoke.mockClear();
    fireEvent.mouseLeave(screen.getAllByAltText("POD Photo 1")[0].parentElement as HTMLElement);
    fireEvent.mouseEnter(screen.getAllByAltText("POD Photo 1")[0].parentElement as HTMLElement);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("opens the bag print URL from the latest PID column", () => {
    const onOpenSourceLink = vi.fn();
    const bagColumns = COLUMNS.filter((column) =>
      [LATEST_BAG_STATUS_COLUMN_PATH].includes(column.path)
    );
    const bagColumnWidths = Object.fromEntries(
      bagColumns.map((column) => [column.path, column.defaultWidth])
    );
    const bagRow: SheetRow = {
      key: "row-bag-1",
      trackingInput: "P2603310114291",
      shipment: {
        url: "",
        detail: {
          shipment_header: {
            nomor_kiriman: "P2603310114291",
          },
        },
        status_akhir: {
          status: "READY",
        },
        pod: {},
        history: [],
        history_summary: {
          irregularity: [],
          bagging_unbagging: [
            {
              nomor_kantung: "PID89477731",
              bagging: {
                lokasi: "DC JAYAPURA 9910A",
                tanggal: "2026-04-22",
                waktu: "12:00:00",
              },
              unbagging: {
                lokasi: "SPP JAYAPURA",
                tanggal: "2026-04-22",
                waktu: "12:30:00",
              },
            },
          ],
          manifest_r7: [],
          delivery_runsheet: [],
        },
      } as never,
      loading: false,
      stale: false,
      dirty: false,
      error: "",
    };

    render(
      <SheetTable
        sheetId="sheet-1"
        displayScale="small"
        displayedRows={[bagRow]}
        visibleColumns={bagColumns}
        hiddenColumns={[]}
        columnWidths={bagColumnWidths}
        pinnedColumnSet={new Set()}
        pinnedLeftMap={{}}
        hoveredColumn={null}
        allVisibleSelected={false}
        selectedRowKeySet={new Set()}
        filters={{}}
        valueFilters={{}}
        valueOptionsByPath={{}}
        openColumnMenuPath={null}
        highlightedColumnPath={null}
        scrollContainerRef={createRef<HTMLDivElement>()}
        onScrollContainer={vi.fn()}
        sortDirectionForPath={() => null}
        onMouseLeaveTable={vi.fn()}
        onHoverColumn={vi.fn()}
        onToggleVisibleSelection={vi.fn()}
        onToggleRowSelection={vi.fn()}
        onOpenSourceLink={onOpenSourceLink}
        onCopyTrackingId={vi.fn()}
        onClearTrackingCell={vi.fn()}
        onTrackingInputChange={vi.fn()}
        onTrackingInputBlur={vi.fn()}
        onTrackingInputKeyDown={vi.fn()}
        onTrackingInputPaste={vi.fn()}
        onFilterChange={vi.fn()}
        onResizeStart={vi.fn()}
        onToggleColumnMenu={vi.fn()}
        onSetColumnSort={vi.fn()}
        onTogglePinnedColumn={vi.fn()}
        onToggleColumnVisibility={vi.fn()}
        onToggleValueFilter={vi.fn()}
        onClearValueFilter={vi.fn()}
        onCloseColumnMenu={vi.fn()}
        onColumnMenuRef={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Cetak PID/Kantong PID89477731" }));

    expect(onOpenSourceLink).toHaveBeenCalledWith(
      "https://apiexpos.mile.app/api/v1/print-bag?bag_id=PID89477731_5f9fae9b5fbe9d6e401ad0c5&oid=NWY5ZmFlOWI1ZmJlOWQ2ZTQwMWFkMGM1"
    );
  });

  it("virtualizes large row sets instead of rendering every row at once", async () => {
    const originalClientHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientHeight"
    );

    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        if (this instanceof HTMLElement && this.classList.contains("sheet-scroll")) {
          return 420;
        }
        return originalClientHeight?.get?.call(this) ?? 0;
      },
    });

    const manyRows = Array.from({ length: 180 }, (_, index) => ({
      ...createRow(),
      key: `row-${index}`,
      trackingInput: `P${index}`,
    }));

    render(
      <SheetTable
        sheetId="sheet-1"
        displayScale="small"
        displayedRows={manyRows}
        visibleColumns={visibleColumns}
        hiddenColumns={[]}
        columnWidths={columnWidths}
        pinnedColumnSet={new Set([visibleColumns[0].path])}
        pinnedLeftMap={{ [visibleColumns[0].path]: 52 }}
        hoveredColumn={null}
        allVisibleSelected={false}
        selectedRowKeySet={new Set()}
        filters={{}}
        valueFilters={{}}
        valueOptionsByPath={{}}
        openColumnMenuPath={null}
        highlightedColumnPath={null}
        scrollContainerRef={createRef<HTMLDivElement>()}
        onScrollContainer={vi.fn()}
        sortDirectionForPath={() => null}
        onMouseLeaveTable={vi.fn()}
        onHoverColumn={vi.fn()}
        onToggleVisibleSelection={vi.fn()}
        onToggleRowSelection={vi.fn()}
        onOpenSourceLink={vi.fn()}
        onCopyTrackingId={vi.fn()}
        onClearTrackingCell={vi.fn()}
        onTrackingInputChange={vi.fn()}
        onTrackingInputBlur={vi.fn()}
        onTrackingInputKeyDown={vi.fn()}
        onTrackingInputPaste={vi.fn()}
        onFilterChange={vi.fn()}
        onResizeStart={vi.fn()}
        onToggleColumnMenu={vi.fn()}
        onSetColumnSort={vi.fn()}
        onTogglePinnedColumn={vi.fn()}
        onToggleColumnVisibility={vi.fn()}
        onToggleValueFilter={vi.fn()}
        onClearValueFilter={vi.fn()}
        onCloseColumnMenu={vi.fn()}
        onColumnMenuRef={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByPlaceholderText("Masukkan ID").length).toBeLessThan(180);
    });

    if (originalClientHeight) {
      Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
    }
  });
});
