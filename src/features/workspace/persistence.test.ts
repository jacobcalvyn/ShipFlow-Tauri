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
      rowPaths: ["status_akhir.status"],
      columnPaths: [],
      valueMetrics: [],
      metricAggregations: {},
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
            rowPaths: [
              "detail.package_detail.jenis_layanan",
              "status_akhir.location",
              "status_akhir.location",
            ],
            columnPaths: ["status_akhir.status", "status_akhir.status"],
            valueMetrics: [COD_TOTAL_COLUMN_PATH, "count", "count"],
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
      rowPaths: ["detail.package_detail.jenis_layanan", "status_akhir.location"],
      columnPaths: ["status_akhir.status"],
      valueMetrics: [COD_TOTAL_COLUMN_PATH],
      metricAggregations: {
        [COD_TOTAL_COLUMN_PATH]: "average",
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
      rowPaths: ["status_akhir.status"],
      columnPaths: [],
      valueMetrics: [],
      metricAggregations: {},
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
            metricAggregations: {
              cod_total: "average",
            },
            chartType: "donut",
          },
        },
      },
    } as never);

    expect(normalized.sheetsById[sheetId].analytics).toEqual({
      sourceScope: "selected_rows",
      rowPaths: ["detail.package_detail.jenis_layanan"],
      columnPaths: [],
      valueMetrics: [COD_TOTAL_COLUMN_PATH],
      metricAggregations: {
        [COD_TOTAL_COLUMN_PATH]: "average",
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
            rowPaths: [],
            columnPaths: [],
            valueMetrics: [],
            chartType: "bar",
          },
        },
      },
    });

    expect(normalized.sheetsById[sheetId].analytics).toEqual({
      sourceScope: "filtered_rows",
      rowPaths: [],
      columnPaths: [],
      valueMetrics: [],
      metricAggregations: {},
      chartType: "bar",
    });
  });

  it("repairs duplicate persisted sheet and row keys", () => {
    const workspace = createDefaultWorkspaceState();
    const sheetId = workspace.activeSheetId;
    const sheet = workspace.sheetsById[sheetId];

    const normalized = normalizePersistedWorkspaceState({
      ...workspace,
      sheetOrder: [sheetId, sheetId],
      sheetsById: {
        [sheetId]: {
          ...sheet,
          rows: [
            {
              ...sheet.rows[0],
              key: "duplicate-row",
              trackingInput: "P1",
            },
            {
              ...sheet.rows[1],
              key: "duplicate-row",
              trackingInput: "P2",
            },
          ],
          selectedRowKeys: ["duplicate-row", "duplicate-row"],
        },
      },
    });

    const normalizedSheet = normalized.sheetsById[sheetId];
    const normalizedRowKeys = normalizedSheet.rows.slice(0, 2).map((row) => row.key);

    expect(normalized.sheetOrder).toEqual([sheetId]);
    expect(normalizedSheet.rows[0].trackingInput).toBe("P1");
    expect(normalizedSheet.rows[1].trackingInput).toBe("P2");
    expect(new Set(normalizedRowKeys).size).toBe(2);
    expect(normalizedSheet.selectedRowKeys).toEqual(["duplicate-row"]);
  });
});
