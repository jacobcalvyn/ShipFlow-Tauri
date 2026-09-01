import { describe, expect, it } from "vitest";
import type {
  SheetRowProjection,
  SheetRowWindow,
} from "../workspace-engine/client";
import { createEmptyRows } from "./utils";
import {
  createEngineRowSelectionKey,
  createSheetTableRowsFromSheetRows,
  createSheetTableRowsFromRustWindow,
  getLoadingTableRowCount,
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

function createProjection(
  rowId: string,
  trackingId: string,
  rowStatus: SheetRowProjection["rowStatus"],
  position: number
): SheetRowProjection {
  return {
    rowId,
    position,
    displayTrackingId: trackingId,
    lookupTrackingId: trackingId,
    rowStatus,
    errorMessage: null,
    statusJson: null,
    detailJson: null,
    historyJson: null,
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
    expect(
      getSelectedTableRowEngineRowIds(rows, [
        "legacy-visible-key",
        createEngineRowSelectionKey("rust-row-900"),
      ])
    ).toEqual(["rust-row-1", "rust-row-900"]);
  });

  it("builds shipment data from stringified Rust projection JSON", () => {
    const window: SheetRowWindow = {
      sheetId: "sheet-1",
      offset: 0,
      limit: 1,
      totalCount: 1,
      hasMore: false,
      nextOffset: null,
      rows: [
        {
          ...createProjection("rust-row-1", "P100", "loaded", 0),
          statusJson: JSON.stringify({ status: "DELIVERED" }),
          detailJson: JSON.stringify({
            shipment_header: { nomor_kiriman: "P100" },
          }),
          historyJson: JSON.stringify({
            history: [],
            history_summary: {
              irregularity: [],
              bagging_unbagging: [],
              manifest_r7: [],
              delivery_runsheet: [],
            },
          }),
        },
      ],
    };

    const rows = createSheetTableRowsFromRustWindow(window, []);

    expect(rows[0]).toMatchObject({
      engineRowId: "rust-row-1",
      trackingInput: "P100",
      status: "Ready",
    });
    expect(rows[0].shipment?.detail.shipment_header.nomor_kiriman).toBe("P100");
    expect(rows[0].shipment?.status_akhir.status).toBe("DELIVERED");
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

  it("uses active local loading state over a loaded Rust projection during retrack", () => {
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
      error: "",
    });
  });

  it("uses locally completed tracking progress over a stale loaded Rust projection", () => {
    const legacyRows = createEmptyRows(1);
    legacyRows[0] = {
      ...legacyRows[0],
      key: "legacy-visible-key",
      trackingInput: "P103",
      shipment: {
        ...createShipment("P103"),
        status_akhir: {
          status: "DELIVERED",
        },
      },
      runtimeTrackingRunId: "run-1",
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
          statusJson: {
            status: "INLOCATION",
          },
          detailJson: {
            shipment_header: {
              nomor_kiriman: "P103",
            },
          },
          historyJson: null,
        },
      ],
    };

    const rows = createSheetTableRowsFromRustWindow(window, legacyRows);

    expect(rows[0]).toMatchObject({
      key: "legacy-visible-key",
      engineRowId: "rust-row-1",
      trackingInput: "P103",
      status: "Ready",
      loading: false,
      queued: false,
      error: "",
    });
    expect(rows[0].shipment?.status_akhir.status).toBe("DELIVERED");
  });

  it("uses local runtime error over a stale loaded Rust projection", () => {
    const legacyRows = createEmptyRows(1);
    legacyRows[0] = {
      ...legacyRows[0],
      key: "legacy-visible-key",
      trackingInput: "P103",
      shipment: createShipment("P103"),
      stale: true,
      dirty: true,
      error: "upstream timeout",
      runtimeTrackingRunId: "run-1",
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
          statusJson: {
            status: "DELIVERED",
          },
          detailJson: {
            shipment_header: {
              nomor_kiriman: "P103",
            },
          },
          historyJson: null,
        },
      ],
    };

    const rows = createSheetTableRowsFromRustWindow(window, legacyRows);

    expect(rows[0]).toMatchObject({
      key: "legacy-visible-key",
      engineRowId: "rust-row-1",
      trackingInput: "P103",
      status: "Error",
      loading: false,
      queued: false,
      error: "upstream timeout",
    });
  });

  it("keeps active local loading state over a pending Rust projection", () => {
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
          rowStatus: "pending",
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
      queued: false,
    });
  });

  it("keeps a local error over a stale pending Rust projection", () => {
    const legacyRows = createEmptyRows(1);
    legacyRows[0] = {
      ...legacyRows[0],
      key: "legacy-visible-key",
      trackingInput: "P103",
      error: "upstream unavailable",
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
          rowStatus: "pending",
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
      status: "Error",
      loading: false,
      queued: false,
      error: "upstream unavailable",
    });
  });

  it("uses pending Rust projection over a locally completed row without active run", () => {
    const legacyRows = createEmptyRows(1);
    legacyRows[0] = {
      ...legacyRows[0],
      key: "legacy-visible-key",
      trackingInput: "P104",
      shipment: createShipment("P104"),
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
          displayTrackingId: "P104",
          lookupTrackingId: "P104",
          rowStatus: "pending",
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
      trackingInput: "P104",
      status: "Pending",
      loading: false,
      queued: true,
      error: "",
    });
    expect(rows[0].shipment).toBeNull();
  });

  it("uses locally completed active-run progress over a stale pending Rust projection", () => {
    const legacyRows = createEmptyRows(1);
    legacyRows[0] = {
      ...legacyRows[0],
      key: "legacy-visible-key",
      trackingInput: "P104",
      shipment: createShipment("P104"),
      runtimeTrackingRunId: "run-1",
    };
    const window: SheetRowWindow = {
      sheetId: "sheet-1",
      offset: 0,
      limit: 1,
      totalCount: 1,
      hasMore: false,
      nextOffset: null,
      rows: [createProjection("rust-row-1", "P104", "pending", 0)],
    };

    const rows = createSheetTableRowsFromRustWindow(window, legacyRows);

    expect(rows[0]).toMatchObject({
      key: "legacy-visible-key",
      engineRowId: "rust-row-1",
      trackingInput: "P104",
      status: "Ready",
      loading: false,
      queued: false,
      error: "",
    });
    expect(rows[0].shipment?.status_akhir.status).toBe("DELIVERED");
  });

  it("uses active-run queued progress over a stale failed Rust projection", () => {
    const legacyRows = createEmptyRows(1);
    legacyRows[0] = {
      ...legacyRows[0],
      key: "legacy-visible-key",
      trackingInput: "P104",
      queued: true,
      runtimeTrackingRunId: "run-1",
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
          ...createProjection("rust-row-1", "P104", "failed", 0),
          errorMessage: "previous failure",
        },
      ],
    };

    const rows = createSheetTableRowsFromRustWindow(window, legacyRows);

    expect(rows[0]).toMatchObject({
      key: "legacy-visible-key",
      engineRowId: "rust-row-1",
      trackingInput: "P104",
      status: "Pending",
      loading: false,
      queued: true,
      error: "",
    });
  });

  it("keeps a locally completed row over an empty Rust projection during tracking progress", () => {
    const legacyRows = createEmptyRows(1);
    legacyRows[0] = {
      ...legacyRows[0],
      key: "legacy-visible-key",
      trackingInput: "P104",
      shipment: createShipment("P104"),
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
          displayTrackingId: "P104",
          lookupTrackingId: "P104",
          rowStatus: "empty",
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
      trackingInput: "P104",
      status: "Ready",
      loading: false,
      queued: false,
      error: "",
    });
    expect(rows[0].shipment?.status_akhir.status).toBe("DELIVERED");
  });

  it("uses loading Rust projection over a locally completed row without active run", () => {
    const legacyRows = createEmptyRows(1);
    legacyRows[0] = {
      ...legacyRows[0],
      key: "legacy-visible-key",
      trackingInput: "P105",
      shipment: createShipment("P105"),
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
          displayTrackingId: "P105",
          lookupTrackingId: "P105",
          rowStatus: "loading",
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
      trackingInput: "P105",
      status: "Loading",
      loading: true,
      queued: false,
      error: "",
    });
    expect(rows[0].shipment).toBeNull();
  });

  it("counts pending Rust projections as in-progress rows", () => {
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
          displayTrackingId: "PENDING1",
          lookupTrackingId: "PENDING1",
          rowStatus: "pending",
          errorMessage: null,
          statusJson: null,
          detailJson: null,
          historyJson: null,
        },
      ],
    };

    const rows = createSheetTableRowsFromRustWindow(window, []);

    expect(rows[0]).toMatchObject({
      status: "Pending",
      loading: false,
      queued: true,
    });
    expect(getLoadingTableRowCount(rows)).toBe(1);
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

  it("reuses unchanged Rust table row objects between progress updates", () => {
    const pendingWindow: SheetRowWindow = {
      sheetId: "sheet-1",
      offset: 0,
      limit: 500,
      totalCount: 3,
      hasMore: false,
      nextOffset: null,
      rows: [
        createProjection("sheet-1:row:0", "P100", "pending", 0),
        createProjection("sheet-1:row:1", "P101", "pending", 1),
        createProjection("sheet-1:row:2", "P102", "pending", 2),
      ],
    };
    const loadedWindow: SheetRowWindow = {
      ...pendingWindow,
      rows: [
        {
          ...createProjection("sheet-1:row:0", "P100", "loaded", 0),
          statusJson: JSON.stringify({ status: "DELIVERED" }),
          detailJson: JSON.stringify({
            shipment_header: { nomor_kiriman: "P100" },
          }),
          historyJson: JSON.stringify({
            history: [],
            history_summary: {
              irregularity: [],
              bagging_unbagging: [],
              manifest_r7: [],
              delivery_runsheet: [],
            },
          }),
        },
        createProjection("sheet-1:row:1", "P101", "pending", 1),
        createProjection("sheet-1:row:2", "P102", "pending", 2),
      ],
    };

    const previousRows = createSheetTableRowsFromRustWindow(pendingWindow, []);
    const nextRows = createSheetTableRowsFromRustWindow(
      loadedWindow,
      [],
      previousRows
    );

    expect(nextRows[0]).not.toBe(previousRows[0]);
    expect(nextRows[1]).toBe(previousRows[1]);
    expect(nextRows[2]).toBe(previousRows[2]);
    expect(nextRows[0].status).toBe("Ready");
    expect(nextRows[1].status).toBe("Pending");
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
