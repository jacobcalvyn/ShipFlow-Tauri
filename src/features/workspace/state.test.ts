import { createDefaultWorkspaceState } from "./default-state";
import {
  appendTrackingIdsToExistingSheetInWorkspace,
  createSheetInWorkspace,
  createSheetWithTrackingIdsInWorkspace,
  deleteSheetInWorkspace,
  moveTrackingIdsToExistingSheetInWorkspace,
  moveTrackingIdsToNewSheetInWorkspace,
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

describe("workspace state", () => {
  it("creates a workspace with one active sheet", () => {
    const workspace = createDefaultWorkspaceState();
    const activeSheet = getActiveSheet(workspace);

    expect(workspace.version).toBe(1);
    expect(workspace.sheetOrder).toHaveLength(1);
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
    }));

    expect(next.sheetsById[firstSheetId].deleteAllArmed).toBe(false);
    expect(next.sheetsById[secondSheetId].deleteAllArmed).toBe(true);
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

  it("duplicates a sheet without carrying transient loading and error state", () => {
    let workspace = createDefaultWorkspaceState();
    const sourceSheetId = workspace.activeSheetId;

    workspace = updateActiveSheetInWorkspace(workspace, (sheet) => ({
      ...sheet,
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
    expect(duplicatedSheet.rows[0].trackingInput).toBe("P2603310114291");
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

  it("creates a clean sheet seeded only with tracking ids", () => {
    const workspace = createDefaultWorkspaceState();
    const result = createSheetWithTrackingIdsInWorkspace(workspace, [
      "P2603001",
      "P2603002",
    ]);
    const seededSheet = result.workspaceState.sheetsById[result.sheetId];

    expect(result.workspaceState.activeSheetId).toBe(result.sheetId);
    expect(seededSheet.rows[0].trackingInput).toBe("P2603001");
    expect(seededSheet.rows[1].trackingInput).toBe("P2603002");
    expect(seededSheet.rows[0].shipment).toBeNull();
    expect(seededSheet.selectedRowKeys).toEqual([]);
    expect(result.targetKeys).toHaveLength(2);
  });

  it("appends tracking ids into an existing sheet without replacing current data", () => {
    let workspace = createDefaultWorkspaceState();
    const firstSheetId = workspace.activeSheetId;

    workspace = updateActiveSheetInWorkspace(workspace, (sheet) => ({
      ...sheet,
      rows: sheet.rows.map((row, index) =>
        index === 0
          ? {
              ...row,
              trackingInput: "P2603999",
            }
          : row
      ),
    }));

    workspace = createSheetInWorkspace(workspace, { activate: false });
    const secondSheetId = workspace.sheetOrder[1];
    const result = appendTrackingIdsToExistingSheetInWorkspace(workspace, secondSheetId, [
      "P2604001",
      "P2604002",
    ]);

    const targetSheet = result.workspaceState.sheetsById[secondSheetId];

    expect(result.workspaceState.activeSheetId).toBe(firstSheetId);
    expect(targetSheet.rows[0].trackingInput).toBe("P2604001");
    expect(targetSheet.rows[1].trackingInput).toBe("P2604002");
    expect(result.targetKeys).toHaveLength(2);
  });

  it("moves tracking ids into an existing sheet and removes them from the source sheet", () => {
    let workspace = createDefaultWorkspaceState();
    const firstSheetId = workspace.activeSheetId;

    workspace = updateActiveSheetInWorkspace(workspace, (sheet) => ({
      ...sheet,
      rows: sheet.rows.map((row, index) =>
        index === 0
          ? {
              ...row,
              trackingInput: "P2604999",
            }
          : row
      ),
      selectedRowKeys: [sheet.rows[0].key],
    }));

    workspace = createSheetInWorkspace(workspace, { activate: false });
    const secondSheetId = workspace.sheetOrder[1];
    const sourceRowKey = workspace.sheetsById[firstSheetId].rows[0].key;
    const result = moveTrackingIdsToExistingSheetInWorkspace(
      workspace,
      firstSheetId,
      secondSheetId,
      [sourceRowKey],
      ["P2604999"]
    );

    const targetSheet = result.workspaceState.sheetsById[secondSheetId];
    const sourceSheet = result.workspaceState.sheetsById[firstSheetId];

    expect(targetSheet.rows[0].trackingInput).toBe("P2604999");
    expect(sourceSheet.rows[0].trackingInput).toBe("");
    expect(sourceSheet.selectedRowKeys).toEqual([]);
  });

  it("moves tracking ids into a new sheet and clears them from the source sheet", () => {
    let workspace = createDefaultWorkspaceState();
    const firstSheetId = workspace.activeSheetId;
    workspace = createSheetInWorkspace(workspace, { activate: false });
    const secondSheetId = workspace.sheetOrder[1];
    const sourceRowKey = workspace.sheetsById[firstSheetId].rows[0].key;

    workspace = updateActiveSheetInWorkspace(workspace, (sheet) => ({
      ...sheet,
      rows: sheet.rows.map((row, index) =>
        index === 0
          ? {
              ...row,
              trackingInput: "P2605001",
            }
          : row
      ),
      selectedRowKeys: [sheet.rows[0].key],
    }));

    const result = moveTrackingIdsToNewSheetInWorkspace(
      workspace,
      firstSheetId,
      [sourceRowKey],
      ["P2605001"]
    );

    const newSheet = result.workspaceState.sheetsById[result.sheetId];
    const sourceSheet = result.workspaceState.sheetsById[firstSheetId];

    expect(result.workspaceState.activeSheetId).toBe(result.sheetId);
    expect(result.workspaceState.sheetMetaById[result.sheetId]?.name).toBe("Sheet 1 - 1");
    expect(result.workspaceState.sheetOrder).toEqual([
      firstSheetId,
      result.sheetId,
      secondSheetId,
    ]);
    expect(newSheet.rows[0].trackingInput).toBe("P2605001");
    expect(sourceSheet.rows[0].trackingInput).toBe("");
    expect(sourceSheet.selectedRowKeys).toEqual([]);
  });

  it("uses the source sheet name when copying ids into a new sheet", () => {
    let workspace = createDefaultWorkspaceState();
    const sourceSheetId = workspace.activeSheetId;
    workspace = createSheetInWorkspace(workspace, { activate: false });
    const secondSheetId = workspace.sheetOrder[1];

    workspace = renameSheetInWorkspace(workspace, sourceSheetId, "Prio");

    const result = createSheetWithTrackingIdsInWorkspace(
      workspace,
      ["P2606001"],
      { sourceSheetId }
    );

    expect(result.workspaceState.sheetMetaById[result.sheetId]?.name).toBe("Prio - 1");
    expect(result.workspaceState.sheetOrder).toEqual([
      sourceSheetId,
      result.sheetId,
      secondSheetId,
    ]);
  });
});
