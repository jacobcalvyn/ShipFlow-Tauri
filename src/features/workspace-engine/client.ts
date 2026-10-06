import { requestScopedWorkspace, replaceScopedWorkspace, type WorkspaceDocumentScope } from "./document-scope";

export type ImportKind = "bag" | "manifest";
export type ImportMode = "replace" | "append";
export type ImportJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
export type ImportJobItemStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";
export type ImportSourceItemKind = "bag" | "manifest" | "manifest_bag";
export type ImportAttemptStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export type ImportJobSummary = {
  jobId: string;
  sheetId: string;
  kind: ImportKind;
  mode: ImportMode;
  status: ImportJobStatus;
  totalCount: number;
  successCount: number;
  failedCount: number;
  pendingCount: number;
};

export type ImportJobItem = {
  itemId: string;
  sourceItemId: string;
  sourceItemKind: ImportSourceItemKind;
  position: number;
  status: ImportJobItemStatus;
  trackingIds: string[];
  sheetRowIds: string[];
  errorMessage: string | null;
  attemptCount: number;
};

export type ImportSourcePreviewItem = {
  sourceItemId: string;
  sourceItemKind: ImportSourceItemKind;
  status: ImportJobItemStatus;
  trackingIds: string[];
  sheetRowIds: string[];
  errorMessage: string | null;
};

export type ImportSourcePreviewResult = {
  kind: ImportKind;
  sourceItems: ImportSourcePreviewItem[];
  manifestBags: ImportSourcePreviewItem[];
  trackingIds: string[];
  rawResponse: string;
};

export type ImportJobDetail = {
  summary: ImportJobSummary;
  items: ImportJobItem[];
};

export type EngineSheet = {
  sheetId: string;
  workspaceId: string;
  name: string;
  position: number;
  viewMode: string;
};

export type ImportJobItemDelta = {
  itemId: string;
  sourceItemId: string;
  sourceItemKind: ImportSourceItemKind;
  status: ImportJobItemStatus;
  trackingIds: string[];
  sheetRowIds: string[];
  errorMessage: string | null;
};

export type ImportJobProgressEvent = {
  jobId: string;
  sheetId: string;
  kind: ImportKind;
  mode: ImportMode;
  status: ImportJobStatus;
  totalCount: number;
  successCount: number;
  failedCount: number;
  pendingCount: number;
  itemDeltas: ImportJobItemDelta[];
};

export type TrackingRefreshProgressEvent = {
  runId?: string | null;
  sheetId: string;
  row: SheetRowProjection;
  totalCount: number;
  successCount: number;
  failedCount: number;
  pendingCount: number;
};

export type WorkspaceEngineEvent =
  | {
      type: "import_job_progress";
      payload: ImportJobProgressEvent;
    }
  | {
      type: "tracking_refresh_progress";
      payload: TrackingRefreshProgressEvent;
    };

export type CreateImportJobRequest = {
  sheetId: string;
  kind: ImportKind;
  ids: string[];
  mode: ImportMode;
};

export type ImportSourcePreviewRequest = {
  kind: ImportKind;
  ids: string[];
  scopeKey?: string;
  requestKey?: string;
};

export type CancelImportSourcePreviewRequest = {
  scopeKey: string;
  requestKey?: string;
};

export type JobIdRequest = {
  jobId: string;
};

export type CreateSheetRequest = {
  sheetId: string;
  name: string;
  position: number;
};

export type RenameSheetRequest = {
  sheetId: string;
  name: string;
};

export type ClearSheetRowsRequest = {
  sheetId: string;
};

export type DeleteSheetRequest = {
  sheetId: string;
};

export type DeleteSheetResponsePayload = {
  sheetId: string;
};

export type DeleteSheetRowsRequest = {
  sheetId: string;
  rowIds: string[];
};

export type TransferSheetRowsRequest = {
  sourceSheetId: string;
  targetSheetId: string;
  rowIds: string[];
  mode: "copy" | "move";
};

