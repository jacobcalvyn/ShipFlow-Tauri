import {
  clearSheetRows,
  createEngineSheet,
  deleteSheet,
  listEngineSheets,
  querySheetRows,
  upsertSheetRows,
} from "../workspace-engine/client";
import { WorkspaceState } from "./types";

export type WorkspaceEngineSyncMode = "replace" | "seed";

type WorkspaceEngineSyncOptions = {
  mode?: WorkspaceEngineSyncMode;
};

export async function syncWorkspaceStateToEngine(
  workspaceState: WorkspaceState,
  options: WorkspaceEngineSyncOptions = {}
) {
  const mode = options.mode ?? "replace";
  const desiredSheetIds = new Set(workspaceState.sheetOrder);

  for (const [position, sheetId] of workspaceState.sheetOrder.entries()) {
    const sheet = workspaceState.sheetsById[sheetId];
    if (!sheet) {
      continue;
    }

    await createEngineSheet({
      sheetId,
      name: workspaceState.sheetMetaById[sheetId]?.name ?? `Sheet ${position + 1}`,
      position,
    });

    const rows = sheet.rows
      .map((row, rowPosition) => ({
        rowId: row.key,
        position: rowPosition,
        displayTrackingId: row.trackingInput.trim(),
      }))
      .filter((row) => row.displayTrackingId !== "");

    if (mode === "seed" && rows.length === 0) {
      continue;
    }

    if (mode === "seed") {
      const existingRows = await querySheetRows({
        sheetId,
        offset: 0,
        limit: 1,
        filters: [],
        valueFilters: [],
        sort: [],
      });

      if (existingRows.payload.totalCount > 0) {
        continue;
      }
    }

    await clearSheetRows({ sheetId });

    if (rows.length > 0) {
      await upsertSheetRows({ sheetId, rows });
    }
  }

  if (mode === "replace") {
    const response = await listEngineSheets();
    for (const engineSheet of response.payload) {
      if (!desiredSheetIds.has(engineSheet.sheetId)) {
        await deleteSheet({ sheetId: engineSheet.sheetId });
      }
    }
  }
}
