import { createDefaultSheetState } from "./default-state";
import {
  setRowSuccessInSheet,
  setRowsQueuedInSheet,
  setSortInSheet,
  setTextFilterInSheet,
  setTrackingInputInSheet,
} from "./actions";
import {
  getActiveFilterCount,
  getColumnShortcuts,
  getDisplayedRows,
  getEffectiveColumnWidths,
  getNonEmptyRows,
  getValueOptionsForOpenColumn,
  getVisibleColumns,
  getVisibleColumnPathSet,
} from "./selectors";
import { TrackResponse } from "../../types";

function createShipment(nomorKiriman: string, status: string): TrackResponse {
  return {
    url: "https://example.test",
    detail: {
      shipment_header: {
        nomor_kiriman: nomorKiriman,
      },
      origin_detail: {},
      package_detail: {
        berat_actual: 0,
        berat_volumetric: 0,
      },
      billing_detail: {
        bea_dasar: 0,
        nilai_barang: 0,
        htnb: 0,
        cod_info: {
          is_cod: false,
          total_cod: 0,
        },
      },
      actors: {
        pengirim: {},
        penerima: {},
      },
      performance_detail: {},
    },
    status_akhir: {
      status,
    },
    pod: {},
    history: [],
    history_summary: {
      irregularity: [],
      bagging_unbagging: [],
      manifest_r7: [],
      delivery_runsheet: [],
    },
  };
}