export type CopySheetRowsRequest = {
  sourceSheetId: string;
  targetSheetId: string;
};

export type RefreshSheetRowTrackingRequest = {
  rowId: string;
  forceRefresh: boolean;
};

export type RefreshSheetRowsTrackingRequest = {
  sheetId: string;
  rowIds: string[];
  forceRefresh: boolean;
  runId?: string | null;
};

export type UpsertSheetRowsRequest = {
  sheetId: string;
  replaceExisting?: boolean;
  appendAtEnd?: boolean;
  rows: Array<{
    rowId: string;
    position: number;
    displayTrackingId: string;
  }>;
};

export type RestoreWorkspaceRequest = {
  seedOnly: boolean;
  sheets: Array<CreateSheetRequest & {
    rows: Array<{
      rowId: string;
      position: number;
      displayTrackingId: string;
      shipment: import("../../types").TrackResponse | null;
      rowStatus: SheetRowStatus;
      errorMessage: string | null;
    }>;
  }>;
};

export type SheetRowStatus =
  | "empty"
  | "pending"
  | "loading"
  | "loaded"
  | "failed"
  | "stale";
export type SortDirection = "asc" | "desc";

export type SheetFilter = {
  field: string;
  value: string;
};

export type SheetValueFilter = {
  field: string;
  values: string[];
};

export type SheetSort = {
  field: string;
  direction: SortDirection;
};

export type SheetRowProjection = {
  rowId: string;
  position: number;
  displayTrackingId: string;
  lookupTrackingId: string;
  rowStatus: SheetRowStatus;
  errorMessage: string | null;
  statusJson: unknown | null;
  detailJson: unknown | null;
  historyJson: unknown | null;
};

export type SheetRowWindow = {
  sheetId: string;
  offset: number;
  limit: number;
  totalCount: number;
  hasMore: boolean;
  nextOffset: number | null;
  rows: SheetRowProjection[];
};

export type SheetFieldValueOption = {
  value: string;
  count: number;
};

export type SheetFieldValuesResult = {
  sheetId: string;
  field: string;
  totalCount: number;
  values: SheetFieldValueOption[];
};

export type SheetRowsTrackingRefreshResult = {
  runId?: string | null;
  sheetId: string;
  successCount: number;
  failedCount: number;
  rows: SheetRowProjection[];
};

export type SheetRowsQuery = {
  sheetId: string;
  offset: number;
  limit: number;
  filters: SheetFilter[];
  valueFilters?: SheetValueFilter[];
  sort: SheetSort[];
};

export type SheetFieldValuesQuery = {
  sheetId: string;
  field: string;
  filters: SheetFilter[];
  valueFilters?: SheetValueFilter[];
  limit: number;
};

export type AnalyticsSourceScope = "all_rows" | "filtered_rows" | "selected_rows";
export type AnalyticsAggregation =
  | "sum"
  | "average"
  | "min"
  | "max"
  | "count"
  | "count_unique"
  | "unique_list"
  | "most_frequent"
  | "first"
  | "last";
export type AnalyticsSortDirection = "asc" | "desc";
export type ChartType = "bar" | "donut";

export type AnalyticsValue = {
  field: string;
  aggregation: AnalyticsAggregation;
};

export type AnalyticsSort = {
  field: string;
  direction: AnalyticsSortDirection;
};

export type PivotQuery = {
  sheetId: string;
  sourceScope: AnalyticsSourceScope;
  filters: SheetFilter[];
  valueFilters?: SheetValueFilter[];
  selectedRowIds: string[];
  rowFields: string[];
  columnFields: string[];
  values: AnalyticsValue[];
  sort: AnalyticsSort[];
  limit: number;
};

export type PivotResult = {
  sheetId: string;
  sourceRowCount: number;
  rows: unknown[];
};

export type ChartQuery = {
  pivotQuery: PivotQuery;
  chartType: ChartType;
};

