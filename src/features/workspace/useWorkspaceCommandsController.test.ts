import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELIVERY_RUNSHEET_COUNT_COLUMN_PATH,
  LATEST_BAG_STATUS_COLUMN_PATH,
  LATEST_DELIVERY_COLUMN_PATH,
  LATEST_MANIFEST_COLUMN_PATH,
  TRACKING_COLUMN_PATH,
  COLUMNS,
} from "../sheet/columns";
import {
  createSheetTableRowsFromSheetRows,
  type SheetTableRowTrackingEntry,
} from "../sheet/table-row-view";
import { SheetRow } from "../sheet/types";
import { createDefaultSheetState } from "../sheet/default-state";
import { useWorkspaceCommandsController } from "./useWorkspaceCommandsController";
import { exportWorkspaceCsv } from "../../backend/commands";
import type { SheetRowsQuery } from "../workspace-engine/client";
import type { WorkspaceState } from "./types";

const workspaceEngineMocks = vi.hoisted(() => ({
  clearSheetRows: vi.fn(),
  copySheetRows: vi.fn(),
  createEngineSheet: vi.fn(),
  deleteSheet: vi.fn(),
  deleteSheetRows: vi.fn(),
  querySheetRows: vi.fn(),
  renameEngineSheet: vi.fn(),
  refreshSheetRowsTracking: vi.fn(),
}));

vi.mock("../../backend/commands", () => ({
  exportWorkspaceCsv: vi.fn(),
}));

vi.mock("../workspace-engine/client", async () => {
  const actual = await vi.importActual<object>("../workspace-engine/client");
  return {
    ...actual,
    clearSheetRows: workspaceEngineMocks.clearSheetRows,
    copySheetRows: workspaceEngineMocks.copySheetRows,
    createEngineSheet: workspaceEngineMocks.createEngineSheet,
    deleteSheet: workspaceEngineMocks.deleteSheet,
    deleteSheetRows: workspaceEngineMocks.deleteSheetRows,
    querySheetRows: workspaceEngineMocks.querySheetRows,
    renameEngineSheet: workspaceEngineMocks.renameEngineSheet,
    refreshSheetRowsTracking: workspaceEngineMocks.refreshSheetRowsTracking,
    refreshSheetRowsTrackingWithProgress:
      workspaceEngineMocks.refreshSheetRowsTracking,
  };
});

const exportWorkspaceCsvMock = vi.mocked(exportWorkspaceCsv);

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createRow(): SheetRow {
  return {
    key: "row-1",
    trackingInput: "P2603310114291",
    shipment: {
      url: "https://example.test/track",
      detail: {
        shipment_header: {
          nomor_kiriman: "P2603310114291",
        },
        origin_detail: {},
        package_detail: {
          berat_actual: 0,
          berat_volumetric: 0,
        },
        billing_detail: {
          bea_dasar: 0,
          nilai_barang: 0,
          htnb: 0,
          cod_info: {
            is_cod: false,
            total_cod: 0,
          },
        },
        actors: {
          pengirim: {},
          penerima: {},
        },
        performance_detail: {},
      },
      status_akhir: {
        status: "DELIVERED",
      },
      pod: {
        photo1_url: "https://example.test/photo-1.jpg",
        photo2_url: "https://example.test/photo-2.jpg",
      },
      history: [],
      history_summary: {
        irregularity: [
          {
            status: "FAILED",
            lokasi: "DC JAYAPURA 9910A",
            tanggal: "2026-04-15",
            waktu: "16:17:07",
          },
        ],
        bagging_unbagging: [
          {
            nomor_kantung: "PID95084242",
            bagging: {
              lokasi: "DC JAYAPURA 9910A",
              tanggal: "2026-04-15",
              waktu: "16:33:20",
            },
          },
        ],
        manifest_r7: [
          {
            nomor_r7: "P20260310064942110",
            tujuan: "DC JAYAPURA 9910A",
            tanggal: "2026-03-10",
            waktu: "08:46:26",
          },
        ],
        delivery_runsheet: [
          {
            petugas_kurir: "Gabriel Erick Taurui (560000529)",
            lokasi: "DC JAYAPURA 9910A",
            tanggal: "2026-04-15",
            waktu: "11:40:47",
            updates: [
              {
                petugas: "Gabriel Erick Taurui (560000529)",
                status: "FAILEDTODELIVERED",
                keterangan_status: "RUMAH/ALAMAT TIDAK DITEMUKAN",
                tanggal: "2026-04-15",
                waktu: "14:50:02",
              },
            ],
          },
        ],
      },
    },
    loading: false,
    stale: false,
    dirty: false,
    error: "",
  };
}

