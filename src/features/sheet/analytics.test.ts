import { TrackResponse } from "../../types";
import {
  setRowSuccessInSheet,
  setTextFilterInSheet,
} from "./actions";
import {
  ANALYTICS_EXCLUDED_COLUMN_PATHS,
  getSheetAnalyticsGroupByOptions,
  getSheetAnalyticsMetricAggregationOptions,
  getSheetAnalyticsMetricOptions,
  getSheetAnalyticsSummary,
} from "./analytics";
import { COLUMNS } from "./columns";
import { createDefaultSheetState } from "./default-state";
import {
  getActiveFilterCount,
  getDisplayedRows,
  getNonEmptyRows,
  getVisibleColumns,
  getVisibleColumnPathSet,
} from "./selectors";

const COD_TOTAL_COLUMN_PATH = "detail.billing_detail.cod_info.total_cod";

function createShipment(params: {
  shipmentId: string;
  status: string;
  service: string;
  isCod: boolean;
  codTotal: number;
  location?: string;
}): TrackResponse {
  return {
    url: `https://example.test/${params.shipmentId}`,
    detail: {
      shipment_header: {
        nomor_kiriman: params.shipmentId,
      },
      origin_detail: {},
      package_detail: {
        jenis_layanan: params.service,
      },
      billing_detail: {
        cod_info: {
          is_cod: params.isCod,
          total_cod: params.codTotal,
        },
      },
      actors: {
        pengirim: {},
        penerima: {},
      },
      performance_detail: {},
    },
    status_akhir: {
      status: params.status,
      location: params.location,
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

function getDisplayedContext(sheetState: ReturnType<typeof createDefaultSheetState>) {
  const nonEmptyRows = getNonEmptyRows(sheetState.rows);
  const visibleColumns = getVisibleColumns(sheetState);
  const visibleColumnPathSet = getVisibleColumnPathSet(visibleColumns);
  const displayedRows = getDisplayedRows(
    sheetState,
    nonEmptyRows,
    visibleColumns,
    getActiveFilterCount(sheetState, visibleColumnPathSet)
  );

  return { nonEmptyRows, displayedRows };
}

describe("sheet analytics", () => {
  it("exposes sheet columns for group and metric fields except blocked raw media/history columns", () => {
    const groupOptions = getSheetAnalyticsGroupByOptions();
    const groupPaths = groupOptions.map((option) => option.path);
    const groupLabels = groupOptions.map((option) => option.label);
    const metricOptions = getSheetAnalyticsMetricOptions();
    const metricKeys = metricOptions.map((option) => option.key);
    const allowedColumnPaths = COLUMNS.filter(
      (column) => !ANALYTICS_EXCLUDED_COLUMN_PATHS.has(column.path)
    ).map((column) => column.path);

    expect(groupPaths).toEqual(allowedColumnPaths);
    expect(groupLabels).toEqual([
      "Nomor Kiriman",
      "TRX - TODAY",
      "TRX - UNBAG",
      "PID/Kantong Terakhir",
      "Manifest Terakhir",
      "Status Akhir",
      "Lokasi Akhir",
      "Petugas Akhir",
      "ID Petugas Akhir",
      "Waktu Status Akhir",
      "Nama Pengirim",
      "Telepon Pengirim",
      "Alamat Pengirim",
      "Nama Penerima",
      "Telepon Penerima",
      "Alamat Penerima",
      "Kode Pos Penerima",
      "ID Pelanggan Korporat",
      "Nama Kantor",
      "ID Kantor",
      "Nama Petugas",
      "ID Petugas",
      "Tanggal Input",
      "Jenis Layanan",
      "Is COD",
      "Total COD",
      "Status COD",
      "SLA Target",
      "SLA Category",
      "SLA Days Diff",
      "Jumlah Delivery Runsheet",
    ]);
    expect(metricKeys).toEqual(allowedColumnPaths);
    expect(
      getSheetAnalyticsMetricAggregationOptions(
        metricOptions.find((option) => option.key === "status_akhir.status")!
      ).map((option) => option.key)
    ).toEqual([
      "unique_list",
      "count",
      "count_unique",
      "most_frequent",
      "first",
      "last",
    ]);
    expect(
      getSheetAnalyticsMetricAggregationOptions(
        metricOptions.find(
          (option) => option.key === "detail.billing_detail.cod_info.total_cod"
        )!
      ).map((option) => option.key)
    ).toEqual(["sum", "average", "max", "min", "count", "count_unique"]);
    expect(
      getSheetAnalyticsMetricAggregationOptions(
        metricOptions.find((option) => option.key === "detail.billing_detail.cod_info.is_cod")!
      ).map((option) => option.key)
    ).toEqual([
      "unique_list",
      "count",
      "count_unique",
      "most_frequent",
      "first",
      "last",
    ]);
  });

  it("supports count and distinct count aggregations for text value fields", () => {
    let sheet = createDefaultSheetState();
    sheet = setRowSuccessInSheet(
      sheet,
      sheet.rows[0].key,
      "P1",
      createShipment({
        shipmentId: "P1",
        status: "DELIVERED",
        service: "Q9",
        isCod: false,
        codTotal: 0,
      })
    );
    sheet = setRowSuccessInSheet(
      sheet,
      sheet.rows[1].key,
      "P2",
      createShipment({
        shipmentId: "P2",
        status: "DELIVERED",
        service: "Q9",
        isCod: false,
        codTotal: 0,
      })
    );
    sheet = setRowSuccessInSheet(
      sheet,
      sheet.rows[2].key,
      "P3",
      createShipment({
        shipmentId: "P3",
        status: "INVEHICLE",
        service: "Q9",
        isCod: false,
        codTotal: 0,
      })
    );
    sheet = {
      ...sheet,
      analytics: {
        sourceScope: "all_rows",
        rowPaths: ["detail.package_detail.jenis_layanan"],
        columnPaths: [],
        valueMetrics: ["status_akhir.status"],
        metricAggregations: {
          "status_akhir.status": "count",
        },
        chartType: "pivot",
      },
    };

    const countSummary = getSheetAnalyticsSummary({
      sheetState: sheet,
      selectedVisibleRowKeys: [],
      ...getDisplayedContext(sheet),
    });

    expect(countSummary.valueMetrics[0]).toEqual(
      expect.objectContaining({
        key: "status_akhir.status",
        aggregation: "count",
        aggregationLabel: "Jumlah Data",
      })
    );
    expect(countSummary.rows[0]).toEqual(
      expect.objectContaining({
        metricValues: expect.objectContaining({
          "status_akhir.status": 3,
        }),
      })
    );

    const distinctSummary = getSheetAnalyticsSummary({
      sheetState: {
        ...sheet,
        analytics: {
          ...sheet.analytics,
          metricAggregations: {
            "status_akhir.status": "count_unique",
          },
        },
      },
      selectedVisibleRowKeys: [],
      ...getDisplayedContext(sheet),
    });

    expect(distinctSummary.valueMetrics[0]).toEqual(
      expect.objectContaining({
        key: "status_akhir.status",
        aggregation: "count_unique",
        aggregationLabel: "Banyaknya Nilai Berbeda",
      })
    );
    expect(distinctSummary.rows[0]).toEqual(
      expect.objectContaining({
        metricValues: expect.objectContaining({
          "status_akhir.status": 2,
        }),
      })
    );
  });

  it("summarizes filtered rows from one sheet", () => {
    let sheet = createDefaultSheetState();
    sheet = setRowSuccessInSheet(
      sheet,
      sheet.rows[0].key,
      "P1",
      createShipment({
        shipmentId: "P1",
        status: "DELIVERED",
        service: "Q9",
        isCod: true,
        codTotal: 100_000,
      })
    );
    sheet = setRowSuccessInSheet(
      sheet,
      sheet.rows[1].key,
      "P2",
      createShipment({
        shipmentId: "P2",
        status: "INVEHICLE",
        service: "Q9",
        isCod: false,
        codTotal: 50_000,
      })
    );
    sheet = setRowSuccessInSheet(
      sheet,
      sheet.rows[2].key,
      "P3",
      createShipment({
        shipmentId: "P3",
        status: "DELIVERED",
        service: "QCOMM",
        isCod: true,
        codTotal: 250_000,
      })
    );
    sheet = setTextFilterInSheet(sheet, "status_akhir.status", "delivered");
    sheet = {
      ...sheet,
      analytics: {
        sourceScope: "filtered_rows",
        rowPaths: ["detail.package_detail.jenis_layanan"],
        columnPaths: [],
        valueMetrics: ["cod_total"],
        chartType: "bar",
      },
    };

    const summary = getSheetAnalyticsSummary({
      sheetState: sheet,
      selectedVisibleRowKeys: [],
      ...getDisplayedContext(sheet),
    });

    expect(summary.sourceRowCount).toBe(2);
    expect(summary.totalCod).toBe(350_000);
    expect(summary.rows).toEqual([
      expect.objectContaining({
        label: "QCOMM",
        count: 1,
        codTotal: 250_000,
        metricValues: {
          count: 1,
          [COD_TOTAL_COLUMN_PATH]: 250_000,
        },
        metricValue: 250_000,
      }),
      expect.objectContaining({
        label: "Q9",
        count: 1,
        codTotal: 100_000,
        metricValues: {
          count: 1,
          [COD_TOTAL_COLUMN_PATH]: 100_000,
        },
        metricValue: 100_000,
      }),
    ]);
  });

  it("summarizes only selected visible rows when selected source scope is active", () => {
    let sheet = createDefaultSheetState();
    sheet = setRowSuccessInSheet(
      sheet,
      sheet.rows[0].key,
      "P1",
      createShipment({
        shipmentId: "P1",
        status: "DELIVERED",
        service: "Q9",
        isCod: true,
        codTotal: 100_000,
      })
    );
    sheet = setRowSuccessInSheet(
      sheet,
      sheet.rows[1].key,
      "P2",
      createShipment({
        shipmentId: "P2",
        status: "INVEHICLE",
        service: "Q9",
        isCod: false,
        codTotal: 50_000,
      })
    );
    sheet = {
      ...sheet,
      analytics: {
        sourceScope: "selected_rows",
        rowPaths: ["status_akhir.status"],
        columnPaths: [],
        valueMetrics: [COD_TOTAL_COLUMN_PATH],
        chartType: "donut",
      },
    };

    const summary = getSheetAnalyticsSummary({
      sheetState: sheet,
      selectedVisibleRowKeys: [sheet.rows[1].key],
      ...getDisplayedContext(sheet),
    });

    expect(summary.sourceRowCount).toBe(1);
    expect(summary.rows).toEqual([
      expect.objectContaining({
        label: "INVEHICLE",
        count: 1,
        metricValue: 50_000,
        share: 100,
      }),
    ]);
  });

  it("groups by multiple fields and exposes multiple metric values", () => {
    let sheet = createDefaultSheetState();
    sheet = setRowSuccessInSheet(
      sheet,
      sheet.rows[0].key,
      "P1",
      createShipment({
        shipmentId: "P1",
        status: "DELIVERED",
        service: "Q9",
        isCod: true,
        codTotal: 100_000,
      })
    );
    sheet = setRowSuccessInSheet(
      sheet,
      sheet.rows[1].key,
      "P2",
      createShipment({
        shipmentId: "P2",
        status: "DELIVERED",
        service: "Q9",
        isCod: true,
        codTotal: 150_000,
      })
    );
    sheet = setRowSuccessInSheet(
      sheet,
      sheet.rows[2].key,
      "P3",
      createShipment({
        shipmentId: "P3",
        status: "DELIVERED",
        service: "QCOMM",
        isCod: false,
        codTotal: 0,
      })
    );
    sheet = {
      ...sheet,
      analytics: {
        sourceScope: "all_rows",
        rowPaths: ["status_akhir.status", "detail.package_detail.jenis_layanan"],
        columnPaths: [],
        valueMetrics: ["cod_total", "status_akhir.status"],
        chartType: "bar",
      },
    };

    const summary = getSheetAnalyticsSummary({
      sheetState: sheet,
      selectedVisibleRowKeys: [],
      ...getDisplayedContext(sheet),
    });

    expect(summary.rowLabel).toBe("Status Akhir / Jenis Layanan");
    expect(summary.valueMetrics.map((metric) => metric.key)).toEqual([
      COD_TOTAL_COLUMN_PATH,
      "status_akhir.status",
    ]);
    expect(summary.rows).toEqual([
      expect.objectContaining({
        label: "DELIVERED / Q9",
        count: 2,
        codTotal: 250_000,
        metricValues: expect.objectContaining({
          count: 2,
          [COD_TOTAL_COLUMN_PATH]: 250_000,
          "status_akhir.status": 1,
        }),
        metricValue: 250_000,
      }),
      expect.objectContaining({
        label: "DELIVERED / QCOMM",
        count: 1,
        codTotal: 0,
        metricValues: expect.objectContaining({
          count: 1,
          [COD_TOTAL_COLUMN_PATH]: 0,
          "status_akhir.status": 1,
        }),
        metricValue: 0,
      }),
    ]);
  });

  it("preserves selected metric order for charts", () => {
    let sheet = createDefaultSheetState();
    sheet = setRowSuccessInSheet(
      sheet,
      sheet.rows[0].key,
      "P1",
      createShipment({
        shipmentId: "P1",
        status: "DELIVERED",
        service: "Q9",
        isCod: true,
        codTotal: 125_000,
      })
    );
    sheet = {
      ...sheet,
      analytics: {
        sourceScope: "all_rows",
        rowPaths: ["status_akhir.status"],
        columnPaths: [],
        valueMetrics: [COD_TOTAL_COLUMN_PATH, "status_akhir.status"],
        metricAggregations: {
          [COD_TOTAL_COLUMN_PATH]: "sum",
          "status_akhir.status": "unique_list",
        },
        chartType: "bar",
      },
    };

    const summary = getSheetAnalyticsSummary({
      sheetState: sheet,
      selectedVisibleRowKeys: [],
      ...getDisplayedContext(sheet),
    });

    expect(summary.valueMetrics.map((metric) => metric.key)).toEqual([
      COD_TOTAL_COLUMN_PATH,
      "status_akhir.status",
    ]);
    expect(summary.primaryMetric).toBe(COD_TOTAL_COLUMN_PATH);
    expect(summary.rows[0]).toEqual(
      expect.objectContaining({
        metricValue: 125_000,
      })
    );
  });

  it("builds pivot columns from column fields and keeps pivot share based on row count", () => {
    let sheet = createDefaultSheetState();
    sheet = setRowSuccessInSheet(
      sheet,
      sheet.rows[0].key,
      "P1",
      createShipment({
        shipmentId: "P1",
        status: "DELIVERED",
        service: "Q9",
        isCod: true,
        codTotal: 100_000,
        location: "DC JAYAPURA",
      })
    );
    sheet = setRowSuccessInSheet(
      sheet,
      sheet.rows[3].key,
      "P4",
      createShipment({
        shipmentId: "P4",
        status: "DELIVERED",
        service: "Q9",
        isCod: true,
        codTotal: 200_000,
        location: "DC JAYAPURA",
      })
    );
    sheet = setRowSuccessInSheet(
      sheet,
      sheet.rows[1].key,
      "P2",
      createShipment({
        shipmentId: "P2",
        status: "DELIVERED",
        service: "QCOMM",
        isCod: true,
        codTotal: 500_000,
        location: "KCU JAYAPURA",
      })
    );
    sheet = setRowSuccessInSheet(
      sheet,
      sheet.rows[2].key,
      "P3",
      createShipment({
        shipmentId: "P3",
        status: "INVEHICLE",
        service: "Q9",
        isCod: true,
        codTotal: 700_000,
        location: "DC JAYAPURA",
      })
    );
    sheet = {
      ...sheet,
      analytics: {
        sourceScope: "all_rows",
        rowPaths: ["detail.package_detail.jenis_layanan"],
        columnPaths: ["status_akhir.status"],
        valueMetrics: [COD_TOTAL_COLUMN_PATH],
        chartType: "pivot",
      },
    };

    const summary = getSheetAnalyticsSummary({
      sheetState: sheet,
      selectedVisibleRowKeys: [],
      ...getDisplayedContext(sheet),
    });

    expect(summary.primaryMetricOption).toEqual(
      expect.objectContaining({
        key: COD_TOTAL_COLUMN_PATH,
        label: "Total COD",
        format: "currency",
      })
    );
    expect(summary.primaryMetric).toBe(COD_TOTAL_COLUMN_PATH);
    expect(summary.rowLabels).toEqual(["Jenis Layanan"]);
    expect(summary.columnLabels).toEqual(["Status Akhir"]);
    expect(summary.valueMetrics.map((metric) => metric.key)).toEqual([COD_TOTAL_COLUMN_PATH]);
    expect(summary.pivotValueColumns.map((column) => column.label)).toEqual([
      "DELIVERED",
      "INVEHICLE",
    ]);
    const deliveredColumn = summary.pivotValueColumns.find(
      (column) => column.label === "DELIVERED"
    );
    const inVehicleColumn = summary.pivotValueColumns.find(
      (column) => column.label === "INVEHICLE"
    );
    expect(deliveredColumn).toBeDefined();
    expect(inVehicleColumn).toBeDefined();
    expect(summary.rows).toHaveLength(2);
    expect(summary.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Q9",
          groupValues: ["Q9"],
          metricValues: expect.objectContaining({
            [COD_TOTAL_COLUMN_PATH]: 1_000_000,
            count: 3,
          }),
          pivotMetricValues: expect.objectContaining({
            [deliveredColumn?.key ?? ""]: 300_000,
            [inVehicleColumn?.key ?? ""]: 700_000,
          }),
          metricValue: 1_000_000,
          share: 75,
        }),
        expect.objectContaining({
          label: "QCOMM",
          groupValues: ["QCOMM"],
          metricValues: expect.objectContaining({
            [COD_TOTAL_COLUMN_PATH]: 500_000,
            count: 1,
          }),
          pivotMetricValues: expect.objectContaining({
            [deliveredColumn?.key ?? ""]: 500_000,
            [inVehicleColumn?.key ?? ""]: 0,
          }),
          metricValue: 500_000,
          share: 25,
        }),
      ])
    );
  });

  it("uses pivot columns without replacing empty row fields with column fields", () => {
    let sheet = createDefaultSheetState();
    sheet = setRowSuccessInSheet(
      sheet,
      sheet.rows[0].key,
      "P1",
      createShipment({
        shipmentId: "P1",
        status: "DELIVERED",
        service: "Q9",
        isCod: false,
        codTotal: 100_000,
      })
    );
    sheet = setRowSuccessInSheet(
      sheet,
      sheet.rows[1].key,
      "P2",
      createShipment({
        shipmentId: "P2",
        status: "INVEHICLE",
        service: "Q9",
        isCod: false,
        codTotal: 200_000,
      })
    );
    sheet = {
      ...sheet,
      analytics: {
        sourceScope: "all_rows",
        rowPaths: [],
        columnPaths: ["status_akhir.status"],
        valueMetrics: [COD_TOTAL_COLUMN_PATH],
        chartType: "pivot",
      },
    };

    const summary = getSheetAnalyticsSummary({
      sheetState: sheet,
      selectedVisibleRowKeys: [],
      ...getDisplayedContext(sheet),
    });

    expect(summary.rowLabels).toEqual(["Semua Row"]);
    expect(summary.columnLabels).toEqual(["Status Akhir"]);
    expect(summary.pivotValueColumns.map((column) => column.label)).toEqual([
      "DELIVERED",
      "INVEHICLE",
    ]);
    expect(summary.rows).toHaveLength(1);
    expect(summary.rows[0]).toEqual(
      expect.objectContaining({
        label: "Semua Row",
        groupValues: ["Semua Row"],
        count: 2,
        metricValue: 300_000,
        share: 100,
      })
    );
  });

  it("keeps stable unique row keys when joined pivot labels collide", () => {
    let sheet = createDefaultSheetState();
    sheet = setRowSuccessInSheet(
      sheet,
      sheet.rows[0].key,
      "P1",
      createShipment({
        shipmentId: "P1",
        status: "B / C",
        service: "A",
        isCod: false,
        codTotal: 1_000,
      })
    );
    sheet = setRowSuccessInSheet(
      sheet,
      sheet.rows[1].key,
      "P2",
      createShipment({
        shipmentId: "P2",
        status: "C",
        service: "A / B",
        isCod: false,
        codTotal: 2_000,
      })
    );
    sheet = {
      ...sheet,
      analytics: {
        sourceScope: "all_rows",
        rowPaths: ["detail.package_detail.jenis_layanan", "status_akhir.status"],
        columnPaths: [],
        valueMetrics: [COD_TOTAL_COLUMN_PATH],
        chartType: "pivot",
      },
    };

    const summary = getSheetAnalyticsSummary({
      sheetState: sheet,
      selectedVisibleRowKeys: [],
      ...getDisplayedContext(sheet),
    });

    expect(summary.rows).toHaveLength(2);
    expect(summary.rows.map((row) => row.label)).toEqual([
      "A / B / C",
      "A / B / C",
    ]);
    expect(new Set(summary.rows.map((row) => row.key)).size).toBe(2);
  });

  it("uses typed empty values for pivot row and column fields", () => {
    let sheet = createDefaultSheetState();
    sheet = setRowSuccessInSheet(
      sheet,
      sheet.rows[0].key,
      "P1",
      createShipment({
        shipmentId: "P1",
        status: "DELIVERED",
        service: "Q9",
        isCod: false,
        codTotal: 0,
      })
    );
    sheet = {
      ...sheet,
      analytics: {
        sourceScope: "all_rows",
        rowPaths: [
          "detail.performance_detail.sla_category",
          "detail.performance_detail.sla_days_diff",
        ],
        columnPaths: ["status_akhir.location"],
        valueMetrics: [COD_TOTAL_COLUMN_PATH],
        chartType: "pivot",
      },
    };

    const summary = getSheetAnalyticsSummary({
      sheetState: sheet,
      selectedVisibleRowKeys: [],
      ...getDisplayedContext(sheet),
    });

    expect(summary.rowLabels).toEqual([
      "SLA Category",
      "SLA Days Diff",
    ]);
    expect(summary.columnLabels).toEqual(["Lokasi Akhir"]);
    expect(summary.pivotValueColumns.map((column) => column.label)).toEqual(["-"]);
    expect(summary.valueMetrics.map((metric) => metric.key)).toEqual([COD_TOTAL_COLUMN_PATH]);
    expect(summary.rows).toEqual([
      expect.objectContaining({
        label: "- / 0",
        groupValues: ["-", "0"],
        count: 1,
        metricValue: 0,
        share: 100,
      }),
    ]);
  });

  it("allows empty group and metric selections while still counting source rows", () => {
    let sheet = createDefaultSheetState();
    sheet = setRowSuccessInSheet(
      sheet,
      sheet.rows[0].key,
      "P1",
      createShipment({
        shipmentId: "P1",
        status: "DELIVERED",
        service: "Q9",
        isCod: true,
        codTotal: 100_000,
      })
    );
    sheet = {
      ...sheet,
      analytics: {
        sourceScope: "all_rows",
        rowPaths: [],
        columnPaths: [],
        valueMetrics: [],
        chartType: "bar",
      },
    };

    const summary = getSheetAnalyticsSummary({
      sheetState: sheet,
      selectedVisibleRowKeys: [],
      ...getDisplayedContext(sheet),
    });

    expect(summary.sourceRowCount).toBe(1);
    expect(summary.rowLabel).toBe("Semua Row");
    expect(summary.valueMetrics).toEqual([]);
    expect(summary.primaryMetric).toBeNull();
    expect(summary.rows).toEqual([
      expect.objectContaining({
        label: "Semua Row",
        metricValue: 0,
        share: 0,
      }),
    ]);
  });
});
