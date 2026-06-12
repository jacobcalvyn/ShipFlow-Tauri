import { INITIAL_ROW_COUNT } from "./columns";
import { createDefaultSheetState } from "./default-state";
import {
  armDeleteAllInSheet,
  clearAllDataInSheet,
  closeImportSourceModalInSheet,
  deleteRowsInSheet,
  forceSelectionToVisibleRowsInSheet,
  openImportSourceModalInSheet,
  setImportSourceJobInSheet,
  setSheetAnalyticsChartTypeInSheet,
  setSheetAnalyticsGroupByPathsInSheet,
  setSheetAnalyticsMetricAggregationInSheet,
  setSheetAnalyticsMetricsInSheet,
  setSheetAnalyticsSourceScopeInSheet,
  setSheetViewModeInSheet,
  setImportSourceDraftInSheet,
  startImportSourceLookupInSheet,
  setRowErrorInSheet,
  setRowLoadingInSheet,
  setRowSuccessInSheet,
  setRowsQueuedInSheet,
  setValueFilterSelectionInSheet,
  setTrackingInputInSheet,
  settleRowRuntimeStateInSheet,
  settleRowsRuntimeStateInSheet,
  stopSelectionFollowingVisibleRowsInSheet,
  toggleRowSelectionInSheet,
} from "./actions";
import { assertValidSheetState } from "./utils";

const COD_TOTAL_COLUMN_PATH = "detail.billing_detail.cod_info.total_cod";

