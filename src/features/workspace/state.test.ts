import {
  DEFAULT_WORKSPACE_SHEET_ID,
  createDefaultWorkspaceState,
} from "./default-state";
import {
  createSheetInWorkspace,
  deleteSheetInWorkspace,
  reconcileWorkspaceSheetsFromEngine,
  renameSheetInWorkspace,
  setActiveSheetInWorkspace,
  updateActiveSheetInWorkspace,
  updateSheetInWorkspace,
} from "./actions";
import {
  getActiveSheet,
  getActiveSheetName,
  getWorkspaceTabs,
} from "./selectors";

const COD_TOTAL_COLUMN_PATH = "detail.billing_detail.cod_info.total_cod";

describe("workspace state", () => {
  it("creates a workspace with one active sheet", () => {
    const workspace = createDefaultWorkspaceState();
    const activeSheet = getActiveSheet(workspace);

    expect(workspace.version).toBe(1);
    expect(workspace.sheetOrder).toHaveLength(1);
    expect(workspace.activeSheetId).toBe(DEFAULT_WORKSPACE_SHEET_ID);
    expect(workspace.activeSheetId).toBe(workspace.sheetOrder[0]);
    expect(getActiveSheetName(workspace)).toBe("Sheet 1");
    expect(activeSheet.rows.length).toBeGreaterThan(0);
  });

  it("updates only the targeted sheet", () => {
    const workspace = createSheetInWorkspace(createDefaultWorkspaceState(), {
      activate: false,
    });
    const [firstSheetId, secondSheetId] = workspace.sheetOrder;

    const next = updateSheetInWorkspace(workspace, secondSheetId, (sheet) => ({
      ...sheet,
      deleteAllArmed: true,
      activeMode: "analytics",
      analytics: {
        ...sheet.analytics,
        rowPaths: ["detail.package_detail.jenis_layanan"],
      },
    }));

    expect(next.sheetsById[firstSheetId].deleteAllArmed).toBe(false);
    expect(next.sheetsById[secondSheetId].deleteAllArmed).toBe(true);
    expect(next.sheetsById[firstSheetId].activeMode).toBe("workspace");
    expect(next.sheetsById[secondSheetId].activeMode).toBe("analytics");
    expect(next.sheetsById[firstSheetId].analytics.rowPaths).toEqual([
      "status_akhir.status",
    ]);
    expect(next.sheetsById[secondSheetId].analytics.rowPaths).toEqual([
      "detail.package_detail.jenis_layanan",
    ]);
  });

  it("updates the active sheet and can switch active tabs", () => {
    const workspace = createSheetInWorkspace(createDefaultWorkspaceState());
    const secondSheetId = workspace.activeSheetId;
    const firstSheetId = workspace.sheetOrder[0];

    const switched = setActiveSheetInWorkspace(workspace, firstSheetId);
    const next = updateActiveSheetInWorkspace(switched, (sheet) => ({
      ...sheet,
      deleteAllArmed: true,
    }));

    expect(next.activeSheetId).toBe(firstSheetId);
    expect(next.sheetsById[firstSheetId].deleteAllArmed).toBe(true);
    expect(next.sheetsById[secondSheetId].deleteAllArmed).toBe(false);
  });

  it("creates, renames, duplicates, and deletes sheets safely", () => {
    let workspace = createDefaultWorkspaceState();
    const originalSheetId = workspace.activeSheetId;

    workspace = renameSheetInWorkspace(workspace, originalSheetId, "Investigasi SLA");
    workspace = createSheetInWorkspace(workspace, {
      sourceSheetId: originalSheetId,
      name: "Investigasi SLA Copy",
    });

    expect(workspace.sheetOrder).toHaveLength(2);
    expect(getWorkspaceTabs(workspace).map((tab) => tab.name)).toEqual([
      "Investigasi SLA",
      "Investigasi SLA Copy",
    ]);

    const duplicatedSheetId = workspace.activeSheetId;
    const afterDelete = deleteSheetInWorkspace(workspace, duplicatedSheetId);

    expect(afterDelete.sheetOrder).toHaveLength(1);
    expect(afterDelete.activeSheetId).toBe(originalSheetId);
    expect(getActiveSheetName(afterDelete)).toBe("Investigasi SLA");
  });

  it("duplicates sheet settings without carrying local row data", () => {
    let workspace = createDefaultWorkspaceState();
    const sourceSheetId = workspace.activeSheetId;

    workspace = updateActiveSheetInWorkspace(workspace, (sheet) => ({
      ...sheet,
      activeMode: "analytics",
      analytics: {
        sourceScope: "selected_rows",
        rowPaths: ["detail.package_detail.jenis_layanan", "status_akhir.status"],
        columnPaths: [],
        valueMetrics: [COD_TOTAL_COLUMN_PATH],
        metricAggregations: {
          [COD_TOTAL_COLUMN_PATH]: "sum",
        },
        chartType: "donut",
      },
      rows: sheet.rows.map((row, index) =>
        index === 0
          ? {
              ...row,
              trackingInput: "P2603310114291",
              loading: true,
              error: "temporary failure",
            }
          : row
      ),
    }));

    const duplicated = createSheetInWorkspace(workspace, {
      sourceSheetId,
    });
    const duplicatedSheet = getActiveSheet(duplicated);

    expect(getActiveSheetName(duplicated)).toBe("Sheet 1 - 1");
    expect(duplicatedSheet.activeMode).toBe("analytics");
    expect(duplicatedSheet.analytics).toEqual({
      sourceScope: "selected_rows",
      rowPaths: ["detail.package_detail.jenis_layanan", "status_akhir.status"],
      columnPaths: [],
      valueMetrics: [COD_TOTAL_COLUMN_PATH],
      metricAggregations: {
        [COD_TOTAL_COLUMN_PATH]: "sum",
      },
      chartType: "donut",
    });
    expect(duplicatedSheet.analytics.rowPaths).not.toBe(
      workspace.sheetsById[sourceSheetId].analytics.rowPaths
    );
    expect(duplicatedSheet.analytics.columnPaths).not.toBe(
      workspace.sheetsById[sourceSheetId].analytics.columnPaths
    );
    expect(duplicatedSheet.analytics.valueMetrics).not.toBe(
      workspace.sheetsById[sourceSheetId].analytics.valueMetrics
    );
    expect(duplicatedSheet.analytics.metricAggregations).not.toBe(
      workspace.sheetsById[sourceSheetId].analytics.metricAggregations
    );
    expect(duplicatedSheet.rows[0].trackingInput).toBe("");
    expect(duplicatedSheet.rows[0].shipment).toBeNull();
    expect(duplicatedSheet.rows[0].loading).toBe(false);
    expect(duplicatedSheet.rows[0].error).toBe("");
  });

  it("names derived sheets from their source with incrementing numeric suffixes", () => {
    let workspace = createDefaultWorkspaceState();
    const sourceSheetId = workspace.activeSheetId;

    workspace = renameSheetInWorkspace(workspace, sourceSheetId, "Prio");
    workspace = createSheetInWorkspace(workspace, {
      sourceSheetId,
      activate: false,
    });
    const prioDashOneId = workspace.sheetOrder[1];
    workspace = createSheetInWorkspace(workspace, {
      sourceSheetId,
      activate: false,
    });

    workspace = createSheetInWorkspace(workspace, {
      sourceSheetId: prioDashOneId,
      activate: false,
    });
    workspace = createSheetInWorkspace(workspace, {
      sourceSheetId: prioDashOneId,
      activate: false,
    });

    expect([...getWorkspaceTabs(workspace).map((tab) => tab.name)].sort()).toEqual([
      "Prio",
      "Prio - 1",
      "Prio - 1 - 1",
      "Prio - 1 - 2",
      "Prio - 2",
    ]);
  });

  it("inserts a duplicated sheet immediately after its source tab", () => {
    let workspace = createDefaultWorkspaceState();
    workspace = createSheetInWorkspace(workspace, { activate: false });
    workspace = createSheetInWorkspace(workspace, { activate: false });

    const middleSheetId = workspace.sheetOrder[1];

    workspace = renameSheetInWorkspace(workspace, middleSheetId, "Prio");
    workspace = createSheetInWorkspace(workspace, {
      sourceSheetId: middleSheetId,
      activate: false,
    });

    expect(getWorkspaceTabs(workspace).map((tab) => tab.name)).toEqual([
      "Sheet 1",
      "Prio",
      "Prio - 1",
      "Sheet 3",
    ]);
  });

  it("keeps generated names unique across repeated create and case-insensitive rename", () => {
    let workspace = createDefaultWorkspaceState();
    const originalSheetId = workspace.activeSheetId;

    workspace = renameSheetInWorkspace(workspace, originalSheetId, "case cod");
    workspace = createSheetInWorkspace(workspace, { activate: false, name: "Case COD" });
    workspace = createSheetInWorkspace(workspace, { activate: false });
    workspace = createSheetInWorkspace(workspace, { activate: false });

    expect(getWorkspaceTabs(workspace).map((tab) => tab.name)).toEqual([
      "case cod",
      "Case COD (2)",
      "Sheet 3",
      "Sheet 4",
    ]);
  });

  it("reconciles sheet metadata from the Rust engine without dropping local sheets", () => {
    let workspace = createDefaultWorkspaceState();
    const firstSheetId = workspace.activeSheetId;

    workspace = createSheetInWorkspace(workspace, { activate: false });
    const localOnlySheetId = workspace.sheetOrder[1];

    const next = reconcileWorkspaceSheetsFromEngine(workspace, [
      {
        sheetId: firstSheetId,
        workspaceId: "workspace-1",
        name: "Engine Sheet",
        position: 1,
        viewMode: "workspace",
      },
      {
        sheetId: "engine-sheet-2",
        workspaceId: "workspace-1",
        name: "Rust Only",
        position: 0,
        viewMode: "workspace",
      },
    ]);

    expect(next.sheetOrder).toEqual([
      "engine-sheet-2",
      firstSheetId,
      localOnlySheetId,
    ]);
    expect(next.activeSheetId).toBe(firstSheetId);
    expect(next.sheetMetaById[firstSheetId]?.name).toBe("Engine Sheet");
    expect(next.sheetMetaById["engine-sheet-2"]?.name).toBe("Rust Only");
    expect(next.sheetsById["engine-sheet-2"]).toBeDefined();
    expect(next.sheetsById[localOnlySheetId]).toBe(workspace.sheetsById[localOnlySheetId]);
  });

  it("ignores Rust sheet metadata when bootstrap ids do not match local tabs yet", () => {
    const workspace = createDefaultWorkspaceState();

    const next = reconcileWorkspaceSheetsFromEngine(workspace, [
      {
        sheetId: "engine-bootstrap-sheet",
        workspaceId: "workspace-1",
        name: "Engine Sheet",
        position: 0,
        viewMode: "workspace",
      },
    ]);

    expect(next).toBe(workspace);
  });
});
