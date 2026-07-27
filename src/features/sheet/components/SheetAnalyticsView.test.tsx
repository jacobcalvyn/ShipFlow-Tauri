import { describe, expect, it } from "vitest";
import type { SheetAnalyticsRow } from "../analytics";
import {
  createDonutBackground,
  selectChartRows,
} from "./SheetAnalyticsView";

function createRow({
  key,
  count,
  metricValue,
  share,
}: {
  key: string;
  count: number;
  metricValue: number;
  share: number;
}): SheetAnalyticsRow {
  return {
    key,
    label: key,
    rowValues: [key],
    groupValues: [key],
    count,
    codTotal: 0,
    metricValues: {},
    metricDisplayValues: {},
    pivotMetricValues: {},
    pivotMetricDisplayValues: {},
    metricValue,
    share,
  };
}

describe("SheetAnalyticsView chart helpers", () => {
  it("ranks chart rows by the selected metric instead of shipment share", () => {
    const lowMetricHighCount = createRow({
      key: "high-count",
      count: 100,
      metricValue: 10,
      share: 90,
    });
    const highMetricLowCount = createRow({
      key: "high-metric",
      count: 1,
      metricValue: 1_000,
      share: 10,
    });

    expect(
      selectChartRows([lowMetricHighCount, highMetricLowCount], 1).map(
        (row) => row.key
      )
    ).toEqual(["high-metric"]);
  });

  it("preserves count ranking when the selected metric is a count", () => {
    const rows = [
      createRow({ key: "two", count: 2, metricValue: 2, share: 20 }),
      createRow({ key: "eight", count: 8, metricValue: 8, share: 80 }),
    ];

    expect(selectChartRows(rows).map((row) => row.key)).toEqual([
      "eight",
      "two",
    ]);
  });

  it("sizes donut segments from metric values rather than shipment share", () => {
    const rows = [
      createRow({ key: "large-metric", count: 1, metricValue: 80, share: 10 }),
      createRow({ key: "small-metric", count: 9, metricValue: 20, share: 90 }),
    ];

    expect(createDonutBackground(rows, 100)).toBe(
      "conic-gradient(#2563eb 0% 80%, #16a34a 80% 100%)"
    );
  });

  it("renders a neutral remainder when top-N rows do not cover the total metric", () => {
    const rows = [
      createRow({ key: "visible", count: 1, metricValue: 60, share: 100 }),
    ];

    expect(createDonutBackground(rows, 100)).toBe(
      "conic-gradient(#2563eb 0% 60%, #e2e8f0 60% 100%)"
    );
  });
});
