import { describe, expect, it } from "vitest";
import { createDefaultSheetState } from "../sheet/default-state";
import { applyProjectedBulkPasteDraftToSheet } from "./useTrackingRuntimeController";

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

    expect(result.targetEntries).toEqual([
      {
        key: "rust-row-7",
        value: "P7",
        position: 7,
      },
      {
        key: "sheet-1:row:8",
        value: "P8",
        position: 8,
      },
      {
        key: "sheet-1:row:9",
        value: "P9",
        position: 9,
      },
    ]);
    expect(
      result.sheetState.rows
        .filter((row) => result.targetEntries.some((entry) => entry.key === row.key))
        .map((row) => [row.key, row.trackingInput])
    ).toEqual([
      ["rust-row-7", "P7"],
      ["sheet-1:row:8", "P8"],
      ["sheet-1:row:9", "P9"],
    ]);
    expect(result.sheetState.selectedRowKeys).toEqual([
      "rust-row-7",
      "sheet-1:row:8",
      "sheet-1:row:9",
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

    expect(result.targetEntries).toEqual([
      {
        key: "legacy-visible-key",
        value: "P4",
        position: 4,
        engineRowId: "rust-row-4",
      },
      {
        key: "sheet-1:row:5",
        value: "P5",
        position: 5,
      },
    ]);
  });
});
