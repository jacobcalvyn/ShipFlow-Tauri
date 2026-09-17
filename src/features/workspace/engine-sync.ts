import {
  restoreWorkspace,
  type RestoreWorkspaceRequest,
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
  const sheets: RestoreWorkspaceRequest["sheets"] = workspaceState.sheetOrder.map(
    (sheetId, position) => {
      const sheet = workspaceState.sheetsById[sheetId];
      if (!sheet) throw new Error(`Missing document sheet: ${sheetId}`);
      return {
        sheetId,
        name: workspaceState.sheetMetaById[sheetId]?.name ?? `Sheet ${position + 1}`,
        position,
        rows: sheet.rows
          .map((row, rowPosition) => ({
            rowId: row.key,
            position: rowPosition,
            displayTrackingId: row.trackingInput.trim(),
            shipment: row.shipment,
            rowStatus: row.loading || row.queued || row.error
              ? "failed" as const
              : row.stale ? "stale" as const
              : row.shipment ? "loaded" as const : "empty" as const,
            errorMessage: row.error || (row.loading || row.queued
              ? "Tracking was interrupted. Retry this shipment."
              : null),
          }))
          .filter((row) => row.displayTrackingId !== ""),
      };
    }
  );
  await restoreWorkspace({ sheets, seedOnly: options.mode === "seed" });
}
