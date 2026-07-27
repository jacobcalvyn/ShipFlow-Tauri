import { describe, expect, it } from "vitest";
import type { TrackResponse } from "../../types";
import { COLUMNS, canUseColumnFilter } from "./columns";
import { createDefaultSheetState } from "./default-state";
import { createRustSheetRowsQuery } from "./rust-row-query-adapter";

function createShipment(
  shipmentId: string,
  options: {
    isCod?: boolean;
    totalCod?: number;
  } = {}
): TrackResponse {
  return {
    url: `https://example.test/${shipmentId}`,
    detail: {
      shipment_header: {
        nomor_kiriman: shipmentId,
      },
      origin_detail: {},
      package_detail: {
        jenis_layanan: "PKH",
      },
      billing_detail: {
        cod_info: {
          is_cod: options.isCod ?? false,
          total_cod: options.totalCod ?? 0,
        },
      },
      actors: {
        pengirim: {},
        penerima: {},
      },
      performance_detail: {},
    },
    status_akhir: {
      status: "INLOCATION",
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

function createVisibleColumnContext() {
  return {
    visibleColumns: COLUMNS,
    visibleColumnPathSet: new Set(COLUMNS.map((column) => column.path)),
  };
}

describe("Rust row query adapter", () => {
  it("builds an unfiltered Rust row query for settled workspace rows", () => {
    const sheet = createDefaultSheetState();
    const row = {
      ...sheet.rows[0],
      trackingInput: "P1",
      shipment: createShipment("P1"),
    };
    const context = createVisibleColumnContext();

    const query = createRustSheetRowsQuery({
      sheetId: "sheet-1",
      sheetState: {
        ...sheet,
        rows: [row],
      },
      nonEmptyRows: [row],
      ...context,
    });

    expect(query).toEqual({
      sheetId: "sheet-1",
      offset: 0,
      limit: 100_000,
      filters: [],
      sort: [],
    });
  });

  it("builds a Rust row query when the React row mirror is empty", () => {
    const sheet = createDefaultSheetState();
    const context = createVisibleColumnContext();

    const query = createRustSheetRowsQuery({
      sheetId: "sheet-1",
      sheetState: sheet,
      nonEmptyRows: [],
      ...context,
    });

    expect(query).toEqual({
      sheetId: "sheet-1",
      offset: 0,
      limit: 100_000,
      filters: [],
      sort: [],
    });
  });

  it("maps supported visible text filters and sorting into the Rust query", () => {
    const sheet = createDefaultSheetState();
    const row = {
      ...sheet.rows[0],
      trackingInput: "P1",
      shipment: createShipment("P1"),
    };
    const context = createVisibleColumnContext();

    const query = createRustSheetRowsQuery({
      sheetId: "sheet-1",
      sheetState: {
        ...sheet,
        rows: [row],
        filters: {
          "status_akhir.status": "IN",
          "detail.package_detail.jenis_layanan": "PKH",
        },
        sortState: {
          path: "detail.billing_detail.cod_info.total_cod",
          direction: "desc",
        },
      },
      nonEmptyRows: [row],
      ...context,
    });

    expect(query?.filters).toEqual([
      {
        field: "status_akhir.status",
        value: "IN",
      },
      {
        field: "detail.package_detail.jenis_layanan",
        value: "PKH",
      },
    ]);
    expect(query?.sort).toEqual([
      {
        field: "detail.billing_detail.cod_info.total_cod",
        direction: "desc",
      },
    ]);
  });

  it("maps supported text value filters into the Rust query", () => {
    const sheet = createDefaultSheetState();
    const row = {
      ...sheet.rows[0],
      trackingInput: "P1",
      shipment: createShipment("P1"),
    };
    const context = createVisibleColumnContext();

    const query = createRustSheetRowsQuery({
      sheetId: "sheet-1",
      sheetState: {
        ...sheet,
        rows: [row],
        valueFilters: {
          "status_akhir.status": ["INLOCATION"],
        },
      },
      nonEmptyRows: [row],
      ...context,
    });

    expect(query?.valueFilters).toEqual([
      {
        field: "status_akhir.status",
        values: ["INLOCATION"],
      },
    ]);
  });

  it("maps formatted numeric value filters to raw values for Rust", () => {
    const sheet = createDefaultSheetState();
    const row = {
      ...sheet.rows[0],
      trackingInput: "P1",
      shipment: createShipment("P1", {
        totalCod: 1000,
      }),
    };
    const context = createVisibleColumnContext();

    const query = createRustSheetRowsQuery({
      sheetId: "sheet-1",
      sheetState: {
        ...sheet,
        rows: [row],
        valueFilters: {
          "detail.billing_detail.cod_info.total_cod": ["1.000"],
        },
      },
      nonEmptyRows: [row],
      ...context,
    });

    expect(query?.valueFilters).toEqual([
      {
        field: "detail.billing_detail.cod_info.total_cod",
        values: ["1000", "1000.0"],
      },
    ]);
  });

  it("maps formatted typed text filters to canonical Rust values", () => {
    const sheet = createDefaultSheetState();
    const context = createVisibleColumnContext();

    const query = createRustSheetRowsQuery({
      sheetId: "sheet-1",
      sheetState: {
        ...sheet,
        filters: {
          "detail.billing_detail.cod_info.total_cod": "1.000",
          "detail.package_detail.berat_actual": "1,5 kg",
          "detail.billing_detail.cod_info.is_cod": "Ya",
          "detail.origin_detail.tanggal_input": "27/05/2026",
        },
      },
      nonEmptyRows: [],
      ...context,
    });

    expect(query?.filters).toEqual([
      {
        field: "detail.origin_detail.tanggal_input",
        value: "2026-05-27",
      },
      {
        field: "detail.package_detail.berat_actual",
        value: "1.5",
      },
      {
        field: "detail.billing_detail.cod_info.is_cod",
        value: "1",
      },
      {
        field: "detail.billing_detail.cod_info.total_cod",
        value: "1000",
      },
    ]);
  });

  it("keeps partial or unrecognized typed filters unchanged", () => {
    const sheet = createDefaultSheetState();
    const context = createVisibleColumnContext();

    const query = createRustSheetRowsQuery({
      sheetId: "sheet-1",
      sheetState: {
        ...sheet,
        filters: {
          "detail.billing_detail.cod_info.is_cod": "mungkin",
          "detail.origin_detail.tanggal_input": "27/05",
        },
      },
      nonEmptyRows: [],
      ...context,
    });

    expect(query?.filters).toEqual([
      {
        field: "detail.origin_detail.tanggal_input",
        value: "27/05",
      },
      {
        field: "detail.billing_detail.cod_info.is_cod",
        value: "mungkin",
      },
    ]);
  });

  it("maps formatted boolean value filters to raw SQLite JSON values for Rust", () => {
    const sheet = createDefaultSheetState();
    const row = {
      ...sheet.rows[0],
      trackingInput: "P1",
      shipment: createShipment("P1", {
        isCod: true,
      }),
    };
    const context = createVisibleColumnContext();

    const query = createRustSheetRowsQuery({
      sheetId: "sheet-1",
      sheetState: {
        ...sheet,
        rows: [row],
        valueFilters: {
          "detail.billing_detail.cod_info.is_cod": ["Ya"],
        },
      },
      nonEmptyRows: [row],
      ...context,
    });

    expect(query?.valueFilters).toEqual([
      {
        field: "detail.billing_detail.cod_info.is_cod",
        values: ["1"],
      },
    ]);
  });

  it("maps value filters without scanning the React row mirror", () => {
    const sheet = createDefaultSheetState();
    const context = createVisibleColumnContext();

    const query = createRustSheetRowsQuery({
      sheetId: "sheet-1",
      sheetState: {
        ...sheet,
        valueFilters: {
          "detail.package_detail.jenis_layanan": ["PKH"],
          "detail.billing_detail.cod_info.total_cod": ["1.000"],
          "detail.billing_detail.cod_info.is_cod": ["Ya"],
          "detail.origin_detail.tanggal_input": ["27/05/2026"],
        },
      },
      nonEmptyRows: [],
      ...context,
    });

    expect(query?.valueFilters).toEqual([
      {
        field: "detail.package_detail.jenis_layanan",
        values: ["PKH"],
      },
      {
        field: "detail.billing_detail.cod_info.total_cod",
        values: ["1000", "1000.0"],
      },
      {
        field: "detail.billing_detail.cod_info.is_cod",
        values: ["1"],
      },
      {
        field: "detail.origin_detail.tanggal_input",
        values: ["27/05/2026", "2026-05-27"],
      },
    ]);
  });

  it("maps tracking value filters without scanning the React row mirror", () => {
    const sheet = createDefaultSheetState();
    const context = createVisibleColumnContext();

    const query = createRustSheetRowsQuery({
      sheetId: "sheet-1",
      sheetState: {
        ...sheet,
        valueFilters: {
          "detail.shipment_header.nomor_kiriman": ["P2606"],
        },
      },
      nonEmptyRows: [],
      ...context,
    });

    expect(query?.valueFilters).toEqual([
      {
        field: "detail.shipment_header.nomor_kiriman",
        values: ["P2606"],
      },
    ]);
  });

  it("keeps visible filterable sheet columns on the Rust query path", () => {
    const sheet = createDefaultSheetState();
    const context = createVisibleColumnContext();

    for (const column of COLUMNS.filter(canUseColumnFilter)) {
      const query = createRustSheetRowsQuery({
        sheetId: "sheet-1",
        sheetState: {
          ...sheet,
          filters: {
            [column.path]: "sample",
          },
        },
        nonEmptyRows: [],
        ...context,
      });

      expect(query, column.path).not.toBeNull();
      expect(query?.filters).toEqual([
        {
          field: column.path,
          value: "sample",
        },
      ]);
    }
  });

  it("ignores stale filters on non-filterable photo and raw JSON columns", () => {
    const sheet = createDefaultSheetState();
    const context = createVisibleColumnContext();

    const query = createRustSheetRowsQuery({
      sheetId: "sheet-1",
      sheetState: {
        ...sheet,
        filters: {
          "pod.photo1_url": "photo",
          "history_summary.bagging_unbagging": "PID",
        },
        valueFilters: {
          "pod.photo1_url": ["photo"],
          "history_summary.bagging_unbagging": ["PID"],
        },
      },
      nonEmptyRows: [],
      ...context,
    });

    expect(query).not.toBeNull();
    expect(query?.filters).toEqual([]);
    expect(query?.valueFilters).toBeUndefined();
  });

  it("keeps filtered or sorted incomplete tracking rows on the legacy path", () => {
    const sheet = createDefaultSheetState();
    const row = {
      ...sheet.rows[0],
      trackingInput: "PENDING1",
    };
    const context = createVisibleColumnContext();

    const query = createRustSheetRowsQuery({
      sheetId: "sheet-1",
      sheetState: {
        ...sheet,
        rows: [row],
        filters: {
          "status_akhir.status": "IN",
        },
      },
      nonEmptyRows: [row],
      ...context,
    });

    expect(query).toBeNull();
  });

  it("keeps filtered dirty rows on the Rust query path", () => {
    const sheet = createDefaultSheetState();
    const row = {
      ...sheet.rows[0],
      trackingInput: "P1-EDITED",
      shipment: createShipment("P1"),
      dirty: true,
      stale: true,
    };
    const context = createVisibleColumnContext();

    const query = createRustSheetRowsQuery({
      sheetId: "sheet-1",
      sheetState: {
        ...sheet,
        rows: [row],
        filters: {
          "status_akhir.status": "DELIVERED",
        },
      },
      nonEmptyRows: [row],
      ...context,
    });

    expect(query).toMatchObject({
      sheetId: "sheet-1",
      filters: [{ field: "status_akhir.status", value: "DELIVERED" }],
      sort: [],
    });
  });
});