export type ChartResult = {
  sheetId: string;
  chartType: ChartType;
  sourceRowCount: number;
  series: unknown[];
};

export type TrackingIdResolution = "exact" | "stripped_numeric_suffix";

export type ResolvedTrackingId = {
  displayId: string;
  lookupId: string;
  resolution: TrackingIdResolution;
};

export type WorkspaceEngineCommand =
  | { command: "restore_workspace"; payload: RestoreWorkspaceRequest }
  | {
      command: "create_import_job";
      payload: CreateImportJobRequest;
    }
  | {
      command: "run_import_job";
      payload: JobIdRequest;
    }
  | {
      command: "retry_import_job_failed";
      payload: JobIdRequest;
    }
  | {
      command: "cancel_import_job";
      payload: JobIdRequest;
    }
  | {
      command: "get_import_job";
      payload: JobIdRequest;
    }
  | {
      command: "list_sheets";
    }
  | {
      command: "create_sheet";
      payload: CreateSheetRequest;
    }
  | {
      command: "rename_sheet";
      payload: RenameSheetRequest;
    }
  | {
      command: "query_sheet_rows";
      payload: {
        query: SheetRowsQuery;
      };
    }
  | {
      command: "query_sheet_field_values";
      payload: {
        query: SheetFieldValuesQuery;
      };
    }
  | {
      command: "clear_sheet_rows";
      payload: ClearSheetRowsRequest;
    }
  | {
      command: "delete_sheet";
      payload: DeleteSheetRequest;
    }
  | {
      command: "delete_sheet_rows";
      payload: DeleteSheetRowsRequest;
    }
  | {
      command: "transfer_sheet_rows";
      payload: TransferSheetRowsRequest;
    }
  | {
      command: "copy_sheet_rows";
      payload: CopySheetRowsRequest;
    }
  | {
      command: "upsert_sheet_rows";
      payload: UpsertSheetRowsRequest;
    }
  | {
      command: "refresh_sheet_row_tracking";
      payload: RefreshSheetRowTrackingRequest;
    }
  | {
      command: "refresh_sheet_rows_tracking";
      payload: RefreshSheetRowsTrackingRequest;
    }
  | {
      command: "preview_import_source";
      payload: ImportSourcePreviewRequest;
    }
  | {
      command: "query_pivot";
      payload: PivotQuery;
    }
  | {
      command: "query_chart";
      payload: ChartQuery;
    }
  | {
      command: "resolve_tracking_id";
      payload: {
        display_id: string;
      };
    };

export type WorkspaceEngineResponse =
  | {
      type: "import_job_summary";
      payload: ImportJobSummary;
    }
  | {
      type: "import_job_detail";
      payload: ImportJobDetail;
    }
  | {
      type: "sheets";
      payload: EngineSheet[];
    }
  | {
      type: "sheet";
      payload: EngineSheet;
    }
  | {
      type: "sheet_row";
      payload: SheetRowProjection;
    }
  | {
      type: "sheet_rows";
      payload: SheetRowWindow;
    }
  | {
      type: "sheet_field_values";
      payload: SheetFieldValuesResult;
    }
  | {
      type: "sheet_deleted";
      payload: DeleteSheetResponsePayload;
    }
  | {
      type: "sheet_rows_tracking_refresh";
      payload: SheetRowsTrackingRefreshResult;
    }
  | {
      type: "pivot";
      payload: PivotResult;
    }
  | {
      type: "chart";
      payload: ChartResult;
    }
  | {
      type: "import_source_preview";
      payload: ImportSourcePreviewResult;
    }
  | {
      type: "resolved_tracking_id";
      payload: ResolvedTrackingId;
    };

export type ImportJobSummaryResponse = Extract<
  WorkspaceEngineResponse,
  { type: "import_job_summary" }
>;
export type ImportJobDetailResponse = Extract<
  WorkspaceEngineResponse,
  { type: "import_job_detail" }
