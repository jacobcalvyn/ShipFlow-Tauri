import { INITIAL_ROW_COUNT } from "./columns";
import { createDefaultSheetState } from "./default-state";
import {
  armDeleteAllInSheet,
  clearAllDataInSheet,
  deleteRowsInSheet,
  setRowErrorInSheet,
  setRowLoadingInSheet,
  setRowSuccessInSheet,
  setTrackingInputInSheet,
  toggleRowSelectionInSheet,
} from "./actions";
import { assertValidSheetState } from "./utils";

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
    expect(next.hiddenColumnPaths).toEqual(changed.hiddenColumnPaths);
    expect(next.pinnedColumnPaths).toEqual(changed.pinnedColumnPaths);
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

    const loadingState = setRowLoadingInSheet(dirtyState, rowKey, "P2603310114291");
    expect(() => assertValidSheetState(loadingState)).not.toThrow();

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
});