function buildOptions() {
  const row = createRow();
  const visibleColumns = COLUMNS.filter((column) =>
    [
      TRACKING_COLUMN_PATH,
      LATEST_BAG_STATUS_COLUMN_PATH,
      LATEST_MANIFEST_COLUMN_PATH,
      LATEST_DELIVERY_COLUMN_PATH,
      "status_akhir.status",
      "pod.photo1_url",
      "pod.photo2_url",
      "history_summary.irregularity",
      "history_summary.bagging_unbagging",
      "history_summary.manifest_r7",
      "history_summary.delivery_runsheet",
      DELIVERY_RUNSHEET_COUNT_COLUMN_PATH,
    ].includes(column.path)
  );
  const workspaceState: WorkspaceState = {
    version: 1,
    activeSheetId: "sheet-1",
    sheetOrder: ["sheet-1"],
    sheetMetaById: {
      "sheet-1": {
        name: "Sheet 1",
        color: "slate",
        icon: "sheet",
      },
    },
    sheetsById: {
      "sheet-1": {
        ...createDefaultSheetState(),
        rows: [row],
      },
    },
  };

  return {
    activeSheetId: "sheet-1",
    activeSheetDeleteAllArmed: false,
    allTrackingIds: ["P2603310114291"],
    exportableTableRows: createSheetTableRowsFromSheetRows([row]),
    rustExportRowsQuery: null as SheetRowsQuery | null,
    retrackableRows: [] as SheetTableRowTrackingEntry[],
    retryFailedEntries: [] as SheetTableRowTrackingEntry[],
    selectedEngineRowIds: [] as string[],
    selectedTrackingIds: [],
    selectedVisibleRowKeys: [] as string[],
    deleteSelectedArmedSheetId: null as string | null,
    visibleColumns,
    visibleColumnPathSet: new Set(visibleColumns.map((column) => column.path)),
    workspaceRef: { current: workspaceState },
    sheetScrollPositionsRef: { current: new Map() },
    highlightedColumnTimeoutRef: { current: null },
    highlightedColumnSheetIdRef: { current: null },
    deleteAllTimeoutRef: { current: null },
    deleteAllArmedSheetIdRef: { current: null },
    deleteSelectedTimeoutRef: { current: null },
    deleteSelectedArmedSheetIdRef: { current: null },
    setDeleteSelectedArmedSheetId: vi.fn(),
    setWorkspaceState: vi.fn(),
    setHoveredColumn: vi.fn(),
    updateActiveSheet: vi.fn(),
    copyText: vi.fn().mockResolvedValue(undefined),
    showNotice: vi.fn(),
    armDeleteAll: vi.fn(),
    disarmDeleteAll: vi.fn(),
    armDeleteSelected: vi.fn(),
    disarmDeleteSelected: vi.fn(),
    focusFirstTrackingInput: vi.fn(),
    abortRowTrackingWork: vi.fn(),
    invalidateSheetTrackingWork: vi.fn(),
    forgetSheetTrackingRuntime: vi.fn(),
    onWorkspaceEngineMutation: vi.fn(),
    refreshTrackingRows: vi.fn().mockResolvedValue(undefined),
  };
}

