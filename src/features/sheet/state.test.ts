import { TRACKING_COLUMN_PATH } from "./columns";
import {
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
    const visiblePaths = new Set([
      "status_akhir.status",
      "pod.photo1_url",
      "detail.package_detail.jenis_layanan",
    ]);

    expect(
      countActiveTextFilters(
        {
          "status_akhir.status": "INLOCATION",
          "pod.photo1_url": "photo",
          "detail.actors.pengirim.nama": "hidden",
        },
        visiblePaths
      )
    ).toBe(1);
    expect(
      countActiveValueFilters(
        {
          "detail.package_detail.jenis_layanan": ["PKH"],
          "pod.photo1_url": ["photo"],
          "detail.actors.pengirim.nama": ["hidden"],
        },
        visiblePaths
      )
    ).toBe(1);
  });

  it("sanitizes filter payloads against valid paths", () => {
    const validPaths = new Set([
      "status_akhir.status",
      "pod.photo1_url",
      "detail.package_detail.jenis_layanan",
    ]);

    expect(
      sanitizeTextFilters(
        {
          "status_akhir.status": "INLOCATION",
          "pod.photo1_url": "photo",
          "detail.actors.pengirim.nama": "hidden",
        },
        validPaths
      )
    ).toEqual({
      "status_akhir.status": "INLOCATION",
    });
    expect(
      sanitizeValueFilters(
        {
          "detail.package_detail.jenis_layanan": ["PKH", "PKH", ""],
          "pod.photo1_url": ["photo"],
          "detail.actors.pengirim.nama": ["hidden"],
        },
        validPaths
      )
    ).toEqual({
      "detail.package_detail.jenis_layanan": ["PKH"],
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
});
