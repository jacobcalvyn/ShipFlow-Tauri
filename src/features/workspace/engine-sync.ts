import {
  createEngineSheet,
  deleteSheet,
  listEngineSheets,
  querySheetRows,
  upsertSheetRows,
} from "../workspace-engine/client";
import { WorkspaceState } from "./types";

export type WorkspaceEngineSyncMode = "replace" | "seed";

export type WorkspaceEngineSyncOptions = {
  mode?: WorkspaceEngineSyncMode;
};

type WorkspaceEngineSyncOperation = (
  workspaceState: WorkspaceState,
  options?: WorkspaceEngineSyncOptions
) => Promise<void>;

export class WorkspaceEngineSyncCoordinator {
  private queue: Promise<void> = Promise.resolve();
  private latestRequestId = 0;

  constructor(
    private readonly syncOperation: WorkspaceEngineSyncOperation =
      syncWorkspaceStateToEngine
  ) {}

  async run(
    workspaceState: WorkspaceState,
    options: WorkspaceEngineSyncOptions = {}
  ) {
    const requestId = this.latestRequestId + 1;
    this.latestRequestId = requestId;
    const operation = this.queue
      .catch(() => undefined)
      .then(() => this.syncOperation(workspaceState, options));
    this.queue = operation.then(
      () => undefined,
      () => undefined
    );
    await operation;
    return requestId === this.latestRequestId;
  }
}

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

    await upsertSheetRows({
      sheetId,
      replaceExisting: true,
      rows,
    });
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
