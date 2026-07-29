import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SheetState } from "../sheet/types";
import { createDefaultSheetState } from "../sheet/default-state";
import type { ImportSourcePreviewResult } from "../workspace-engine/client";
import type { WorkspaceState } from "./types";
import { useWorkspaceInteractionRuntimeController } from "./useWorkspaceInteractionRuntimeController";

const mocks = vi.hoisted(() => ({
  cancelImportSourcePreviewMock: vi.fn(),
  clearSheetRowsMock: vi.fn(),
  previewImportSourceMock: vi.fn(),
  querySheetRowsMock: vi.fn(),
  refreshSheetRowsTrackingMock: vi.fn(),
  upsertSheetRowsMock: vi.fn(),
  useWorkspaceRuntimeCommandsControllerMock: vi.fn(),
  useWorkspaceTableControllersMock: vi.fn(),
}));

vi.mock("../workspace-engine/client", async () => {
  const actual = await vi.importActual<object>("../workspace-engine/client");
  return {
    ...actual,
    cancelImportSourcePreview: mocks.cancelImportSourcePreviewMock,
    clearSheetRows: mocks.clearSheetRowsMock,
    previewImportSource: mocks.previewImportSourceMock,
    querySheetRows: mocks.querySheetRowsMock,
    refreshSheetRowsTracking: mocks.refreshSheetRowsTrackingMock,
    refreshSheetRowsTrackingWithProgress: mocks.refreshSheetRowsTrackingMock,
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
    expect(mocks.previewImportSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "bag",
        ids: ["PID-A"],
        scopeKey: "sheet-1:bag",
        requestKey: expect.any(String),
      })
    );
    expect(mocks.previewImportSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "bag",
        ids: ["PID-B"],
        scopeKey: "sheet-1:bag",
        requestKey: expect.any(String),
      })
    );
  });

  it("shows the Rust timeout returned for a stuck bag import preview source", async () => {
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
    mocks.previewImportSourceMock.mockRejectedValue(
      new Error("Timeout ambil data setelah 30 detik.")
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

    await act(async () => {
      await result.current.runImportSourceLookup("bag");
    });

    expect(mocks.previewImportSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "bag",
        ids: ["PID-SLOW"],
        scopeKey: "sheet-1:bag",
        requestKey: expect.any(String),
      })
    );

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
    const refreshResponse = {
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
    } as const;
    const refreshDeferred = createDeferred<typeof refreshResponse>();
    mocks.refreshSheetRowsTrackingMock.mockReturnValue(refreshDeferred.promise);
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
      expect(mocks.refreshSheetRowsTrackingMock).toHaveBeenCalledTimes(1);
    });

    expect(onWorkspaceEngineMutation).toHaveBeenCalledTimes(1);
    expect(
      workspaceRef.current.sheetsById["sheet-1"].importSourceModalKind
    ).toBeNull();
    expect(
      workspaceRef.current.sheetsById["sheet-1"].rows.find(
        (row) => row.trackingInput === "P2606020189412.30"
      )
    ).toMatchObject({
      loading: false,
      queued: true,
    });
    expect(showNotice).not.toHaveBeenCalledWith(
      expect.objectContaining({ tone: "success" })
    );

    await act(async () => {
      refreshDeferred.resolve(refreshResponse);
      await refreshDeferred.promise;
    });

    await waitFor(() => {
      expect(showNotice).toHaveBeenCalledWith({
        tone: "success",
        message: "1 nomor kiriman dari Bag ditambahkan ke sheet.",
      });
    });

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
    expect(onWorkspaceEngineMutation).toHaveBeenCalledTimes(2);
    expect(workspaceRef.current.sheetsById["sheet-1"].importSourceModalKind).toBeNull();
    expect(
      workspaceRef.current.sheetsById["sheet-1"].rows.map(
        (row) => row.trackingInput
      )
    ).toContain("P2606020189412.30");
    expect(workspaceRef.current.sheetsById["sheet-1"].rows[0].trackingInput).toBe(
      "LOCAL-DRAFT"
    );
  });

  it("keeps existing sheet data when an atomic replace commit fails", async () => {
    const existingRow = {
      ...createDefaultSheetState().rows[0],
      key: "existing-row",
      trackingInput: "EXISTING-ID",
    };
    const sheetState: SheetState = {
      ...createDefaultSheetState(),
      importSourceModalKind: "bag",
      importSourceLookupStates: {
        ...createDefaultSheetState().importSourceLookupStates,
        bag: {
          loading: false,
          rawResponse: "",
          error: "",
          trackingIds: ["REPLACEMENT-ID"],
          jobId: null,
          requestKey: "bag:preview:replace",
          sourceItemStates: [],
          manifestBagStates: [],
        },
      },
      rows: [existingRow, ...createDefaultSheetState().rows.slice(1)],
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
    const invalidateSheetTrackingWork = vi.fn();
    mocks.upsertSheetRowsMock.mockRejectedValueOnce(
      new Error("transaction failed")
    );
    mocks.useWorkspaceRuntimeCommandsControllerMock.mockReturnValue({
      fetchRow: vi.fn(),
      copySelectedTrackingIds: vi.fn(),
      invalidateSheetTrackingWork,
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

    await act(async () => {
      await result.current.importBagTrackingIds("replace");
    });

    expect(mocks.upsertSheetRowsMock).toHaveBeenCalledWith({
      sheetId: "sheet-1",
      replaceExisting: true,
      rows: [
        expect.objectContaining({
          position: 0,
          displayTrackingId: "REPLACEMENT-ID",
        }),
      ],
    });
    expect(mocks.querySheetRowsMock).not.toHaveBeenCalled();
    expect(invalidateSheetTrackingWork).not.toHaveBeenCalled();
    expect(
      workspaceRef.current.sheetsById["sheet-1"].rows[0].trackingInput
    ).toBe("EXISTING-ID");
    expect(
      workspaceRef.current.sheetsById["sheet-1"].importSourceModalKind
    ).toBe("bag");
    expect(showNotice).toHaveBeenLastCalledWith({
      tone: "error",
      message: "transaction failed",
    });
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
