import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createSheetInWorkspace } from "./actions";
import { createDefaultWorkspaceState } from "./default-state";
import { useSelectionTransferController } from "./useSelectionTransferController";
import {
  createEngineSheet,
  deleteSheet,
  querySheetRows,
  transferSheetRows,
} from "../workspace-engine/client";

vi.mock("../workspace-engine/client", async () => {
  const actual = await vi.importActual<object>("../workspace-engine/client");
  return {
    ...actual,
    createEngineSheet: vi.fn(),
    deleteSheet: vi.fn(),
    querySheetRows: vi.fn(),
    transferSheetRows: vi.fn(),
  };
});

const createEngineSheetMock = vi.mocked(createEngineSheet);
const deleteSheetMock = vi.mocked(deleteSheet);
const querySheetRowsMock = vi.mocked(querySheetRows);
const transferSheetRowsMock = vi.mocked(transferSheetRows);

describe("useSelectionTransferController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createEngineSheetMock.mockResolvedValue({
      type: "sheet",
      payload: {
        sheetId: "sheet-2",
        workspaceId: "workspace-1",
        name: "Sheet 2",
        position: 1,
        viewMode: "workspace",
      },
    });
    deleteSheetMock.mockResolvedValue({
      type: "sheet_deleted",
      payload: { sheetId: "sheet-2" },
    });
    querySheetRowsMock.mockResolvedValue({
      type: "sheet_rows",
      payload: {
        sheetId: "sheet-1",
        offset: 0,
        limit: 100_000,
        totalCount: 0,
        hasMore: false,
        nextOffset: null,
        rows: [],
      },
    });
  });

  it("copies selected rows through the Rust transfer command instead of bulk paste refetch", async () => {
    let workspace = createDefaultWorkspaceState();
    const sourceSheetId = workspace.activeSheetId;
    workspace = createSheetInWorkspace(workspace, {
      activate: false,
      name: "Target",
    });
    const targetSheetId = workspace.sheetOrder.find((sheetId) => sheetId !== sourceSheetId);
    if (!targetSheetId) {
      throw new Error("target sheet was not created");
    }
    const setWorkspaceState = vi.fn();
    const onWorkspaceEngineMutation = vi.fn();
    transferSheetRowsMock.mockResolvedValueOnce({
      type: "sheet_rows",
      payload: {
        sheetId: targetSheetId,
        offset: 0,
        limit: 1000,
        totalCount: 1,
        hasMore: false,
        nextOffset: null,
        rows: [
          {
            rowId: `${targetSheetId}:row:0`,
            position: 0,
            displayTrackingId: "P2606020189412.30",
            lookupTrackingId: "P2606020189412",
            rowStatus: "loaded",
            errorMessage: null,
            statusJson: {
              status: "DELIVERED",
            },
            detailJson: {
              shipment_header: {
                nomor_kiriman: "P2606020189412.30",
              },
            },
            historyJson: null,
          },
        ],
      },
    });

    const { result } = renderHook(() =>
      useSelectionTransferController({
        activeSheetId: sourceSheetId,
        workspaceTabs: workspace.sheetOrder.map((sheetId) => ({
          id: sheetId,
          name: workspace.sheetMetaById[sheetId]?.name ?? "Sheet",
        })),
        selectedTrackingIds: ["P2606020189412.30"],
        selectedEngineRowIds: ["rust-source-row-1"],
        selectedVisibleRowKeys: ["legacy-visible-key"],
        workspaceRef: { current: workspace },
        setWorkspaceState,
        setHoveredColumn: vi.fn(),
        disarmDeleteAll: vi.fn(),
        disarmDeleteSelected: vi.fn(),
        abortRowTrackingWork: vi.fn(),
        showNotice: vi.fn(),
        onWorkspaceEngineMutation,
      })
    );

    await act(async () => {
      await result.current.transferSelectedIdsToExistingSheet("copy", targetSheetId);
    });

    expect(createEngineSheetMock).not.toHaveBeenCalled();
    expect(transferSheetRowsMock).toHaveBeenCalledWith({
      sourceSheetId,
      targetSheetId,
      rowIds: ["rust-source-row-1"],
      mode: "copy",
    });
    expect(onWorkspaceEngineMutation).toHaveBeenCalledWith([
      sourceSheetId,
      targetSheetId,
    ]);
    expect(setWorkspaceState).not.toHaveBeenCalled();
  });

  it("resolves selected local row keys to engine row ids before transfer", async () => {
    let workspace = createDefaultWorkspaceState();
    const sourceSheetId = workspace.activeSheetId;
    workspace = createSheetInWorkspace(workspace, {
      activate: false,
      name: "Target",
    });
    const targetSheetId = workspace.sheetOrder.find((sheetId) => sheetId !== sourceSheetId);
    if (!targetSheetId) {
      throw new Error("target sheet was not created");
    }
    const setWorkspaceState = vi.fn();
    const onWorkspaceEngineMutation = vi.fn();
    querySheetRowsMock.mockResolvedValueOnce({
      type: "sheet_rows",
      payload: {
        sheetId: sourceSheetId,
        offset: 0,
        limit: 100_000,
        totalCount: 1,
        hasMore: false,
        nextOffset: null,
        rows: [
          {
            rowId: `${sourceSheetId}:row:0`,
            position: 0,
            displayTrackingId: "PLOCAL",
            lookupTrackingId: "PLOCAL",
            rowStatus: "loaded",
            errorMessage: null,
            statusJson: null,
            detailJson: null,
            historyJson: null,
          },
        ],
      },
    });
    transferSheetRowsMock.mockResolvedValueOnce({
      type: "sheet_rows",
      payload: {
        sheetId: targetSheetId,
        offset: 0,
        limit: 1000,
        totalCount: 1,
        hasMore: false,
        nextOffset: null,
        rows: [],
      },
    });

    const { result } = renderHook(() =>
      useSelectionTransferController({
        activeSheetId: sourceSheetId,
        workspaceTabs: workspace.sheetOrder.map((sheetId) => ({
          id: sheetId,
          name: workspace.sheetMetaById[sheetId]?.name ?? "Sheet",
        })),
        selectedTrackingIds: ["PLOCAL"],
        selectedEngineRowIds: [],
        selectedVisibleRowKeys: ["local-ui-row-key"],
        workspaceRef: { current: workspace },
        setWorkspaceState,
        setHoveredColumn: vi.fn(),
        disarmDeleteAll: vi.fn(),
        disarmDeleteSelected: vi.fn(),
        abortRowTrackingWork: vi.fn(),
        showNotice: vi.fn(),
        onWorkspaceEngineMutation,
      })
    );

    await act(async () => {
      await result.current.transferSelectedIdsToExistingSheet("copy", targetSheetId);
    });

    expect(querySheetRowsMock).toHaveBeenCalledWith({
      sheetId: sourceSheetId,
      offset: 0,
      limit: 100_000,
      filters: [],
      sort: [],
    });
    expect(transferSheetRowsMock).toHaveBeenCalledWith({
      sourceSheetId,
      targetSheetId,
      rowIds: [`${sourceSheetId}:row:0`],
      mode: "copy",
    });
  });

  it("creates the Rust target sheet before copying selected rows into a new sheet", async () => {
    const workspace = createDefaultWorkspaceState();
    const sourceSheetId = workspace.activeSheetId;
    const setWorkspaceState = vi.fn();
    const onWorkspaceEngineMutation = vi.fn();
    transferSheetRowsMock.mockResolvedValueOnce({
      type: "sheet_rows",
      payload: {
        sheetId: "sheet-2",
        offset: 0,
        limit: 1000,
        totalCount: 1,
        hasMore: false,
        nextOffset: null,
        rows: [
          {
            rowId: "sheet-2:row:0",
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

    const { result } = renderHook(() =>
      useSelectionTransferController({
        activeSheetId: sourceSheetId,
        workspaceTabs: workspace.sheetOrder.map((sheetId) => ({
          id: sheetId,
          name: workspace.sheetMetaById[sheetId]?.name ?? "Sheet",
        })),
        selectedTrackingIds: ["P2606020189412.30"],
        selectedEngineRowIds: ["rust-source-row-1"],
        selectedVisibleRowKeys: ["legacy-visible-key"],
        workspaceRef: { current: workspace },
        setWorkspaceState,
        setHoveredColumn: vi.fn(),
        disarmDeleteAll: vi.fn(),
        disarmDeleteSelected: vi.fn(),
        abortRowTrackingWork: vi.fn(),
        showNotice: vi.fn(),
        onWorkspaceEngineMutation,
      })
    );

    await act(async () => {
      await result.current.transferSelectedIdsToNewSheet("copy");
    });

    expect(createEngineSheetMock).toHaveBeenCalledWith({
      sheetId: expect.any(String),
      name: "Sheet 1 - 1",
      position: 1,
    });
    expect(transferSheetRowsMock).toHaveBeenCalledWith({
      sourceSheetId,
      targetSheetId: expect.any(String),
      rowIds: ["rust-source-row-1"],
      mode: "copy",
    });
    expect(onWorkspaceEngineMutation).toHaveBeenCalledWith([
      sourceSheetId,
      expect.any(String),
    ]);
    expect(setWorkspaceState).toHaveBeenCalledTimes(1);
    const nextWorkspace = setWorkspaceState.mock.calls[0]?.[0];
    const targetSheetId = nextWorkspace?.activeSheetId ?? "";
    expect(nextWorkspace?.sheetsById[targetSheetId]?.rows[0]?.trackingInput).toBe("");
    expect(nextWorkspace?.sheetsById[targetSheetId]?.rows[0]?.shipment).toBeNull();
  });
});
