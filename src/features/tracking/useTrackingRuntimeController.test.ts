import { describe, expect, it, vi } from "vitest";
import { createDefaultSheetState } from "../sheet/default-state";
import {
  applyProjectedBulkPasteDraftToSheet,
  createBulkPasteTargetEntries,
  resolveProjectedBulkPasteTargetEntries,
} from "./useTrackingRuntimeController";

describe("tracking runtime controller helpers", () => {
  it("creates local draft rows for projected Rust bulk paste targets", () => {
    const sheet = createDefaultSheetState();

    const result = applyProjectedBulkPasteDraftToSheet(
      sheet,
      "sheet-1",
      "rust-row-7",
      7,
      ["P7", "P8", "P9"]
    );

    expect(result.targetEntries[0]).toEqual({
      key: "rust-row-7",
      value: "P7",
      position: 7,
    });
    expect(result.targetEntries[1]?.key).toMatch(/^sheet-1:paste:/);
    expect(result.targetEntries[1]?.value).toBe("P8");
    expect(result.targetEntries[1]?.position).toBe(8);
    expect(result.targetEntries[2]?.key).toMatch(/^sheet-1:paste:/);
    expect(result.targetEntries[2]?.value).toBe("P9");
    expect(result.targetEntries[2]?.position).toBe(9);
    expect(
      result.sheetState.rows
        .filter((row) => result.targetEntries.some((entry) => entry.key === row.key))
        .map((row) => [row.key, row.trackingInput])
    ).toEqual([
      ["rust-row-7", "P7"],
      [result.targetEntries[1].key, "P8"],
      [result.targetEntries[2].key, "P9"],
    ]);
    expect(result.sheetState.selectedRowKeys).toEqual([
      "engine:rust-row-7",
      `engine:${result.targetEntries[1].key}`,
      `engine:${result.targetEntries[2].key}`,
    ]);
  });

  it("keeps the engine row id on the first projected bulk paste target", () => {
    const sheet = createDefaultSheetState();

    const result = applyProjectedBulkPasteDraftToSheet(
      sheet,
      "sheet-1",
      "legacy-visible-key",
      4,
      ["P4", "P5"],
      "rust-row-4"
    );

    expect(result.targetEntries[0]).toEqual({
      key: "legacy-visible-key",
      value: "P4",
      position: 4,
      engineRowId: "rust-row-4",
    });
    expect(result.targetEntries[1]?.key).toMatch(/^sheet-1:paste:/);
    expect(result.targetEntries[1]?.value).toBe("P5");
    expect(result.targetEntries[1]?.position).toBe(5);
  });

  it("pastes along displayed projection order instead of local document order", () => {
    const targets = createBulkPasteTargetEntries({
      sheetId: "sheet-1",
      startRowKey: "visible-b",
      values: ["PB", "PC", "PNEW"],
      startPosition: 40,
      displayedRows: [
        { key: "visible-a", position: 10, engineRowId: "engine-a" },
        { key: "visible-b", position: 40, engineRowId: "engine-b" },
        { key: "visible-c", position: 90, engineRowId: "engine-c" },
      ],
      nextAppendPosition: 120,
    });

    expect(targets[0]).toEqual({
      key: "visible-b",
      value: "PB",
      position: 40,
      engineRowId: "engine-b",
    });
    expect(targets[1]).toEqual({
      key: "visible-c",
      value: "PC",
      position: 90,
      engineRowId: "engine-c",
    });
    expect(targets[2]?.key).toMatch(/^sheet-1:paste:/);
    expect(targets[2]?.value).toBe("PNEW");
    expect(targets[2]?.position).toBe(120);
  });

  it("continues projected bulk paste across Rust query windows before appending", async () => {
    const loadRows = vi
      .fn()
      .mockResolvedValueOnce({
        type: "sheet_rows",
        payload: {
          sheetId: "sheet-1",
          offset: 499,
          limit: 3,
          totalCount: 501,
          hasMore: true,
          nextOffset: 500,
          rows: [
            {
              rowId: "rust-row-499",
              position: 800,
              displayTrackingId: "P499",
              lookupTrackingId: "P499",
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
          offset: 500,
          limit: 2,
          totalCount: 501,
          hasMore: false,
          nextOffset: null,
          rows: [
            {
              rowId: "rust-row-500",
              position: 900,
              displayTrackingId: "P500",
              lookupTrackingId: "P500",
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
          offset: 0,
          limit: 1,
          totalCount: 501,
          hasMore: true,
          nextOffset: 1,
          rows: [
            {
              rowId: "rust-row-tail",
              position: 1_200,
              displayTrackingId: "PTAIL",
              lookupTrackingId: "PTAIL",
              rowStatus: "loaded",
              errorMessage: null,
              statusJson: null,
              detailJson: null,
              historyJson: null,
            },
          ],
        },
      });

    const targets = await resolveProjectedBulkPasteTargetEntries({
      sheetId: "sheet-1",
      values: ["P-NEW-499", "P-NEW-500", "P-APPEND"],
      displayedRows: [
        { key: "visible-499", position: 800, engineRowId: "rust-row-499" },
      ],
      startOffset: 499,
      rowsQuery: {
        sheetId: "sheet-1",
        offset: 0,
        limit: 500,
        filters: [{ field: "status_akhir.status", value: "IN" }],
        valueFilters: [],
        sort: [{ field: "position", direction: "asc" }],
      },
      loadRows,
    });

    expect(targets).toEqual([
      {
        key: "visible-499",
        value: "P-NEW-499",
        position: 800,
        engineRowId: "rust-row-499",
      },
      {
        key: "rust-row-500",
        value: "P-NEW-500",
        position: 900,
        engineRowId: "rust-row-500",
      },
      expect.objectContaining({
        value: "P-APPEND",
        position: 1_201,
      }),
    ]);
    expect(loadRows).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ offset: 500, limit: 2 })
    );
    expect(loadRows).toHaveBeenNthCalledWith(3, {
      sheetId: "sheet-1",
      offset: 0,
      limit: 1,
      filters: [],
      valueFilters: [],
      sort: [{ field: "position", direction: "desc" }],
    });
  });
});
