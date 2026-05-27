import { createDefaultWorkspaceState } from "./default-state";
import { normalizePersistedWorkspaceState } from "./persistence";

const COD_TOTAL_COLUMN_PATH = "detail.billing_detail.cod_info.total_cod";

describe("workspace persistence", () => {
  it("migrates older persisted sheets without mode or analytics fields", () => {
    const workspace = createDefaultWorkspaceState();
    const sheetId = workspace.activeSheetId;
    const legacySheet = { ...workspace.sheetsById[sheetId] } as Record<
      string,
      unknown
    >;
    delete legacySheet.activeMode;
    delete legacySheet.analytics;

    const normalized = normalizePersistedWorkspaceState({
      ...workspace,
      sheetsById: {
        [sheetId]: legacySheet,
      },
    } as never);

    expect(normalized.sheetsById[sheetId].activeMode).toBe("workspace");
    expect(normalized.sheetsById[sheetId].analytics).toEqual({
      sourceScope: "filtered_rows",
      groupByPaths: ["status_akhir.status"],
      metrics: ["count"],
      metricAggregations: {
        count: "count",
      },
      chartType: "pivot",
    });
  });

  it("keeps valid per-sheet analytics config and drops invalid values", () => {
    const workspace = createDefaultWorkspaceState();
    const sheetId = workspace.activeSheetId;

    const normalized = normalizePersistedWorkspaceState({
      ...workspace,
      sheetsById: {
        [sheetId]: {
          ...workspace.sheetsById[sheetId],
          activeMode: "analytics",
          analytics: {
            sourceScope: "selected_rows",
            groupByPaths: [
              "detail.package_detail.jenis_layanan",
              "status_akhir.location",
              "status_akhir.location",
            ],
            metrics: [COD_TOTAL_COLUMN_PATH, "count", "count"],
            metricAggregations: {
              [COD_TOTAL_COLUMN_PATH]: "average",
              count: "count",
            },
            chartType: "pivot",
          },
        },
      },
    });

    expect(normalized.sheetsById[sheetId].activeMode).toBe("analytics");
    expect(normalized.sheetsById[sheetId].analytics).toEqual({
      sourceScope: "selected_rows",
      groupByPaths: ["detail.package_detail.jenis_layanan", "status_akhir.location"],
      metrics: [COD_TOTAL_COLUMN_PATH, "count"],
      metricAggregations: {
        [COD_TOTAL_COLUMN_PATH]: "average",
        count: "count",
      },
      chartType: "pivot",
    });

    const invalid = normalizePersistedWorkspaceState({
      ...workspace,
      sheetsById: {
        [sheetId]: {
          ...workspace.sheetsById[sheetId],
          activeMode: "legacy",
          analytics: {
            sourceScope: "global",
            groupByPaths: ["missing.path"],
            metrics: ["avg"],
            chartType: "line",
          },
        },
      },
    } as never);

    expect(invalid.sheetsById[sheetId].activeMode).toBe("workspace");
    expect(invalid.sheetsById[sheetId].analytics).toEqual({
      sourceScope: "filtered_rows",
      groupByPaths: ["status_akhir.status"],
      metrics: ["count"],
      metricAggregations: {
        count: "count",
      },
      chartType: "pivot",
    });
  });

  it("migrates legacy single analytics fields into multi-select arrays", () => {
    const workspace = createDefaultWorkspaceState();
    const sheetId = workspace.activeSheetId;

    const normalized = normalizePersistedWorkspaceState({
      ...workspace,
      sheetsById: {
        [sheetId]: {
          ...workspace.sheetsById[sheetId],
          analytics: {
            sourceScope: "selected_rows",
            groupByPath: "detail.package_detail.jenis_layanan",
            metric: "cod_total",
            chartType: "donut",
          },
        },
      },
    } as never);

    expect(normalized.sheetsById[sheetId].analytics).toEqual({
      sourceScope: "selected_rows",
      groupByPaths: ["detail.package_detail.jenis_layanan"],
      metrics: [COD_TOTAL_COLUMN_PATH],
      metricAggregations: {
        [COD_TOTAL_COLUMN_PATH]: "sum",
      },
      chartType: "donut",
    });
  });

  it("preserves intentionally empty analytics field selections", () => {
    const workspace = createDefaultWorkspaceState();
    const sheetId = workspace.activeSheetId;

    const normalized = normalizePersistedWorkspaceState({
      ...workspace,
      sheetsById: {
        [sheetId]: {
          ...workspace.sheetsById[sheetId],
          analytics: {
            sourceScope: "filtered_rows",
            groupByPaths: [],
            metrics: [],
            chartType: "bar",
          },
        },
      },
    });

    expect(normalized.sheetsById[sheetId].analytics).toEqual({
      sourceScope: "filtered_rows",
      groupByPaths: [],
      metrics: [],
      metricAggregations: {},
      chartType: "bar",
    });
  });
});
