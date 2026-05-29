import { describe, expect, it, vi } from "vitest";
import { createDefaultSheetState } from "./default-state";
import {
  createSheetAnalyticsSummaryWithEngine,
  defaultSheetAnalyticsEngine,
  SheetAnalyticsEngine,
} from "./analytics-engine";

describe("sheet analytics engine boundary", () => {
  it("uses the TypeScript array engine by default", () => {
    const sheet = createDefaultSheetState();
    const summary = createSheetAnalyticsSummaryWithEngine({
      sheetState: sheet,
      nonEmptyRows: [],
      displayedRows: [],
      selectedVisibleRowKeys: [],
    });

    expect(defaultSheetAnalyticsEngine.id).toBe("typescript-array");
    expect(summary.rows).toEqual([]);
  });

  it("can delegate summary creation to an injected engine", () => {
    const sheet = createDefaultSheetState();
    const createSummary = vi.fn(defaultSheetAnalyticsEngine.createSummary);
    const engine: SheetAnalyticsEngine = {
      id: "typescript-array",
      createSummary,
    };

    createSheetAnalyticsSummaryWithEngine(
      {
        sheetState: sheet,
        nonEmptyRows: [],
        displayedRows: [],
        selectedVisibleRowKeys: [],
      },
      engine
    );

    expect(createSummary).toHaveBeenCalledTimes(1);
    expect(createSummary).toHaveBeenCalledWith({
      sheetState: sheet,
      nonEmptyRows: [],
      displayedRows: [],
      selectedVisibleRowKeys: [],
    });
  });
});
