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
import { COLUMNS } from "../columns";
import { SheetRow } from "../types";

const visibleColumns = COLUMNS.slice(0, 6);
const columnWidths = Object.fromEntries(
  visibleColumns.map((column) => [column.path, column.defaultWidth])
);

function createBenchmarkRow(index: number): SheetRow {
  return {
    key: `bench-row-${index}`,
    trackingInput: `P2604${String(index).padStart(6, "0")}`,
    shipment: null,
    loading: false,
    stale: false,
    dirty: false,
    error: "",
  };
}

describe("SheetTable benchmark", () => {
  it("renders 1000 rows with virtualization and logs baseline metrics", async () => {
    const originalClientHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientHeight"
    );

    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        if (this instanceof HTMLElement && this.classList.contains("sheet-scroll")) {
          return 720;
        }
        return originalClientHeight?.get?.call(this) ?? 0;
      },
    });

    const rows = Array.from({ length: 1000 }, (_, index) => createBenchmarkRow(index));
    const scrollRef = createRef<HTMLDivElement>();
    const renderStartedAt = performance.now();

    render(
      <SheetTable
        sheetId="bench-sheet"
        displayScale="small"
        displayedRows={rows}
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
        scrollContainerRef={scrollRef}
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
      expect(screen.getAllByPlaceholderText("Masukkan ID").length).toBeLessThan(80);
    });

    const renderedInputCount = screen.getAllByPlaceholderText("Masukkan ID").length;
    const initialRenderMs = performance.now() - renderStartedAt;

    const scrollContainer = document.querySelector(".sheet-scroll") as HTMLDivElement | null;
    expect(scrollContainer).not.toBeNull();

    const firstRenderedBeforeScroll = screen.getAllByPlaceholderText(
      "Masukkan ID"
    )[0] as HTMLInputElement;

    const scrollStartedAt = performance.now();
    if (scrollContainer) {
      fireEvent.scroll(scrollContainer, { target: { scrollTop: 60000 } });
    }

    await waitFor(() => {
      expect(screen.getAllByPlaceholderText("Masukkan ID").length).toBeLessThan(80);
      expect(screen.getAllByPlaceholderText("Masukkan ID")[0]).not.toBe(
        firstRenderedBeforeScroll
      );
    });

    const postScrollVisibleInputCount = screen.getAllByPlaceholderText(
      "Masukkan ID"
    ).length;
    const scrollUpdateMs = performance.now() - scrollStartedAt;

    console.info("[SheetTableBenchmark]", {
      datasetSize: rows.length,
      renderedInputCount,
      postScrollVisibleInputCount,
      initialRenderMs: Number(initialRenderMs.toFixed(2)),
      scrollUpdateMs: Number(scrollUpdateMs.toFixed(2)),
    });

    if (originalClientHeight) {
      Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
    }
  });
});
