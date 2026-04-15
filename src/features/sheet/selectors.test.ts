import { createDefaultSheetState } from "./default-state";
import { setSortInSheet, setTextFilterInSheet, setTrackingInputInSheet } from "./actions";
import {
  getActiveFilterCount,
  getDisplayedRows,
  getLoadedCount,
  getNonEmptyRows,
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
    next = {
      ...next,
      rows: next.rows.map((row, index) =>
        index === 0
          ? {
              ...row,
              shipment: createShipment("P2", "INVEHICLE"),
            }
          : index === 1
            ? {
                ...row,
                shipment: createShipment("P1", "DELIVERED"),
              }
            : row
      ),
    };

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

    expect(getLoadedCount(displayedRows)).toBe(1);
    expect(displayedRows[0].shipment?.detail.shipment_header.nomor_kiriman).toBe("P1");
  });
});
