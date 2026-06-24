import {
  DEFAULT_WORKSPACE_SHEET_ID,
  createDefaultWorkspaceState,
} from "./default-state";
import type { TrackResponse } from "../../types";
import {
  normalizePersistedWorkspaceState,
  persistWorkspaceStateSnapshot,
} from "./persistence";

const COD_TOTAL_COLUMN_PATH = "detail.billing_detail.cod_info.total_cod";
const WORKSPACE_STATE_STORAGE_KEY = "shipflow-workspace-state";

function createTrackResponse(shipmentId: string): TrackResponse {
  return {
    url: `https://example.test/track/${shipmentId}`,
    detail: {
      shipment_header: {
        nomor_kiriman: shipmentId,
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
      status: "INVEHICLE",
    },
    pod: {
      photo1_url: "https://example.test/photo-1.jpg",
      photo2_url: "https://example.test/photo-2.jpg",
      signature_url: "https://example.test/signature.jpg",
    },
    history: [],
    history_summary: {
      irregularity: [],
      bagging_unbagging: [],
      manifest_r7: [],
      delivery_runsheet: [],
    },
  };
}

describe("workspace persistence", () => {
  beforeEach(() => {
    window.localStorage.removeItem(WORKSPACE_STATE_STORAGE_KEY);
  });

  it("migrates the legacy primary sheet id to the Rust bootstrap sheet id", () => {
    const workspace = createDefaultWorkspaceState();
    const sheet = workspace.sheetsById[workspace.activeSheetId];
    const meta = workspace.sheetMetaById[workspace.activeSheetId];

    const normalized = normalizePersistedWorkspaceState({
      ...workspace,
      activeSheetId: "legacy-random-sheet",
      sheetOrder: ["legacy-random-sheet"],
      sheetMetaById: {
        "legacy-random-sheet": {
          ...meta,
          name: "Legacy Local",
        },
      },
      sheetsById: {
        "legacy-random-sheet": {
          ...sheet,
          rows: [
            {
              ...sheet.rows[0],
              key: "legacy-row",
              trackingInput: "P2606020189412.30",
            },
          ],
        },
      },
    });

    expect(normalized.activeSheetId).toBe(DEFAULT_WORKSPACE_SHEET_ID);
    expect(normalized.sheetOrder).toEqual([DEFAULT_WORKSPACE_SHEET_ID]);
    expect(normalized.sheetMetaById[DEFAULT_WORKSPACE_SHEET_ID]?.name).toBe(
      "Legacy Local"
    );
    expect(
      normalized.sheetsById[DEFAULT_WORKSPACE_SHEET_ID].rows[0].trackingInput
    ).toBe("P2606020189412.30");
  });

  it("can preserve document-owned sheet ids during document normalization", () => {
    const workspace = createDefaultWorkspaceState();
    const sheet = workspace.sheetsById[workspace.activeSheetId];
    const meta = workspace.sheetMetaById[workspace.activeSheetId];

    const normalized = normalizePersistedWorkspaceState(
      {
        ...workspace,
        activeSheetId: "sheet-opened",
        sheetOrder: ["sheet-opened"],
        sheetMetaById: {
          "sheet-opened": meta,
        },
        sheetsById: {
          "sheet-opened": sheet,
        },
      },
      {
        migratePrimarySheetToDefault: false,
      }
    );

    expect(normalized.activeSheetId).toBe("sheet-opened");
    expect(normalized.sheetOrder).toEqual(["sheet-opened"]);
  });

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

  it("persists local workspace snapshots with inputs only", () => {
    const workspace = createDefaultWorkspaceState();
    const sheetId = workspace.activeSheetId;

    const workspaceWithShipment = {
      ...workspace,
      sheetsById: {
        ...workspace.sheetsById,
        [sheetId]: {
          ...workspace.sheetsById[sheetId],
          rows: [
            {
              ...workspace.sheetsById[sheetId].rows[0],
              key: "row-with-shipment",
              trackingInput: "P2603310114291",
              shipment: createTrackResponse("P2603310114291"),
              stale: true,
              dirty: true,
            },
            ...workspace.sheetsById[sheetId].rows.slice(1),
          ],
        },
      },
    };

    persistWorkspaceStateSnapshot({
      workspaceState: workspaceWithShipment,
      documentMeta: {
        path: "/tmp/current.shipflow",
        isDirty: false,
      },
      windowLabel: "main",
    });

    const stored = window.localStorage.getItem(WORKSPACE_STATE_STORAGE_KEY);
    expect(stored).not.toBeNull();

    const parsed = JSON.parse(stored ?? "{}");
    const storedRow = parsed.sheetsById[sheetId].rows[0];
    expect(storedRow.trackingInput).toBe("P2603310114291");
    expect(storedRow.shipment).toBeNull();
    expect(storedRow.stale).toBe(false);
    expect(storedRow.dirty).toBe(false);
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
