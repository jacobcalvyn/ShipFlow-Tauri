import {
  getSheetAnalyticsSummary,
  type SheetAnalyticsSummary,
} from "./analytics";
import type { SheetRow, SheetState } from "./types";

export type SheetAnalyticsQuery = {
  sheetState: SheetState;
  nonEmptyRows: SheetRow[];
  displayedRows: SheetRow[];
  selectedVisibleRowKeys: string[];
};

export type SheetAnalyticsEngineId = "typescript-array" | "duckdb-wasm-prototype";

export type SheetAnalyticsEngine = {
  id: SheetAnalyticsEngineId;
  createSummary: (query: SheetAnalyticsQuery) => SheetAnalyticsSummary;
};

export const typescriptArraySheetAnalyticsEngine: SheetAnalyticsEngine = {
  id: "typescript-array",
  createSummary: getSheetAnalyticsSummary,
};

export const defaultSheetAnalyticsEngine = typescriptArraySheetAnalyticsEngine;

export function createSheetAnalyticsSummaryWithEngine(
  query: SheetAnalyticsQuery,
  engine: SheetAnalyticsEngine = defaultSheetAnalyticsEngine
) {
  return engine.createSummary(query);
}
