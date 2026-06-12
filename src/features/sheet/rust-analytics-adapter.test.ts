import { describe, expect, it } from "vitest";
import type { PivotResult } from "../workspace-engine/client";
import { createDefaultSheetState } from "./default-state";
import {
  createRustPivotQueryFromSheetAnalytics,
  createSheetAnalyticsSummaryFromRustChart,
  createSheetAnalyticsSummaryFromRustPivot,
} from "./rust-analytics-adapter";

describe("Rust analytics adapter", () => {
  it("builds a Rust pivot query from the row-column-value sheet state", () => {
    const sheet = {
      ...createDefaultSheetState(),
      analytics: {
        sourceScope: "filtered_rows" as const,
        rowPaths: ["detail.package_detail.jenis_layanan"],
        columnPaths: ["status_akhir.status"],
        valueMetrics: ["detail.shipment_header.nomor_kiriman"],
        metricAggregations: {
          "detail.shipment_header.nomor_kiriman": "count_unique" as const,
        },
        chartType: "pivot" as const,
      },
    };

    const query = createRustPivotQueryFromSheetAnalytics({
      sheetId: "sheet-1",
      sheetState: sheet,
      filters: [{ field: "rowStatus", value: "loaded" }],
      valueFilters: [{ field: "status_akhir.status", values: ["DELIVERED"] }],
      selectedRowIds: ["row-1", "row-2"],
    });

    expect(query).toEqual({
      sheetId: "sheet-1",
      sourceScope: "filtered_rows",
      filters: [{ field: "rowStatus", value: "loaded" }],
      valueFilters: [{ field: "status_akhir.status", values: ["DELIVERED"] }],
      selectedRowIds: ["row-1", "row-2"],
      rowFields: ["detail.package_detail.jenis_layanan"],
      columnFields: ["status_akhir.status"],
      values: [
        {
          field: "detail.shipment_header.nomor_kiriman",
          aggregation: "count_unique",
        },
      ],
      sort: [{ field: "share", direction: "desc" }],
      limit: 10_000,
    });
  });

  it("omits column fields from Rust chart queries", () => {
    const sheet = {
      ...createDefaultSheetState(),
      analytics: {
        sourceScope: "all_rows" as const,
        rowPaths: ["detail.package_detail.jenis_layanan"],
        columnPaths: ["status_akhir.status"],
        valueMetrics: ["detail.shipment_header.nomor_kiriman"],
        metricAggregations: {
          "detail.shipment_header.nomor_kiriman": "count_unique" as const,
        },
        chartType: "bar" as const,
      },
    };

    const query = createRustPivotQueryFromSheetAnalytics({
      sheetId: "sheet-1",
      sheetState: sheet,
      filters: [],
      selectedRowIds: [],
    });

    expect(query.columnFields).toEqual([]);
  });

  it("adapts Rust chart series into the existing summary view model", () => {
    const sheet = {
      ...createDefaultSheetState(),
      analytics: {
        sourceScope: "all_rows" as const,
        rowPaths: ["detail.package_detail.jenis_layanan"],
        columnPaths: ["status_akhir.status"],
        valueMetrics: ["detail.shipment_header.nomor_kiriman"],
        metricAggregations: {
          "detail.shipment_header.nomor_kiriman": "count_unique" as const,
        },
        chartType: "bar" as const,
      },
    };

    const summary = createSheetAnalyticsSummaryFromRustChart({
      sheetState: sheet,
      chartResult: {
        sheetId: "sheet-1",
        chartType: "bar",
        sourceRowCount: 3,
        series: [
          {
            rowValues: ["PKH"],
            columnValues: [],
            count: 3,
            metrics: {
              "detail.shipment_header.nomor_kiriman__count_unique": 3,
            },
            share: 100,
          },
        ],
      },
      selectedRowCount: 0,
    });

    expect(summary.sourceRowCount).toBe(3);
    expect(summary.rows[0]).toMatchObject({
      rowValues: ["PKH"],
      metricValue: 3,
      share: 100,
    });
  });

  it("adapts Rust long-form pivot rows into the existing summary view model", () => {
    const sheet = {
      ...createDefaultSheetState(),
      analytics: {
        sourceScope: "all_rows" as const,
        rowPaths: ["detail.package_detail.jenis_layanan"],
        columnPaths: ["status_akhir.status"],
        valueMetrics: ["detail.shipment_header.nomor_kiriman"],
        metricAggregations: {
          "detail.shipment_header.nomor_kiriman": "count_unique" as const,
        },
        chartType: "pivot" as const,
      },
    };
    const pivotResult: PivotResult = {
      sheetId: "sheet-1",
      sourceRowCount: 4,
      rows: [
        {
          rowValues: ["PKH"],
          columnValues: ["DELIVERED"],
          count: 2,
          metrics: {
            "detail.shipment_header.nomor_kiriman__count_unique": 2,
          },
          share: 50,
        },
        {
          rowValues: ["PKH"],
          columnValues: ["unBag"],
          count: 1,
          metrics: {
            "detail.shipment_header.nomor_kiriman__count_unique": 1,
          },
          share: 25,
        },
        {
          rowValues: ["EC3"],
          columnValues: ["unBag"],
          count: 1,
          metrics: {
            "detail.shipment_header.nomor_kiriman__count_unique": 1,
          },
          share: 25,
        },
      ],
    };

    const summary = createSheetAnalyticsSummaryFromRustPivot({
      sheetState: sheet,
      pivotResult,
      selectedRowCount: 0,
    });

    expect(summary.sourceRowCount).toBe(4);
    expect(summary.rowLabels).toEqual(["Jenis Layanan"]);
    expect(summary.columnLabels).toEqual(["Status Akhir"]);
    expect(summary.pivotValueColumns.map((column) => column.label)).toEqual([
      "DELIVERED",
      "unBag",
    ]);
    expect(summary.rows).toHaveLength(2);
    expect(summary.rows[0]).toMatchObject({
      rowValues: ["PKH"],
      count: 3,
      metricValue: 3,
      share: 75,
      pivotMetricValues: {
        "[\"DELIVERED\"]:detail.shipment_header.nomor_kiriman": 2,
        "[\"unBag\"]:detail.shipment_header.nomor_kiriman": 1,
      },
    });
    expect(summary.rows[1]).toMatchObject({
      rowValues: ["EC3"],
      count: 1,
      metricValue: 1,
      share: 25,
    });
  });
});
