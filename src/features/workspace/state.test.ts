import { createDefaultWorkspaceState } from "./default-state";
import {
  appendTrackingIdsToExistingSheetInWorkspace,
  createSheetInWorkspace,
  createSheetWithTrackingIdsInWorkspace,
  deleteSheetInWorkspace,
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

    expect(duplicatedSheet.rows[0].trackingInput).toBe("P2603310114291");
    expect(duplicatedSheet.rows[0].loading).toBe(false);
    expect(duplicatedSheet.rows[0].error).toBe("");
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
});
