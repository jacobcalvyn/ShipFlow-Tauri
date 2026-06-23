import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackResponse } from "../../types";
import { setRowSuccessInSheet } from "../sheet/actions";
import { createDefaultSheetState } from "../sheet/default-state";
import { useWorkspaceSheetViewModel } from "./useWorkspaceSheetViewModel";

const mocks = vi.hoisted(() => ({
  querySheetFieldValues: vi.fn(),
  queryChart: vi.fn(),
  queryPivot: vi.fn(),
  querySheetRows: vi.fn(),
}));

vi.mock("../workspace-engine/client", async () => {
  const actual = await vi.importActual<object>("../workspace-engine/client");
  return {
    ...actual,
    querySheetFieldValues: mocks.querySheetFieldValues,
    queryChart: mocks.queryChart,
    queryPivot: mocks.queryPivot,
    querySheetRows: mocks.querySheetRows,
  };
});

function createShipment(params: {
  shipmentId: string;
  status: string;
  service: string;
}): TrackResponse {
  return {
    url: `https://example.test/${params.shipmentId}`,
    detail: {
      shipment_header: {
        nomor_kiriman: params.shipmentId,
      },
      origin_detail: {},
      package_detail: {
        jenis_layanan: params.service,
      },
      billing_detail: {
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
      status: params.status,
    },
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

function createAnalyticsSheet() {
  let sheet = createDefaultSheetState();
  sheet = setRowSuccessInSheet(
    sheet,
    sheet.rows[0].key,
    "P1",
    createShipment({
      shipmentId: "P1",
      status: "DELIVERED",
      service: "PKH",
    })
  );
  sheet = setRowSuccessInSheet(
    sheet,
    sheet.rows[1].key,
    "P2",
    createShipment({
      shipmentId: "P2",
      status: "unBag",
      service: "PKH",
    })
  );

  return {
    ...sheet,
    activeMode: "analytics" as const,
    analytics: {
      sourceScope: "all_rows" as const,
      rowPaths: ["detail.package_detail.jenis_layanan"],
      columnPaths: ["status_akhir.status"],
      valueMetrics: ["detail.shipment_header.nomor_kiriman"],
      metricAggregations: {
        "detail.shipment_header.nomor_kiriman": "count_unique" as const,
      },
      chartType: "pivot" as const,
    },
  };
}

describe("useWorkspaceSheetViewModel Rust analytics boundary", () => {
  beforeEach(() => {
    mocks.queryChart.mockReset();
    mocks.queryPivot.mockReset();
    mocks.querySheetFieldValues.mockReset();
    mocks.querySheetFieldValues.mockResolvedValue({
      type: "sheet_field_values",
      payload: {
        sheetId: "sheet-1",
        field: "status_akhir.status",
        totalCount: 0,
        values: [],
      },
    });
    mocks.querySheetRows.mockReset();
    mocks.querySheetRows.mockResolvedValue({
      type: "sheet_rows",
      payload: {
        sheetId: "sheet-1",
        offset: 0,
        limit: 500,
        totalCount: 0,
        hasMore: false,
        nextOffset: null,
        rows: [],
      },
    });
  });

  it("uses the Rust pivot summary when the source row count matches the UI source", async () => {
    mocks.queryPivot.mockResolvedValueOnce({
      type: "pivot",
      payload: {
        sheetId: "sheet-1",
        sourceRowCount: 2,
        rows: [
          {
            rowValues: ["RUST"],
            columnValues: ["DELIVERED"],
            count: 2,
            metrics: {
              "detail.shipment_header.nomor_kiriman__count_unique": 2,
            },
            share: 100,
          },
        ],
      },
    });

    const sheet = createAnalyticsSheet();
    const { result } = renderHook(() => useWorkspaceSheetViewModel(sheet, "sheet-1"));

    await waitFor(() => {
      expect(result.current.analyticsSummary.rows[0]?.rowValues).toEqual(["RUST"]);
    });

    expect(mocks.queryPivot).toHaveBeenCalledWith(
      expect.objectContaining({
        sheetId: "sheet-1",
        rowFields: ["detail.package_detail.jenis_layanan"],
        columnFields: ["status_akhir.status"],
        values: [
          {
            field: "detail.shipment_header.nomor_kiriman",
            aggregation: "count_unique",
          },
        ],
      })
    );
    expect(mocks.queryChart).not.toHaveBeenCalled();
  });

  it("uses the Rust chart query for bar and donut modes", async () => {
    mocks.queryChart.mockResolvedValueOnce({
      type: "chart",
      payload: {
        sheetId: "sheet-1",
        chartType: "bar",
        sourceRowCount: 2,
        series: [
          {
            rowValues: ["RUST"],
            columnValues: [],
            count: 2,
            metrics: {
              "detail.shipment_header.nomor_kiriman__count_unique": 2,
            },
            share: 100,
          },
        ],
      },
    });

    const baseSheet = createAnalyticsSheet();
    const sheet = {
      ...baseSheet,
      analytics: {
        ...baseSheet.analytics,
        chartType: "bar" as const,
      },
    };
    const { result } = renderHook(() => useWorkspaceSheetViewModel(sheet, "sheet-1"));

    await waitFor(() => {
      expect(result.current.analyticsSummary.rows[0]?.rowValues).toEqual(["RUST"]);
    });

    expect(mocks.queryPivot).not.toHaveBeenCalled();
    expect(mocks.queryChart).toHaveBeenCalledWith({
      pivotQuery: expect.objectContaining({
        sheetId: "sheet-1",
        rowFields: ["detail.package_detail.jenis_layanan"],
        columnFields: [],
        values: [
          {
            field: "detail.shipment_header.nomor_kiriman",
            aggregation: "count_unique",
          },
        ],
      }),
      chartType: "bar",
    });
  });

  it("trusts the Rust pivot source row count for representable analytics scopes", async () => {
    mocks.queryPivot.mockResolvedValueOnce({
      type: "pivot",
      payload: {
        sheetId: "sheet-1",
        sourceRowCount: 1,
        rows: [
          {
            rowValues: ["RUST"],
            columnValues: ["DELIVERED"],
            count: 1,
            metrics: {
              "detail.shipment_header.nomor_kiriman__count_unique": 1,
            },
            share: 100,
          },
        ],
      },
    });

    const sheet = createAnalyticsSheet();
    const { result } = renderHook(() => useWorkspaceSheetViewModel(sheet, "sheet-1"));

    await waitFor(() => {
      expect(mocks.queryPivot).toHaveBeenCalledTimes(1);
    });

    expect(result.current.analyticsSummary.sourceRowCount).toBe(1);
    expect(result.current.analyticsSummary.rows[0]?.rowValues).toEqual(["RUST"]);
  });

  it("passes supported filtered-row value filters into Rust pivot queries", async () => {
    mocks.queryPivot.mockResolvedValueOnce({
      type: "pivot",
      payload: {
        sheetId: "sheet-1",
        sourceRowCount: 1,
        rows: [
          {
            rowValues: ["RUST"],
            columnValues: ["DELIVERED"],
            count: 1,
            metrics: {
              "detail.shipment_header.nomor_kiriman__count_unique": 1,
            },
            share: 100,
          },
        ],
      },
    });
    const sheet = createAnalyticsSheet();
    const filteredSheet = {
      ...sheet,
      analytics: {
        ...sheet.analytics,
        sourceScope: "filtered_rows" as const,
      },
      valueFilters: {
        "status_akhir.status": ["DELIVERED"],
      },
    };

    const { result } = renderHook(() =>
      useWorkspaceSheetViewModel(filteredSheet, "sheet-1")
    );

    await waitFor(() => {
      expect(mocks.queryPivot).toHaveBeenCalledTimes(1);
    });

    expect(mocks.queryPivot).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [],
        valueFilters: [
          {
            field: "status_akhir.status",
            values: ["DELIVERED"],
          },
        ],
      })
    );
    expect(result.current.analyticsSummary.rows[0]?.rowValues).toEqual(["RUST"]);
  });

  it("passes Rust engine row ids into selected-row pivot queries", async () => {
    mocks.querySheetRows.mockResolvedValueOnce({
      type: "sheet_rows",
      payload: {
        sheetId: "sheet-1",
        offset: 0,
        limit: 500,
        totalCount: 1,
        hasMore: false,
        nextOffset: null,
        rows: [
          {
            rowId: "rust-row-1",
            position: 0,
            displayTrackingId: "P1",
            lookupTrackingId: "P1",
            rowStatus: "loaded",
            errorMessage: null,
            statusJson: null,
            detailJson: {
              shipment_header: {
                nomor_kiriman: "P1",
              },
            },
            historyJson: null,
          },
        ],
      },
    });
    mocks.queryPivot.mockResolvedValue({
      type: "pivot",
      payload: {
        sheetId: "sheet-1",
        sourceRowCount: 1,
        rows: [
          {
            rowValues: ["PKH"],
            columnValues: ["DELIVERED"],
            count: 1,
            metrics: {
              "detail.shipment_header.nomor_kiriman__count_unique": 1,
            },
            share: 100,
          },
        ],
      },
    });
    const sheet = createAnalyticsSheet();
    const selectedSheet = {
      ...sheet,
      selectedRowKeys: [sheet.rows[0].key],
      analytics: {
        ...sheet.analytics,
        sourceScope: "selected_rows" as const,
      },
    };

    renderHook(() => useWorkspaceSheetViewModel(selectedSheet, "sheet-1"));

    await waitFor(() => {
      expect(mocks.queryPivot).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceScope: "selected_rows",
          selectedRowIds: ["rust-row-1"],
        })
      );
    });

    expect(
      mocks.queryPivot.mock.calls.some(([query]) =>
        query.selectedRowIds.includes(sheet.rows[0].key)
      )
    ).toBe(false);
  });

  it("ignores POD value filters in Rust pivot queries", async () => {
    mocks.queryPivot.mockResolvedValueOnce({
      type: "pivot",
      payload: {
        sheetId: "sheet-1",
        sourceRowCount: 1,
        rows: [
          {
            rowValues: ["PKH"],
            columnValues: ["DELIVERED"],
            count: 1,
            metrics: {
              "detail.shipment_header.nomor_kiriman__count_unique": 1,
            },
            share: 100,
          },
        ],
      },
    });
    const sheet = createAnalyticsSheet();
    const filteredSheet = {
      ...sheet,
      analytics: {
        ...sheet.analytics,
        sourceScope: "filtered_rows" as const,
      },
      valueFilters: {
        "pod.photo1_url": ["https://example.test/pod.jpg"],
      },
    };

    const { result } = renderHook(() =>
      useWorkspaceSheetViewModel(filteredSheet, "sheet-1")
    );

    await waitFor(() => {
      expect(mocks.queryPivot).toHaveBeenCalled();
    });
    expect(mocks.queryPivot.mock.calls[0]?.[0]).not.toHaveProperty("valueFilters");
    expect(mocks.queryChart).not.toHaveBeenCalled();
    expect(result.current.analyticsSummary.sourceRowCount).toBe(1);
  });

  it("does not fall back to React row data when Rust analytics cannot be queried", () => {
    const sheet = createAnalyticsSheet();
    const { result } = renderHook(() => useWorkspaceSheetViewModel(sheet));

    expect(mocks.queryPivot).not.toHaveBeenCalled();
    expect(mocks.queryChart).not.toHaveBeenCalled();
    expect(result.current.analyticsSummary.sourceRowCount).toBe(0);
    expect(result.current.analyticsSummary.rows).toEqual([]);
  });

  it("queries Rust row windows for empty React workspace sheets and falls back on an empty engine window", async () => {
    const sheet = createDefaultSheetState();

    const { result } = renderHook(() => useWorkspaceSheetViewModel(sheet, "sheet-1"));

    await waitFor(() => {
      expect(mocks.querySheetRows).toHaveBeenCalledTimes(1);
    });

    expect(result.current.displayedTableRows).toHaveLength(sheet.rows.length);
    expect(result.current.displayedTableRows[0]?.key).toBe(sheet.rows[0]?.key);
    expect(mocks.querySheetRows).toHaveBeenCalledWith({
      sheetId: "sheet-1",
      offset: 0,
      limit: 500,
      filters: [],
      sort: [],
    });
  });

  it("does not resurrect filled React mirror rows when the Rust row window is empty", async () => {
    let sheet = createDefaultSheetState();
    sheet = setRowSuccessInSheet(
      sheet,
      sheet.rows[0].key,
      "PLEGACY",
      createShipment({
        shipmentId: "PLEGACY",
        status: "DELIVERED",
        service: "PKH",
      })
    );

    const { result } = renderHook(() => useWorkspaceSheetViewModel(sheet, "sheet-1"));

    await waitFor(() => {
      expect(mocks.querySheetRows).toHaveBeenCalledTimes(1);
    });

    expect(
      result.current.displayedTableRows.some((row) => row.trackingInput === "PLEGACY")
    ).toBe(false);
    expect(result.current.displayedRowWindow?.totalCount).toBe(0);
  });

  it("does not fall back to filled React mirror rows while a representable Rust row query is pending", async () => {
    mocks.querySheetRows.mockReturnValueOnce(new Promise(() => undefined));
    let sheet = createDefaultSheetState();
    sheet = setRowSuccessInSheet(
      sheet,
      sheet.rows[0].key,
      "PLEGACY",
      createShipment({
        shipmentId: "PLEGACY",
        status: "DELIVERED",
        service: "PKH",
      })
    );

    const { result } = renderHook(() => useWorkspaceSheetViewModel(sheet, "sheet-1"));

    await waitFor(() => {
      expect(mocks.querySheetRows).toHaveBeenCalledTimes(1);
    });

    expect(
      result.current.displayedTableRows.some((row) => row.trackingInput === "PLEGACY")
    ).toBe(false);
    expect(result.current.displayedRowWindow?.totalCount).toBe(0);
  });

  it("does not resurrect filled React mirror rows when the Rust row query fails", async () => {
    mocks.querySheetRows.mockRejectedValueOnce(new Error("engine unavailable"));
    let sheet = createDefaultSheetState();
    sheet = setRowSuccessInSheet(
      sheet,
      sheet.rows[0].key,
      "PLEGACY",
      createShipment({
        shipmentId: "PLEGACY",
        status: "DELIVERED",
        service: "PKH",
      })
    );

    const { result } = renderHook(() => useWorkspaceSheetViewModel(sheet, "sheet-1"));

    await waitFor(() => {
      expect(result.current.displayedRowWindow?.totalCount).toBe(0);
    });

    expect(
      result.current.displayedTableRows.some((row) => row.trackingInput === "PLEGACY")
    ).toBe(false);
  });

  it("requeries Rust row windows after workspace engine sync completes", async () => {
    mocks.querySheetRows
      .mockResolvedValueOnce({
        type: "sheet_rows",
        payload: {
          sheetId: "sheet-1",
          offset: 0,
          limit: 500,
          totalCount: 0,
          hasMore: false,
          nextOffset: null,
          rows: [],
        },
      })
      .mockResolvedValueOnce({
        type: "sheet_rows",
        payload: {
          sheetId: "sheet-1",
          offset: 0,
          limit: 500,
          totalCount: 1,
          hasMore: false,
          nextOffset: null,
          rows: [
            {
              rowId: "rust-row-1",
              position: 0,
              displayTrackingId: "P1",
              lookupTrackingId: "P1",
              rowStatus: "loaded",
              errorMessage: null,
              statusJson: { status: "DELIVERED" },
              detailJson: {
                shipment_header: {
                  nomor_kiriman: "P1",
                },
              },
              historyJson: null,
            },
          ],
        },
      });
    const sheet = {
      ...createDefaultSheetState(),
      rows: createDefaultSheetState().rows.map((row, index) =>
        index === 0
          ? {
              ...row,
              key: "legacy-row-1",
              trackingInput: "P1",
            }
          : row
      ),
    };

    const { result, rerender } = renderHook(
      ({ generation }) => useWorkspaceSheetViewModel(sheet, "sheet-1", generation),
      {
        initialProps: {
          generation: 0,
        },
      }
    );

    await waitFor(() => {
      expect(mocks.querySheetRows).toHaveBeenCalledTimes(1);
    });
    expect(result.current.displayedRowWindow?.totalCount).toBe(0);

    rerender({ generation: 1 });

    await waitFor(() => {
      expect(mocks.querySheetRows).toHaveBeenCalledTimes(2);
      expect(result.current.displayedRowWindow?.totalCount).toBe(1);
    });
    expect(result.current.displayedTableRows[0]?.engineRowId).toBe("rust-row-1");
    expect(result.current.displayedTableRows[0]?.trackingInput).toBe("P1");
  });

  it("keeps the previous Rust row window visible while a refreshed window is loading", async () => {
    let resolveSecondQuery!: (value: unknown) => void;
    mocks.querySheetRows
      .mockResolvedValueOnce({
        type: "sheet_rows",
        payload: {
          sheetId: "sheet-1",
          offset: 0,
          limit: 500,
          totalCount: 2,
          hasMore: false,
          nextOffset: null,
          rows: [
            {
              rowId: "sheet-1:row:0",
              position: 0,
              displayTrackingId: "P1",
              lookupTrackingId: "P1",
              rowStatus: "pending",
              errorMessage: null,
              statusJson: null,
              detailJson: null,
              historyJson: null,
            },
            {
              rowId: "sheet-1:row:1",
              position: 1,
              displayTrackingId: "P2",
              lookupTrackingId: "P2",
              rowStatus: "pending",
              errorMessage: null,
              statusJson: null,
              detailJson: null,
              historyJson: null,
            },
          ],
        },
      })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecondQuery = resolve;
        })
      );

    const sheet = createDefaultSheetState();
    const { result, rerender } = renderHook(
      ({ generation }) => useWorkspaceSheetViewModel(sheet, "sheet-1", generation),
      {
        initialProps: {
          generation: 0,
        },
      }
    );

    await waitFor(() => {
      expect(result.current.displayedRowWindow?.totalCount).toBe(2);
    });
    const previousRows = result.current.displayedTableRows;

    rerender({ generation: 1 });

    await waitFor(() => {
      expect(mocks.querySheetRows).toHaveBeenCalledTimes(2);
    });
    expect(result.current.displayedTableRows[0]).toBe(previousRows[0]);
    expect(result.current.displayedTableRows[1]).toBe(previousRows[1]);
    expect(result.current.displayedTableRows[0]?.status).toBe("Pending");

    await act(async () => {
      resolveSecondQuery({
        type: "sheet_rows",
        payload: {
          sheetId: "sheet-1",
          offset: 0,
          limit: 500,
          totalCount: 2,
          hasMore: false,
          nextOffset: null,
          rows: [
            {
              rowId: "sheet-1:row:0",
              position: 0,
              displayTrackingId: "P1",
              lookupTrackingId: "P1",
              rowStatus: "loaded",
              errorMessage: null,
              statusJson: { status: "DELIVERED" },
              detailJson: {
                shipment_header: {
                  nomor_kiriman: "P1",
                },
              },
              historyJson: null,
            },
            {
              rowId: "sheet-1:row:1",
              position: 1,
              displayTrackingId: "P2",
              lookupTrackingId: "P2",
              rowStatus: "pending",
              errorMessage: null,
              statusJson: null,
              detailJson: null,
              historyJson: null,
            },
          ],
        },
      });
    });

    await waitFor(() => {
      expect(result.current.displayedTableRows[0]?.status).toBe("Ready");
    });
    expect(result.current.displayedTableRows[0]).not.toBe(previousRows[0]);
    expect(result.current.displayedTableRows[1]).toBe(previousRows[1]);
  });

  it("passes value filters into Rust row windows without a React row mirror", async () => {
    mocks.querySheetRows.mockResolvedValueOnce({
      type: "sheet_rows",
      payload: {
        sheetId: "sheet-1",
        offset: 0,
        limit: 500,
        totalCount: 1,
        hasMore: false,
        nextOffset: null,
        rows: [
          {
            rowId: "rust-row-1",
            position: 0,
            displayTrackingId: "P1",
            lookupTrackingId: "P1",
            rowStatus: "loaded",
            errorMessage: null,
            statusJson: null,
            detailJson: null,
            historyJson: null,
          },
        ],
      },
    });
    const sheet = {
      ...createDefaultSheetState(),
      valueFilters: {
        "detail.billing_detail.cod_info.total_cod": ["1.000"],
        "detail.billing_detail.cod_info.is_cod": ["Ya"],
      },
    };

    const { result } = renderHook(() => useWorkspaceSheetViewModel(sheet, "sheet-1"));

    await waitFor(() => {
      expect(result.current.displayedTableRows[0]?.trackingInput).toBe("P1");
    });

    expect(mocks.querySheetRows).toHaveBeenCalledWith({
      sheetId: "sheet-1",
      offset: 0,
      limit: 500,
      filters: [],
      valueFilters: [
        {
          field: "detail.billing_detail.cod_info.total_cod",
          values: ["1000"],
        },
        {
          field: "detail.billing_detail.cod_info.is_cod",
          values: ["1"],
        },
      ],
      sort: [],
    });
  });

  it("queries Rust field values for the open value-filter menu", async () => {
    mocks.querySheetFieldValues.mockResolvedValueOnce({
      type: "sheet_field_values",
      payload: {
        sheetId: "sheet-1",
        field: "detail.shipment_header.nomor_kiriman",
        totalCount: 3,
        values: [
          { value: "P2606", count: 2 },
          { value: "P2605", count: 1 },
        ],
      },
    });
    const sheet = {
      ...createDefaultSheetState(),
      openColumnMenuPath: "detail.shipment_header.nomor_kiriman",
    };

    const { result } = renderHook(() => useWorkspaceSheetViewModel(sheet, "sheet-1"));

    await waitFor(() => {
      expect(result.current.valueOptionsByPath).toEqual({
        "detail.shipment_header.nomor_kiriman": [
          { value: "P2606", count: 2 },
          { value: "P2605", count: 1 },
        ],
      });
    });

    expect(mocks.querySheetFieldValues).toHaveBeenCalledWith({
      sheetId: "sheet-1",
      field: "detail.shipment_header.nomor_kiriman",
      filters: [],
      limit: 1000,
    });
  });

  it("keeps other value filters but excludes the open column when querying value options", async () => {
    const sheet = {
      ...createDefaultSheetState(),
      openColumnMenuPath: "status_akhir.status",
      valueFilters: {
        "status_akhir.status": ["DELIVERED"],
        "detail.package_detail.jenis_layanan": ["PKH"],
      },
    };

    renderHook(() => useWorkspaceSheetViewModel(sheet, "sheet-1"));

    await waitFor(() => {
      expect(mocks.querySheetFieldValues).toHaveBeenCalledWith({
        sheetId: "sheet-1",
        field: "status_akhir.status",
        filters: [],
        valueFilters: [
          {
            field: "detail.package_detail.jenis_layanan",
            values: ["PKH"],
          },
        ],
        limit: 1000,
      });
    });
  });

  it("formats numeric Rust field values like local value-filter options", async () => {
    mocks.querySheetFieldValues.mockResolvedValueOnce({
      type: "sheet_field_values",
      payload: {
        sheetId: "sheet-1",
        field: "detail.billing_detail.cod_info.total_cod",
        totalCount: 2,
        values: [
          { value: "1000", count: 1 },
          { value: "250000", count: 1 },
        ],
      },
    });
    const sheet = {
      ...createDefaultSheetState(),
      openColumnMenuPath: "detail.billing_detail.cod_info.total_cod",
    };

    const { result } = renderHook(() => useWorkspaceSheetViewModel(sheet, "sheet-1"));

    await waitFor(() => {
      expect(result.current.valueOptionsByPath).toEqual({
        "detail.billing_detail.cod_info.total_cod": [
          { value: "1.000", count: 1 },
          { value: "250.000", count: 1 },
        ],
      });
    });
  });

  it("does not query Rust value options for non-filterable photo and raw JSON columns", async () => {
    const photoSheet = {
      ...createDefaultSheetState(),
      openColumnMenuPath: "pod.photo1_url",
    };
    const jsonSheet = {
      ...createDefaultSheetState(),
      openColumnMenuPath: "history_summary.bagging_unbagging",
    };

    renderHook(() => useWorkspaceSheetViewModel(photoSheet, "sheet-1"));
    renderHook(() => useWorkspaceSheetViewModel(jsonSheet, "sheet-1"));

    await waitFor(() => {
      expect(mocks.querySheetRows).toHaveBeenCalled();
    });
    expect(mocks.querySheetFieldValues).not.toHaveBeenCalled();
  });

  it("queries Rust row windows while legacy tracking work is queued in the React mirror", async () => {
    mocks.querySheetRows.mockResolvedValueOnce({
      type: "sheet_rows",
      payload: {
        sheetId: "sheet-1",
        offset: 0,
        limit: 500,
        totalCount: 1,
        hasMore: false,
        nextOffset: null,
        rows: [
          {
            rowId: "rust-row-pending",
            position: 0,
            displayTrackingId: "PENDING1",
            lookupTrackingId: "PENDING1",
            rowStatus: "loading",
            errorMessage: null,
            statusJson: null,
            detailJson: null,
            historyJson: null,
          },
        ],
      },
    });
    const baseSheet = createDefaultSheetState();
    const sheet = {
      ...baseSheet,
      rows: baseSheet.rows.map((row, index) =>
        index === 0
          ? {
              ...row,
              key: "legacy-row-initial",
              trackingInput: "P1",
            }
          : row
      ),
    };
    const queuedSheet = {
      ...sheet,
      rows: [
        {
          ...sheet.rows[0],
          trackingInput: "PENDING1",
          queued: true,
        },
        ...sheet.rows.slice(1),
      ],
    };

    const { result } = renderHook(() =>
      useWorkspaceSheetViewModel(queuedSheet, "sheet-1")
    );

    await waitFor(() => {
      expect(result.current.displayedTableRows[0]?.trackingInput).toBe("PENDING1");
    });

    expect(mocks.querySheetRows).toHaveBeenCalledWith({
      sheetId: "sheet-1",
      offset: 0,
      limit: 500,
      filters: [],
      sort: [],
    });
    expect(result.current.displayedTableRows[0]?.loading).toBe(true);
  });

  it("queries unfiltered Rust row windows while a legacy row has an unsynced dirty edit", async () => {
    mocks.querySheetRows.mockResolvedValueOnce({
      type: "sheet_rows",
      payload: {
        sheetId: "sheet-1",
        offset: 0,
        limit: 500,
        totalCount: 1,
        hasMore: false,
        nextOffset: null,
        rows: [
          {
            rowId: "legacy-row-dirty",
            position: 0,
            displayTrackingId: "P1",
            lookupTrackingId: "P1",
            rowStatus: "loaded",
            errorMessage: null,
            statusJson: {
              status: "DELIVERED",
            },
            detailJson: {
              shipment_header: {
                nomor_kiriman: "P1",
              },
            },
            historyJson: null,
          },
        ],
      },
    });
    const baseSheet = createDefaultSheetState();
    const dirtySheet = {
      ...baseSheet,
      rows: [
        {
          ...baseSheet.rows[0],
          key: "legacy-row-dirty",
          trackingInput: "P1-EDITED",
          shipment: createShipment({
            shipmentId: "P1",
            status: "DELIVERED",
            service: "PKH",
          }),
          dirty: true,
          stale: true,
        },
        ...baseSheet.rows.slice(1),
      ],
    };

    const { result } = renderHook(() =>
      useWorkspaceSheetViewModel(dirtySheet, "sheet-1")
    );

    await waitFor(() => {
      expect(mocks.querySheetRows).toHaveBeenCalledTimes(1);
    });

    expect(result.current.displayedTableRows[0]?.trackingInput).toBe("P1-EDITED");
    expect(result.current.displayedTableRows[0]?.engineRowId).toBe("legacy-row-dirty");
  });

  it("queries filtered Rust row windows while a dirty edit is unsynced", async () => {
    mocks.querySheetRows.mockResolvedValueOnce({
      type: "sheet_rows",
      payload: {
        sheetId: "sheet-1",
        offset: 0,
        limit: 500,
        totalCount: 1,
        hasMore: false,
        nextOffset: null,
        rows: [
          {
            rowId: "legacy-row-dirty",
            position: 0,
            displayTrackingId: "P1",
            lookupTrackingId: "P1",
            rowStatus: "loaded",
            errorMessage: null,
            statusJson: {
              status: "DELIVERED",
            },
            detailJson: {
              shipment_header: {
                nomor_kiriman: "P1",
              },
            },
            historyJson: null,
          },
        ],
      },
    });
    const baseSheet = createDefaultSheetState();
    const dirtySheet = {
      ...baseSheet,
      filters: {
        "status_akhir.status": "DELIVERED",
      },
      rows: [
        {
          ...baseSheet.rows[0],
          key: "legacy-row-dirty",
          trackingInput: "P1-EDITED",
          shipment: createShipment({
            shipmentId: "P1",
            status: "DELIVERED",
            service: "PKH",
          }),
          dirty: true,
          stale: true,
        },
        ...baseSheet.rows.slice(1),
      ],
    };

    const { result } = renderHook(() =>
      useWorkspaceSheetViewModel(dirtySheet, "sheet-1")
    );

    await waitFor(() => {
      expect(mocks.querySheetRows).toHaveBeenCalledWith({
        sheetId: "sheet-1",
        offset: 0,
        limit: 500,
        filters: [{ field: "status_akhir.status", value: "DELIVERED" }],
        sort: [],
      });
    });

    expect(result.current.displayedTableRows[0]?.trackingInput).toBe("P1-EDITED");
    expect(result.current.displayedTableRows[0]?.engineRowId).toBe("legacy-row-dirty");
  });

  it("uses Rust row windows for displayed rows when the grid source is in parity", async () => {
    mocks.querySheetRows.mockResolvedValueOnce({
      type: "sheet_rows",
      payload: {
        sheetId: "sheet-1",
        offset: 0,
        limit: 500,
        totalCount: 2,
        hasMore: false,
        nextOffset: null,
        rows: [
          {
            rowId: "rust-row-2",
            position: 1,
            displayTrackingId: "P2",
            lookupTrackingId: "P2",
          rowStatus: "loaded",
          errorMessage: null,
          statusJson: null,
          detailJson: {
            shipment_header: {
              nomor_kiriman: "P2",
            },
          },
          historyJson: null,
        },
        {
            rowId: "rust-row-1",
            position: 0,
            displayTrackingId: "P1",
            lookupTrackingId: "P1",
          rowStatus: "loaded",
          errorMessage: null,
          statusJson: null,
          detailJson: {
            shipment_header: {
              nomor_kiriman: "P1",
            },
          },
          historyJson: null,
        },
        ],
      },
    });
    const sheet = createAnalyticsSheet();
    const workspaceSheet = {
      ...sheet,
      activeMode: "workspace" as const,
    };

    const { result } = renderHook(() =>
      useWorkspaceSheetViewModel(workspaceSheet, "sheet-1")
    );

    await waitFor(() => {
      expect(result.current.displayedTableRows[0]?.trackingInput).toBe("P2");
    });

    expect(mocks.querySheetRows).toHaveBeenCalledWith({
      sheetId: "sheet-1",
      offset: 0,
      limit: 500,
      filters: [],
      sort: [],
    });
    expect(result.current.displayedTableRows[1]?.trackingInput).toBe("P1");
  });

  it("passes supported table filters and sorting into Rust row windows", async () => {
    mocks.querySheetRows.mockResolvedValueOnce({
      type: "sheet_rows",
      payload: {
        sheetId: "sheet-1",
        offset: 0,
        limit: 500,
        totalCount: 1,
        hasMore: false,
        nextOffset: null,
        rows: [
          {
            rowId: "rust-row-2",
            position: 1,
            displayTrackingId: "P2",
            lookupTrackingId: "P2",
            rowStatus: "loaded",
            errorMessage: null,
            statusJson: {
              status: "unBag",
            },
            detailJson: {
              shipment_header: {
                nomor_kiriman: "P2",
              },
            },
            historyJson: null,
          },
        ],
      },
    });
    const sheet = createAnalyticsSheet();
    const workspaceSheet = {
      ...sheet,
      activeMode: "workspace" as const,
      filters: {
        "status_akhir.status": "un",
      },
      valueFilters: {
        "detail.package_detail.jenis_layanan": ["PKH"],
      },
      sortState: {
        path: "detail.shipment_header.nomor_kiriman",
        direction: "desc" as const,
      },
    };

    const { result } = renderHook(() =>
      useWorkspaceSheetViewModel(workspaceSheet, "sheet-1")
    );

    await waitFor(() => {
      expect(result.current.displayedTableRows[0]?.trackingInput).toBe("P2");
    });

    expect(mocks.querySheetRows).toHaveBeenCalledWith({
      sheetId: "sheet-1",
      offset: 0,
      limit: 500,
      filters: [
        {
          field: "status_akhir.status",
          value: "un",
        },
      ],
      valueFilters: [
        {
          field: "detail.package_detail.jenis_layanan",
          values: ["PKH"],
        },
      ],
      sort: [
        {
          field: "detail.shipment_header.nomor_kiriman",
          direction: "desc",
        },
      ],
    });
  });

  it("uses the Rust row window even when the React mirror row count is stale", async () => {
    mocks.querySheetRows.mockResolvedValueOnce({
      type: "sheet_rows",
      payload: {
        sheetId: "sheet-1",
        offset: 0,
        limit: 500,
        totalCount: 1,
        hasMore: false,
        nextOffset: null,
        rows: [
          {
            rowId: "rust-row-1",
            position: 0,
            displayTrackingId: "RUST",
            lookupTrackingId: "RUST",
            rowStatus: "loaded",
            errorMessage: null,
            statusJson: null,
            detailJson: null,
            historyJson: null,
          },
        ],
      },
    });
    const sheet = createAnalyticsSheet();
    const workspaceSheet = {
      ...sheet,
      activeMode: "workspace" as const,
    };

    const { result } = renderHook(() =>
      useWorkspaceSheetViewModel(workspaceSheet, "sheet-1")
    );

    await waitFor(() => {
      expect(mocks.querySheetRows).toHaveBeenCalledTimes(1);
    });

    expect(result.current.displayedTableRows[0]?.trackingInput).toBe("RUST");
    expect(result.current.displayedTableRows[0]?.key).toBe("rust-row-1");
    expect(result.current.loadedCount).toBe(1);
    expect(result.current.allTrackingIds).toEqual(["RUST"]);
    expect(result.current.retrackableRows).toEqual([
      {
        engineRowId: "rust-row-1",
        key: "rust-row-1",
        value: "RUST",
      },
    ]);
    expect(result.current.visibleSelectableKeys).toEqual(["rust-row-1"]);
  });

  it("keeps total shipment count unfiltered when filters narrow Rust rows", async () => {
    mocks.querySheetRows.mockImplementation(async (query) => {
      if (query.filters.length === 0) {
        return {
          type: "sheet_rows",
          payload: {
            sheetId: "sheet-1",
            offset: 0,
            limit: 1,
            totalCount: 47,
            hasMore: true,
            nextOffset: 1,
            rows: [
              {
                rowId: "rust-row-total-probe",
                position: 0,
                displayTrackingId: "P1",
                lookupTrackingId: "P1",
                rowStatus: "loaded",
                errorMessage: null,
                statusJson: null,
                detailJson: null,
                historyJson: null,
              },
            ],
          },
        };
      }

      return {
        type: "sheet_rows",
        payload: {
          sheetId: "sheet-1",
          offset: 0,
          limit: 500,
          totalCount: 6,
          hasMore: false,
          nextOffset: null,
          rows: Array.from({ length: 6 }, (_, index) => ({
            rowId: `rust-row-${index + 1}`,
            position: index,
            displayTrackingId: `P${index + 1}`,
            lookupTrackingId: `P${index + 1}`,
            rowStatus: "loaded" as const,
            errorMessage: null,
            statusJson: null,
            detailJson: null,
            historyJson: null,
          })),
        },
      };
    });
    const sheet = {
      ...createAnalyticsSheet(),
      activeMode: "workspace" as const,
      filters: {
        "detail.shipment_header.nomor_kiriman": "P",
      },
    };

    const { result } = renderHook(() =>
      useWorkspaceSheetViewModel(sheet, "sheet-1")
    );

    await waitFor(() => {
      expect(result.current.loadedCount).toBe(6);
      expect(result.current.totalShipmentCount).toBe(47);
    });
    expect(mocks.querySheetRows).toHaveBeenCalledWith({
      sheetId: "sheet-1",
      offset: 0,
      limit: 1,
      filters: [],
      sort: [],
    });
  });

  it("reprojects an existing Rust row window against React mirror changes without requerying", async () => {
    mocks.querySheetRows.mockResolvedValueOnce({
      type: "sheet_rows",
      payload: {
        sheetId: "sheet-1",
        offset: 0,
        limit: 500,
        totalCount: 1,
        hasMore: false,
        nextOffset: null,
        rows: [
          {
            rowId: "rust-row-1",
            position: 0,
            displayTrackingId: "P1",
            lookupTrackingId: "P1",
            rowStatus: "loaded",
            errorMessage: null,
            statusJson: null,
            detailJson: {
              shipment_header: {
                nomor_kiriman: "P1",
              },
            },
            historyJson: null,
          },
        ],
      },
    });
    const baseSheet = createDefaultSheetState();
    const sheet = {
      ...baseSheet,
      rows: baseSheet.rows.map((row, index) =>
        index === 0
          ? {
              ...row,
              key: "legacy-row-initial",
              trackingInput: "P1",
            }
          : row
      ),
    };
    const { result, rerender } = renderHook(
      ({ currentSheet }) => useWorkspaceSheetViewModel(currentSheet, "sheet-1"),
      {
        initialProps: {
          currentSheet: sheet,
        },
      }
    );

    await waitFor(() => {
      expect(result.current.displayedTableRows[0]?.key).toBe("legacy-row-initial");
    });
    expect(result.current.displayedTableRows[0]?.engineRowId).toBe("rust-row-1");
    expect(mocks.querySheetRows).toHaveBeenCalledTimes(1);

    const mirroredSheet = {
      ...sheet,
      rows: sheet.rows.map((row, index) =>
        index === 0
          ? {
              ...row,
              key: "legacy-row-1",
              trackingInput: "P1",
              shipment: createShipment({
                shipmentId: "P1",
                status: "DELIVERED",
                service: "PKH",
              }),
            }
          : row
      ),
    };

    rerender({ currentSheet: mirroredSheet });

    await waitFor(() => {
      expect(result.current.displayedTableRows[0]?.key).toBe("legacy-row-1");
    });
    expect(result.current.displayedTableRows[0]?.engineRowId).toBe("rust-row-1");
    expect(result.current.displayedTableRows[0]?.trackingInput).toBe("P1");
    expect(mocks.querySheetRows).toHaveBeenCalledTimes(1);
  });

  it("builds retry entries from failed Rust projection rows without React detail state", async () => {
    mocks.querySheetRows.mockResolvedValueOnce({
      type: "sheet_rows",
      payload: {
        sheetId: "sheet-1",
        offset: 0,
        limit: 500,
        totalCount: 1,
        hasMore: false,
        nextOffset: null,
        rows: [
          {
            rowId: "rust-row-failed",
            position: 0,
            displayTrackingId: "PFAILED",
            lookupTrackingId: "PFAILED",
            rowStatus: "failed",
            errorMessage: "tracking unavailable",
            statusJson: null,
            detailJson: null,
            historyJson: null,
          },
        ],
      },
    });
    const sheet = {
      ...createDefaultSheetState(),
      selectedRowKeys: ["rust-row-failed"],
    };

    const { result } = renderHook(() => useWorkspaceSheetViewModel(sheet, "sheet-1"));

    await waitFor(() => {
      expect(result.current.retryFailedEntries).toEqual([
        {
          key: "rust-row-failed",
          value: "PFAILED",
          engineRowId: "rust-row-failed",
        },
      ]);
    });

    expect(result.current.selectedTrackingIds).toEqual(["PFAILED"]);
    expect(result.current.loadedCount).toBe(0);
  });

  it("uses the Rust row window even when Rust rows omit old React tracking details", async () => {
    mocks.querySheetRows.mockResolvedValueOnce({
      type: "sheet_rows",
      payload: {
        sheetId: "sheet-1",
        offset: 0,
        limit: 500,
        totalCount: 2,
        hasMore: false,
        nextOffset: null,
        rows: [
          {
            rowId: "rust-row-2",
            position: 1,
            displayTrackingId: "P2",
            lookupTrackingId: "P2",
            rowStatus: "loaded",
            errorMessage: null,
            statusJson: null,
            detailJson: null,
            historyJson: null,
          },
          {
            rowId: "rust-row-1",
            position: 0,
            displayTrackingId: "P1",
            lookupTrackingId: "P1",
            rowStatus: "loaded",
            errorMessage: null,
            statusJson: null,
            detailJson: null,
            historyJson: null,
          },
        ],
      },
    });
    const sheet = createAnalyticsSheet();
    const workspaceSheet = {
      ...sheet,
      activeMode: "workspace" as const,
    };

    const { result } = renderHook(() =>
      useWorkspaceSheetViewModel(workspaceSheet, "sheet-1")
    );

    await waitFor(() => {
      expect(mocks.querySheetRows).toHaveBeenCalledTimes(1);
    });

    expect(result.current.displayedTableRows[0]?.trackingInput).toBe("P2");
    expect(result.current.displayedTableRows[1]?.trackingInput).toBe("P1");
  });

  it("requests the next Rust row window from the visible grid range", async () => {
    mocks.querySheetRows
      .mockResolvedValueOnce({
        type: "sheet_rows",
        payload: {
          sheetId: "sheet-1",
          offset: 0,
          limit: 500,
          totalCount: 1200,
          hasMore: true,
          nextOffset: 500,
          rows: [
            {
              rowId: "rust-row-1",
              position: 0,
              displayTrackingId: "P1",
              lookupTrackingId: "P1",
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
          limit: 500,
          totalCount: 1200,
          hasMore: true,
          nextOffset: 1000,
          rows: [
            {
              rowId: "rust-row-501",
              position: 500,
              displayTrackingId: "P501",
              lookupTrackingId: "P501",
              rowStatus: "loaded",
              errorMessage: null,
              statusJson: null,
              detailJson: null,
              historyJson: null,
            },
          ],
        },
      });
    const sheet = createAnalyticsSheet();
    const workspaceSheet = {
      ...sheet,
      activeMode: "workspace" as const,
    };

    const { result } = renderHook(() =>
      useWorkspaceSheetViewModel(workspaceSheet, "sheet-1")
    );

    await waitFor(() => {
      expect(result.current.displayedRowWindow?.offset).toBe(0);
    });
    expect(result.current.totalShipmentCount).toBe(1200);

    act(() => {
      result.current.requestVisibleRowWindow({
        startIndex: 540,
        endIndex: 560,
      });
    });

    await waitFor(() => {
      expect(result.current.displayedRowWindow?.offset).toBe(500);
    });

    expect(mocks.querySheetRows).toHaveBeenLastCalledWith({
      sheetId: "sheet-1",
      offset: 500,
      limit: 500,
      filters: [],
      sort: [],
    });
    expect(result.current.displayedTableRows[0]?.trackingInput).toBe("P501");
  });

  it("keeps same-signature Rust row windows active after a mutation generation change", async () => {
    const sheet = createDefaultSheetState();
    const rowWindow = {
      type: "sheet_rows",
      payload: {
        sheetId: "sheet-1",
        offset: 0,
        limit: 500,
        totalCount: 1,
        hasMore: false,
        nextOffset: null,
        rows: [
          {
            rowId: "sheet-1:row:0",
            position: 0,
            displayTrackingId: "P260000000001",
            lookupTrackingId: "P260000000001",
            rowStatus: "loaded",
            errorMessage: null,
            statusJson: null,
            detailJson: null,
            historyJson: null,
          },
        ],
      },
    };
    mocks.querySheetRows.mockResolvedValue(rowWindow);

    const { result, rerender } = renderHook(
      ({
        syncGeneration,
        cacheGeneration,
      }: {
        syncGeneration: number;
        cacheGeneration: number;
      }) =>
        useWorkspaceSheetViewModel(
          sheet,
          "sheet-1",
          syncGeneration,
          cacheGeneration
        ),
      {
        initialProps: {
          syncGeneration: 0,
          cacheGeneration: 0,
        },
      }
    );

    await waitFor(() => {
      expect(result.current.totalShipmentCount).toBe(1);
    });

    rerender({
      syncGeneration: 1,
      cacheGeneration: 1,
    });

    await waitFor(() => {
      expect(mocks.querySheetRows).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(result.current.totalShipmentCount).toBe(1);
    });
    expect(result.current.displayedTableRows[0]?.trackingInput).toBe(
      "P260000000001"
    );
  });

  it("does not downgrade a loading Rust row window back to pending in the same cache generation", async () => {
    const sheet = createDefaultSheetState();
    const loadingWindow = {
      type: "sheet_rows",
      payload: {
        sheetId: "sheet-1",
        offset: 0,
        limit: 500,
        totalCount: 1,
        hasMore: false,
        nextOffset: null,
        rows: [
          {
            rowId: "sheet-1:row:0",
            position: 0,
            displayTrackingId: "P260000000001",
            lookupTrackingId: "P260000000001",
            rowStatus: "loading",
            errorMessage: null,
            statusJson: null,
            detailJson: null,
            historyJson: null,
          },
        ],
      },
    };
    const stalePendingWindow = {
      type: "sheet_rows",
      payload: {
        ...loadingWindow.payload,
        rows: [
          {
            ...loadingWindow.payload.rows[0],
            rowStatus: "pending",
          },
        ],
      },
    };
    mocks.querySheetRows
      .mockResolvedValueOnce(loadingWindow)
      .mockResolvedValueOnce(stalePendingWindow);

    const { result, rerender } = renderHook(
      ({
        syncGeneration,
        cacheGeneration,
      }: {
        syncGeneration: number;
        cacheGeneration: number;
      }) =>
        useWorkspaceSheetViewModel(
          sheet,
          "sheet-1",
          syncGeneration,
          cacheGeneration
        ),
      {
        initialProps: {
          syncGeneration: 0,
          cacheGeneration: 0,
        },
      }
    );

    await waitFor(() => {
      expect(result.current.displayedTableRows[0]?.status).toBe("Loading");
    });

    rerender({
      syncGeneration: 1,
      cacheGeneration: 0,
    });

    await waitFor(() => {
      expect(mocks.querySheetRows).toHaveBeenCalledTimes(2);
    });
    expect(result.current.displayedTableRows[0]?.status).toBe("Loading");
  });
});
