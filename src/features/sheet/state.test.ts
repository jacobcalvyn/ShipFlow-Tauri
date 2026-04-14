import { TRACKING_COLUMN_PATH } from "./columns";
import {
  applyPresetToHiddenColumns,
  buildFilterPreset,
  countActiveTextFilters,
  countActiveValueFilters,
  sanitizeTextFilters,
  sanitizeValueFilters,
  toggleColumnVisibilityState,
  togglePinnedColumnState,
  toggleValueFilterSelection,
} from "./state";

describe("sheet state utils", () => {
  it("counts active text and value filters with optional visibility", () => {
    const visiblePaths = new Set(["a", "b"]);

    expect(countActiveTextFilters({ a: "x", b: " ", c: "y" }, visiblePaths)).toBe(1);
    expect(countActiveValueFilters({ a: ["A"], b: [], c: ["C"] }, visiblePaths)).toBe(1);
  });

  it("sanitizes filter payloads against valid paths", () => {
    const validPaths = new Set(["a", "b"]);

    expect(sanitizeTextFilters({ a: "x", b: " ", c: "y" }, validPaths)).toEqual({
      a: "x",
    });
    expect(
      sanitizeValueFilters(
        {
          a: ["A", "A", ""],
          b: [],
          c: ["C"],
        },
        validPaths
      )
    ).toEqual({
      a: ["A"],
    });
  });

  it("toggles hidden and pinned columns safely", () => {
    expect(toggleColumnVisibilityState([], "detail.actors.pengirim.nama")).toEqual([
      "detail.actors.pengirim.nama",
    ]);
    expect(
      toggleColumnVisibilityState(["detail.actors.pengirim.nama"], "detail.actors.pengirim.nama")
    ).toEqual([]);
    expect(toggleColumnVisibilityState([], TRACKING_COLUMN_PATH)).toEqual([]);

    expect(togglePinnedColumnState([], "detail.actors.pengirim.nama")).toEqual([
      "detail.actors.pengirim.nama",
    ]);
    expect(
      togglePinnedColumnState(["detail.actors.pengirim.nama"], "detail.actors.pengirim.nama")
    ).toEqual([]);
  });

  it("toggles multi-value filter selection", () => {
    expect(toggleValueFilterSelection({}, "a", "A")).toEqual({ a: ["A"] });
    expect(toggleValueFilterSelection({ a: ["A"] }, "a", "B")).toEqual({
      a: ["A", "B"],
    });
    expect(toggleValueFilterSelection({ a: ["A", "B"] }, "a", "A")).toEqual({
      a: ["B"],
    });
    expect(toggleValueFilterSelection({ a: ["A"] }, "a", "A")).toEqual({});
  });

  it("builds presets and unhides referenced columns", () => {
    const preset = buildFilterPreset(
      " Jakarta ",
      {
        a: "KCU",
        c: "",
      },
      {
        b: ["COD"],
        d: ["x"],
      },
      new Set(["a", "b", "c"]),
      () => "preset-1"
    );

    expect(preset).toEqual({
      id: "preset-1",
      name: "Jakarta",
      textFilters: { a: "KCU" },
      valueFilters: { b: ["COD"] },
    });

    expect(
      applyPresetToHiddenColumns(["a", "b", "x"], {
        id: "preset-1",
        name: "Jakarta",
        textFilters: { a: "KCU" },
        valueFilters: { b: ["COD"] },
      })
    ).toEqual(["x"]);
  });
});
