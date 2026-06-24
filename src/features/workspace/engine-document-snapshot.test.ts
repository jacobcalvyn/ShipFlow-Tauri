import {
  type SheetRowsQuery,
  type SheetRowsResponse,
} from "../workspace-engine/client";
import { createDefaultWorkspaceState } from "./default-state";
import { createWorkspaceDocumentStateFromEngine } from "./engine-document-snapshot";

function createEngineRowsResponse(
  query: SheetRowsQuery,
  rows: SheetRowsResponse["payload"]["rows"],
  options?: {
    totalCount?: number;
    hasMore?: boolean;
    nextOffset?: number | null;
  }
): SheetRowsResponse {
  return {
    type: "sheet_rows",
    payload: {
      sheetId: query.sheetId,
      offset: query.offset,
      limit: query.limit,
      totalCount: options?.totalCount ?? rows.length,
      hasMore: options?.hasMore ?? false,
      nextOffset: options?.nextOffset ?? null,
      rows,
    },
  };
}

describe("engine document snapshot", () => {
  it("builds saved workspace rows only from paginated Rust row windows", async () => {
    const workspace = createDefaultWorkspaceState();
    const sheetId = workspace.activeSheetId;
    const workspaceWithUnsyncedRow = {
      ...workspace,
      sheetsById: {
        ...workspace.sheetsById,
        [sheetId]: {
          ...workspace.sheetsById[sheetId],
          rows: [
            {
              ...workspace.sheetsById[sheetId].rows[0],
              key: "legacy-unsynced-row",
              trackingInput: "PLOCAL1",
            },
            ...workspace.sheetsById[sheetId].rows.slice(1),
          ],
        },
      },
    };
    const queryRows = vi.fn(async (query: SheetRowsQuery) => {
      if (query.offset === 0) {
        return createEngineRowsResponse(
          query,
          [
            {
              rowId: "engine-row-1",
              position: 0,
              displayTrackingId: "PENGINE1",
              lookupTrackingId: "PENGINE1",
              rowStatus: "loaded",
              errorMessage: null,
              statusJson: {
                status: "DELIVERED",
              },
              detailJson: {
                shipment_header: {
                  nomor_kiriman: "PENGINE1",
                },
              },
              historyJson: {
                history: [],
                history_summary: {
                  irregularity: [],
                  bagging_unbagging: [],
                  manifest_r7: [],
                  delivery_runsheet: [],
                },
              },
            },
          ],
          {
            totalCount: 2,
            hasMore: true,
            nextOffset: 1,
          }
        );
      }

      return createEngineRowsResponse(
        query,
        [
          {
            rowId: "engine-row-2",
            position: 1,
            displayTrackingId: "PENGINE2",
            lookupTrackingId: "PENGINE2",
            rowStatus: "empty",
            errorMessage: null,
            statusJson: null,
            detailJson: null,
            historyJson: null,
          },
        ],
        {
          totalCount: 2,
        }
      );
    });

    const snapshot = await createWorkspaceDocumentStateFromEngine(
      workspaceWithUnsyncedRow,
      queryRows
    );

    expect(queryRows).toHaveBeenNthCalledWith(1, {
      sheetId,
      offset: 0,
      limit: 1000,
      filters: [],
      valueFilters: [],
      sort: [],
    });
    expect(queryRows).toHaveBeenNthCalledWith(2, {
      sheetId,
      offset: 1,
      limit: 1000,
      filters: [],
      valueFilters: [],
      sort: [],
    });

    const savedRows = snapshot.sheetsById[sheetId].rows;
    expect(savedRows[0].key).toBe("engine-row-1");
    expect(savedRows[0].trackingInput).toBe("PENGINE1");
    expect(savedRows[0].shipment?.status_akhir.status).toBe("DELIVERED");
    expect(savedRows[1].key).toBe("engine-row-2");
    expect(savedRows[1].shipment).toBeNull();
    expect(savedRows.some((row) => row.key === "legacy-unsynced-row")).toBe(false);
    expect(savedRows.some((row) => row.trackingInput === "PLOCAL1")).toBe(false);
    expect(
      savedRows.slice(2).every((row) => row.trackingInput === "" && row.shipment === null)
    ).toBe(true);
    expect(savedRows.slice(2)).toHaveLength(5);
  });

  it("fails fast when Rust row-window pagination stalls", async () => {
    const workspace = createDefaultWorkspaceState();
    const sheetId = workspace.activeSheetId;
    const queryRows = vi.fn(async (query: SheetRowsQuery) =>
      createEngineRowsResponse(query, [], {
        totalCount: 10,
        hasMore: true,
        nextOffset: query.offset,
      })
    );

    await expect(
      createWorkspaceDocumentStateFromEngine(workspace, queryRows)
    ).rejects.toThrow("Rust document snapshot pagination stalled.");
    expect(queryRows).toHaveBeenCalledWith({
      sheetId,
      offset: 0,
      limit: 1000,
      filters: [],
      valueFilters: [],
      sort: [],
    });
  });
});
