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

function createShipment(trackingId: string): NonNullable<SheetRow["shipment"]> {
  return {
    url: "https://example.test",
    detail: {
      shipment_header: { nomor_kiriman: trackingId },
      origin_detail: {},
      package_detail: {},
      billing_detail: { cod_info: { is_cod: false } },
      actors: { pengirim: {}, penerima: {} },
      performance_detail: {},
    },
    status_akhir: { status: "DELIVERED" },
    pod: {},
    history: [],
    history_summary: {
      irregularity: [],
      bagging_unbagging: [],
      manifest_r7: [],
      delivery_runsheet: [],
    },
  };
}

describe("tracking refresh state", () => {
  it("ignores progress from a stale tracking run", () => {
    const sheet = {
      ...createDefaultSheetState(),
      activeTrackingRunId: "run-current",
      rows: [createRow({ trackingInput: "PNEW" })],
    };

    const staleEvent = {
      ...createLoadedEvent("PNEW"),
      runId: "run-old",
    };
    const nextSheet = applyTrackingRefreshProgressToSheet(sheet, staleEvent, {
      rowKey: "row-1",
    });

    expect(nextSheet).toBe(sheet);
    expect(nextSheet.rows[0]?.shipment).toBeNull();
  });

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

  it("marks terminal progress rows with the active tracking run", () => {
    const sheet = {
      ...createDefaultSheetState(),
      activeTrackingRunId: "run-1",
      rows: [createRow({ trackingInput: "PNEW" })],
    };

    const nextSheet = applyTrackingRefreshProgressToSheet(
      sheet,
      {
        ...createLoadedEvent("PNEW"),
        runId: "run-1",
      },
      {
        rowKey: "row-1",
        runId: "run-1",
      }
    );

    expect(nextSheet.rows[0]).toMatchObject({
      trackingInput: "PNEW",
      loading: false,
      queued: false,
      runtimeTrackingRunId: "run-1",
    });
    expect(nextSheet.rows[0]?.shipment?.detail.shipment_header.nomor_kiriman).toBe(
      "PNEW"
    );
  });

  it("marks active pending progress over previous shipment data", () => {
    const sheet = {
      ...createDefaultSheetState(),
      activeTrackingRunId: "run-1",
      rows: [
        createRow({
          trackingInput: "PNEW",
          shipment: createShipment("PNEW"),
        }),
      ],
    };

    const pendingEvent: TrackingRefreshProgressEvent = {
      ...createLoadedEvent("PNEW"),
      runId: "run-1",
      successCount: 0,
      pendingCount: 1,
      row: {
        ...createLoadedEvent("PNEW").row,
        rowStatus: "pending",
        statusJson: null,
        detailJson: null,
      },
    };

    const nextSheet = applyTrackingRefreshProgressToSheet(sheet, pendingEvent, {
      rowKey: "row-1",
      runId: "run-1",
    });

    expect(nextSheet.rows[0]).toMatchObject({
      trackingInput: "PNEW",
      loading: false,
      queued: true,
      error: "",
      runtimeTrackingRunId: "run-1",
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

  it("keeps an active retrack loading row from being downgraded to pending", () => {
    const sheet = {
      ...createDefaultSheetState(),
      activeTrackingRunId: "run-1",
      rows: [createRow({ trackingInput: "PNEW" })],
    };

    const loadedSheet = applyTrackingRefreshProgressToSheet(
      sheet,
      {
        ...createLoadedEvent("PNEW"),
        runId: "run-1",
      },
      {
        rowKey: "row-1",
        runId: "run-1",
      }
    );

    const loadingEvent: TrackingRefreshProgressEvent = {
      ...createLoadedEvent("PNEW"),
      runId: "run-1",
      successCount: 0,
      pendingCount: 1,
      row: {
        ...createLoadedEvent("PNEW").row,
        rowStatus: "loading",
        statusJson: null,
        detailJson: null,
      },
    };
    const afterLoading = applyTrackingRefreshProgressToSheet(
      loadedSheet,
      loadingEvent,
      {
        rowKey: "row-1",
        runId: "run-1",
      }
    );
    const pendingEvent: TrackingRefreshProgressEvent = {
      ...loadingEvent,
      row: {
        ...loadingEvent.row,
        rowStatus: "pending",
      },
    };
    const afterPending = applyTrackingRefreshProgressToSheet(
      afterLoading,
      pendingEvent,
      {
        rowKey: "row-1",
        runId: "run-1",
      }
    );

    expect(afterLoading).not.toBe(loadedSheet);
    expect(afterPending).toBe(afterLoading);
    expect(afterPending.rows[0]).toMatchObject({
      loading: true,
      queued: false,
      error: "",
    });
  });
});
