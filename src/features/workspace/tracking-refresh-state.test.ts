import { describe, expect, it } from "vitest";
import { createDefaultSheetState } from "../sheet/default-state";
import type { SheetRow } from "../sheet/types";
import type { TrackingRefreshProgressEvent } from "../workspace-engine/client";
import { applyTrackingRefreshProgressToSheet } from "./tracking-refresh-state";

function createRow(overrides: Partial<SheetRow> = {}): SheetRow {
  return {
    key: "row-1",
    trackingInput: "PNEW",
    shipment: null,
    loading: false,
    queued: false,
    stale: false,
    dirty: false,
    error: "",
    ...overrides,
  };
}

function createLoadedEvent(displayTrackingId: string): TrackingRefreshProgressEvent {
  return {
    sheetId: "sheet-1",
    totalCount: 1,
    successCount: 1,
    failedCount: 0,
    pendingCount: 0,
    row: {
      rowId: "row-1",
      position: 0,
      displayTrackingId,
      lookupTrackingId: displayTrackingId,
      rowStatus: "loaded",
      errorMessage: null,
      statusJson: {
        status: "DELIVERED",
      },
      detailJson: {
        shipment_header: {
          nomor_kiriman: displayTrackingId,
        },
      },
      historyJson: null,
    },
  };
}

describe("tracking refresh state", () => {
  it("ignores stale final results when the visible row input has changed", () => {
    const sheet = {
      ...createDefaultSheetState(),
      rows: [createRow({ trackingInput: "PNEW" })],
    };

    const nextSheet = applyTrackingRefreshProgressToSheet(
      sheet,
      createLoadedEvent("POLD"),
      {
        rowKey: "row-1",
      }
    );

    expect(nextSheet).toBe(sheet);
    expect(nextSheet.rows[0]).toMatchObject({
      trackingInput: "PNEW",
      shipment: null,
      loading: false,
      queued: false,
    });
  });

  it("applies matching final results to the targeted row", () => {
    const sheet = {
      ...createDefaultSheetState(),
      rows: [createRow({ trackingInput: "PNEW" })],
    };

    const nextSheet = applyTrackingRefreshProgressToSheet(
      sheet,
      createLoadedEvent("PNEW"),
      {
        rowKey: "row-1",
      }
    );

    expect(nextSheet.rows[0]).toMatchObject({
      trackingInput: "PNEW",
      loading: false,
      queued: false,
      error: "",
    });
    expect(nextSheet.rows[0]?.shipment?.detail.shipment_header.nomor_kiriman).toBe(
      "PNEW"
    );
  });

  it("creates a local mirror row for loaded Rust-only projections", () => {
    const sheet = {
      ...createDefaultSheetState(),
      rows: [],
    };

    const nextSheet = applyTrackingRefreshProgressToSheet(
      sheet,
      createLoadedEvent("PNEW"),
      {
        createMissingRow: true,
      }
    );

    expect(nextSheet.rows.length).toBeGreaterThanOrEqual(1);
    expect(nextSheet.rows[0]).toMatchObject({
      key: "row-1",
      trackingInput: "PNEW",
      loading: false,
      queued: false,
      error: "",
    });
    expect(nextSheet.rows[0]?.shipment?.detail.shipment_header.nomor_kiriman).toBe(
      "PNEW"
    );
  });

  it("does not create a mirror row for Rust-only projections by default", () => {
    const sheet = {
      ...createDefaultSheetState(),
      rows: [],
    };

    const nextSheet = applyTrackingRefreshProgressToSheet(
      sheet,
      createLoadedEvent("PNEW")
    );

    expect(nextSheet).toBe(sheet);
    expect(nextSheet.rows).toEqual([]);
  });
});