describe("useWorkspaceCommandsController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceEngineMocks.clearSheetRows.mockReset();
    workspaceEngineMocks.clearSheetRows.mockResolvedValue({ payload: null });
    workspaceEngineMocks.copySheetRows.mockReset();
    workspaceEngineMocks.createEngineSheet.mockReset();
    workspaceEngineMocks.createEngineSheet.mockResolvedValue({
      type: "sheet",
      payload: {
        sheetId: "sheet-2",
        workspaceId: "workspace-1",
        name: "Sheet 2",
        position: 1,
        viewMode: "workspace",
      },
    });
    workspaceEngineMocks.deleteSheet.mockReset();
    workspaceEngineMocks.deleteSheet.mockResolvedValue({
      type: "sheet_deleted",
      payload: { sheetId: "sheet-1" },
    });
    workspaceEngineMocks.deleteSheetRows.mockReset();
    workspaceEngineMocks.deleteSheetRows.mockResolvedValue({ payload: null });
    workspaceEngineMocks.querySheetRows.mockReset();
    workspaceEngineMocks.renameEngineSheet.mockReset();
    workspaceEngineMocks.renameEngineSheet.mockResolvedValue({
      type: "sheet",
      payload: {
        sheetId: "sheet-1",
        workspaceId: "workspace-1",
        name: "Renamed",
        position: 0,
        viewMode: "workspace",
      },
    });
    workspaceEngineMocks.refreshSheetRowsTracking.mockReset();
    exportWorkspaceCsvMock.mockResolvedValue({
      path: "/tmp/shipflow-view.csv",
      rowCount: 1,
      exportedAt: "2026-05-04T00:00:00.000Z",
    });
  });

  it("deletes selected Rust rows by engine row id instead of the UI key", async () => {
    const options = buildOptions();
    options.deleteSelectedArmedSheetId = "sheet-1";
    options.selectedVisibleRowKeys = ["legacy-visible-key"];
    options.selectedEngineRowIds = ["rust-row-1"];

    const { result } = renderHook(() =>
      useWorkspaceCommandsController(options as never)
    );

    await act(async () => {
      await result.current.deleteSelectedRows();
    });

    expect(workspaceEngineMocks.deleteSheetRows).toHaveBeenCalledWith({
      sheetId: "sheet-1",
      rowIds: ["rust-row-1"],
    });
    expect(options.abortRowTrackingWork).toHaveBeenCalledWith(
      "sheet-1",
      ["legacy-visible-key", "rust-row-1"],
      "selected_rows_deleted"
    );
    expect(options.updateActiveSheet).toHaveBeenCalledTimes(1);
  });

  it("removes selected local rows only after the engine delete succeeds", async () => {
    const options = buildOptions();
    options.deleteSelectedArmedSheetId = "sheet-1";
    options.selectedVisibleRowKeys = ["row-1"];
    options.selectedEngineRowIds = ["rust-row-1"];
    let resolveDeleteRows: (() => void) | null = null;
    workspaceEngineMocks.deleteSheetRows.mockReturnValue(
      new Promise((resolve) => {
        resolveDeleteRows = () =>
          resolve({
            type: "sheet_delete_rows",
            payload: {
              sheetId: "sheet-1",
              deleted: 1,
            },
          });
      })
    );

    const { result } = renderHook(() =>
      useWorkspaceCommandsController(options as never)
    );

    void act(() => {
      void result.current.deleteSelectedRows();
    });

    expect(options.updateActiveSheet).not.toHaveBeenCalled();

    await act(async () => {
      resolveDeleteRows?.();
      await Promise.resolve();
    });

    expect(options.updateActiveSheet).toHaveBeenCalledTimes(1);
    const updater = vi.mocked(options.updateActiveSheet).mock.calls[0]?.[0];
    expect(updater).toBeTypeOf("function");
    const nextSheet = updater({
      ...createDefaultSheetState(),
      rows: [
        {
          ...createRow(),
          trackingInput: "P2606020189412.30",
        },
      ],
      selectedRowKeys: ["row-1"],
    });
    expect(nextSheet.rows[0]?.trackingInput).toBe("");
    expect(nextSheet.selectedRowKeys).toEqual([]);
  });

  it("keeps selected local rows when the engine delete fails", async () => {
    const options = buildOptions();
    options.deleteSelectedArmedSheetId = "sheet-1";
    options.selectedVisibleRowKeys = ["row-1"];
    workspaceEngineMocks.deleteSheetRows.mockRejectedValueOnce(new Error("database locked"));

    const { result } = renderHook(() =>
      useWorkspaceCommandsController(options as never)
    );

    await act(async () => {
      await result.current.deleteSelectedRows();
    });

    expect(options.updateActiveSheet).not.toHaveBeenCalled();
    expect(options.showNotice).toHaveBeenCalledWith({
      tone: "error",
      message: "Gagal menghapus row. Data tetap dipertahankan.",
    });
  });

  it("clears Rust sheet rows when the React row mirror is empty", async () => {
    const options = buildOptions();
    options.activeSheetDeleteAllArmed = true;
    options.allTrackingIds = [];
    options.rustExportRowsQuery = {
      sheetId: "sheet-1",
      offset: 0,
      limit: 1_000,
      filters: [],
      sort: [],
    };

    const { result } = renderHook(() =>
      useWorkspaceCommandsController(options as never)
    );

    await act(async () => {
      await result.current.deleteAllRows();
    });

    expect(workspaceEngineMocks.clearSheetRows).toHaveBeenCalledWith({
      sheetId: "sheet-1",
    });
    expect(options.updateActiveSheet).toHaveBeenCalledTimes(1);
    expect(options.focusFirstTrackingInput).toHaveBeenCalledTimes(1);
  });

  it("clears local rows only after the engine clear succeeds", async () => {
    const options = buildOptions();
    options.activeSheetDeleteAllArmed = true;
    let resolveClearRows: (() => void) | null = null;
    workspaceEngineMocks.clearSheetRows.mockReturnValue(
      new Promise((resolve) => {
        resolveClearRows = () =>
          resolve({
            type: "sheet_clear_rows",
            payload: {
              sheetId: "sheet-1",
              deleted: 1,
            },
          });
      })
    );

    const { result } = renderHook(() =>
      useWorkspaceCommandsController(options as never)
    );

    void act(() => {
      void result.current.deleteAllRows();
    });

    expect(options.updateActiveSheet).not.toHaveBeenCalled();

    await act(async () => {
      resolveClearRows?.();
      await Promise.resolve();
    });

    expect(options.updateActiveSheet).toHaveBeenCalledTimes(1);
    const updater = vi.mocked(options.updateActiveSheet).mock.calls[0]?.[0];
    expect(updater).toBeTypeOf("function");
    const nextSheet = updater({
      ...createDefaultSheetState(),
      rows: [
        {
          ...createRow(),
          trackingInput: "P2606020189412.30",
        },
      ],
      selectedRowKeys: ["row-1"],
      deleteAllArmed: true,
    });
    expect(nextSheet.rows[0]?.trackingInput).toBe("");
    expect(nextSheet.selectedRowKeys).toEqual([]);
    expect(nextSheet.deleteAllArmed).toBe(false);
  });

  it("keeps all local rows when the engine clear fails", async () => {
    const options = buildOptions();
    options.activeSheetDeleteAllArmed = true;
    workspaceEngineMocks.clearSheetRows.mockRejectedValueOnce(new Error("database locked"));

    const { result } = renderHook(() =>
      useWorkspaceCommandsController(options as never)
    );

    await act(async () => {
      await result.current.deleteAllRows();
    });

    expect(options.updateActiveSheet).not.toHaveBeenCalled();
    expect(options.focusFirstTrackingInput).not.toHaveBeenCalled();
    expect(options.showNotice).toHaveBeenCalledWith({
      tone: "error",
      message: "Gagal menghapus semua row. Data tetap dipertahankan.",
    });
  });

  it("creates a local sheet tab and syncs its metadata to the workspace engine", async () => {
    const options = buildOptions();
    const { result } = renderHook(() =>
      useWorkspaceCommandsController(options as never)
    );

    await act(async () => {
      await result.current.createSheet();
    });

    expect(workspaceEngineMocks.createEngineSheet).toHaveBeenCalledWith({
      sheetId: expect.any(String),
      name: "Sheet 2",
      position: 1,
    });
    expect(options.setWorkspaceState).toHaveBeenCalledTimes(1);
    const nextWorkspace = vi.mocked(options.setWorkspaceState).mock.calls[0]?.[0];
    if (typeof nextWorkspace === "function") {
      throw new Error("createSheet should set the resolved workspace snapshot.");
    }
    expect(nextWorkspace?.sheetOrder).toHaveLength(2);
  });

  it("renames a sheet through the workspace engine with the resolved unique name", async () => {
    const options = buildOptions();
    options.workspaceRef.current = {
      ...options.workspaceRef.current,
      sheetOrder: ["sheet-1", "sheet-2"],
      sheetMetaById: {
        "sheet-1": {
          name: "Sheet 1",
          color: "slate",
          icon: "sheet",
        },
        "sheet-2": {
          name: "Cases",
          color: "slate",
          icon: "sheet",
        },
      },
      sheetsById: {
        ...options.workspaceRef.current.sheetsById,
        "sheet-2": createDefaultSheetState(),
      },
    };
    const { result } = renderHook(() =>
      useWorkspaceCommandsController(options as never)
    );

    await act(async () => {
      await result.current.renameActiveSheet("sheet-1", "Cases");
    });

    expect(workspaceEngineMocks.renameEngineSheet).toHaveBeenCalledWith({
      sheetId: "sheet-1",
      name: "Cases (2)",
    });
    expect(options.setWorkspaceState).toHaveBeenCalledTimes(1);
  });

  it("rolls back only the failed rename without reverting concurrent workspace changes", async () => {
    const options = buildOptions();
    workspaceEngineMocks.renameEngineSheet.mockRejectedValueOnce(
      new Error("database locked")
    );
    const { result } = renderHook(() =>
      useWorkspaceCommandsController(options as never)
    );

    act(() => {
      result.current.renameActiveSheet("sheet-1", "Cases");
    });

    await waitFor(() => {
      expect(options.setWorkspaceState).toHaveBeenCalledTimes(2);
    });

    const rollback = vi.mocked(options.setWorkspaceState).mock.calls[1]?.[0];
    expect(typeof rollback).toBe("function");
    const concurrentWorkspace: WorkspaceState = {
      ...options.workspaceRef.current,
      sheetOrder: ["sheet-1", "sheet-2"],
      sheetMetaById: {
        ...options.workspaceRef.current.sheetMetaById,
        "sheet-1": {
          ...options.workspaceRef.current.sheetMetaById["sheet-1"],
          name: "Cases",
        },
        "sheet-2": { name: "Concurrent", color: "slate", icon: "sheet" },
      },
      sheetsById: {
        ...options.workspaceRef.current.sheetsById,
        "sheet-2": createDefaultSheetState(),
      },
    };
    const rolledBack =
      typeof rollback === "function"
        ? rollback(concurrentWorkspace)
        : concurrentWorkspace;

    expect(rolledBack.sheetMetaById["sheet-1"].name).toBe("Sheet 1");
    expect(rolledBack.sheetMetaById["sheet-2"].name).toBe("Concurrent");
    expect(rolledBack.sheetOrder).toEqual(["sheet-1", "sheet-2"]);
  });

  it("deletes a sheet through the workspace engine before removing the local tab", async () => {
    const options = buildOptions();
    const { result } = renderHook(() =>
      useWorkspaceCommandsController(options as never)
    );

    await act(async () => {
      await result.current.deleteActiveSheet("sheet-1");
    });

    expect(workspaceEngineMocks.deleteSheet).toHaveBeenCalledWith({
      sheetId: "sheet-1",
    });
    expect(options.invalidateSheetTrackingWork).toHaveBeenCalledWith("sheet-1");
    expect(options.forgetSheetTrackingRuntime).toHaveBeenCalledWith("sheet-1");
    expect(options.setWorkspaceState).toHaveBeenCalledWith(expect.any(Function));
  });

  it("duplicates sheet rows from the workspace engine response", async () => {
    const options = buildOptions();
    options.workspaceRef.current = {
      version: 1,
      activeSheetId: "sheet-1",
      sheetOrder: ["sheet-1"],
      sheetMetaById: {
        "sheet-1": {
          name: "Sheet 1",
          color: "slate",
          icon: "sheet",
        },
      },
      sheetsById: {
        "sheet-1": {
          ...createDefaultSheetState(),
          rows: [
            {
              ...createRow(),
              trackingInput: "FRONTEND-CLONE",
            },
          ],
        },
      },
    };
    workspaceEngineMocks.copySheetRows.mockImplementation(
      ({ sourceSheetId, targetSheetId }) =>
        Promise.resolve({
          type: "sheet_rows",
          payload: {
            sheetId: targetSheetId,
            offset: 0,
            limit: 1,
            totalCount: 1,
            hasMore: false,
            nextOffset: null,
            rows: [
              {
                rowId: `${targetSheetId}:row:0`,
                position: 0,
                displayTrackingId: "RUST-COPY",
                lookupTrackingId: "RUST-COPY",
                rowStatus: "loaded",
                errorMessage: null,
                statusJson: { status: "INLOCATION" },
                detailJson: {
                  shipment_header: {
                    nomor_kiriman: "RUST-COPY",
                  },
                },
                historyJson: null,
              },
            ],
          },
        })
    );

    const { result } = renderHook(() =>
      useWorkspaceCommandsController(options as never)
    );

    await act(async () => {
      await result.current.duplicateSheet("sheet-1");
    });

    expect(workspaceEngineMocks.createEngineSheet).toHaveBeenCalledWith({
      sheetId: expect.any(String),
      name: "Sheet 1 - 1",
      position: 1,
    });
    expect(workspaceEngineMocks.copySheetRows).toHaveBeenCalledWith({
      sourceSheetId: "sheet-1",
      targetSheetId: expect.any(String),
    });
    expect(options.setWorkspaceState).toHaveBeenCalledTimes(1);
    const nextWorkspace = vi.mocked(options.setWorkspaceState).mock.calls[0]?.[0];
    expect(typeof nextWorkspace).toBe("object");
    if (typeof nextWorkspace === "function") {
      throw new Error("duplicateSheet should set the resolved workspace snapshot.");
    }
    const targetSheetId = nextWorkspace?.activeSheetId ?? "";
    expect(nextWorkspace?.sheetsById[targetSheetId]?.rows[0]?.trackingInput).toBe("");
    expect(nextWorkspace?.sheetsById[targetSheetId]?.rows[0]?.shipment).toBeNull();
  });

  it("does not overwrite concurrent workspace changes when duplication finishes", async () => {
    const options = buildOptions();
    const copyDeferred = createDeferred<{
      type: "sheet_rows";
      payload: {
        sheetId: string;
        offset: number;
        limit: number;
        totalCount: number;
        hasMore: boolean;
        nextOffset: null;
        rows: [];
      };
    }>();
    workspaceEngineMocks.copySheetRows.mockReturnValue(copyDeferred.promise);
    const { result } = renderHook(() =>
      useWorkspaceCommandsController(options as never)
    );

    let duplicatePromise!: Promise<void>;
    act(() => {
      duplicatePromise = result.current.duplicateSheet("sheet-1");
    });

    await waitFor(() => {
      expect(options.setWorkspaceState).toHaveBeenCalledTimes(1);
    });
    options.workspaceRef.current = {
      ...options.workspaceRef.current,
      sheetMetaById: {
        ...options.workspaceRef.current.sheetMetaById,
        "sheet-1": {
          ...options.workspaceRef.current.sheetMetaById["sheet-1"],
          name: "Concurrent rename",
        },
      },
    };

    await act(async () => {
      copyDeferred.resolve({
        type: "sheet_rows",
        payload: {
          sheetId: "duplicate",
          offset: 0,
          limit: 0,
          totalCount: 0,
          hasMore: false,
          nextOffset: null,
          rows: [],
        },
      });
      await duplicatePromise;
    });

    expect(options.setWorkspaceState).toHaveBeenCalledTimes(1);
  });

  it("excludes POD and raw history summary columns from exported CSV", async () => {
    const options = buildOptions();
    const { result } = renderHook(() =>
      useWorkspaceCommandsController(options as never)
    );

    await act(async () => {
      result.current.exportCsv();
      await Promise.resolve();
    });

    expect(exportWorkspaceCsvMock).toHaveBeenCalledTimes(1);
    const csvContent = exportWorkspaceCsvMock.mock.calls[0]?.[0].csvContent ?? "";

    expect(csvContent).toContain("Nomor Kiriman");
    expect(csvContent).toContain("PID/Kantong Terakhir");
    expect(csvContent).toContain("Manifest Terakhir");
    expect(csvContent).toContain("Delivery Terakhir");
    expect(csvContent).toContain("Jumlah Delivery Runsheet");
    expect(csvContent).toContain("Status Akhir");

    expect(csvContent).not.toContain("POD Photo 1");
    expect(csvContent).not.toContain("POD Photo 2");
    expect(csvContent).not.toContain("History Summary Irregularity");
    expect(csvContent).not.toContain("History Summary Bagging Unbagging");
    expect(csvContent).not.toContain("History Summary Manifest R7");
    expect(csvContent).not.toContain("History Summary Delivery Runsheet");
  });

  it("exports CSV from table row view models without SheetRow export data", async () => {
    const options = buildOptions();
    options.exportableTableRows = [
      {
        key: "rust-row-1",
        position: 0,
        trackingInput: "RUST-1",
        shipment: null,
        error: "",
        status: "Ready",
        loading: false,
        queued: false,
        stale: false,
        dirty: false,
        getFormattedValue: (column) =>
          column.path === TRACKING_COLUMN_PATH ? "RUST-1" : "from-table-row",
        getRawValue: () => null,
        getLatestBagId: () => null,
        getLatestBagPrintUrl: () => null,
        getLatestManifestId: () => null,
      },
    ];

    const { result } = renderHook(() =>
      useWorkspaceCommandsController(options as never)
    );

    await act(async () => {
      result.current.exportCsv();
      await Promise.resolve();
    });

    const csvContent = exportWorkspaceCsvMock.mock.calls[0]?.[0].csvContent ?? "";
    expect(csvContent).toContain("RUST-1");
    expect(exportWorkspaceCsvMock.mock.calls[0]?.[0].rowCount).toBe(1);
  });

  it("exports selected Rust rows even when they are outside the active query window", async () => {
    const options = buildOptions();
    options.exportableTableRows = [];
    options.selectedEngineRowIds = ["rust-row-1500", "rust-row-2"];
    options.rustExportRowsQuery = {
      sheetId: "sheet-1",
      offset: 0,
      limit: 500,
      filters: [{ field: "status_akhir.status", value: "DELIVERED" }],
      valueFilters: [],
      sort: [{ field: TRACKING_COLUMN_PATH, direction: "asc" }],
    };
    workspaceEngineMocks.querySheetRows
      .mockResolvedValueOnce({
        type: "sheet_rows",
        payload: {
          sheetId: "sheet-1",
          offset: 0,
          limit: 1_000,
          totalCount: 1_501,
          hasMore: true,
          nextOffset: 1_000,
          rows: [
            {
              rowId: "rust-row-2",
              position: 2,
              displayTrackingId: "RUST-2",
              lookupTrackingId: "RUST-2",
              rowStatus: "loaded",
              errorMessage: null,
              statusJson: { status: "DELIVERED" },
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
          offset: 1_000,
          limit: 1_000,
          totalCount: 1_501,
          hasMore: false,
          nextOffset: null,
          rows: [
            {
              rowId: "rust-row-1500",
              position: 1_500,
              displayTrackingId: "RUST-1500",
              lookupTrackingId: "RUST-1500",
              rowStatus: "loaded",
              errorMessage: null,
              statusJson: { status: "INLOCATION" },
              detailJson: null,
              historyJson: null,
            },
          ],
        },
      });

    const { result } = renderHook(() =>
      useWorkspaceCommandsController(options as never)
    );

    await act(async () => {
      result.current.exportCsv();
    });

    await waitFor(() => {
      expect(exportWorkspaceCsvMock).toHaveBeenCalledTimes(1);
    });

    expect(workspaceEngineMocks.querySheetRows).toHaveBeenNthCalledWith(1, {
      ...options.rustExportRowsQuery,
      offset: 0,
      limit: 1_000,
      filters: [],
      valueFilters: [],
      sort: [],
    });
    expect(workspaceEngineMocks.querySheetRows).toHaveBeenNthCalledWith(2, {
      ...options.rustExportRowsQuery,
      offset: 1_000,
      limit: 1_000,
      filters: [],
      valueFilters: [],
      sort: [],
    });
    const csvContent = exportWorkspaceCsvMock.mock.calls[0]?.[0].csvContent ?? "";
    expect(csvContent.indexOf("RUST-1500")).toBeLessThan(
      csvContent.indexOf("RUST-2")
    );
    expect(exportWorkspaceCsvMock.mock.calls[0]?.[0].rowCount).toBe(2);
  });

  it("exports unselected CSV rows by paging through the Rust row query", async () => {
    const options = buildOptions();
    options.exportableTableRows = [];
    options.rustExportRowsQuery = {
      sheetId: "sheet-1",
      offset: 0,
      limit: 1_000,
      filters: [{ field: "status_akhir.status", value: "IN" }],
      sort: [{ field: TRACKING_COLUMN_PATH, direction: "asc" }],
    };
    workspaceEngineMocks.querySheetRows
      .mockResolvedValueOnce({
        type: "sheet_rows",
        payload: {
          sheetId: "sheet-1",
          offset: 0,
          limit: 1_000,
          totalCount: 2,
          hasMore: true,
          nextOffset: 1_000,
          rows: [
            {
              rowId: "rust-row-1",
              position: 0,
              displayTrackingId: "RUST-A",
              lookupTrackingId: "RUST-A",
              rowStatus: "loaded",
              errorMessage: null,
              statusJson: { status: "INLOCATION" },
              detailJson: {
                shipment_header: {
                  nomor_kiriman: "RUST-A",
                },
              },
              historyJson: null,
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        type: "sheet_rows",
        payload: {
          sheetId: "sheet-1",
          offset: 1_000,
          limit: 1_000,
          totalCount: 2,
          hasMore: false,
          nextOffset: null,
          rows: [
            {
              rowId: "rust-row-2",
              position: 1,
              displayTrackingId: "RUST-B",
              lookupTrackingId: "RUST-B",
              rowStatus: "loaded",
              errorMessage: null,
              statusJson: { status: "INVEHICLE" },
              detailJson: {
                shipment_header: {
                  nomor_kiriman: "RUST-B",
                },
              },
              historyJson: null,
            },
          ],
        },
      });

    const { result } = renderHook(() =>
      useWorkspaceCommandsController(options as never)
    );

    await act(async () => {
      result.current.exportCsv();
    });

    await waitFor(() => {
      expect(exportWorkspaceCsvMock).toHaveBeenCalledTimes(1);
    });

    expect(workspaceEngineMocks.querySheetRows).toHaveBeenNthCalledWith(1, {
      ...options.rustExportRowsQuery,
      offset: 0,
      limit: 1_000,
    });
    expect(workspaceEngineMocks.querySheetRows).toHaveBeenNthCalledWith(2, {
      ...options.rustExportRowsQuery,
      offset: 1_000,
      limit: 1_000,
    });
    const csvContent = exportWorkspaceCsvMock.mock.calls[0]?.[0].csvContent ?? "";
    expect(csvContent).toContain("RUST-A");
    expect(csvContent).toContain("RUST-B");
    expect(csvContent).not.toContain("P2603310114291");
    expect(exportWorkspaceCsvMock.mock.calls[0]?.[0].rowCount).toBe(2);
  });

  it("copies all tracking ids by paging through the Rust row query", async () => {
    const options = buildOptions();
    options.allTrackingIds = ["LOCAL-WINDOW-ONLY"];
    options.rustExportRowsQuery = {
      sheetId: "sheet-1",
      offset: 0,
      limit: 1_000,
      filters: [{ field: "status_akhir.status", value: "IN" }],
      sort: [{ field: TRACKING_COLUMN_PATH, direction: "asc" }],
    };
    workspaceEngineMocks.querySheetRows
      .mockResolvedValueOnce({
        type: "sheet_rows",
        payload: {
          sheetId: "sheet-1",
          offset: 0,
          limit: 1_000,
          totalCount: 2,
          hasMore: true,
          nextOffset: 1_000,
          rows: [
            {
              rowId: "rust-row-1",
              position: 0,
              displayTrackingId: "RUST-A",
              lookupTrackingId: "RUST-A",
              rowStatus: "loaded",
              errorMessage: null,
              statusJson: { status: "INLOCATION" },
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
          offset: 1_000,
          limit: 1_000,
          totalCount: 2,
          hasMore: false,
          nextOffset: null,
          rows: [
            {
              rowId: "rust-row-2",
              position: 1,
              displayTrackingId: "RUST-B",
              lookupTrackingId: "RUST-B",
              rowStatus: "loaded",
              errorMessage: null,
              statusJson: { status: "INVEHICLE" },
              detailJson: null,
              historyJson: null,
            },
          ],
        },
      });

    const { result } = renderHook(() =>
      useWorkspaceCommandsController(options as never)
    );

    await act(async () => {
      result.current.copyAllTrackingIds();
    });

    await waitFor(() => {
      expect(options.copyText).toHaveBeenCalledTimes(1);
    });

    expect(workspaceEngineMocks.querySheetRows).toHaveBeenNthCalledWith(1, {
      ...options.rustExportRowsQuery,
      offset: 0,
      limit: 1_000,
    });
    expect(workspaceEngineMocks.querySheetRows).toHaveBeenNthCalledWith(2, {
      ...options.rustExportRowsQuery,
      offset: 1_000,
      limit: 1_000,
    });
    expect(options.copyText).toHaveBeenCalledWith("RUST-A\nRUST-B");
  });

  it("forces refresh when retrying failed rows", async () => {
    const options = buildOptions();
    options.retryFailedEntries = [
      { key: "row-1", value: "P2603310114291" },
    ];
    const { result } = renderHook(() =>
      useWorkspaceCommandsController(options as never)
    );

    await act(async () => {
      result.current.retryFailedRows();
    });

    expect(options.refreshTrackingRows).toHaveBeenCalledWith(
      "sheet-1",
      options.retryFailedEntries,
      { forceRefresh: true }
    );
  });

  it("refreshes failed Rust rows through the batch tracking command", async () => {
    const options = buildOptions();
    options.retryFailedEntries = [
      {
        key: "legacy-row-key",
        value: "RUST-FAILED",
        engineRowId: "rust-failed-row",
      },
    ];
    options.rustExportRowsQuery = {
      sheetId: "sheet-1",
      offset: 0,
      limit: 1_000,
      filters: [],
      sort: [],
    };
    workspaceEngineMocks.refreshSheetRowsTracking.mockImplementationOnce(async (payload) => ({
      type: "sheet_rows_tracking_refresh",
      payload: {
        sheetId: "sheet-1",
        runId: payload.runId,
        successCount: 1,
        failedCount: 0,
        rows: [],
      },
    }));

    const { result } = renderHook(() =>
      useWorkspaceCommandsController(options as never)
    );

    await act(async () => {
      result.current.retryFailedRows();
    });

    await waitFor(() => {
      expect(workspaceEngineMocks.refreshSheetRowsTracking).toHaveBeenCalledTimes(1);
    });

    expect(workspaceEngineMocks.refreshSheetRowsTracking).toHaveBeenCalledWith(
      expect.objectContaining({
        sheetId: "sheet-1",
        rowIds: ["rust-failed-row"],
        forceRefresh: true,
        runId: expect.any(String),
      }),
      expect.any(Function)
    );
    expect(options.refreshTrackingRows).not.toHaveBeenCalled();
    expect(workspaceEngineMocks.querySheetRows).not.toHaveBeenCalled();
    expect(options.updateActiveSheet).not.toHaveBeenCalled();
    expect(options.onWorkspaceEngineMutation).toHaveBeenCalledWith("sheet-1");
    expect(options.showNotice).toHaveBeenLastCalledWith({
      tone: "success",
      message: "Lacak ulang berhasil.",
    });
  });

  it("rejects an overlapping Rust tracking command for the same sheet", async () => {
    const options = buildOptions();
    options.retryFailedEntries = [
      {
        key: "legacy-row-key",
        value: "RUST-FAILED",
        engineRowId: "rust-failed-row",
      },
    ];
    options.rustExportRowsQuery = {
      sheetId: "sheet-1",
      offset: 0,
      limit: 1_000,
      filters: [],
      sort: [],
    };
    const refreshDeferred = createDeferred<{
      type: "sheet_rows_tracking_refresh";
      payload: {
        sheetId: string;
        runId?: string | null;
        successCount: number;
        failedCount: number;
        rows: [];
      };
    }>();
    workspaceEngineMocks.refreshSheetRowsTracking.mockReturnValue(
      refreshDeferred.promise
    );

    const { result } = renderHook(() =>
      useWorkspaceCommandsController(options as never)
    );

    act(() => {
      result.current.retryFailedRows();
      result.current.retryFailedRows();
    });

    expect(workspaceEngineMocks.refreshSheetRowsTracking).toHaveBeenCalledTimes(1);
    expect(options.showNotice).toHaveBeenCalledWith({
      tone: "info",
      message: "Proses lacak untuk sheet ini masih berjalan.",
    });

    const firstCall = workspaceEngineMocks.refreshSheetRowsTracking.mock
      .calls[0]?.[0];
    await act(async () => {
      refreshDeferred.resolve({
        type: "sheet_rows_tracking_refresh",
        payload: {
          sheetId: "sheet-1",
          runId: firstCall?.runId,
          successCount: 1,
          failedCount: 0,
          rows: [],
        },
      });
      await refreshDeferred.promise;
    });
  });

  it("projects retrack progress as loading then ready without marking all rows active", async () => {
    const options = buildOptions();
    options.retryFailedEntries = [
      {
        key: "row-1",
        value: "P2603310114291",
        engineRowId: "row-1",
      },
    ];
    options.rustExportRowsQuery = {
      sheetId: "sheet-1",
      offset: 0,
      limit: 1_000,
      filters: [],
      sort: [],
    };
    workspaceEngineMocks.refreshSheetRowsTracking.mockImplementationOnce(
      async (payload, onEvent) => {
        onEvent({
          type: "tracking_refresh_progress",
          payload: {
            sheetId: "sheet-1",
            runId: payload.runId,
            totalCount: 1,
            successCount: 0,
            failedCount: 0,
            pendingCount: 1,
            row: {
              rowId: "row-1",
              position: 0,
              displayTrackingId: "P2603310114291",
              lookupTrackingId: "P2603310114291",
              rowStatus: "loading",
              errorMessage: null,
              statusJson: null,
              detailJson: null,
              historyJson: null,
            },
          },
        });
        onEvent({
          type: "tracking_refresh_progress",
          payload: {
            sheetId: "sheet-1",
            runId: payload.runId,
            totalCount: 1,
            successCount: 0,
            failedCount: 0,
            pendingCount: 1,
            row: {
              rowId: "row-1",
              position: 0,
              displayTrackingId: "P2603310114291",
              lookupTrackingId: "P2603310114291",
              rowStatus: "pending",
              errorMessage: null,
              statusJson: null,
              detailJson: null,
              historyJson: null,
            },
          },
        });
        onEvent({
          type: "tracking_refresh_progress",
          payload: {
            sheetId: "sheet-1",
            runId: payload.runId,
            totalCount: 1,
            successCount: 1,
            failedCount: 0,
            pendingCount: 0,
            row: {
              rowId: "row-1",
              position: 0,
              displayTrackingId: "P2603310114291",
              lookupTrackingId: "P2603310114291",
              rowStatus: "loaded",
              errorMessage: null,
              statusJson: { status: "DELIVERED" },
              detailJson: {
                shipment_header: {
                  nomor_kiriman: "P2603310114291",
                },
              },
              historyJson: null,
            },
          },
        });

        return {
          type: "sheet_rows_tracking_refresh",
          payload: {
            sheetId: "sheet-1",
            runId: payload.runId,
            successCount: 1,
            failedCount: 0,
            rows: [],
          },
        };
      }
    );

    const { result } = renderHook(() =>
      useWorkspaceCommandsController(options as never)
    );

    await act(async () => {
      result.current.retryFailedRows();
    });

    await waitFor(() => {
      expect(options.setWorkspaceState).toHaveBeenCalledTimes(5);
    });

    const workspaceUpdaters = vi
      .mocked(options.setWorkspaceState)
      .mock.calls.map(([updater]) => updater);
    const baseWorkspace: WorkspaceState = {
      ...options.workspaceRef.current,
      sheetsById: {
        ...options.workspaceRef.current.sheetsById,
        "sheet-1": {
          ...createDefaultSheetState(),
          rows: [createRow()],
        },
      },
    };
    const workspaces = workspaceUpdaters.reduce<WorkspaceState[]>(
      (states, updater) => {
        const previous = states[states.length - 1];
        const next =
          typeof updater === "function" ? updater(previous) : updater;
        return [...states, next];
      },
      [baseWorkspace]
    );
    const loadingWorkspace = workspaces[2];
    const latePendingWorkspace = workspaces[3];
    const loadedWorkspace = workspaces[4];
    const loadingSheet = loadingWorkspace.sheetsById["sheet-1"];
    const latePendingSheet = latePendingWorkspace.sheetsById["sheet-1"];
    const loadedSheet = loadedWorkspace.sheetsById["sheet-1"];

    expect(loadingSheet.rows[0]).toMatchObject({
      loading: true,
      queued: false,
    });
    expect(latePendingSheet.rows[0]).toMatchObject({
      loading: true,
      queued: false,
    });
    expect(loadedSheet.rows[0]).toMatchObject({
      loading: false,
      queued: false,
      error: "",
    });
    expect(loadedSheet.rows[0]?.shipment?.status_akhir.status).toBe("DELIVERED");
    expect(options.onWorkspaceEngineMutation).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to frontend failed-row retry for Rust rows without engine row ids", async () => {
    const options = buildOptions();
    options.retryFailedEntries = [
      { key: "row-1", value: "P2603310114291" },
    ];
    options.rustExportRowsQuery = {
      sheetId: "sheet-1",
      offset: 0,
      limit: 1_000,
      filters: [{ field: "status_akhir.status", value: "FAILED" }],
      sort: [],
    };
    const { result } = renderHook(() =>
      useWorkspaceCommandsController(options as never)
    );

    await act(async () => {
      result.current.retryFailedRows();
    });

    expect(options.showNotice).toHaveBeenCalledWith({
      tone: "error",
      message: "Lacak ulang gagal: target row Rust belum lengkap.",
    });
    expect(options.refreshTrackingRows).not.toHaveBeenCalled();
    expect(workspaceEngineMocks.querySheetRows).not.toHaveBeenCalled();
    expect(workspaceEngineMocks.refreshSheetRowsTracking).not.toHaveBeenCalled();
  });

  it("forces refresh when retracking all rows", async () => {
    const options = buildOptions();
    options.retrackableRows = [
      { key: "row-1", value: "P2603310114291" },
    ];
    const { result } = renderHook(() =>
      useWorkspaceCommandsController(options as never)
    );

    await act(async () => {
      result.current.retrackAllRows();
      await Promise.resolve();
    });

    expect(options.refreshTrackingRows).toHaveBeenCalledWith(
      "sheet-1",
      options.retrackableRows,
      { forceRefresh: true }
    );
  });

  it("refreshes all Rust sheet rows without frontend bulk row orchestration", async () => {
    const options = buildOptions();
    options.rustExportRowsQuery = {
      sheetId: "sheet-1",
      offset: 0,
      limit: 1_000,
      filters: [],
      sort: [],
    };
    workspaceEngineMocks.refreshSheetRowsTracking.mockImplementationOnce(async (payload) => ({
      type: "sheet_rows_tracking_refresh",
      payload: {
        sheetId: "sheet-1",
        runId: payload.runId,
        successCount: 2,
        failedCount: 0,
        rows: [],
      },
    }));

    const { result } = renderHook(() =>
      useWorkspaceCommandsController(options as never)
    );

    await act(async () => {
      result.current.retrackAllRows();
    });

    await waitFor(() => {
      expect(workspaceEngineMocks.refreshSheetRowsTracking).toHaveBeenCalledTimes(1);
    });

    expect(workspaceEngineMocks.refreshSheetRowsTracking).toHaveBeenCalledWith(
      expect.objectContaining({
        sheetId: "sheet-1",
        rowIds: [],
        forceRefresh: true,
        runId: expect.any(String),
      }),
      expect.any(Function)
    );
    expect(workspaceEngineMocks.querySheetRows).not.toHaveBeenCalled();
    expect(options.refreshTrackingRows).not.toHaveBeenCalled();
    expect(options.updateActiveSheet).not.toHaveBeenCalled();
    expect(options.onWorkspaceEngineMutation).toHaveBeenCalledWith("sheet-1");
    expect(options.showNotice).toHaveBeenLastCalledWith({
      tone: "success",
      message: "Lacak ulang berhasil.",
    });
  });

  it("refreshes filtered Rust rows by collecting row ids from the Rust query", async () => {
    const options = buildOptions();
    options.rustExportRowsQuery = {
      sheetId: "sheet-1",
      offset: 0,
      limit: 1_000,
      filters: [{ field: "status_akhir.status", value: "IN" }],
      valueFilters: [{ field: "detail.package_detail.jenis_layanan", values: ["PKH"] }],
      sort: [],
    };
    workspaceEngineMocks.querySheetRows
      .mockResolvedValueOnce({
        type: "sheet_rows",
        payload: {
          sheetId: "sheet-1",
          offset: 0,
          limit: 1_000,
          totalCount: 1,
          hasMore: false,
          nextOffset: null,
          rows: [
            {
              rowId: "rust-filtered-row",
              position: 0,
              displayTrackingId: "RUST-F",
              lookupTrackingId: "RUST-F",
              rowStatus: "loaded",
              errorMessage: null,
              statusJson: { status: "INLOCATION" },
              detailJson: {
                shipment_header: {
                  nomor_kiriman: "RUST-F",
                },
              },
              historyJson: null,
            },
          ],
        },
      })
      ;
    workspaceEngineMocks.refreshSheetRowsTracking.mockImplementationOnce(async (payload) => ({
      type: "sheet_rows_tracking_refresh",
      payload: {
        sheetId: "sheet-1",
        runId: payload.runId,
        successCount: 1,
        failedCount: 0,
        rows: [],
      },
    }));

    const { result } = renderHook(() =>
      useWorkspaceCommandsController(options as never)
    );

    await act(async () => {
      result.current.retrackAllRows();
    });

    await waitFor(() => {
      expect(workspaceEngineMocks.refreshSheetRowsTracking).toHaveBeenCalledTimes(1);
    });

    expect(workspaceEngineMocks.refreshSheetRowsTracking).toHaveBeenCalledWith(
      expect.objectContaining({
        sheetId: "sheet-1",
        rowIds: ["rust-filtered-row"],
        forceRefresh: true,
        runId: expect.any(String),
      }),
      expect.any(Function)
    );
    expect(workspaceEngineMocks.querySheetRows).toHaveBeenCalledTimes(1);
    expect(workspaceEngineMocks.querySheetRows).toHaveBeenCalledWith({
      ...options.rustExportRowsQuery,
      offset: 0,
      limit: 1_000,
    });
    expect(options.refreshTrackingRows).not.toHaveBeenCalled();
    expect(options.updateActiveSheet).not.toHaveBeenCalled();
    expect(options.onWorkspaceEngineMutation).toHaveBeenCalledWith("sheet-1");
  });
});