describe("sheet selectors", () => {
  it("counts active filters only on visible columns", () => {
    const initial = createDefaultSheetState();
    const withFilters = {
      ...initial,
      filters: {
        "status_akhir.status": "invehicle",
        "detail.origin_detail.id_kantor": "12345",
      },
      hiddenColumnPaths: ["detail.origin_detail.id_kantor"],
    };

    const visibleColumns = getVisibleColumns(withFilters);
    const visiblePathSet = getVisibleColumnPathSet(visibleColumns);

    expect(getActiveFilterCount(withFilters, visiblePathSet)).toBe(1);
  });

  it("returns all empty rows when there is no shipment data yet", () => {
    const initial = createDefaultSheetState();
    const visibleColumns = getVisibleColumns(initial);
    const visiblePathSet = getVisibleColumnPathSet(visibleColumns);
    const displayedRows = getDisplayedRows(
      initial,
      getNonEmptyRows(initial.rows),
      visibleColumns,
      getActiveFilterCount(initial, visiblePathSet)
    );

    expect(displayedRows).toHaveLength(initial.rows.length);
  });

  it("filters and sorts non-empty rows deterministically", () => {
    const initial = createDefaultSheetState();
    const rowA = initial.rows[0].key;
    const rowB = initial.rows[1].key;

    let next = setTrackingInputInSheet(initial, rowA, "P2");
    next = setTrackingInputInSheet(next, rowB, "P1");
    next = setRowSuccessInSheet(next, rowA, "P2", createShipment("P2", "INVEHICLE"));
    next = setRowSuccessInSheet(next, rowB, "P1", createShipment("P1", "DELIVERED"));

    next = setTextFilterInSheet(next, "status_akhir.status", "delivered");
    next = setSortInSheet(next, "detail.shipment_header.nomor_kiriman", "asc");

    const visibleColumns = getVisibleColumns(next);
    const visiblePathSet = getVisibleColumnPathSet(visibleColumns);
    const displayedRows = getDisplayedRows(
      next,
      getNonEmptyRows(next.rows),
      visibleColumns,
      getActiveFilterCount(next, visiblePathSet)
    );

    const loadedRows = displayedRows.filter((row) => row.shipment !== null);
    expect(loadedRows).toHaveLength(1);
    expect(loadedRows[0].shipment?.detail.shipment_header.nomor_kiriman).toBe("P1");
  });

  it("keeps queued rows visible without counting stale shipment data as loaded", () => {
    const initial = createDefaultSheetState();
    const rowKey = initial.rows[0].key;
    const loaded = setRowSuccessInSheet(
      initial,
      rowKey,
      "P1",
      createShipment("P1", "INVEHICLE")
    );
    const queued = setRowsQueuedInSheet(loaded, [{ key: rowKey, value: "P1" }]);
    const filtered = setTextFilterInSheet(queued, "status_akhir.status", "delivered");

    const visibleColumns = getVisibleColumns(filtered);
    const visiblePathSet = getVisibleColumnPathSet(visibleColumns);
    const displayedRows = getDisplayedRows(
      filtered,
      getNonEmptyRows(filtered.rows),
      visibleColumns,
      getActiveFilterCount(filtered, visiblePathSet)
    );

    expect(displayedRows.some((row) => row.key === rowKey && row.queued)).toBe(true);
  });

  it("does not force settled Rust-owned local rows visible through filters", () => {
    const initial = createDefaultSheetState();
    const rowKey = initial.rows[0].key;
    const withTracking = setTrackingInputInSheet(initial, rowKey, "P1");
    const settled = {
      ...withTracking,
      rows: withTracking.rows.map((row) =>
        row.key === rowKey
          ? {
              ...row,
              loading: false,
              queued: false,
              stale: false,
              dirty: false,
              shipment: null,
            }
          : row
      ),
    };
    const filtered = setTextFilterInSheet(
      settled,
      "detail.shipment_header.nomor_kiriman",
      "P2"
    );

    const visibleColumns = getVisibleColumns(filtered);
    const visiblePathSet = getVisibleColumnPathSet(visibleColumns);
    const displayedRows = getDisplayedRows(
      filtered,
      getNonEmptyRows(filtered.rows),
      visibleColumns,
      getActiveFilterCount(filtered, visiblePathSet)
    );

    expect(displayedRows.some((row) => row.key === rowKey)).toBe(false);
  });

  it("applies caller-provided tracking auto width to the tracking column", () => {
    let next = createDefaultSheetState();
    next = setTrackingInputInSheet(
      next,
      next.rows[0].key,
      "SHPE26040250CE10034572-LONG-VALUE-123456"
    );
    next = setTrackingInputInSheet(
      next,
      next.rows[1].key,
      "X".repeat(200)
    );

    const visibleColumns = getVisibleColumns(next);
    const widths = getEffectiveColumnWidths(
      visibleColumns,
      next.columnWidths,
      320
    );

    expect(widths["detail.shipment_header.nomor_kiriman"]).toBe(320);
  });

  it("places the PID/Kantong shortcut before Status Akhir", () => {
    const visibleColumns = getVisibleColumns(createDefaultSheetState());
    const visiblePathSet = getVisibleColumnPathSet(visibleColumns);
    const shortcuts = getColumnShortcuts(visiblePathSet);
    const pidShortcutIndex = shortcuts.findIndex(
      (shortcut) => shortcut.path === "history_summary.latest_bagging_status"
    );
    const statusShortcutIndex = shortcuts.findIndex(
      (shortcut) => shortcut.path === "status_akhir.status"
    );

    expect(pidShortcutIndex).toBeGreaterThanOrEqual(0);
    expect(statusShortcutIndex).toBeGreaterThan(pidShortcutIndex);
  });

  it("places the Kantor Kirim shortcut before Jenis Layanan", () => {
    const visibleColumns = getVisibleColumns(createDefaultSheetState());
    const visiblePathSet = getVisibleColumnPathSet(visibleColumns);
    const shortcuts = getColumnShortcuts(visiblePathSet);
    const officeShortcutIndex = shortcuts.findIndex(
      (shortcut) => shortcut.path === "detail.origin_detail.nama_kantor"
    );
    const serviceShortcutIndex = shortcuts.findIndex(
      (shortcut) => shortcut.path === "detail.package_detail.jenis_layanan"
    );

    expect(officeShortcutIndex).toBeGreaterThanOrEqual(0);
    expect(serviceShortcutIndex).toBeGreaterThan(officeShortcutIndex);
    expect(shortcuts[officeShortcutIndex]?.label).toBe("Kantor Kirim");
  });

  it("does not build value filter options for photo and raw JSON columns", () => {
    const sheet = createDefaultSheetState();
    const row = {
      ...sheet.rows[0],
      trackingInput: "P260000000001",
      shipment: {
        ...createShipment("P260000000001", "DELIVERED"),
        pod: {
          photo1_url: "https://example.test/pod-1.jpg",
        },
        history_summary: {
          irregularity: [],
          bagging_unbagging: [
            {
              nomor_kantung: "PID123",
            },
          ],
          manifest_r7: [],
          delivery_runsheet: [],
        },
      },
    };
    const visibleColumns = getVisibleColumns(sheet);

    expect(
      getValueOptionsForOpenColumn([row], visibleColumns, "pod.photo1_url")
    ).toEqual({});
    expect(
      getValueOptionsForOpenColumn(
        [row],
        visibleColumns,
        "history_summary.bagging_unbagging"
      )
    ).toEqual({});
  });
});
