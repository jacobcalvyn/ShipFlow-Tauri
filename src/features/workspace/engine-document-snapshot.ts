import { ensureTrailingEmptyRows } from "../sheet/utils";
import { createTrackResponseFromProjection } from "../sheet/rust-row-window-adapter";
import type { SheetRow } from "../sheet/types";
import {
  querySheetRows,
  type SheetRowProjection,
  type SheetRowsQuery,
  type SheetRowsResponse,
} from "../workspace-engine/client";
import type { WorkspaceState } from "./types";

const ENGINE_DOCUMENT_ROW_WINDOW_LIMIT = 1_000;

type QuerySheetRowsClient = (query: SheetRowsQuery) => Promise<SheetRowsResponse>;

function createSheetRowFromProjection(row: SheetRowProjection): SheetRow {
  return {
    key: row.rowId,
    trackingInput: row.displayTrackingId,
    shipment: createTrackResponseFromProjection(row),
    loading: row.rowStatus === "loading",
    queued: false,
    stale: row.rowStatus === "stale",
    dirty: false,
    error: row.errorMessage ?? "",
  };
}

async function collectEngineRowsForDocument(
  sheetId: string,
  queryRows: QuerySheetRowsClient
) {
  const rows: SheetRow[] = [];
  let offset = 0;

  while (true) {
    const response = await queryRows({
      sheetId,
      offset,
      limit: ENGINE_DOCUMENT_ROW_WINDOW_LIMIT,
      filters: [],
      valueFilters: [],
      sort: [],
    });

    for (const projection of response.payload.rows) {
      rows.push(createSheetRowFromProjection(projection));
    }

    if (!response.payload.hasMore || response.payload.nextOffset === null) {
      break;
    }

    if (response.payload.nextOffset <= offset) {
      throw new Error("Rust document snapshot pagination stalled.");
    }

    offset = response.payload.nextOffset;
  }

  return ensureTrailingEmptyRows(rows);
}

export async function createWorkspaceDocumentStateFromEngine(
  workspaceState: WorkspaceState,
  queryRows: QuerySheetRowsClient = querySheetRows
): Promise<WorkspaceState> {
  const sheetsById = { ...workspaceState.sheetsById };

  for (const sheetId of workspaceState.sheetOrder) {
    const sheet = workspaceState.sheetsById[sheetId];
    if (!sheet) {
      continue;
    }

    sheetsById[sheetId] = {
      ...sheet,
      rows: await collectEngineRowsForDocument(sheetId, queryRows),
    };
  }

  return {
    ...workspaceState,
    sheetsById,
  };
}
