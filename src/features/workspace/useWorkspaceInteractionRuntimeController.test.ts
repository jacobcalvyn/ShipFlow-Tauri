import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SheetState } from "../sheet/types";
import { createDefaultSheetState } from "../sheet/default-state";
import type { ImportJobDetail, WorkspaceEngineEvent } from "../workspace-engine/client";
import type { WorkspaceState } from "./types";
import {
  applyWorkspaceEngineImportJobDetail,
  getImportJobSheetRowIds,
  useWorkspaceInteractionRuntimeController,
} from "./useWorkspaceInteractionRuntimeController";

const mocks = vi.hoisted(() => ({
  createImportJobMock: vi.fn(),
  getImportJobMock: vi.fn(),
  previewImportSourceMock: vi.fn(),
  refreshSheetRowsTrackingMock: vi.fn(),
  retryImportJobFailedWithProgressMock: vi.fn(),
  runImportJobWithProgressMock: vi.fn(),
  useWorkspaceRuntimeCommandsControllerMock: vi.fn(),
  useWorkspaceTableControllersMock: vi.fn(),
}));

vi.mock("../workspace-engine/client", async () => {
  const actual = await vi.importActual<object>("../workspace-engine/client");
  return {
    ...actual,
    createImportJob: mocks.createImportJobMock,
    getImportJob: mocks.getImportJobMock,
    previewImportSource: mocks.previewImportSourceMock,
    refreshSheetRowsTracking: mocks.refreshSheetRowsTrackingMock,
    retryImportJobFailedWithProgress:
      mocks.retryImportJobFailedWithProgressMock,
    runImportJobWithProgress: mocks.runImportJobWithProgressMock,
  };
});

vi.mock("./useWorkspaceRuntimeCommandsController", () => ({
  useWorkspaceRuntimeCommandsController:
    mocks.useWorkspaceRuntimeCommandsControllerMock,
}));

vi.mock("./useWorkspaceTableControllers", () => ({
  useWorkspaceTableControllers: mocks.useWorkspaceTableControllersMock,
}));

describe("useWorkspaceInteractionRuntimeController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(mocks.refreshSheetRowsTrackingMock).toHaveBeenCalledWith({
      sheetId: "sheet-1",
      rowIds: ["sheet-1:row:1"],
      forceRefresh: true,
    });
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

  it("commits imports without copying Rust row windows into React sheet rows", async () => {
    const initialRows = createDefaultSheetState().rows;
    const sheetState: SheetState = {
      ...createDefaultSheetState(),
      importSourceModalKind: "bag",
      importSourceDrafts: {
        bag: "PID-OK",
        manifest: "",
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
    const created: ImportJobDetail = {
      summary: {
        jobId: "job-1",
        sheetId: "sheet-1",
        kind: "bag",
        mode: "append",
        status: "running",
        totalCount: 1,
        successCount: 0,
        failedCount: 0,
        pendingCount: 1,
      },
      items: [
        {
          itemId: "job-1:item:0",
          sourceItemId: "PID-OK",
          sourceItemKind: "bag",
          position: 0,
          status: "pending",
          trackingIds: [],
          sheetRowIds: [],
          errorMessage: null,
          attemptCount: 0,
        },
      ],
    };
    const completed: ImportJobDetail = {
      summary: {
        ...created.summary,
        status: "completed",
        successCount: 1,
        pendingCount: 0,
      },
      items: [
        {
          ...created.items[0],
          status: "succeeded",
          trackingIds: ["P2606020189412.30"],
          sheetRowIds: ["sheet-1:row:0"],
          attemptCount: 1,
        },
      ],
    };
    mocks.createImportJobMock.mockResolvedValue({
      type: "import_job_detail",
      payload: created,
    });
    mocks.runImportJobWithProgressMock.mockResolvedValue({
      type: "import_job_detail",
      payload: completed,
    });
    mocks.refreshSheetRowsTrackingMock.mockResolvedValue({
      type: "sheet_rows_tracking_refresh",
      payload: {
        sheetId: "sheet-1",
        successCount: 1,
        failedCount: 0,
        rows: [
          {
            rowId: "sheet-1:row:0",
            sheetId: "sheet-1",
            position: 0,
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

    expect(mocks.createImportJobMock).toHaveBeenCalledWith({
      sheetId: "sheet-1",
      kind: "bag",
      ids: ["PID-OK"],
      mode: "append",
    });
    expect(mocks.refreshSheetRowsTrackingMock).toHaveBeenCalledWith({
      sheetId: "sheet-1",
      rowIds: ["sheet-1:row:0"],
      forceRefresh: true,
    });
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
