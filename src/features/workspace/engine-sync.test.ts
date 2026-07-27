import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultWorkspaceState } from "./default-state";
import {
  syncWorkspaceStateToEngine,
  WorkspaceEngineSyncCoordinator,
} from "./engine-sync";
import { updateActiveSheetInWorkspace } from "./actions";
import {
  createEngineSheet,
  deleteSheet,
  listEngineSheets,
  querySheetRows,
  upsertSheetRows,
} from "../workspace-engine/client";

vi.mock("../workspace-engine/client", () => ({
  createEngineSheet: vi.fn(),
  deleteSheet: vi.fn(),
  listEngineSheets: vi.fn(),
  querySheetRows: vi.fn(),
  upsertSheetRows: vi.fn(),
}));

const createEngineSheetMock = vi.mocked(createEngineSheet);
const deleteSheetMock = vi.mocked(deleteSheet);
const listEngineSheetsMock = vi.mocked(listEngineSheets);
const querySheetRowsMock = vi.mocked(querySheetRows);
const upsertSheetRowsMock = vi.mocked(upsertSheetRows);

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
    createEngineSheetMock.mockResolvedValue({ payload: null } as never);
    deleteSheetMock.mockResolvedValue({ payload: null } as never);
    listEngineSheetsMock.mockResolvedValue({
      payload: [],
    } as never);
    querySheetRowsMock.mockResolvedValue({
      payload: {
        sheetId: "default-sheet",
        offset: 0,
        limit: 1,
        totalCount: 0,
        hasMore: false,
        nextOffset: null,
        rows: [],
      },
    } as never);
    upsertSheetRowsMock.mockResolvedValue({ payload: null } as never);
  });

  it("syncs sheet metadata before replacing Rust rows", async () => {
    let workspace = createDefaultWorkspaceState();
    const sheetId = workspace.activeSheetId;
    workspace = {
      ...workspace,
      sheetMetaById: {
        ...workspace.sheetMetaById,
        [sheetId]: {
          ...workspace.sheetMetaById[sheetId],
          name: "Legacy Local",
        },
      },
    };
    workspace = updateActiveSheetInWorkspace(workspace, (sheet) => ({
      ...sheet,
      rows: sheet.rows.map((row, index) =>
        index === 0
          ? {
              ...row,
              key: "row-1",
              trackingInput: " P2606020189412.30 ",
            }
          : row
      ),
    }));

    await syncWorkspaceStateToEngine(workspace);

    expect(createEngineSheetMock).toHaveBeenCalledWith({
      sheetId,
      name: "Legacy Local",
      position: 0,
    });
    expect(upsertSheetRowsMock).toHaveBeenCalledWith({
      sheetId,
      replaceExisting: true,
      rows: [
        {
          rowId: "row-1",
          position: 0,
          displayTrackingId: "P2606020189412.30",
        },
      ],
    });
    expect(createEngineSheetMock.mock.invocationCallOrder[0]).toBeLessThan(
      upsertSheetRowsMock.mock.invocationCallOrder[0]
    );
  });

  it("does not clear durable Rust rows when seeding an empty local mirror", async () => {
    const workspace = createDefaultWorkspaceState();
    const sheetId = workspace.activeSheetId;

    await syncWorkspaceStateToEngine(workspace, { mode: "seed" });

    expect(createEngineSheetMock).toHaveBeenCalledWith({
      sheetId,
      name: "Sheet 1",
      position: 0,
    });
    expect(upsertSheetRowsMock).not.toHaveBeenCalled();
  });

  it("seeds local legacy rows only when the Rust sheet is empty", async () => {
    let workspace = createDefaultWorkspaceState();
    const sheetId = workspace.activeSheetId;
    workspace = updateActiveSheetInWorkspace(workspace, (sheet) => ({
      ...sheet,
      rows: sheet.rows.map((row, index) =>
        index === 0
          ? {
              ...row,
              key: "row-legacy",
              trackingInput: "PLEGACY1",
            }
          : row
      ),
    }));

    await syncWorkspaceStateToEngine(workspace, { mode: "seed" });

    expect(querySheetRowsMock).toHaveBeenCalledWith({
      sheetId,
      offset: 0,
      limit: 1,
      filters: [],
      valueFilters: [],
      sort: [],
    });
    expect(upsertSheetRowsMock).toHaveBeenCalledWith({
      sheetId,
      replaceExisting: true,
      rows: [
        {
          rowId: "row-legacy",
          position: 0,
          displayTrackingId: "PLEGACY1",
        },
      ],
    });
  });

  it("does not replace durable Rust rows when seed mode finds existing engine data", async () => {
    let workspace = createDefaultWorkspaceState();
    const sheetId = workspace.activeSheetId;
    workspace = updateActiveSheetInWorkspace(workspace, (sheet) => ({
      ...sheet,
      rows: sheet.rows.map((row, index) =>
        index === 0
          ? {
              ...row,
              key: "row-legacy",
              trackingInput: "PLEGACY1",
            }
          : row
      ),
    }));
    querySheetRowsMock.mockResolvedValueOnce({
      payload: {
        sheetId,
        offset: 0,
        limit: 1,
        totalCount: 1,
        hasMore: false,
        nextOffset: null,
        rows: [
          {
            rowId: "rust-row-1",
            position: 0,
            displayTrackingId: "RUST1",
            lookupTrackingId: "RUST1",
            rowStatus: "loaded",
            errorMessage: null,
            statusJson: null,
            detailJson: null,
            historyJson: null,
          },
        ],
      },
    } as never);

    await syncWorkspaceStateToEngine(workspace, { mode: "seed" });

    expect(querySheetRowsMock).toHaveBeenCalledWith({
      sheetId,
      offset: 0,
      limit: 1,
      filters: [],
      valueFilters: [],
      sort: [],
    });
    expect(upsertSheetRowsMock).not.toHaveBeenCalled();
  });

  it("deletes engine sheets absent from a replacement workspace", async () => {
    const workspace = createDefaultWorkspaceState();
    listEngineSheetsMock.mockResolvedValueOnce({
      payload: [
        {
          sheetId: workspace.activeSheetId,
          workspaceId: "default-workspace",
          name: "Sheet 1",
          position: 0,
          viewMode: "workspace",
        },
        {
          sheetId: "stale-sheet",
          workspaceId: "default-workspace",
          name: "Stale",
          position: 1,
          viewMode: "workspace",
        },
      ],
    } as never);

    await syncWorkspaceStateToEngine(workspace);

    expect(deleteSheetMock).toHaveBeenCalledTimes(1);
    expect(deleteSheetMock).toHaveBeenCalledWith({ sheetId: "stale-sheet" });
  });

  it("does not delete engine sheets while seeding a local mirror", async () => {
    const workspace = createDefaultWorkspaceState();

    await syncWorkspaceStateToEngine(workspace, { mode: "seed" });

    expect(listEngineSheetsMock).not.toHaveBeenCalled();
    expect(deleteSheetMock).not.toHaveBeenCalled();
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
