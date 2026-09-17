import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultWorkspaceState } from "./default-state";
import { syncWorkspaceStateToEngine, WorkspaceEngineSyncCoordinator } from "./engine-sync";
import { restoreWorkspace } from "../workspace-engine/client";
import { createTrackResponseFromProjection } from "../sheet/rust-row-window-adapter";
vi.mock("../workspace-engine/client", () => ({ restoreWorkspace: vi.fn() }));
const restoreMock = vi.mocked(restoreWorkspace);
function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("workspace engine sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restoreMock.mockResolvedValue({ type: "sheets", payload: [] });
  });

  it("restores all document sheets and full tracking payloads in one atomic request", async () => {
    const workspace = createDefaultWorkspaceState();
    const sheetId = workspace.activeSheetId;
    const row = workspace.sheetsById[sheetId].rows[0];
    row.trackingInput = " P1.2 ";
    row.shipment = createTrackResponseFromProjection({
      rowId: row.key,
      position: 0,
      displayTrackingId: "P1.2",
      lookupTrackingId: "P1",
      rowStatus: "loaded",
      errorMessage: null,
      statusJson: { status: "DELIVERED" },
      detailJson: { shipment_header: { nomor_kiriman: "P1" } },
      historyJson: {
        url: "https://example.test/P1",
        history: [{ status: "DELIVERED" }],
        pod: { foto: "proof" },
      },
    });
    await syncWorkspaceStateToEngine(workspace);
    expect(restoreMock).toHaveBeenCalledTimes(1);
    expect(restoreMock).toHaveBeenCalledWith({
      seedOnly: false,
      sheets: [{
        sheetId,
        name: "Sheet 1",
        position: 0,
        rows: [{
          rowId: row.key,
          position: 0,
          displayTrackingId: "P1.2",
          shipment: row.shipment,
          rowStatus: "loaded",
          errorMessage: null,
        }],
      }],
    });
    expect(restoreMock.mock.calls[0][0].sheets[0].rows[0].shipment?.url).toBe(
      "https://example.test/P1"
    );
  });

  it("delegates empty-mirror seeding to the engine without replacing durable rows", async () => {
    const workspace = createDefaultWorkspaceState();
    await syncWorkspaceStateToEngine(workspace, { mode: "seed" });
    expect(restoreMock).toHaveBeenCalledWith({
      seedOnly: true,
      sheets: [{ sheetId: workspace.activeSheetId, name: "Sheet 1", position: 0, rows: [] }],
    });
  });

  it("preserves sparse positions when seeding legacy rows", async () => {
    const workspace = createDefaultWorkspaceState();
    const row = workspace.sheetsById[workspace.activeSheetId].rows[2];
    row.trackingInput = "P2";
    await syncWorkspaceStateToEngine(workspace, { mode: "seed" });
    expect(restoreMock.mock.calls[0][0]).toMatchObject({
      seedOnly: true,
      sheets: [{ rows: [{ rowId: row.key, position: 2, displayTrackingId: "P2" }] }],
    });
  });

  it("preserves terminal errors and marks interrupted tracking as retryable", async () => {
    const workspace = createDefaultWorkspaceState();
    const rows = workspace.sheetsById[workspace.activeSheetId].rows;
    Object.assign(rows[0], { trackingInput: "P1", loading: true });
    Object.assign(rows[1], { trackingInput: "P2", error: "Not found" });
    await syncWorkspaceStateToEngine(workspace);
    expect(restoreMock.mock.calls[0][0].sheets[0].rows).toEqual([
      expect.objectContaining({
        rowStatus: "failed",
        errorMessage: "Tracking was interrupted. Retry this shipment.",
      }),
      expect.objectContaining({ rowStatus: "failed", errorMessage: "Not found" }),
    ]);
  });

  it("rejects a missing document sheet before any engine mutation", async () => {
    const workspace = createDefaultWorkspaceState();
    workspace.sheetOrder.push("missing");
    await expect(syncWorkspaceStateToEngine(workspace)).rejects.toThrow("Missing document sheet");
    expect(restoreMock).not.toHaveBeenCalled();
  });

  it("propagates an atomic restore failure to the document controller", async () => {
    restoreMock.mockRejectedValueOnce(new Error("Invalid document row"));
    await expect(syncWorkspaceStateToEngine(createDefaultWorkspaceState())).rejects.toThrow(
      "Invalid document row"
    );
  });

  it("serializes document syncs and only commits the latest request", async () => {
    const firstWorkspace = createDefaultWorkspaceState();
    const secondWorkspace = {
      ...createDefaultWorkspaceState(),
      workspaceId: "replacement-workspace",
    };
    const firstSync = createDeferred<void>();
    const secondSync = createDeferred<void>();
    const syncOperation = vi
      .fn()
      .mockReturnValueOnce(firstSync.promise)
      .mockReturnValueOnce(secondSync.promise);
    const coordinator = new WorkspaceEngineSyncCoordinator(syncOperation);

    const firstResult = coordinator.run(firstWorkspace);
    const secondResult = coordinator.run(secondWorkspace);

    await vi.waitFor(() => expect(syncOperation).toHaveBeenCalledTimes(1));
    expect(syncOperation).toHaveBeenNthCalledWith(1, firstWorkspace, {});

    firstSync.resolve(undefined);
    await expect(firstResult).resolves.toBe(false);
    await vi.waitFor(() => expect(syncOperation).toHaveBeenCalledTimes(2));
    expect(syncOperation).toHaveBeenNthCalledWith(2, secondWorkspace, {});

    secondSync.resolve(undefined);
    await expect(secondResult).resolves.toBe(true);
  });
});
