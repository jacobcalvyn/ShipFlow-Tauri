import { describe, expect, it } from "vitest";
import type { TrackResponse } from "../../types";
import { setRowSuccessInSheet } from "./actions";
import {
  createDuckDbAnalyticsRows,
  createDuckDbAnalyticsSqlPlan,
  getDuckDbAnalyticsColumns,
  quoteDuckDbIdentifier,
} from "./duckdb-analytics-prototype";
import { createDefaultSheetState } from "./default-state";
import {
  getActiveFilterCount,
  getDisplayedRows,
  getNonEmptyRows,
  getVisibleColumns,
  getVisibleColumnPathSet,
} from "./selectors";

const SERVICE_COLUMN_PATH = "detail.package_detail.jenis_layanan";
const STATUS_COLUMN_PATH = "status_akhir.status";
const TRACKING_COLUMN_PATH = "detail.shipment_header.nomor_kiriman";
const COD_TOTAL_COLUMN_PATH = "detail.billing_detail.cod_info.total_cod";

function createShipment(params: {
  shipmentId: string;
  status: string;
  service: string;
  codTotal: number;
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
          is_cod: params.codTotal > 0,
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

describe("duckdb analytics prototype", () => {
  it("projects sheet rows into DuckDB-ready analytics records", () => {
    let sheet = createDefaultSheetState();
    sheet = setRowSuccessInSheet(
      sheet,
      sheet.rows[0].key,
      "P1",
      createShipment({
        shipmentId: "P1",
        status: "DELIVERED",
        service: "PKH",
        codTotal: 125000,
      })
    );

    const columns = getDuckDbAnalyticsColumns();
    const rows = createDuckDbAnalyticsRows([sheet.rows[0], sheet.rows[1]], columns);

    expect(rows[0][TRACKING_COLUMN_PATH]).toBe("P1");
    expect(rows[0][`${TRACKING_COLUMN_PATH}__has_value`]).toBe(true);
    expect(rows[0][STATUS_COLUMN_PATH]).toBe("DELIVERED");
    expect(rows[0][`${STATUS_COLUMN_PATH}__has_value`]).toBe(true);
    expect(rows[0][COD_TOTAL_COLUMN_PATH]).toBe(125000);
    expect(rows[0][`${COD_TOTAL_COLUMN_PATH}__has_value`]).toBe(true);

    expect(rows[1][STATUS_COLUMN_PATH]).toBe("-");
    expect(rows[1][`${STATUS_COLUMN_PATH}__has_value`]).toBe(false);
    expect(rows[1][COD_TOTAL_COLUMN_PATH]).toBe(0);
    expect(rows[1][`${COD_TOTAL_COLUMN_PATH}__has_value`]).toBe(false);
  });

  it("builds a long-form DuckDB pivot query with text count and distinct aggregations", () => {
    let sheet = createDefaultSheetState();
    sheet = setRowSuccessInSheet(
      sheet,
      sheet.rows[0].key,
      "P1",
      createShipment({
        shipmentId: "P1",
        status: "DELIVERED",
        service: "PKH",
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
        service: "PKH",
        codTotal: 0,
      })
    );
    sheet = {
      ...sheet,
      analytics: {
        sourceScope: "all_rows",
        rowPaths: [SERVICE_COLUMN_PATH],
        columnPaths: [STATUS_COLUMN_PATH],
        valueMetrics: [TRACKING_COLUMN_PATH, STATUS_COLUMN_PATH],
        metricAggregations: {
          [TRACKING_COLUMN_PATH]: "count",
          [STATUS_COLUMN_PATH]: "count_unique",
        },
        chartType: "pivot",
      },
    };

    const plan = createDuckDbAnalyticsSqlPlan(
      {
        sheetState: sheet,
        selectedVisibleRowKeys: [],
        ...getDisplayedContext(sheet),
      },
      {
        rowPaths: sheet.analytics.rowPaths,
        columnPaths: sheet.analytics.columnPaths,
        valueMetrics: [
          {
            key: TRACKING_COLUMN_PATH,
            path: TRACKING_COLUMN_PATH,
            label: "Nomor Kiriman",
            format: "text",
            aggregation: "count",
          },
          {
            key: STATUS_COLUMN_PATH,
            path: STATUS_COLUMN_PATH,
            label: "Status Akhir",
            format: "text",
            aggregation: "count_unique",
          },
        ],
      }
    );

    expect(plan.engineId).toBe("duckdb-wasm-prototype");
    expect(plan.rows).toHaveLength(2);
    expect(plan.sql).toContain(`FROM ${quoteDuckDbIdentifier("shipflow_rows")}`);
    expect(plan.sql).toContain(
      `GROUP BY ${quoteDuckDbIdentifier(SERVICE_COLUMN_PATH)}, ${quoteDuckDbIdentifier(
        STATUS_COLUMN_PATH
      )}`
    );
    expect(plan.sql).toContain(
      `sum(case when ${quoteDuckDbIdentifier(
        `${TRACKING_COLUMN_PATH}__has_value`
      )} then 1 else 0 end) as ${quoteDuckDbIdentifier(
        `${TRACKING_COLUMN_PATH}__count`
      )}`
    );
    expect(plan.sql).toContain(
      `count(distinct case when ${quoteDuckDbIdentifier(
        `${STATUS_COLUMN_PATH}__has_value`
      )} then cast(${quoteDuckDbIdentifier(
        STATUS_COLUMN_PATH
      )} as varchar) else null end) as ${quoteDuckDbIdentifier(
        `${STATUS_COLUMN_PATH}__count_unique`
      )}`
    );
  });
});
