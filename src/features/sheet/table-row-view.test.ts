import { describe, expect, it } from "vitest";
import type { SheetRowWindow } from "../workspace-engine/client";
import { createEmptyRows } from "./utils";
import {
  createSheetTableRowsFromSheetRows,
  createSheetTableRowsFromRustWindow,
  getSelectedTableRowEngineRowIds,
  getSelectedTableRowKeySet,
  getSelectedVisibleTableRowKeys,
  getTableRowTrackingColumnAutoWidth,
  getTotalTableRowTrackingCount,
} from "./table-row-view";

function createShipment(id: string) {
  return {
    url: "",
    detail: {
      shipment_header: {
        nomor_kiriman: id,
      },
      origin_detail: {},
      package_detail: {},
      billing_detail: {
        cod_info: {
          is_cod: false,
        },
      },
      actors: {
        pengirim: {},
        penerima: {},
      },
      performance_detail: {},
    },
    status_akhir: {
      status: "DELIVERED",
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

describe("sheet table row view", () => {
  it("keeps Rust engine row ids when the visible row key comes from legacy state", () => {
    const legacyRows = createEmptyRows(1);
    legacyRows[0] = {
      ...legacyRows[0],
      key: "legacy-visible-key",
      trackingInput: "P2606020189412.30",
    };
    const window: SheetRowWindow = {
      sheetId: "sheet-1",
      offset: 0,
      limit: 1,
      totalCount: 1,
      hasMore: false,
      nextOffset: null,
      rows: [
        {
          rowId: "rust-row-1",
          position: 0,
          displayTrackingId: "P2606020189412.30",
          lookupTrackingId: "P2606020189412",
          rowStatus: "loaded",
          errorMessage: null,
          statusJson: null,
          detailJson: null,
          historyJson: null,
        },
      ],
    };

    const rows = createSheetTableRowsFromRustWindow(window, legacyRows);

    expect(rows[0].key).toBe("legacy-visible-key");
    expect(rows[0].engineRowId).toBe("rust-row-1");
    expect(rows[0].position).toBe(0);
    expect(getSelectedTableRowEngineRowIds(rows, ["legacy-visible-key"])).toEqual([
      "rust-row-1",
    ]);
  });

  it("keeps local draft input visible while the Rust row window is stale", () => {
    const legacyRows = createEmptyRows(1);
    legacyRows[0] = {
      ...legacyRows[0],
      key: "rust-row-1",
      trackingInput: "P102",
      error: "",
    };
    const window: SheetRowWindow = {
      sheetId: "sheet-1",
      offset: 0,
      limit: 1,
      totalCount: 1,
      hasMore: false,
      nextOffset: null,
      rows: [
        {
          rowId: "rust-row-1",
          position: 0,
          displayTrackingId: "P101",
          lookupTrackingId: "P101",
          rowStatus: "failed",
          errorMessage: "boom",
          statusJson: null,
          detailJson: null,
          historyJson: null,
        },
      ],
    };

    const rows = createSheetTableRowsFromRustWindow(window, legacyRows);

    expect(rows[0].key).toBe("rust-row-1");
    expect(rows[0].engineRowId).toBe("rust-row-1");
    expect(rows[0].position).toBe(0);
    expect(rows[0].trackingInput).toBe("P102");
    expect(rows[0].status).toBe("Pending");
    expect(rows[0].error).toBe("");
  });

  it("keeps local loading state while a Rust projection is stale", () => {
    const legacyRows = createEmptyRows(1);
    legacyRows[0] = {
      ...legacyRows[0],
      key: "legacy-visible-key",
      trackingInput: "P103",
      loading: true,
    };
    const window: SheetRowWindow = {
      sheetId: "sheet-1",
      offset: 0,
      limit: 1,
      totalCount: 1,
      hasMore: false,
      nextOffset: null,
      rows: [
        {
          rowId: "rust-row-1",
          position: 0,
          displayTrackingId: "P103",
          lookupTrackingId: "P103",
          rowStatus: "loaded",
          errorMessage: null,
          statusJson: null,
          detailJson: null,
          historyJson: null,
        },
      ],
    };

    const rows = createSheetTableRowsFromRustWindow(window, legacyRows);

    expect(rows[0]).toMatchObject({
      key: "legacy-visible-key",
      engineRowId: "rust-row-1",
      trackingInput: "P103",
      status: "Loading",
      loading: true,
    });
  });

  it("matches selected legacy keys to the current Rust table row", () => {
    const legacyRows = createEmptyRows(1);
    legacyRows[0] = {
      ...legacyRows[0],
      key: "legacy-visible-key",
      trackingInput: "P104",
    };
    const window: SheetRowWindow = {
      sheetId: "sheet-1",
      offset: 0,
      limit: 1,
      totalCount: 1,
      hasMore: false,
      nextOffset: null,
      rows: [
        {
          rowId: "sheet-1:row:0",
          position: 0,
          displayTrackingId: "P104",
          lookupTrackingId: "P104",
          rowStatus: "loaded",
          errorMessage: null,
          statusJson: null,
          detailJson: null,
          historyJson: null,
        },
      ],
    };

    const rows = createSheetTableRowsFromRustWindow(window, []);

    expect(
      getSelectedVisibleTableRowKeys(rows, ["legacy-visible-key"], legacyRows)
    ).toEqual(["sheet-1:row:0"]);
    expect(
      getSelectedTableRowKeySet(rows, ["legacy-visible-key"], legacyRows).has(
        "sheet-1:row:0"
      )
    ).toBe(true);
  });

  it("does not duplicate a cleared local draft row that overlays a Rust projection", () => {
    const legacyRows = createEmptyRows(1);
    legacyRows[0] = {
      ...legacyRows[0],
      key: "rust-row-1",
      trackingInput: "",
      shipment: null,
    };
    const window: SheetRowWindow = {
      sheetId: "sheet-1",
      offset: 0,
      limit: 1,
      totalCount: 1,
      hasMore: false,
      nextOffset: null,
      rows: [
        {
          rowId: "rust-row-1",
          position: 0,
          displayTrackingId: "P101",
          lookupTrackingId: "P101",
          rowStatus: "loaded",
          errorMessage: null,
          statusJson: null,
          detailJson: null,
          historyJson: null,
        },
      ],
    };

    const rows = createSheetTableRowsFromRustWindow(window, legacyRows);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: "rust-row-1",
      trackingInput: "",
      engineRowId: "rust-row-1",
      position: 0,
    });
  });

  it("keeps local input rows but not filled mirror rows when the Rust window is empty", () => {
    const legacyRows = createEmptyRows(3);
    legacyRows[0] = {
      ...legacyRows[0],
      key: "filled-mirror",
      trackingInput: "PLEGACY",
      shipment: createShipment("PLEGACY"),
    };
    legacyRows[1] = {
      ...legacyRows[1],
      key: "local-input",
      trackingInput: "PDRAFT",
      shipment: null,
    };
    const window: SheetRowWindow = {
      sheetId: "sheet-1",
      offset: 0,
      limit: 500,
      totalCount: 0,
      hasMore: false,
      nextOffset: null,
      rows: [],
    };

    const rows = createSheetTableRowsFromRustWindow(window, legacyRows);

    expect(rows.map((row) => row.key)).toEqual(["local-input", legacyRows[2].key]);
    expect(rows.some((row) => row.trackingInput === "PLEGACY")).toBe(false);
  });

  it("calculates UI counts and tracking width from table row projections", () => {
    const legacyRows = createEmptyRows(2);
    legacyRows[0] = {
      ...legacyRows[0],
      trackingInput: "P2606020189412.30",
    };
    legacyRows[1] = {
      ...legacyRows[1],
      trackingInput: "",
    };
    const rows = createSheetTableRowsFromSheetRows(legacyRows);

    expect(getTotalTableRowTrackingCount(rows)).toBe(1);
    expect(getTableRowTrackingColumnAutoWidth(rows)).toBeGreaterThan(118);
  });
});