describe("sheet actions", () => {
  it("updates tracking input without affecting unrelated rows", () => {
    const initial = createDefaultSheetState();
    const targetRow = initial.rows[0];
    const untouchedRow = initial.rows[1];

    const next = setTrackingInputInSheet(initial, targetRow.key, "P2603310114291");

    expect(next.rows[0].trackingInput).toBe("P2603310114291");
    expect(next.rows[1].key).toBe(untouchedRow.key);
    expect(next.rows[1].trackingInput).toBe("");
  });

  it("arms delete-all and clears selection state", () => {
    const initial = {
      ...createDefaultSheetState(),
      selectedRowKeys: ["row-1", "row-2"],
      selectionFollowsVisibleRows: true,
    };

    const next = armDeleteAllInSheet(initial);

    expect(next.deleteAllArmed).toBe(true);
    expect(next.selectedRowKeys).toEqual([]);
    expect(next.selectionFollowsVisibleRows).toBe(false);
  });

  it("clears all sheet data but preserves sheet view preferences", () => {
    const initial = createDefaultSheetState();
    const rowKey = initial.rows[0].key;
    const changed = {
      ...toggleRowSelectionInSheet(
        setTrackingInputInSheet(initial, rowKey, "P2603310114291"),
        rowKey
      ),
      filters: { "status_akhir.status": "INVEHICLE" },
      hiddenColumnPaths: ["detail.origin_detail.id_kantor"],
      pinnedColumnPaths: ["detail.shipment_header.nomor_kiriman"],
      activeMode: "analytics" as const,
      analytics: {
        sourceScope: "all_rows" as const,
        rowPaths: ["detail.package_detail.jenis_layanan"],
        columnPaths: [],
        valueMetrics: [COD_TOTAL_COLUMN_PATH],
        chartType: "donut" as const,
      },
      deleteAllArmed: true,
    };

    const next = clearAllDataInSheet(changed);

    expect(next.rows).toHaveLength(INITIAL_ROW_COUNT);
    expect(next.rows.every((row) => row.trackingInput === "" && row.shipment === null)).toBe(
      true
    );
    expect(next.filters).toEqual({});
    expect(next.selectedRowKeys).toEqual([]);
    expect(next.deleteAllArmed).toBe(false);
    expect(next.activeMode).toBe("workspace");
    expect(next.analytics).toEqual(createDefaultSheetState().analytics);
    expect(next.hiddenColumnPaths).toEqual(changed.hiddenColumnPaths);
    expect(next.pinnedColumnPaths).toEqual(changed.pinnedColumnPaths);
  });

  it("updates analytics mode and configuration inside the sheet state", () => {
    const initial = createDefaultSheetState();

    const next = setSheetAnalyticsChartTypeInSheet(
      setSheetAnalyticsMetricsInSheet(
        setSheetAnalyticsGroupByPathsInSheet(
          setSheetAnalyticsSourceScopeInSheet(
            setSheetViewModeInSheet(initial, "analytics"),
            "selected_rows"
          ),
          ["detail.package_detail.jenis_layanan", "status_akhir.location"]
        ),
        ["cod_total", "count"]
      ),
      "pivot"
    );

    expect(next.activeMode).toBe("analytics");
    expect(next.analytics).toEqual({
      sourceScope: "selected_rows",
      rowPaths: ["detail.package_detail.jenis_layanan", "status_akhir.location"],
      columnPaths: [],
      valueMetrics: [COD_TOTAL_COLUMN_PATH],
      metricAggregations: {
        [COD_TOTAL_COLUMN_PATH]: "sum",
      },
      chartType: "pivot",
    });
    expect(() => assertValidSheetState(next)).not.toThrow();

    const empty = setSheetAnalyticsMetricsInSheet(
      setSheetAnalyticsGroupByPathsInSheet(next, []),
      []
    );

    expect(empty.analytics.rowPaths).toEqual([]);
    expect(empty.analytics.valueMetrics).toEqual([]);
    expect(() => assertValidSheetState(empty)).not.toThrow();

    const averaged = setSheetAnalyticsMetricAggregationInSheet(
      next,
      COD_TOTAL_COLUMN_PATH,
      "average"
    );

    expect(averaged.analytics.metricAggregations).toEqual({
      [COD_TOTAL_COLUMN_PATH]: "average",
    });
  });

  it("removes selected rows and compacts remaining data upward", () => {
    const initial = createDefaultSheetState();
    const rowKeys = initial.rows.slice(0, 3).map((row) => row.key);

    const populated = setTrackingInputInSheet(
      setTrackingInputInSheet(
        setTrackingInputInSheet(
          setTrackingInputInSheet(initial, rowKeys[0], "P2603310114291"),
          rowKeys[1],
          "P2603310114292"
        ),
        rowKeys[2],
        "P2603310114293"
      ),
      initial.rows[3].key,
      "P2603310114294"
    );

    const next = deleteRowsInSheet(populated, [rowKeys[1], rowKeys[2]]);

    expect(next.rows[0].trackingInput).toBe("P2603310114291");
    expect(next.rows[1].trackingInput).toBe("P2603310114294");
    expect(
      next.rows
        .slice(0, 2)
        .every((row) => row.trackingInput.trim() !== "" || row.shipment !== null)
    ).toBe(true);
  });

  it("keeps row state transitions internally valid", () => {
    const initial = createDefaultSheetState();
    const rowKey = initial.rows[0].key;

    const dirtyState = setTrackingInputInSheet(initial, rowKey, "P2603310114291");
    expect(() => assertValidSheetState(dirtyState)).not.toThrow();
    expect(dirtyState.rows[0].dirty).toBe(true);

    const loadingState = setRowLoadingInSheet(dirtyState, rowKey, "P2603310114291");
    expect(() => assertValidSheetState(loadingState)).not.toThrow();
    expect(loadingState.rows[0].dirty).toBe(false);

    const errorState = setRowErrorInSheet(loadingState, rowKey, "timeout");
    expect(() => assertValidSheetState(errorState)).not.toThrow();

    const successState = setRowSuccessInSheet(errorState, rowKey, "P2603310114291", {
      url: "https://example.test",
      detail: {
        shipment_header: { nomor_kiriman: "P2603310114291" },
        origin_detail: {},
        package_detail: {},
        billing_detail: { cod_info: { is_cod: false } },
        actors: { pengirim: {}, penerima: {} },
        performance_detail: {},
      },
      status_akhir: {},
      pod: {},
      history: [],
      history_summary: {
        irregularity: [],
        bagging_unbagging: [],
        manifest_r7: [],
        delivery_runsheet: [],
      },
    });
    expect(() => assertValidSheetState(successState)).not.toThrow();
  });

  it("marks rows queued before bulk tracking workers pick them up", () => {
    const initial = createDefaultSheetState();
    const rowKey = initial.rows[0].key;
    const previousSuccess = setRowSuccessInSheet(initial, rowKey, "P2603310114291", {
      url: "https://example.test",
      detail: {
        shipment_header: { nomor_kiriman: "P2603310114291" },
        origin_detail: {},
        package_detail: {},
        billing_detail: { cod_info: { is_cod: false } },
        actors: { pengirim: {}, penerima: {} },
        performance_detail: {},
      },
      status_akhir: {},
      pod: {},
      history: [],
      history_summary: {
        irregularity: [],
        bagging_unbagging: [],
        manifest_r7: [],
        delivery_runsheet: [],
      },
    });

    const queuedState = setRowsQueuedInSheet(previousSuccess, [
      { key: rowKey, value: " P2603310114291 " },
    ]);
    const queuedRow = queuedState.rows.find((row) => row.key === rowKey);

    expect(queuedRow).toMatchObject({
      trackingInput: "P2603310114291",
      loading: false,
      queued: true,
      stale: false,
      dirty: false,
      error: "",
    });
    expect(queuedRow?.shipment).toBe(previousSuccess.rows[0].shipment);
    expect(() => assertValidSheetState(queuedState)).not.toThrow();
  });

  it("settles runtime flags without copying or clearing shipment detail", () => {
    const initial = createDefaultSheetState();
    const firstRowKey = initial.rows[0].key;
    const secondRowKey = initial.rows[1].key;
    const successState = setRowSuccessInSheet(
      setRowSuccessInSheet(initial, firstRowKey, "P2603310114291", {
        url: "https://example.test/1",
        detail: {
          shipment_header: { nomor_kiriman: "P2603310114291" },
          origin_detail: {},
          package_detail: {},
          billing_detail: { cod_info: { is_cod: false } },
          actors: { pengirim: {}, penerima: {} },
          performance_detail: {},
        },
        status_akhir: {},
        pod: {},
        history: [],
        history_summary: {
          irregularity: [],
          bagging_unbagging: [],
          manifest_r7: [],
          delivery_runsheet: [],
        },
      }),
      secondRowKey,
      "P2603310114292",
      {
        url: "https://example.test/2",
        detail: {
          shipment_header: { nomor_kiriman: "P2603310114292" },
          origin_detail: {},
          package_detail: {},
          billing_detail: { cod_info: { is_cod: false } },
          actors: { pengirim: {}, penerima: {} },
          performance_detail: {},
        },
        status_akhir: {},
        pod: {},
        history: [],
        history_summary: {
          irregularity: [],
          bagging_unbagging: [],
          manifest_r7: [],
          delivery_runsheet: [],
        },
      }
    );
    const loadingState = setRowsQueuedInSheet(
      setRowLoadingInSheet(successState, firstRowKey, "P2603310114291"),
      [{ key: secondRowKey, value: "P2603310114292" }]
    );

    const singleSettled = settleRowRuntimeStateInSheet(
      loadingState,
      firstRowKey
    );
    const fullySettled = settleRowsRuntimeStateInSheet(singleSettled, [
      secondRowKey,
    ]);

    expect(fullySettled.rows[0]).toMatchObject({
      trackingInput: "P2603310114291",
      loading: false,
      queued: false,
      stale: false,
      dirty: false,
      error: "",
    });
    expect(fullySettled.rows[1]).toMatchObject({
      trackingInput: "P2603310114292",
      loading: false,
      queued: false,
      stale: false,
      dirty: false,
      error: "",
    });
    expect(fullySettled.rows[0].shipment).toBe(successState.rows[0].shipment);
    expect(fullySettled.rows[1].shipment).toBe(successState.rows[1].shipment);
    expect(() => assertValidSheetState(fullySettled)).not.toThrow();
  });

  it("clears carried tracking state when a row input becomes empty", () => {
    const initial = createDefaultSheetState();
    const rowKey = initial.rows[0].key;

    const successState = setRowSuccessInSheet(initial, rowKey, "P2603310114291", {
      url: "https://example.test",
      detail: {
        shipment_header: { nomor_kiriman: "P2603310114291" },
        origin_detail: {},
        package_detail: {},
        billing_detail: { cod_info: { is_cod: false } },
        actors: { pengirim: {}, penerima: {} },
        performance_detail: {},
      },
      status_akhir: {},
      pod: {},
      history: [],
      history_summary: {
        irregularity: [],
        bagging_unbagging: [],
        manifest_r7: [],
        delivery_runsheet: [],
      },
    });

    const clearedState = setTrackingInputInSheet(successState, rowKey, "");
    const clearedRow = clearedState.rows.find((row) => row.key === rowKey);

    expect(clearedRow).toMatchObject({
      trackingInput: "",
      shipment: null,
      loading: false,
      stale: false,
      dirty: false,
      error: "",
    });
    expect(() => assertValidSheetState(clearedState)).not.toThrow();
  });

  it("sets exact value filter selections for quick include and exclude actions", () => {
    const initial = {
      ...createDefaultSheetState(),
      valueFilters: {
        status: ["A", "B", "C"],
      },
    };

    const onlyB = setValueFilterSelectionInSheet(initial, "status", ["B"]);
    expect(onlyB.valueFilters.status).toEqual(["B"]);

    const exceptB = setValueFilterSelectionInSheet(onlyB, "status", ["A", "C"]);
    expect(exceptB.valueFilters.status).toEqual(["A", "C"]);

    const cleared = setValueFilterSelectionInSheet(exceptB, "status", []);
    expect(cleared.valueFilters.status).toBeUndefined();
  });

  it("forces selection to match visible rows when filter-driven selection is active", () => {
    const initial = {
      ...createDefaultSheetState(),
      selectedRowKeys: ["row-9"],
      selectionFollowsVisibleRows: false,
    };

    const next = forceSelectionToVisibleRowsInSheet(initial, ["row-2", "row-4"]);

    expect(next.selectionFollowsVisibleRows).toBe(true);
    expect(next.selectedRowKeys).toEqual(["row-2", "row-4"]);
  });

  it("stops selection following visible rows without changing selected keys", () => {
    const initial = {
      ...createDefaultSheetState(),
      selectedRowKeys: ["row-2", "row-4"],
      selectionFollowsVisibleRows: true,
    };

    const next = stopSelectionFollowingVisibleRowsInSheet(initial);

    expect(next.selectionFollowsVisibleRows).toBe(false);
    expect(next.selectedRowKeys).toEqual(["row-2", "row-4"]);
  });

  it("opens and closes import source modals per sheet", () => {
    const initial = createDefaultSheetState();

    const opened = openImportSourceModalInSheet(initial, "bag");
    const closed = closeImportSourceModalInSheet(opened);

    expect(opened.importSourceModalKind).toBe("bag");
    expect(closed.importSourceModalKind).toBeNull();
  });

  it("stores import source drafts by modal kind", async () => {
    const initial = createDefaultSheetState();

    const withBagDraft = setImportSourceDraftInSheet(initial, "bag", "PID123");
    const withManifestDraft = setImportSourceDraftInSheet(
      withBagDraft,
      "manifest",
      "MNF456"
    );

    expect(withManifestDraft.importSourceDrafts).toEqual({
      bag: "PID123",
      manifest: "MNF456",
    });
  });

  it("keeps Rust import job ids scoped to the active import request", () => {
    const initial = createDefaultSheetState();
    const loading = startImportSourceLookupInSheet(
      initial,
      "bag",
      "request-1",
      ["PID123"]
    );

    const attached = setImportSourceJobInSheet(
      loading,
      "bag",
      "request-1",
      "job-1"
    );
    const stale = setImportSourceJobInSheet(
      attached,
      "bag",
      "request-2",
      "job-2"
    );
    const restarted = startImportSourceLookupInSheet(
      attached,
      "bag",
      "request-3",
      ["PID456"]
    );

    expect(attached.importSourceLookupStates.bag.jobId).toBe("job-1");
    expect(stale.importSourceLookupStates.bag.jobId).toBe("job-1");
    expect(restarted.importSourceLookupStates.bag.jobId).toBeNull();
  });
});