>;
export type SheetsResponse = Extract<WorkspaceEngineResponse, { type: "sheets" }>;
export type SheetResponse = Extract<WorkspaceEngineResponse, { type: "sheet" }>;
export type SheetRowsResponse = Extract<
  WorkspaceEngineResponse,
  { type: "sheet_rows" }
>;
export type SheetFieldValuesResponse = Extract<
  WorkspaceEngineResponse,
  { type: "sheet_field_values" }
>;
export type SheetDeletedResponse = Extract<
  WorkspaceEngineResponse,
  { type: "sheet_deleted" }
>;
export type SheetRowResponse = Extract<WorkspaceEngineResponse, { type: "sheet_row" }>;
export type SheetRowsTrackingRefreshResponse = Extract<
  WorkspaceEngineResponse,
  { type: "sheet_rows_tracking_refresh" }
>;
export type PivotResponse = Extract<WorkspaceEngineResponse, { type: "pivot" }>;
export type ChartResponse = Extract<WorkspaceEngineResponse, { type: "chart" }>;
export type ImportSourcePreviewResponse = Extract<
  WorkspaceEngineResponse,
  { type: "import_source_preview" }
>;
export type ResolvedTrackingIdResponse = Extract<
  WorkspaceEngineResponse,
  { type: "resolved_tracking_id" }
>;

export function workspaceEngineCommand<
  Response extends WorkspaceEngineResponse = WorkspaceEngineResponse,
>(command: WorkspaceEngineCommand, scope?: WorkspaceDocumentScope) {
  return requestScopedWorkspace<Response>("workspace.command", command, undefined, scope);
}

export function createImportJob(payload: CreateImportJobRequest) {
  return workspaceEngineCommand<ImportJobDetailResponse>({
    command: "create_import_job",
    payload,
  });
}

export function runImportJob(jobId: string) {
  return workspaceEngineCommand<ImportJobDetailResponse>({
    command: "run_import_job",
    payload: { jobId },
  });
}

export function runImportJobWithProgress(
  jobId: string,
  onEvent: (event: WorkspaceEngineEvent) => void,
) {
  return requestScopedWorkspace<ImportJobDetailResponse>(
    "workspace.run_import_job_with_progress",
    { jobId },
    (event) => onEvent(event as WorkspaceEngineEvent),
  );
}

export function retryImportJobFailed(jobId: string) {
  return workspaceEngineCommand<ImportJobDetailResponse>({
    command: "retry_import_job_failed",
    payload: { jobId },
  });
}

export function retryImportJobFailedWithProgress(
  jobId: string,
  onEvent: (event: WorkspaceEngineEvent) => void,
) {
  return requestScopedWorkspace<ImportJobDetailResponse>(
    "workspace.retry_import_job_with_progress",
    { jobId },
    (event) => onEvent(event as WorkspaceEngineEvent),
  );
}

export function cancelImportJob(jobId: string) {
  return workspaceEngineCommand<ImportJobDetailResponse>({
    command: "cancel_import_job",
    payload: { jobId },
  });
}

export function getImportJob(jobId: string) {
  return workspaceEngineCommand<ImportJobDetailResponse>({
    command: "get_import_job",
    payload: { jobId },
  });
}

export function listEngineSheets() {
  return workspaceEngineCommand<SheetsResponse>({
    command: "list_sheets",
  });
}

export function createEngineSheet(payload: CreateSheetRequest, scope?: WorkspaceDocumentScope) {
  return workspaceEngineCommand<SheetResponse>({
    command: "create_sheet",
    payload,
  }, scope);
}

export function renameEngineSheet(payload: RenameSheetRequest, scope?: WorkspaceDocumentScope) {
  return workspaceEngineCommand<SheetResponse>({
    command: "rename_sheet",
    payload,
  }, scope);
}

export function querySheetRows(query: SheetRowsQuery, scope?: WorkspaceDocumentScope) {
  return workspaceEngineCommand<SheetRowsResponse>({
    command: "query_sheet_rows",
    payload: { query },
  }, scope);
}

