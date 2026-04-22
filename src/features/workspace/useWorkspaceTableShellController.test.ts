import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultSheetState } from "../sheet/default-state";
import { SheetState } from "../sheet/types";
import { useWorkspaceTableShellController } from "./useWorkspaceTableShellController";

function createOptions(overrides: Partial<Parameters<typeof useWorkspaceTableShellController>[0]> = {}) {
  return {
    activeSheetId: "sheet-1",
    activeSheetOpenColumnMenuPath: null,
    activeSheetSelectionFollowsVisibleRows: false,
    hiddenColumnPaths: [],
    pinnedColumnPaths: [],
    hasActiveFilters: false,
    visibleSelectableKeys: ["row-1", "row-2"],
    selectedVisibleRowKeys: [],
    selectedTrackingIds: [],
    visibleColumnPathSet: new Set<string>(),
    effectiveColumnWidths: {},
    pinnedColumnSet: new Set<string>(),
    sheetScrollRef: { current: null },
    sheetScrollPositionsRef: { current: new Map() },
    columnMenuRefs: { current: new Map() },
    highlightedColumnTimeoutRef: { current: null },
    highlightedColumnSheetIdRef: { current: null },
    updateActiveSheet: vi.fn(),
    updateSheet: vi.fn(),
    copySelectedTrackingIds: vi.fn(),
    ...overrides,
  };
}

function applyActiveSheetUpdaters(
  initialSheet: SheetState,
  updateActiveSheet: ReturnType<typeof vi.fn>
) {
  return updateActiveSheet.mock.calls.reduce<SheetState>(
    (currentSheet, [updater]) => updater(currentSheet),
    initialSheet
  );
}

describe("useWorkspaceTableShellController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("forces selection to exactly visible rows while filters are active", () => {
    const updateActiveSheet = vi.fn();
    const options = createOptions({
      hasActiveFilters: true,
      visibleSelectableKeys: ["row-2", "row-4"],
      updateActiveSheet,
    });
    const initialSheet = {
      ...createDefaultSheetState(),
      selectedRowKeys: ["row-9"],
      selectionFollowsVisibleRows: false,
    };

    renderHook(() => useWorkspaceTableShellController(options));

    const nextSheet = applyActiveSheetUpdaters(initialSheet, updateActiveSheet);

    expect(nextSheet.selectionFollowsVisibleRows).toBe(true);
    expect(nextSheet.selectedRowKeys).toEqual(["row-2", "row-4"]);
  });

  it("stops following visible rows when filters are cleared without selecting everything", () => {
    const updateActiveSheet = vi.fn();
    const options = createOptions({
      activeSheetSelectionFollowsVisibleRows: true,
      hasActiveFilters: false,
      visibleSelectableKeys: ["row-1", "row-2", "row-3", "row-4"],
      updateActiveSheet,
    });
    const initialSheet = {
      ...createDefaultSheetState(),
      selectedRowKeys: ["row-2"],
      selectionFollowsVisibleRows: true,
    };

    renderHook(() => useWorkspaceTableShellController(options));

    const nextSheet = applyActiveSheetUpdaters(initialSheet, updateActiveSheet);

    expect(nextSheet.selectionFollowsVisibleRows).toBe(false);
    expect(nextSheet.selectedRowKeys).toEqual(["row-2"]);
  });
});
