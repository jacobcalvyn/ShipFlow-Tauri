import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SheetState } from "../sheet/types";
import { createDefaultSheetState } from "../sheet/default-state";
import type {
  ImportJobDetail,
  ImportSourcePreviewResult,
  WorkspaceEngineEvent,
} from "../workspace-engine/client";
import type { WorkspaceState } from "./types";
import {
  applyWorkspaceEngineImportJobDetail,
  getImportJobSheetRowIds,
  useWorkspaceInteractionRuntimeController,
} from "./useWorkspaceInteractionRuntimeController";

const mocks = vi.hoisted(() => ({
  createImportJobMock: vi.fn(),
  clearSheetRowsMock: vi.fn(),
  getImportJobMock: vi.fn(),
  previewImportSourceMock: vi.fn(),
  querySheetRowsMock: vi.fn(),
  refreshSheetRowsTrackingMock: vi.fn(),
  retryImportJobFailedWithProgressMock: vi.fn(),
  runImportJobWithProgressMock: vi.fn(),
  upsertSheetRowsMock: vi.fn(),
  useWorkspaceRuntimeCommandsControllerMock: vi.fn(),
  useWorkspaceTableControllersMock: vi.fn(),
}));

vi.mock("../workspace-engine/client", async () => {
  const actual = await vi.importActual<object>("../workspace-engine/client");
  return {
    ...actual,
    createImportJob: mocks.createImportJobMock,
    clearSheetRows: mocks.clearSheetRowsMock,
    getImportJob: mocks.getImportJobMock,
    previewImportSource: mocks.previewImportSourceMock,
    querySheetRows: mocks.querySheetRowsMock,
    refreshSheetRowsTracking: mocks.refreshSheetRowsTrackingMock,
    refreshSheetRowsTrackingWithProgress: mocks.refreshSheetRowsTrackingMock,
    retryImportJobFailedWithProgress:
      mocks.retryImportJobFailedWithProgressMock,
    runImportJobWithProgress: mocks.runImportJobWithProgressMock,
    upsertSheetRows: mocks.upsertSheetRowsMock,
  };
});

vi.mock("./useWorkspaceRuntimeCommandsController", () => ({
  useWorkspaceRuntimeCommandsController:
    mocks.useWorkspaceRuntimeCommandsControllerMock,
}));

vi.mock("./useWorkspaceTableControllers", () => ({
  useWorkspaceTableControllers: mocks.useWorkspaceTableControllersMock,
}));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

function createPreviewResponse(payload: ImportSourcePreviewResult) {
  return {
    type: "import_source_preview" as const,
    payload,
  };
}