export function querySheetFieldValues(query: SheetFieldValuesQuery, scope?: WorkspaceDocumentScope) {
  return workspaceEngineCommand<SheetFieldValuesResponse>({
    command: "query_sheet_field_values",
    payload: { query },
  }, scope);
}

export function clearSheetRows(payload: ClearSheetRowsRequest, scope?: WorkspaceDocumentScope) {
  return workspaceEngineCommand<SheetRowsResponse>({
    command: "clear_sheet_rows",
    payload,
  }, scope);
}

export function deleteSheet(payload: DeleteSheetRequest, scope?: WorkspaceDocumentScope) {
  return workspaceEngineCommand<SheetDeletedResponse>({
    command: "delete_sheet",
    payload,
  }, scope);
}

export function deleteSheetRows(payload: DeleteSheetRowsRequest, scope?: WorkspaceDocumentScope) {
  return workspaceEngineCommand<SheetRowsResponse>({
    command: "delete_sheet_rows",
    payload,
  }, scope);
}

export function transferSheetRows(payload: TransferSheetRowsRequest, scope?: WorkspaceDocumentScope) {
  return workspaceEngineCommand<SheetRowsResponse>({
    command: "transfer_sheet_rows",
    payload,
  }, scope);
}

export function copySheetRows(payload: CopySheetRowsRequest, scope?: WorkspaceDocumentScope) {
  return workspaceEngineCommand<SheetRowsResponse>({
    command: "copy_sheet_rows",
    payload,
  }, scope);
}

export function upsertSheetRows(payload: UpsertSheetRowsRequest, scope?: WorkspaceDocumentScope) {
  return workspaceEngineCommand<SheetRowsResponse>({
    command: "upsert_sheet_rows",
    payload,
  }, scope);
}

export function restoreWorkspace(payload: RestoreWorkspaceRequest) {
  const command = { command: "restore_workspace" as const, payload };
  return payload.seedOnly
    ? workspaceEngineCommand<SheetsResponse>(command)
    : replaceScopedWorkspace<SheetsResponse>(command);
}

export function refreshSheetRowTracking(payload: RefreshSheetRowTrackingRequest, scope?: WorkspaceDocumentScope) {
  return workspaceEngineCommand<SheetRowResponse>({
    command: "refresh_sheet_row_tracking",
    payload,
  }, scope);
}

export function refreshSheetRowsTrackingWithProgress(
  payload: RefreshSheetRowsTrackingRequest,
  onEvent: (event: WorkspaceEngineEvent) => void,
  scope?: WorkspaceDocumentScope,
) {
  return requestScopedWorkspace<SheetRowsTrackingRefreshResponse>(
    "workspace.refresh_tracking_with_progress",
    payload,
    (event) => onEvent(event as WorkspaceEngineEvent),
    scope,
  );
}

export function previewImportSource(payload: ImportSourcePreviewRequest) {
  return workspaceEngineCommand<ImportSourcePreviewResponse>({
    command: "preview_import_source",
    payload,
  });
}

export function cancelImportSourcePreview(
  payload: CancelImportSourcePreviewRequest,
) {
  return requestScopedWorkspace<{ cancelled: boolean }>(
    "workspace.cancel_import_preview",
    payload,
  );
}

export function queryPivot(payload: PivotQuery, scope?: WorkspaceDocumentScope) {
  return workspaceEngineCommand<PivotResponse>({
    command: "query_pivot",
    payload,
  }, scope);
}

export function queryChart(payload: ChartQuery, scope?: WorkspaceDocumentScope) {
  return workspaceEngineCommand<ChartResponse>({
    command: "query_chart",
    payload,
  }, scope);
}

export function resolveTrackingId(displayId: string) {
  return workspaceEngineCommand<ResolvedTrackingIdResponse>({
    command: "resolve_tracking_id",
    payload: {
      display_id: displayId,
    },
  });
}
