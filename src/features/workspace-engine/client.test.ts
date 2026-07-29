import { beforeEach, describe, expect, it, vi } from "vitest";
import { installTestBridge } from "../../test/bridge";

const requestWorkspaceMock = vi.fn();

describe("workspace engine client", () => {
  beforeEach(() => {
    requestWorkspaceMock.mockReset();
    installTestBridge({ requestWorkspace: requestWorkspaceMock });
  });

  it("serializes dotted tracking id resolution with the Rust field name", async () => {
    requestWorkspaceMock.mockResolvedValueOnce({
      type: "resolved_tracking_id",
      payload: {
        displayId: "P2606020189412.30",
        lookupId: "P2606020189412",
        resolution: "stripped_numeric_suffix",
      },
    });
    const { resolveTrackingId } = await import("./client");

    const response = await resolveTrackingId("P2606020189412.30");

    expect(requestWorkspaceMock).toHaveBeenCalledWith("workspace.command", {
      command: "resolve_tracking_id",
      payload: {
        display_id: "P2606020189412.30",
      },
    });
    expect(response.payload.lookupId).toBe("P2606020189412");
  });

  it("serializes sheet metadata listing without a payload", async () => {
    requestWorkspaceMock.mockResolvedValueOnce({
      type: "sheets",
      payload: [
        {
          sheetId: "sheet-1",
          workspaceId: "workspace-1",
          name: "Sheet 1",
          position: 0,
          viewMode: "workspace",
        },
      ],
    });
    const { listEngineSheets } = await import("./client");

    const response = await listEngineSheets();

    expect(requestWorkspaceMock).toHaveBeenCalledWith("workspace.command", {
      command: "list_sheets",
    });
    expect(response.payload[0]?.sheetId).toBe("sheet-1");
  });

  it("serializes sheet row tracking refresh with the Rust command contract", async () => {
    requestWorkspaceMock.mockResolvedValueOnce({
      type: "sheet_row",
      payload: {
        rowId: "row-1",
        position: 0,
        displayTrackingId: "P2606020189412.30",
        lookupTrackingId: "P2606020189412",
        rowStatus: "loaded",
        errorMessage: null,
        statusJson: { status: "DELIVERED" },
        detailJson: {},
        historyJson: {},
      },
    });
    const { refreshSheetRowTracking } = await import("./client");

    const response = await refreshSheetRowTracking({
      rowId: "row-1",
      forceRefresh: true,
    });

    expect(requestWorkspaceMock).toHaveBeenCalledWith("workspace.command", {
      command: "refresh_sheet_row_tracking",
      payload: {
        rowId: "row-1",
        forceRefresh: true,
      },
    });
    expect(response.payload.displayTrackingId).toBe("P2606020189412.30");
  });

  it("serializes sheet row window queries for the Rust-owned grid boundary", async () => {
    requestWorkspaceMock.mockResolvedValueOnce({
      type: "sheet_rows",
      payload: {
        sheetId: "sheet-1",
        offset: 50,
        limit: 25,
        totalCount: 90,
        hasMore: true,
        nextOffset: 75,
        rows: [
          {
            rowId: "row-50",
            position: 50,
            displayTrackingId: "P2606020189412.30",
            lookupTrackingId: "P2606020189412",
            rowStatus: "loaded",
            errorMessage: null,
            statusJson: { status: "DELIVERED" },
            detailJson: {},
            historyJson: [],
          },
        ],
      },
    });
    const { querySheetRows } = await import("./client");

    const response = await querySheetRows({
      sheetId: "sheet-1",
      offset: 50,
      limit: 25,
      filters: [{ field: "rowStatus", value: "loaded" }],
      sort: [{ field: "displayTrackingId", direction: "asc" }],
    });

    expect(requestWorkspaceMock).toHaveBeenCalledWith("workspace.command", {
      command: "query_sheet_rows",
      payload: {
        query: {
          sheetId: "sheet-1",
          offset: 50,
          limit: 25,
          filters: [{ field: "rowStatus", value: "loaded" }],
          sort: [{ field: "displayTrackingId", direction: "asc" }],
        },
      },
    });
    expect(response.payload.hasMore).toBe(true);
    expect(response.payload.nextOffset).toBe(75);
    expect(response.payload.rows[0]?.displayTrackingId).toBe("P2606020189412.30");
  });

  it("serializes sheet field value queries for engine-owned value-filter menus", async () => {
    requestWorkspaceMock.mockResolvedValueOnce({
      type: "sheet_field_values",
      payload: {
        sheetId: "sheet-1",
        field: "status_akhir.status",
        totalCount: 3,
        values: [
          { value: "DELIVERED", count: 2 },
          { value: "INLOCATION", count: 1 },
        ],
      },
    });
    const { querySheetFieldValues } = await import("./client");

    const response = await querySheetFieldValues({
      sheetId: "sheet-1",
      field: "status_akhir.status",
      filters: [{ field: "rowStatus", value: "loaded" }],
      valueFilters: [{ field: "detail.package_detail.jenis_layanan", values: ["PKH"] }],
      limit: 1000,
    });

    expect(requestWorkspaceMock).toHaveBeenCalledWith("workspace.command", {
      command: "query_sheet_field_values",
      payload: {
        query: {
          sheetId: "sheet-1",
          field: "status_akhir.status",
          filters: [{ field: "rowStatus", value: "loaded" }],
          valueFilters: [
            { field: "detail.package_detail.jenis_layanan", values: ["PKH"] },
          ],
          limit: 1000,
        },
      },
    });
    expect(response.payload.values[0]).toEqual({ value: "DELIVERED", count: 2 });
  });

  it("serializes import source preview without a sheet mutation command", async () => {
    requestWorkspaceMock.mockResolvedValueOnce({
      type: "import_source_preview",
      payload: {
        kind: "manifest",
        sourceItems: [
          {
            sourceItemId: "MAN1",
            sourceItemKind: "manifest",
            status: "succeeded",
            trackingIds: ["PID1"],
            errorMessage: null,
          },
        ],
        manifestBags: [
          {
            sourceItemId: "PID1",
            sourceItemKind: "manifest_bag",
            status: "succeeded",
            trackingIds: ["P2606020189412.30"],
            errorMessage: null,
          },
        ],
        trackingIds: ["P2606020189412.30"],
        rawResponse: "{}",
      },
    });
    const { previewImportSource } = await import("./client");

    const response = await previewImportSource({
      kind: "manifest",
      ids: ["MAN1"],
      scopeKey: "sheet-1:manifest",
      requestKey: "request-1",
    });

    expect(requestWorkspaceMock).toHaveBeenCalledWith("workspace.command", {
      command: "preview_import_source",
      payload: {
        kind: "manifest",
        ids: ["MAN1"],
        scopeKey: "sheet-1:manifest",
        requestKey: "request-1",
      },
    });
    expect(response.payload.trackingIds).toEqual(["P2606020189412.30"]);
  });

  it("serializes import source preview cancellation by sheet and kind", async () => {
    requestWorkspaceMock.mockResolvedValueOnce({ cancelled: true });
    const { cancelImportSourcePreview } = await import("./client");

    await cancelImportSourcePreview({
      scopeKey: "sheet-1:manifest",
      requestKey: "request-1",
    });

    expect(requestWorkspaceMock).toHaveBeenCalledWith(
      "workspace.cancel_import_preview",
      {
        scopeKey: "sheet-1:manifest",
        requestKey: "request-1",
      },
    );
  });

  it("keeps pivot commands ready for row-column-value analytics", async () => {
    requestWorkspaceMock.mockResolvedValueOnce({
      type: "pivot",
      payload: {
        sheetId: "sheet-1",
        sourceRowCount: 30,
        rows: [],
      },
    });
    const { queryPivot } = await import("./client");

    await queryPivot({
      sheetId: "sheet-1",
      sourceScope: "filtered_rows",
      filters: [{ field: "rowStatus", value: "loaded" }],
      valueFilters: [{ field: "status_akhir.status", values: ["DELIVERED"] }],
      selectedRowIds: ["row-1", "row-2"],
      rowFields: ["detail.package_detail.jenis_layanan"],
      columnFields: ["status_akhir.status"],
      values: [
        {
          field: "detail.billing_detail.cod_info.total_cod",
          aggregation: "sum",
        },
        {
          field: "status_akhir.status",
          aggregation: "count_unique",
        },
      ],
      sort: [
        {
          field: "share",
          direction: "desc",
        },
      ],
      limit: 1000,
    });

    expect(requestWorkspaceMock).toHaveBeenCalledWith("workspace.command", {
      command: "query_pivot",
      payload: {
          sheetId: "sheet-1",
          sourceScope: "filtered_rows",
          filters: [{ field: "rowStatus", value: "loaded" }],
          valueFilters: [{ field: "status_akhir.status", values: ["DELIVERED"] }],
          selectedRowIds: ["row-1", "row-2"],
          rowFields: ["detail.package_detail.jenis_layanan"],
          columnFields: ["status_akhir.status"],
          values: [
            {
              field: "detail.billing_detail.cod_info.total_cod",
              aggregation: "sum",
            },
            {
              field: "status_akhir.status",
              aggregation: "count_unique",
            },
          ],
          sort: [
            {
              field: "share",
              direction: "desc",
            },
          ],
          limit: 1000,
      },
    });
  });

  it("keeps chart commands ready for Rust-owned bar and donut analytics", async () => {
    requestWorkspaceMock.mockResolvedValueOnce({
      type: "chart",
      payload: {
        sheetId: "sheet-1",
        chartType: "bar",
        sourceRowCount: 30,
        series: [],
      },
    });
    const { queryChart } = await import("./client");

    const response = await queryChart({
      pivotQuery: {
        sheetId: "sheet-1",
        sourceScope: "filtered_rows",
        filters: [{ field: "rowStatus", value: "loaded" }],
        valueFilters: [{ field: "status_akhir.status", values: ["DELIVERED"] }],
        selectedRowIds: [],
        rowFields: ["detail.package_detail.jenis_layanan"],
        columnFields: [],
        values: [
          {
            field: "detail.shipment_header.nomor_kiriman",
            aggregation: "count_unique",
          },
        ],
        sort: [
          {
            field: "share",
            direction: "desc",
          },
        ],
        limit: 1000,
      },
      chartType: "bar",
    });

    expect(requestWorkspaceMock).toHaveBeenCalledWith("workspace.command", {
      command: "query_chart",
      payload: {
          pivotQuery: {
            sheetId: "sheet-1",
            sourceScope: "filtered_rows",
            filters: [{ field: "rowStatus", value: "loaded" }],
            valueFilters: [{ field: "status_akhir.status", values: ["DELIVERED"] }],
            selectedRowIds: [],
            rowFields: ["detail.package_detail.jenis_layanan"],
            columnFields: [],
            values: [
              {
                field: "detail.shipment_header.nomor_kiriman",
                aggregation: "count_unique",
              },
            ],
            sort: [
              {
                field: "share",
                direction: "desc",
              },
            ],
            limit: 1000,
          },
          chartType: "bar",
      },
    });
    expect(response.payload.sourceRowCount).toBe(30);
  });
});
