import { TrackResponse } from "../../types";
import {
  setRowSuccessInSheet,
  setTextFilterInSheet,
} from "./actions";
import {
  ANALYTICS_EXCLUDED_COLUMN_PATHS,
  getSheetAnalyticsGroupByOptions,
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
    const groupPaths = getSheetAnalyticsGroupByOptions().map((option) => option.path);
    const metricKeys = getSheetAnalyticsMetricOptions().map((option) => option.key);
    const allowedColumnPaths = COLUMNS.filter(
      (column) => !ANALYTICS_EXCLUDED_COLUMN_PATHS.has(column.path)
    ).map((column) => column.path);

    expect(groupPaths).toEqual(allowedColumnPaths);
    expect(metricKeys).toEqual(["count", ...allowedColumnPaths]);
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
        codTotal: 0,
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
        groupByPaths: ["detail.package_detail.jenis_layanan"],
        metrics: ["cod_total"],
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
        codTotal: 0,
      })
    );
    sheet = {
      ...sheet,
      analytics: {
        sourceScope: "selected_rows",
        groupByPaths: ["status_akhir.status"],
        metrics: ["count"],
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
        metricValue: 1,
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
        groupByPaths: ["status_akhir.status", "detail.package_detail.jenis_layanan"],
        metrics: ["count", "cod_total"],
        chartType: "bar",
      },
    };

    const summary = getSheetAnalyticsSummary({
      sheetState: sheet,
      selectedVisibleRowKeys: [],
      ...getDisplayedContext(sheet),
    });

    expect(summary.groupByLabel).toBe("Status Akhir / Jenis Layanan");
    expect(summary.metrics.map((metric) => metric.key)).toEqual([
      "count",
      COD_TOTAL_COLUMN_PATH,
    ]);
    expect(summary.rows).toEqual([
      expect.objectContaining({
        label: "DELIVERED / Q9",
        count: 2,
        codTotal: 250_000,
        metricValues: {
          count: 2,
          [COD_TOTAL_COLUMN_PATH]: 250_000,
        },
        metricValue: 2,
      }),
      expect.objectContaining({
        label: "DELIVERED / QCOMM",
        count: 1,
        codTotal: 0,
        metricValues: {
          count: 1,
          [COD_TOTAL_COLUMN_PATH]: 0,
        },
        metricValue: 1,
      }),
    ]);
  });

  it("splits pivot rows by text metric values and keeps pivot share based on row count", () => {
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
        groupByPaths: ["detail.package_detail.jenis_layanan"],
        metrics: ["status_akhir.status", COD_TOTAL_COLUMN_PATH],
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
    expect(summary.groupByLabels).toEqual(["Jenis Layanan", "Status Akhir"]);
    expect(summary.metrics.map((metric) => metric.key)).toEqual([COD_TOTAL_COLUMN_PATH]);
    expect(summary.rows).toHaveLength(3);
    expect(summary.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Q9 / DELIVERED",
          groupValues: ["Q9", "DELIVERED"],
          metricValues: expect.objectContaining({
            [COD_TOTAL_COLUMN_PATH]: 300_000,
            count: 2,
            "status_akhir.status": 1,
          }),
          metricDisplayValues: {
            "status_akhir.status": "DELIVERED",
          },
          metricValue: 300_000,
          share: 50,
        }),
        expect.objectContaining({
          label: "Q9 / INVEHICLE",
          groupValues: ["Q9", "INVEHICLE"],
          metricValues: expect.objectContaining({
            [COD_TOTAL_COLUMN_PATH]: 700_000,
            count: 1,
            "status_akhir.status": 1,
          }),
          metricDisplayValues: {
            "status_akhir.status": "INVEHICLE",
          },
          metricValue: 700_000,
          share: 25,
        }),
        expect.objectContaining({
          label: "QCOMM / DELIVERED",
          groupValues: ["QCOMM", "DELIVERED"],
          metricValues: expect.objectContaining({
            [COD_TOTAL_COLUMN_PATH]: 500_000,
            count: 1,
            "status_akhir.status": 1,
          }),
          metricDisplayValues: {
            "status_akhir.status": "DELIVERED",
          },
          metricValue: 500_000,
          share: 25,
        }),
      ])
    );
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
        groupByPaths: [],
        metrics: [],
        chartType: "bar",
      },
    };

    const summary = getSheetAnalyticsSummary({
      sheetState: sheet,
      selectedVisibleRowKeys: [],
      ...getDisplayedContext(sheet),
    });

    expect(summary.sourceRowCount).toBe(1);
    expect(summary.groupByLabel).toBe("Semua Row");
    expect(summary.metrics).toEqual([]);
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