describe("useWorkspaceInteractionRuntimeController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("collects import refresh targets from Rust job item row ids", () => {
    const detail = {
      summary: {
        jobId: "job-1",
        sheetId: "sheet-1",
        kind: "bag",
        mode: "append",
        status: "completed",
        totalCount: 3,
        successCount: 2,
        failedCount: 1,
        pendingCount: 0,
      },
      items: [
        {
          itemId: "job-1:item:0",
          sourceItemId: "PID-A",
          sourceItemKind: "bag",
          position: 0,
          status: "succeeded",
          trackingIds: ["P1", "P2"],
          sheetRowIds: ["sheet-1:row:0", "sheet-1:row:1"],
          errorMessage: null,
          attemptCount: 1,
        },
        {
          itemId: "job-1:item:1",
          sourceItemId: "PID-B",
          sourceItemKind: "bag",
          position: 1,
          status: "succeeded",
          trackingIds: ["P2", "P3"],
          sheetRowIds: ["sheet-1:row:1", "sheet-1:row:2"],
          errorMessage: null,
          attemptCount: 1,
        },
        {
          itemId: "job-1:item:2",
          sourceItemId: "PID-C",
          sourceItemKind: "bag",
          position: 2,
          status: "failed",
          trackingIds: ["SHOULD-NOT-REFRESH"],
          sheetRowIds: ["sheet-1:row:99"],
          errorMessage: "upstream failed",
          attemptCount: 1,
        },
      ],
    } as ImportJobDetail;

    expect(getImportJobSheetRowIds(detail)).toEqual([
      "sheet-1:row:0",
      "sheet-1:row:1",
      "sheet-1:row:2",
    ]);
  });

  it("reconstructs bag import modal state from Rust job detail without stale ids", () => {
    const sheetState = {
      importSourceLookupStates: {
        bag: {
          loading: false,
          rawResponse: "legacy-preview",
          error: "stale error",
          trackingIds: ["STALE-ID"],
          jobId: "old-job",
          requestKey: "bag:commit:1",
          sourceItemStates: [
            {
              itemId: "STALE-BAG",
              loading: false,
              error: "",
              trackingIds: ["STALE-ID"],
            },
          ],
        },
        manifest: {
          loading: false,
          rawResponse: "",
          error: "",
          trackingIds: [],
        },
      },
    } as unknown as SheetState;
    const detail: ImportJobDetail = {
      summary: {
        jobId: "job-1",
        sheetId: "sheet-1",
        kind: "bag",
        mode: "append",
        status: "completed",
        totalCount: 2,
        successCount: 1,
        failedCount: 1,
        pendingCount: 0,
      },
      items: [
        {
          itemId: "job-1:item:0",
          sourceItemId: "PID-OK",
          sourceItemKind: "bag",
          position: 0,
          status: "succeeded",
          trackingIds: ["P1", "P2"],
          sheetRowIds: ["sheet-1:row:0", "sheet-1:row:1"],
          errorMessage: null,
          attemptCount: 1,
        },
        {
          itemId: "job-1:item:1",
          sourceItemId: "PID-FAILED",
          sourceItemKind: "bag",
          position: 1,
          status: "failed",
          trackingIds: [],
          sheetRowIds: [],
          errorMessage: "upstream timeout",
          attemptCount: 1,
        },
      ],
    };

    const next = applyWorkspaceEngineImportJobDetail(
      sheetState,
      "bag",
      "bag:commit:1",
      detail
    );

    expect(next.importSourceLookupStates.bag).toMatchObject({
      loading: false,
      error: "",
      trackingIds: ["P1", "P2"],
      jobId: "job-1",
      sourceItemStates: [
        {
          itemId: "PID-OK",
          loading: false,
          error: "",
          trackingIds: ["P1", "P2"],
        },
        {
          itemId: "PID-FAILED",
          loading: false,
          error: "upstream timeout",
          trackingIds: [],
        },
      ],
      manifestBagStates: [],
    });
  });

  it("reconstructs manifest import modal bag rows from Rust job detail", () => {
    const sheetState = {
      importSourceLookupStates: {
        bag: {
          loading: false,
          rawResponse: "",
          error: "",
          trackingIds: [],
        },
        manifest: {
          loading: false,
          rawResponse: "legacy-preview",
          error: "",
          trackingIds: ["STALE-ID"],
          requestKey: "manifest:commit:1",
          sourceItemStates: [
            {
              itemId: "STALE-MANIFEST",
              loading: false,
              error: "",
              trackingIds: ["STALE-BAG"],
            },
          ],
          manifestBagStates: [
            {
              bagId: "STALE-BAG",
              loading: false,
              error: "",
              trackingIds: ["STALE-ID"],
            },
          ],
        },
      },
    } as unknown as SheetState;
    const detail: ImportJobDetail = {
      summary: {
        jobId: "job-2",
        sheetId: "sheet-1",
        kind: "manifest",
        mode: "replace",
        status: "completed",
        totalCount: 3,
        successCount: 2,
        failedCount: 1,
        pendingCount: 0,
      },
      items: [
        {
          itemId: "job-2:manifest:0",
          sourceItemId: "MNF-OK",
          sourceItemKind: "manifest",
          position: 0,
          status: "succeeded",
          trackingIds: ["PID-OK"],
          sheetRowIds: [],
          errorMessage: null,
          attemptCount: 1,
        },
        {
          itemId: "job-2:bag:1",
          sourceItemId: "PID-OK",
          sourceItemKind: "manifest_bag",
          position: 1,
          status: "succeeded",
          trackingIds: ["P1", "P2"],
          sheetRowIds: ["sheet-1:row:0", "sheet-1:row:1"],
          errorMessage: null,
          attemptCount: 1,
        },
        {
          itemId: "job-2:bag:2",
          sourceItemId: "PID-FAILED",
          sourceItemKind: "manifest_bag",
          position: 2,
          status: "failed",
          trackingIds: [],
          sheetRowIds: [],
          errorMessage: "bag timeout",
          attemptCount: 2,
        },
      ],
    };

    const next = applyWorkspaceEngineImportJobDetail(
      sheetState,
      "manifest",
      "manifest:commit:1",
      detail
    );

    expect(next.importSourceLookupStates.manifest).toMatchObject({
      loading: false,
      error: "",
      trackingIds: ["P1", "P2"],
      jobId: "job-2",
      sourceItemStates: [
        {
          itemId: "MNF-OK",
          loading: false,
          error: "",
          trackingIds: ["PID-OK"],
        },
      ],
      manifestBagStates: [
        {
          bagId: "PID-OK",
          loading: false,
          error: "",
          trackingIds: ["P1", "P2"],
        },
        {
          bagId: "PID-FAILED",
          loading: false,
          error: "bag timeout",
          trackingIds: [],
        },
      ],
    });
  });

  it("updates bag import preview state as each source id finishes", async () => {
    const sheetState: SheetState = {
      ...createDefaultSheetState(),
      importSourceDrafts: {
        bag: "PID-A\nPID-B",
        manifest: "",
      },
    };
    const workspaceRef: { current: WorkspaceState } = {
      current: {
        version: 1,
        activeSheetId: "sheet-1",
        sheetOrder: ["sheet-1"],
        sheetMetaById: {
          "sheet-1": {
            name: "Sheet 1",
            color: "blue",
            icon: "sheet",
          },
        },
        sheetsById: {
          "sheet-1": sheetState,
        },
      },
    };
    const updateSheet = vi.fn(
      (sheetId: string, updater: (sheet: SheetState) => SheetState) => {
        const currentSheet = workspaceRef.current.sheetsById[sheetId];
        workspaceRef.current = {
          ...workspaceRef.current,
          sheetsById: {
            ...workspaceRef.current.sheetsById,
            [sheetId]: updater(currentSheet),
          },
        };
      }
    );
    type PreviewResponse = ReturnType<typeof createPreviewResponse>;
    const previewRequests = new Map<
      string,
      ReturnType<typeof createDeferred<PreviewResponse>>
    >();
    mocks.previewImportSourceMock.mockImplementation(
      ({ ids }: { ids: string[] }) => {
        const deferred = createDeferred<ReturnType<typeof createPreviewResponse>>();
        previewRequests.set(ids[0], deferred);
        return deferred.promise;
      }
    );
    mocks.useWorkspaceRuntimeCommandsControllerMock.mockReturnValue({
      fetchRow: vi.fn(),
      copySelectedTrackingIds: vi.fn(),
      invalidateSheetTrackingWork: vi.fn(),
    });
    mocks.useWorkspaceTableControllersMock.mockReturnValue({});

    const { result } = renderHook(() =>
      useWorkspaceInteractionRuntimeController({
        activeSheet: sheetState,
        activeSheetId: "sheet-1",
        workspaceTabs: [{ id: "sheet-1", name: "Sheet 1" }],
        workspaceRef,
        setWorkspaceState: vi.fn(),
        updateActiveSheet: vi.fn(),
        updateSheet,
        setHoveredColumn: vi.fn(),
        deleteAllTimeoutRef: { current: null },
        deleteAllArmedSheetIdRef: { current: null },
        deleteSelectedTimeoutRef: { current: null },
        deleteSelectedArmedSheetIdRef: { current: null },
        deleteSelectedArmedSheetId: null,
        setDeleteSelectedArmedSheetId: vi.fn(),
        armDeleteAll: vi.fn(),
        disarmDeleteAll: vi.fn(),
        armDeleteSelected: vi.fn(),
        disarmDeleteSelected: vi.fn(),
        resizeStateRef: { current: null },
        sheetScrollRef: { current: null },
        sheetScrollPositionsRef: { current: new Map() },
        columnMenuRefs: { current: new Map() },
        highlightedColumnTimeoutRef: { current: null },
        highlightedColumnSheetIdRef: { current: null },
        activeFilterCount: 0,
        allTrackingIds: [],
        exportableTableRows: [],
        rustExportRowsQuery: null,
        retrackableRows: [],
        retryFailedEntries: [],
        selectedEngineRowIds: [],
        selectedTrackingIds: [],
        selectedVisibleRowKeys: [],
        visibleColumns: [],
        visibleColumnPathSet: new Set(),
        visibleSelectableKeys: [],
        effectiveColumnWidths: {},
        pinnedColumnSet: new Set(),
        allVisibleSelected: false,
        showNotice: vi.fn(),
        onWorkspaceEngineMutation: vi.fn(),
      } as never)
    );

    const lookupPromise = result.current.runImportSourceLookup("bag");

    await waitFor(() => {
      expect(previewRequests.has("PID-A")).toBe(true);
      expect(previewRequests.has("PID-B")).toBe(true);
    });

    act(() => {
      previewRequests.get("PID-A")?.resolve(
        createPreviewResponse({
          kind: "bag",
          sourceItems: [
            {
              sourceItemId: "PID-A",
              sourceItemKind: "bag",
              status: "succeeded",
              trackingIds: ["P1"],
              sheetRowIds: [],
              errorMessage: null,
            },
          ],
          manifestBags: [],
          trackingIds: ["P1"],
          rawResponse: JSON.stringify({ nomor_kantung: "PID-A" }),
        })
      );
    });

    await waitFor(() => {
      const state =
        workspaceRef.current.sheetsById["sheet-1"].importSourceLookupStates.bag;
      expect(state.loading).toBe(true);
      expect(state.trackingIds).toEqual(["P1"]);
      expect(state.sourceItemStates).toEqual([
        {
          itemId: "PID-A",
          loading: false,
          error: "",
          trackingIds: ["P1"],
        },
        {
          itemId: "PID-B",
          loading: true,
          error: "",
          trackingIds: [],
        },
      ]);
    });

    act(() => {
      previewRequests.get("PID-B")?.resolve(
        createPreviewResponse({
          kind: "bag",
          sourceItems: [
            {
              sourceItemId: "PID-B",
              sourceItemKind: "bag",
              status: "succeeded",
              trackingIds: ["P2"],
              sheetRowIds: [],
              errorMessage: null,
            },
          ],
          manifestBags: [],
          trackingIds: ["P2"],
          rawResponse: JSON.stringify({ nomor_kantung: "PID-B" }),
        })
      );
    });

    await lookupPromise;

    expect(
      workspaceRef.current.sheetsById["sheet-1"].importSourceLookupStates.bag
    ).toMatchObject({
      loading: false,
      trackingIds: ["P1", "P2"],
      sourceItemStates: [
        {
          itemId: "PID-A",
          loading: false,
          error: "",
          trackingIds: ["P1"],
        },
        {
          itemId: "PID-B",
          loading: false,
          error: "",
          trackingIds: ["P2"],
        },
      ],
    });
    expect(mocks.previewImportSourceMock).toHaveBeenCalledWith({
      kind: "bag",
      ids: ["PID-A"],
    });
    expect(mocks.previewImportSourceMock).toHaveBeenCalledWith({
      kind: "bag",
      ids: ["PID-B"],
    });
  });

  it("marks a stuck bag import preview source as timed out", async () => {
    vi.useFakeTimers();

    const sheetState: SheetState = {
      ...createDefaultSheetState(),
      importSourceDrafts: {
        bag: "PID-SLOW",
        manifest: "",
      },
    };
    const workspaceRef: { current: WorkspaceState } = {
      current: {
        version: 1,
        activeSheetId: "sheet-1",
        sheetOrder: ["sheet-1"],
        sheetMetaById: {
          "sheet-1": {
            name: "Sheet 1",
            color: "blue",
            icon: "sheet",
          },
        },
        sheetsById: {
          "sheet-1": sheetState,
        },
      },
    };
    const updateSheet = vi.fn(
      (sheetId: string, updater: (sheet: SheetState) => SheetState) => {
        const currentSheet = workspaceRef.current.sheetsById[sheetId];
        workspaceRef.current = {
          ...workspaceRef.current,
          sheetsById: {
            ...workspaceRef.current.sheetsById,
            [sheetId]: updater(currentSheet),
          },
        };
      }
    );
    mocks.previewImportSourceMock.mockReturnValue(new Promise(() => {}));
    mocks.useWorkspaceRuntimeCommandsControllerMock.mockReturnValue({
      fetchRow: vi.fn(),
      copySelectedTrackingIds: vi.fn(),
      invalidateSheetTrackingWork: vi.fn(),
    });
    mocks.useWorkspaceTableControllersMock.mockReturnValue({});

    const { result } = renderHook(() =>
      useWorkspaceInteractionRuntimeController({
        activeSheet: sheetState,
        activeSheetId: "sheet-1",
        workspaceTabs: [{ id: "sheet-1", name: "Sheet 1" }],
        workspaceRef,
        setWorkspaceState: vi.fn(),
        updateActiveSheet: vi.fn(),
        updateSheet,
        setHoveredColumn: vi.fn(),
        deleteAllTimeoutRef: { current: null },
        deleteAllArmedSheetIdRef: { current: null },
        deleteSelectedTimeoutRef: { current: null },
        deleteSelectedArmedSheetIdRef: { current: null },
        deleteSelectedArmedSheetId: null,
        setDeleteSelectedArmedSheetId: vi.fn(),
        armDeleteAll: vi.fn(),
        disarmDeleteAll: vi.fn(),
        armDeleteSelected: vi.fn(),
        disarmDeleteSelected: vi.fn(),
        resizeStateRef: { current: null },
        sheetScrollRef: { current: null },
        sheetScrollPositionsRef: { current: new Map() },
        columnMenuRefs: { current: new Map() },
        highlightedColumnTimeoutRef: { current: null },
        highlightedColumnSheetIdRef: { current: null },
        activeFilterCount: 0,
        allTrackingIds: [],
        exportableTableRows: [],
        rustExportRowsQuery: null,
        retrackableRows: [],
        retryFailedEntries: [],
        selectedEngineRowIds: [],
        selectedTrackingIds: [],
        selectedVisibleRowKeys: [],
        visibleColumns: [],
        visibleColumnPathSet: new Set(),
        visibleSelectableKeys: [],
        effectiveColumnWidths: {},
        pinnedColumnSet: new Set(),
        allVisibleSelected: false,
        showNotice: vi.fn(),
        onWorkspaceEngineMutation: vi.fn(),
      } as never)
    );

    const lookupPromise = result.current.runImportSourceLookup("bag");
    expect(mocks.previewImportSourceMock).toHaveBeenCalledWith({
      kind: "bag",
      ids: ["PID-SLOW"],
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await lookupPromise;
    });

    const state =
      workspaceRef.current.sheetsById["sheet-1"].importSourceLookupStates.bag;
    expect(state.loading).toBe(false);
    expect(state.trackingIds).toEqual([]);
    expect(state.sourceItemStates).toEqual([
      {
        itemId: "PID-SLOW",
        loading: false,
        error: "Timeout ambil data setelah 30 detik.",
        trackingIds: [],
      },
    ]);
    expect(state.error).toContain("PID-SLOW: Timeout ambil data");
  });

  it("updates manifest import preview source and bag states incrementally", async () => {
    const sheetState: SheetState = {
      ...createDefaultSheetState(),
      importSourceDrafts: {
        bag: "",
        manifest: "MNF-A\nMNF-B",
      },
    };
    const workspaceRef: { current: WorkspaceState } = {
      current: {
        version: 1,
        activeSheetId: "sheet-1",
        sheetOrder: ["sheet-1"],
        sheetMetaById: {
          "sheet-1": {
            name: "Sheet 1",
            color: "blue",
            icon: "sheet",
          },
        },
        sheetsById: {
          "sheet-1": sheetState,
        },
      },
    };
    const updateSheet = vi.fn(
      (sheetId: string, updater: (sheet: SheetState) => SheetState) => {
        const currentSheet = workspaceRef.current.sheetsById[sheetId];
        workspaceRef.current = {
          ...workspaceRef.current,
          sheetsById: {
            ...workspaceRef.current.sheetsById,
            [sheetId]: updater(currentSheet),
          },
        };
      }
    );
    type PreviewResponse = ReturnType<typeof createPreviewResponse>;
    const previewRequests = new Map<
      string,
      ReturnType<typeof createDeferred<PreviewResponse>>
    >();
    mocks.previewImportSourceMock.mockImplementation(
      ({ ids }: { ids: string[] }) => {
        const deferred = createDeferred<PreviewResponse>();
        previewRequests.set(ids[0], deferred);
        return deferred.promise;
      }
    );
    mocks.useWorkspaceRuntimeCommandsControllerMock.mockReturnValue({
      fetchRow: vi.fn(),
      copySelectedTrackingIds: vi.fn(),
      invalidateSheetTrackingWork: vi.fn(),
    });
    mocks.useWorkspaceTableControllersMock.mockReturnValue({});

    const { result } = renderHook(() =>
      useWorkspaceInteractionRuntimeController({
        activeSheet: sheetState,
        activeSheetId: "sheet-1",
        workspaceTabs: [{ id: "sheet-1", name: "Sheet 1" }],
        workspaceRef,
        setWorkspaceState: vi.fn(),
        updateActiveSheet: vi.fn(),
        updateSheet,
        setHoveredColumn: vi.fn(),
        deleteAllTimeoutRef: { current: null },
        deleteAllArmedSheetIdRef: { current: null },
        deleteSelectedTimeoutRef: { current: null },
        deleteSelectedArmedSheetIdRef: { current: null },
        deleteSelectedArmedSheetId: null,
        setDeleteSelectedArmedSheetId: vi.fn(),
        armDeleteAll: vi.fn(),
        disarmDeleteAll: vi.fn(),
        armDeleteSelected: vi.fn(),
        disarmDeleteSelected: vi.fn(),
        resizeStateRef: { current: null },
        sheetScrollRef: { current: null },
        sheetScrollPositionsRef: { current: new Map() },
        columnMenuRefs: { current: new Map() },
        highlightedColumnTimeoutRef: { current: null },
        highlightedColumnSheetIdRef: { current: null },
        activeFilterCount: 0,
        allTrackingIds: [],
        exportableTableRows: [],
        rustExportRowsQuery: null,
        retrackableRows: [],
        retryFailedEntries: [],
        selectedEngineRowIds: [],
        selectedTrackingIds: [],
        selectedVisibleRowKeys: [],
        visibleColumns: [],
        visibleColumnPathSet: new Set(),
        visibleSelectableKeys: [],
        effectiveColumnWidths: {},
        pinnedColumnSet: new Set(),
        allVisibleSelected: false,
        showNotice: vi.fn(),
        onWorkspaceEngineMutation: vi.fn(),
      } as never)
    );

    const lookupPromise = result.current.runImportSourceLookup("manifest");

    await waitFor(() => {
      expect(previewRequests.has("MNF-A")).toBe(true);
      expect(previewRequests.has("MNF-B")).toBe(true);
    });

    act(() => {
      previewRequests.get("MNF-A")?.resolve(
        createPreviewResponse({
          kind: "manifest",
          sourceItems: [
            {
              sourceItemId: "MNF-A",
              sourceItemKind: "manifest",
              status: "succeeded",
              trackingIds: ["PID-A"],
              sheetRowIds: [],
              errorMessage: null,
            },
          ],
          manifestBags: [
            {
              sourceItemId: "PID-A",
              sourceItemKind: "manifest_bag",
              status: "succeeded",
              trackingIds: ["P1"],
              sheetRowIds: [],
              errorMessage: null,
            },
          ],
          trackingIds: ["P1"],
          rawResponse: JSON.stringify({ manifest: "MNF-A" }),
        })
      );
    });

    await waitFor(() => {
      const state =
        workspaceRef.current.sheetsById["sheet-1"].importSourceLookupStates
          .manifest;
      expect(state.loading).toBe(true);
      expect(state.trackingIds).toEqual(["P1"]);
      expect(state.sourceItemStates).toEqual([
        {
          itemId: "MNF-A",
          loading: false,
          error: "",
          trackingIds: ["PID-A"],
        },
        {
          itemId: "MNF-B",
          loading: true,
          error: "",
          trackingIds: [],
        },
      ]);
      expect(state.manifestBagStates).toEqual([
        {
          bagId: "PID-A",
          loading: false,
          error: "",
          trackingIds: ["P1"],
        },
      ]);
    });

    act(() => {
      previewRequests.get("MNF-B")?.resolve(
        createPreviewResponse({
          kind: "manifest",
          sourceItems: [
            {
              sourceItemId: "MNF-B",
              sourceItemKind: "manifest",
              status: "succeeded",
              trackingIds: ["PID-B"],
              sheetRowIds: [],
              errorMessage: null,
            },
          ],
          manifestBags: [
            {
              sourceItemId: "PID-B",
              sourceItemKind: "manifest_bag",
              status: "succeeded",
              trackingIds: ["P2"],
              sheetRowIds: [],
              errorMessage: null,
            },
          ],
          trackingIds: ["P2"],
          rawResponse: JSON.stringify({ manifest: "MNF-B" }),
        })
      );
    });

    await lookupPromise;

    expect(
      workspaceRef.current.sheetsById["sheet-1"].importSourceLookupStates
        .manifest
    ).toMatchObject({
      loading: false,
      trackingIds: ["P1", "P2"],
      sourceItemStates: [
        {
          itemId: "MNF-A",
          loading: false,
          error: "",
          trackingIds: ["PID-A"],
        },
        {
          itemId: "MNF-B",
          loading: false,
          error: "",
          trackingIds: ["PID-B"],
        },
      ],
      manifestBagStates: [
        {
          bagId: "PID-A",
          loading: false,
          error: "",
          trackingIds: ["P1"],
        },
        {
          bagId: "PID-B",
          loading: false,
          error: "",
          trackingIds: ["P2"],
        },
      ],
    });
  });

  it("retries a committed import through the Rust failed-only job channel", async () => {
    const sheetState = {
      deleteAllArmed: false,
      openColumnMenuPath: null,
      selectionFollowsVisibleRows: false,
      hiddenColumnPaths: [],
      pinnedColumnPaths: [],
      importSourceDrafts: {
        bag: "PID-FAILED",
        manifest: "",
      },
      importSourceLookupStates: {
        bag: {
          loading: false,
          rawResponse: "",
          error: "",
          trackingIds: ["P1"],
          jobId: "job-1",
          requestKey: "bag:commit:1",
          sourceItemStates: [
            {
              itemId: "PID-OK",
              loading: false,
              error: "",
              trackingIds: ["P1"],
            },
            {
              itemId: "PID-FAILED",
              loading: false,
              error: "upstream timeout",
              trackingIds: [],
            },
          ],
          manifestBagStates: [],
        },
        manifest: {
          loading: false,
          rawResponse: "",
          error: "",
          trackingIds: [],
        },
      },
    } as unknown as SheetState;
    const workspaceRef: { current: WorkspaceState } = {
      current: {
        version: 1,
        activeSheetId: "sheet-1",
        sheetOrder: ["sheet-1"],
        sheetMetaById: {
          "sheet-1": {
            name: "Sheet 1",
            color: "blue",
            icon: "sheet",
          },
        },
        sheetsById: {
          "sheet-1": sheetState,
        },
      },
    };
    const updateSheet = vi.fn(
      (sheetId: string, updater: (sheet: SheetState) => SheetState) => {
        const currentSheet = workspaceRef.current.sheetsById[sheetId];
        workspaceRef.current = {
          ...workspaceRef.current,
          sheetsById: {
            ...workspaceRef.current.sheetsById,
            [sheetId]: updater(currentSheet),
          },
        };
      }
    );
    const completed: ImportJobDetail = {
      summary: {
        jobId: "job-1",
        sheetId: "sheet-1",
        kind: "bag",
        mode: "append",
        status: "completed",
        totalCount: 2,
        successCount: 2,
        failedCount: 0,
        pendingCount: 0,
      },
      items: [
        {
          itemId: "job-1:item:0",
          sourceItemId: "PID-OK",
          sourceItemKind: "bag",
          position: 0,
          status: "succeeded",
          trackingIds: ["P1"],
          sheetRowIds: ["sheet-1:row:0"],
          errorMessage: null,
          attemptCount: 1,
        },
        {
          itemId: "job-1:item:1",
          sourceItemId: "PID-FAILED",
          sourceItemKind: "bag",
          position: 1,
          status: "succeeded",
          trackingIds: ["P2"],
          sheetRowIds: ["sheet-1:row:1"],
          errorMessage: null,
          attemptCount: 2,
        },
      ],
    };
    mocks.retryImportJobFailedWithProgressMock.mockImplementation(
      async (_jobId: string, onEvent: (event: WorkspaceEngineEvent) => void) => {
        onEvent({
          type: "import_job_progress",
          payload: {
            jobId: "job-1",
            sheetId: "sheet-1",
            kind: "bag",
            mode: "append",
            status: "completed",
            totalCount: 2,
            successCount: 2,
            failedCount: 0,
            pendingCount: 0,
            itemDeltas: [
              {
                itemId: "job-1:item:1",
                sourceItemId: "PID-FAILED",
                sourceItemKind: "bag",
                status: "succeeded",
                trackingIds: ["P2"],
                sheetRowIds: ["sheet-1:row:1"],
                errorMessage: null,
              },
            ],
          },
        });

        return {
          type: "import_job_detail",
          payload: completed,
        };
      }
    );
    mocks.refreshSheetRowsTrackingMock.mockResolvedValue({
      type: "sheet_rows_tracking_refresh",
      payload: {
        sheetId: "sheet-1",
        successCount: 1,
        failedCount: 0,
        rows: [],
      },
    });
    mocks.useWorkspaceRuntimeCommandsControllerMock.mockReturnValue({
      fetchRow: vi.fn(),
      copySelectedTrackingIds: vi.fn(),
    });
    mocks.useWorkspaceTableControllersMock.mockReturnValue({});
    const showNotice = vi.fn();
    const onWorkspaceEngineMutation = vi.fn();

    const { result } = renderHook(() =>
      useWorkspaceInteractionRuntimeController({
        activeSheet: sheetState,
        activeSheetId: "sheet-1",
        workspaceTabs: [{ id: "sheet-1", name: "Sheet 1" }],
        workspaceRef,
        setWorkspaceState: vi.fn(),
        updateActiveSheet: vi.fn(),
        updateSheet,
        setHoveredColumn: vi.fn(),
        deleteAllTimeoutRef: { current: null },
        deleteAllArmedSheetIdRef: { current: null },
        deleteSelectedTimeoutRef: { current: null },
        deleteSelectedArmedSheetIdRef: { current: null },
        deleteSelectedArmedSheetId: null,
        setDeleteSelectedArmedSheetId: vi.fn(),
        armDeleteAll: vi.fn(),
        disarmDeleteAll: vi.fn(),
        armDeleteSelected: vi.fn(),
        disarmDeleteSelected: vi.fn(),
        resizeStateRef: { current: null },
        sheetScrollRef: { current: null },
        sheetScrollPositionsRef: { current: new Map() },
        columnMenuRefs: { current: new Map() },
        highlightedColumnTimeoutRef: { current: null },
        highlightedColumnSheetIdRef: { current: null },
        activeFilterCount: 0,
        allTrackingIds: ["P1"],
        exportableTableRows: [],
        rustExportRowsQuery: null,
        retrackableRows: [],
        retryFailedEntries: [],
        selectedEngineRowIds: [],
        selectedTrackingIds: [],
        selectedVisibleRowKeys: [],
        visibleColumns: [],
        visibleColumnPathSet: new Set(),
        visibleSelectableKeys: [],
        effectiveColumnWidths: {},
        pinnedColumnSet: new Set(),
        allVisibleSelected: false,
        showNotice,
        onWorkspaceEngineMutation,
      } as never)
    );

    await result.current.runImportSourceLookup("bag", {
      sourceItemIds: ["PID-FAILED"],
    });

    expect(mocks.retryImportJobFailedWithProgressMock).toHaveBeenCalledWith(
      "job-1",
      expect.any(Function)
    );
    expect(mocks.previewImportSourceMock).not.toHaveBeenCalled();
    expect(mocks.refreshSheetRowsTrackingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sheetId: "sheet-1",
        rowIds: ["sheet-1:row:1"],
        forceRefresh: true,
        runId: expect.any(String),
      }),
      expect.any(Function)
    );
    expect(onWorkspaceEngineMutation).toHaveBeenCalledTimes(2);
    expect(showNotice).toHaveBeenLastCalledWith({
      tone: "success",
      message: "Ambil ulang gagal berhasil.",
    });
    expect(
      workspaceRef.current.sheetsById["sheet-1"].importSourceLookupStates.bag
        .trackingIds
    ).toEqual(["P1", "P2"]);
  });

  it("commits previewed import tracking ids without refetching source ids", async () => {
    const initialRows = createDefaultSheetState().rows;
    const sheetState: SheetState = {
      ...createDefaultSheetState(),
      importSourceModalKind: "bag",
      importSourceDrafts: {
        bag: "PID-EDITED-AFTER-PREVIEW",
        manifest: "",
      },
      importSourceLookupStates: {
        ...createDefaultSheetState().importSourceLookupStates,
        bag: {
          loading: false,
          rawResponse: "",
          error: "",
          trackingIds: ["P2606020189412.30"],
          jobId: null,
          requestKey: "bag:preview:1",
          sourceItemStates: [
            {
              itemId: "PID-OK",
              loading: false,
              error: "",
              trackingIds: ["P2606020189412.30"],
            },
          ],
          manifestBagStates: [],
        },
      },
      rows: [
        {
          ...initialRows[0],
          key: "local-draft-row",
          trackingInput: "LOCAL-DRAFT",
        },
        ...initialRows.slice(1),
      ],
    };
    const workspaceRef: { current: WorkspaceState } = {
      current: {
        version: 1,
        activeSheetId: "sheet-1",
        sheetOrder: ["sheet-1"],
        sheetMetaById: {
          "sheet-1": {
            name: "Sheet 1",
            color: "blue",
            icon: "sheet",
          },
        },
        sheetsById: {
          "sheet-1": sheetState,
        },
      },
    };
    const updateSheet = vi.fn(
      (sheetId: string, updater: (sheet: SheetState) => SheetState) => {
        const currentSheet = workspaceRef.current.sheetsById[sheetId];
        workspaceRef.current = {
          ...workspaceRef.current,
          sheetsById: {
            ...workspaceRef.current.sheetsById,
            [sheetId]: updater(currentSheet),
          },
        };
      }
    );
    mocks.querySheetRowsMock.mockResolvedValue({
      type: "sheet_rows",
      payload: {
        sheetId: "sheet-1",
        offset: 0,
        limit: 1,
        totalCount: 1,
        hasMore: false,
        nextOffset: null,
        rows: [],
      },
    });
    mocks.upsertSheetRowsMock.mockResolvedValue({
      type: "sheet_rows",
      payload: {
        sheetId: "sheet-1",
        offset: 0,
        limit: 1,
        totalCount: 2,
        hasMore: false,
        nextOffset: null,
        rows: [],
      },
    });
    mocks.refreshSheetRowsTrackingMock.mockResolvedValue({
      type: "sheet_rows_tracking_refresh",
      payload: {
        sheetId: "sheet-1",
        successCount: 1,
        failedCount: 0,
        rows: [
          {
            rowId: "sheet-1:import:batch:0",
            sheetId: "sheet-1",
            position: 1,
            displayTrackingId: "P2606020189412.30",
            lookupTrackingId: "P2606020189412",
            rowStatus: "loaded",
            errorMessage: null,
            statusJson: null,
            detailJson: null,
            historyJson: null,
          },
        ],
      },
    });
    mocks.useWorkspaceRuntimeCommandsControllerMock.mockReturnValue({
      fetchRow: vi.fn(),
      copySelectedTrackingIds: vi.fn(),
      invalidateSheetTrackingWork: vi.fn(),
    });
    mocks.useWorkspaceTableControllersMock.mockReturnValue({});
    const showNotice = vi.fn();
    const onWorkspaceEngineMutation = vi.fn();

    const { result } = renderHook(() =>
      useWorkspaceInteractionRuntimeController({
        activeSheet: sheetState,
        activeSheetId: "sheet-1",
        workspaceTabs: [{ id: "sheet-1", name: "Sheet 1" }],
        workspaceRef,
        setWorkspaceState: vi.fn(),
        updateActiveSheet: vi.fn(),
        updateSheet,
        setHoveredColumn: vi.fn(),
        deleteAllTimeoutRef: { current: null },
        deleteAllArmedSheetIdRef: { current: null },
        deleteSelectedTimeoutRef: { current: null },
        deleteSelectedArmedSheetIdRef: { current: null },
        deleteSelectedArmedSheetId: null,
        setDeleteSelectedArmedSheetId: vi.fn(),
        armDeleteAll: vi.fn(),
        disarmDeleteAll: vi.fn(),
        armDeleteSelected: vi.fn(),
        disarmDeleteSelected: vi.fn(),
        resizeStateRef: { current: null },
        sheetScrollRef: { current: null },
        sheetScrollPositionsRef: { current: new Map() },
        columnMenuRefs: { current: new Map() },
        highlightedColumnTimeoutRef: { current: null },
        highlightedColumnSheetIdRef: { current: null },
        activeFilterCount: 0,
        allTrackingIds: [],
        exportableTableRows: [],
        rustExportRowsQuery: null,
        retrackableRows: [],
        retryFailedEntries: [],
        selectedEngineRowIds: [],
        selectedTrackingIds: [],
        selectedVisibleRowKeys: [],
        visibleColumns: [],
        visibleColumnPathSet: new Set(),
        visibleSelectableKeys: [],
        effectiveColumnWidths: {},
        pinnedColumnSet: new Set(),
        allVisibleSelected: false,
        showNotice,
        onWorkspaceEngineMutation,
      } as never)
    );

    act(() => {
      result.current.importBagTrackingIds("append");
    });

    await waitFor(() => {
      expect(showNotice).toHaveBeenCalledWith({
        tone: "success",
        message: "1 nomor kiriman dari Bag ditambahkan ke sheet.",
      });
    });

    expect(mocks.createImportJobMock).not.toHaveBeenCalled();
    expect(mocks.runImportJobWithProgressMock).not.toHaveBeenCalled();
    expect(mocks.querySheetRowsMock).toHaveBeenCalledWith({
      sheetId: "sheet-1",
      offset: 0,
      limit: 1000,
      filters: [],
      valueFilters: [],
      sort: [],
    });
    expect(mocks.upsertSheetRowsMock).toHaveBeenCalledWith({
      sheetId: "sheet-1",
      rows: [
        expect.objectContaining({
          position: 1,
          displayTrackingId: "P2606020189412.30",
        }),
      ],
    });
    expect(mocks.refreshSheetRowsTrackingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sheetId: "sheet-1",
        rowIds: [expect.stringMatching(/^sheet-1:import:/)],
        forceRefresh: true,
        runId: expect.any(String),
      }),
      expect.any(Function)
    );
    expect(onWorkspaceEngineMutation).toHaveBeenCalledTimes(1);
    expect(workspaceRef.current.sheetsById["sheet-1"].importSourceModalKind).toBeNull();
    expect(
      workspaceRef.current.sheetsById["sheet-1"].rows.map(
        (row) => row.trackingInput
      )
    ).not.toContain("P2606020189412.30");
    expect(workspaceRef.current.sheetsById["sheet-1"].rows[0].trackingInput).toBe(
      "LOCAL-DRAFT"
    );
  });

  it("dedupes appended import tracking ids beyond the first Rust row window", async () => {
    const sheetState: SheetState = {
      ...createDefaultSheetState(),
      importSourceModalKind: "bag",
      importSourceDrafts: {
        bag: "PID-OK",
        manifest: "",
      },
      importSourceLookupStates: {
        ...createDefaultSheetState().importSourceLookupStates,
        bag: {
          loading: false,
          rawResponse: "",
          error: "",
          trackingIds: ["P2606020189412.30"],
          jobId: null,
          requestKey: "bag:preview:1",
          sourceItemStates: [
            {
              itemId: "PID-OK",
              loading: false,
              error: "",
              trackingIds: ["P2606020189412.30"],
            },
          ],
          manifestBagStates: [],
        },
      },
    };
    const workspaceRef: { current: WorkspaceState } = {
      current: {
        version: 1,
        activeSheetId: "sheet-1",
        sheetOrder: ["sheet-1"],
        sheetMetaById: {
          "sheet-1": {
            name: "Sheet 1",
            color: "blue",
            icon: "sheet",
          },
        },
        sheetsById: {
          "sheet-1": sheetState,
        },
      },
    };
    const updateSheet = vi.fn(
      (sheetId: string, updater: (sheet: SheetState) => SheetState) => {
        const currentSheet = workspaceRef.current.sheetsById[sheetId];
        workspaceRef.current = {
          ...workspaceRef.current,
          sheetsById: {
            ...workspaceRef.current.sheetsById,
            [sheetId]: updater(currentSheet),
          },
        };
      }
    );
    mocks.querySheetRowsMock
      .mockResolvedValueOnce({
        type: "sheet_rows",
        payload: {
          sheetId: "sheet-1",
          offset: 0,
          limit: 1000,
          totalCount: 1001,
          hasMore: true,
          nextOffset: 1000,
          rows: [
            {
              rowId: "sheet-1:row:0",
              sheetId: "sheet-1",
              position: 0,
              displayTrackingId: "P-OTHER",
              lookupTrackingId: "P-OTHER",
              rowStatus: "loaded",
              errorMessage: null,
              statusJson: null,
              detailJson: null,
              historyJson: null,
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        type: "sheet_rows",
        payload: {
          sheetId: "sheet-1",
          offset: 1000,
          limit: 1,
          totalCount: 1001,
          hasMore: false,
          nextOffset: null,
          rows: [
            {
              rowId: "sheet-1:row:1000",
              sheetId: "sheet-1",
              position: 1000,
              displayTrackingId: "P2606020189412.30",
              lookupTrackingId: "P2606020189412",
              rowStatus: "loaded",
              errorMessage: null,
              statusJson: null,
              detailJson: null,
              historyJson: null,
            },
          ],
        },
      });
    mocks.refreshSheetRowsTrackingMock.mockResolvedValue({
      type: "sheet_rows_tracking_refresh",
      payload: {
        sheetId: "sheet-1",
        successCount: 1,
        failedCount: 0,
        rows: [],
      },
    });
    mocks.useWorkspaceRuntimeCommandsControllerMock.mockReturnValue({
      fetchRow: vi.fn(),
      copySelectedTrackingIds: vi.fn(),
      invalidateSheetTrackingWork: vi.fn(),
    });
    mocks.useWorkspaceTableControllersMock.mockReturnValue({});
    const showNotice = vi.fn();

    const { result } = renderHook(() =>
      useWorkspaceInteractionRuntimeController({
        activeSheet: sheetState,
        activeSheetId: "sheet-1",
        workspaceTabs: [{ id: "sheet-1", name: "Sheet 1" }],
        workspaceRef,
        setWorkspaceState: vi.fn(),
        updateActiveSheet: vi.fn(),
        updateSheet,
        setHoveredColumn: vi.fn(),
        deleteAllTimeoutRef: { current: null },
        deleteAllArmedSheetIdRef: { current: null },
        deleteSelectedTimeoutRef: { current: null },
        deleteSelectedArmedSheetIdRef: { current: null },
        deleteSelectedArmedSheetId: null,
        setDeleteSelectedArmedSheetId: vi.fn(),
        armDeleteAll: vi.fn(),
        disarmDeleteAll: vi.fn(),
        armDeleteSelected: vi.fn(),
        disarmDeleteSelected: vi.fn(),
        resizeStateRef: { current: null },
        sheetScrollRef: { current: null },
        sheetScrollPositionsRef: { current: new Map() },
        columnMenuRefs: { current: new Map() },
        highlightedColumnTimeoutRef: { current: null },
        highlightedColumnSheetIdRef: { current: null },
        activeFilterCount: 0,
        allTrackingIds: [],
        exportableTableRows: [],
        rustExportRowsQuery: null,
        retrackableRows: [],
        retryFailedEntries: [],
        selectedEngineRowIds: [],
        selectedTrackingIds: [],
        selectedVisibleRowKeys: [],
        visibleColumns: [],
        visibleColumnPathSet: new Set(),
        visibleSelectableKeys: [],
        effectiveColumnWidths: {},
        pinnedColumnSet: new Set(),
        allVisibleSelected: false,
        showNotice,
      } as never)
    );

    act(() => {
      result.current.importBagTrackingIds("append");
    });

    await waitFor(() => {
      expect(showNotice).toHaveBeenCalledWith({
        tone: "success",
        message: "1 nomor kiriman dari Bag sudah ada dan dilacak ulang.",
      });
    });

    expect(mocks.querySheetRowsMock).toHaveBeenCalledTimes(2);
    expect(mocks.querySheetRowsMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sheetId: "sheet-1",
        offset: 1000,
        limit: 1000,
      })
    );
    expect(mocks.upsertSheetRowsMock).not.toHaveBeenCalled();
    expect(mocks.refreshSheetRowsTrackingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sheetId: "sheet-1",
        rowIds: ["sheet-1:row:1000"],
        forceRefresh: true,
      }),
      expect.any(Function)
    );
  });

  it("wires runtime commands and table controllers together", () => {
    const activeSheet = {
      deleteAllArmed: false,
      openColumnMenuPath: "status",
      selectionFollowsVisibleRows: false,
      hiddenColumnPaths: [],
      pinnedColumnPaths: [],
      importSourceDrafts: {
        bag: "",
        manifest: "",
      },
      importSourceLookupStates: {
        bag: {
          loading: false,
          rawResponse: "",
          error: "",
          trackingIds: [],
        },
        manifest: {
          loading: false,
          rawResponse: "",
          error: "",
          trackingIds: [],
        },
      },
    };
    const options = {
      activeSheet: activeSheet as never,
      activeSheetId: "sheet-1",
      workspaceTabs: [{ id: "sheet-1", name: "Sheet 1" }],
      workspaceRef: { current: {} } as never,
      setWorkspaceState: vi.fn(),
      updateActiveSheet: vi.fn(),
      updateSheet: vi.fn(),
      setHoveredColumn: vi.fn(),
      deleteAllTimeoutRef: { current: null },
      deleteAllArmedSheetIdRef: { current: null },
      deleteSelectedTimeoutRef: { current: null },
      deleteSelectedArmedSheetIdRef: { current: null },
      deleteSelectedArmedSheetId: null,
      setDeleteSelectedArmedSheetId: vi.fn(),
      armDeleteAll: vi.fn(),
      disarmDeleteAll: vi.fn(),
      armDeleteSelected: vi.fn(),
      disarmDeleteSelected: vi.fn(),
      resizeStateRef: { current: null },
      sheetScrollRef: { current: null },
      sheetScrollPositionsRef: { current: new Map() },
      columnMenuRefs: { current: new Map() },
      highlightedColumnTimeoutRef: { current: null },
      highlightedColumnSheetIdRef: { current: null },
      activeFilterCount: 2,
      allTrackingIds: ["ID-1"],
      exportableTableRows: [],
      rustExportRowsQuery: null,
      retrackableRows: [],
      retryFailedEntries: [],
      selectedEngineRowIds: ["engine-row-1"],
      selectedTrackingIds: ["ID-1"],
      selectedVisibleRowKeys: ["row-1"],
      visibleColumns: [],
      visibleColumnPathSet: new Set(["status"]),
      visibleSelectableKeys: ["row-1"],
      effectiveColumnWidths: { status: 120 },
      pinnedColumnSet: new Set(["trackingId"]),
      allVisibleSelected: false,
      showNotice: vi.fn(),
    };
    const runtimeCommands = {
      fetchRow: vi.fn(),
      copySelectedTrackingIds: vi.fn(),
      createSheet: vi.fn(),
      invalidateSheetTrackingWork: vi.fn(),
      refreshTrackingRows: vi.fn(),
    };
    const tableControllers = {
      handleSheetScroll: vi.fn(),
      toggleColumnMenu: vi.fn(),
    };

    mocks.useWorkspaceRuntimeCommandsControllerMock.mockReturnValue(
      runtimeCommands
    );
    mocks.useWorkspaceTableControllersMock.mockReturnValue(tableControllers);

    const { result } = renderHook(() =>
      useWorkspaceInteractionRuntimeController(options as never)
    );

    expect(mocks.useWorkspaceRuntimeCommandsControllerMock).toHaveBeenCalledWith({
      activeSheet,
      activeSheetId: options.activeSheetId,
      workspaceTabs: options.workspaceTabs,
      workspaceRef: options.workspaceRef,
      setWorkspaceState: options.setWorkspaceState,
      setHoveredColumn: options.setHoveredColumn,
      updateActiveSheet: options.updateActiveSheet,
      updateSheet: options.updateSheet,
      deleteAllTimeoutRef: options.deleteAllTimeoutRef,
      deleteAllArmedSheetIdRef: options.deleteAllArmedSheetIdRef,
      deleteSelectedTimeoutRef: options.deleteSelectedTimeoutRef,
      deleteSelectedArmedSheetIdRef: options.deleteSelectedArmedSheetIdRef,
      deleteSelectedArmedSheetId: options.deleteSelectedArmedSheetId,
      setDeleteSelectedArmedSheetId: options.setDeleteSelectedArmedSheetId,
      armDeleteAll: options.armDeleteAll,
      disarmDeleteAll: options.disarmDeleteAll,
      armDeleteSelected: options.armDeleteSelected,
      disarmDeleteSelected: options.disarmDeleteSelected,
      sheetScrollRef: options.sheetScrollRef,
      sheetScrollPositionsRef: options.sheetScrollPositionsRef,
      highlightedColumnTimeoutRef: options.highlightedColumnTimeoutRef,
      highlightedColumnSheetIdRef: options.highlightedColumnSheetIdRef,
      allTrackingIds: options.allTrackingIds,
      exportableTableRows: options.exportableTableRows,
      rustExportRowsQuery: options.rustExportRowsQuery,
      retrackableRows: options.retrackableRows,
      retryFailedEntries: options.retryFailedEntries,
      selectedEngineRowIds: options.selectedEngineRowIds,
      selectedTrackingIds: options.selectedTrackingIds,
      selectedVisibleRowKeys: options.selectedVisibleRowKeys,
      visibleColumns: options.visibleColumns,
      visibleColumnPathSet: options.visibleColumnPathSet,
      showNotice: options.showNotice,
    });
    expect(mocks.useWorkspaceTableControllersMock).toHaveBeenCalledWith({
      activeSheet,
      activeSheetId: options.activeSheetId,
      updateActiveSheet: options.updateActiveSheet,
      updateSheet: options.updateSheet,
      resizeStateRef: options.resizeStateRef,
      sheetScrollRef: options.sheetScrollRef,
      sheetScrollPositionsRef: options.sheetScrollPositionsRef,
      columnMenuRefs: options.columnMenuRefs,
      highlightedColumnTimeoutRef: options.highlightedColumnTimeoutRef,
      highlightedColumnSheetIdRef: options.highlightedColumnSheetIdRef,
      hasActiveFilters: true,
      visibleSelectableKeys: options.visibleSelectableKeys,
      selectedVisibleRowKeys: options.selectedVisibleRowKeys,
      selectedTrackingIds: options.selectedTrackingIds,
      visibleColumnPathSet: options.visibleColumnPathSet,
      effectiveColumnWidths: options.effectiveColumnWidths,
      pinnedColumnSet: options.pinnedColumnSet,
      allVisibleSelected: options.allVisibleSelected,
      fetchRow: runtimeCommands.fetchRow,
      copySelectedTrackingIds: runtimeCommands.copySelectedTrackingIds,
      showNotice: options.showNotice,
    });
    expect(result.current).toEqual({
      ...runtimeCommands,
      ...tableControllers,
      closeImportSourceModal: expect.any(Function),
      importBagTrackingIds: expect.any(Function),
      importManifestTrackingIds: expect.any(Function),
      openImportSourceModal: expect.any(Function),
      runImportSourceLookup: expect.any(Function),
      setImportSourceDraft: expect.any(Function),
    });
  });
});
