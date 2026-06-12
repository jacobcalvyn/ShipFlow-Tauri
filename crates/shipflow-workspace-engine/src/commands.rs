use serde::{Deserialize, Serialize};

use crate::analytics::{ChartQuery, ChartResult, PivotQuery, PivotResult};
use crate::imports::{
    ImportJobDetail, ImportJobSummary, ImportKind, ImportMode, ImportSourcePreviewRequest,
    ImportSourcePreviewResult,
};
use crate::storage::{
    SheetFieldValuesQuery, SheetFieldValuesResult, SheetRecord, SheetRowProjection, SheetRowWindow,
    SheetRowsQuery,
};
use crate::tracking::{ResolvedTrackingId, SheetRowsTrackingRefreshResult};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateImportJobRequest {
    pub sheet_id: String,
    pub kind: ImportKind,
    pub ids: Vec<String>,
    pub mode: ImportMode,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateImportJobResponse {
    pub job: ImportJobSummary,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobIdRequest {
    pub job_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuerySheetRowsRequest {
    pub query: SheetRowsQuery,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuerySheetFieldValuesRequest {
    pub query: SheetFieldValuesQuery,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSheetRequest {
    pub sheet_id: String,
    pub name: String,
    pub position: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameSheetRequest {
    pub sheet_id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearSheetRowsRequest {
    pub sheet_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSheetRequest {
    pub sheet_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSheetResponse {
    pub sheet_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSheetRowsRequest {
    pub sheet_id: String,
    pub row_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferSheetRowsMode {
    Copy,
    Move,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferSheetRowsRequest {
    pub source_sheet_id: String,
    pub target_sheet_id: String,
    pub row_ids: Vec<String>,
    pub mode: TransferSheetRowsMode,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopySheetRowsRequest {
    pub source_sheet_id: String,
    pub target_sheet_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshSheetRowTrackingRequest {
    pub row_id: String,
    pub force_refresh: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshSheetRowsTrackingRequest {
    pub sheet_id: String,
    pub row_ids: Vec<String>,
    pub force_refresh: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertSheetRowsRequest {
    pub sheet_id: String,
    pub rows: Vec<UpsertSheetRowRequest>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertSheetRowRequest {
    pub row_id: String,
    pub position: u32,
    pub display_tracking_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "command", content = "payload", rename_all = "snake_case")]
pub enum WorkspaceEngineCommand {
    CreateImportJob(CreateImportJobRequest),
    RunImportJob(JobIdRequest),
    RetryImportJobFailed(JobIdRequest),
    CancelImportJob(JobIdRequest),
    GetImportJob(JobIdRequest),
    ListSheets,
    CreateSheet(CreateSheetRequest),
    RenameSheet(RenameSheetRequest),
    QuerySheetRows(QuerySheetRowsRequest),
    QuerySheetFieldValues(QuerySheetFieldValuesRequest),
    ClearSheetRows(ClearSheetRowsRequest),
    DeleteSheet(DeleteSheetRequest),
    DeleteSheetRows(DeleteSheetRowsRequest),
    TransferSheetRows(TransferSheetRowsRequest),
    CopySheetRows(CopySheetRowsRequest),
    QueryPivot(PivotQuery),
    QueryChart(ChartQuery),
    UpsertSheetRows(UpsertSheetRowsRequest),
    RefreshSheetRowTracking(RefreshSheetRowTrackingRequest),
    RefreshSheetRowsTracking(RefreshSheetRowsTrackingRequest),
    PreviewImportSource(ImportSourcePreviewRequest),
    ResolveTrackingId { display_id: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum WorkspaceEngineResponse {
    ImportJobSummary(ImportJobSummary),
    ImportJobDetail(ImportJobDetail),
    Sheets(Vec<SheetRecord>),
    Sheet(SheetRecord),
    SheetRow(SheetRowProjection),
    SheetRows(SheetRowWindow),
    SheetFieldValues(SheetFieldValuesResult),
    SheetDeleted(DeleteSheetResponse),
    SheetRowsTrackingRefresh(SheetRowsTrackingRefreshResult),
    Pivot(PivotResult),
    Chart(ChartResult),
    ImportSourcePreview(ImportSourcePreviewResult),
    ResolvedTrackingId(ResolvedTrackingId),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_contract_uses_snake_case_tags_and_camel_case_payloads() {
        let command = WorkspaceEngineCommand::CreateImportJob(CreateImportJobRequest {
            sheet_id: "sheet-1".to_string(),
            kind: ImportKind::Manifest,
            ids: vec!["MNF1".to_string()],
            mode: ImportMode::Append,
        });

        let json = serde_json::to_string(&command).expect("command serializes");

        assert!(json.contains(r#""command":"create_import_job""#));
        assert!(json.contains(r#""sheetId":"sheet-1""#));
        assert!(json.contains(r#""kind":"manifest""#));
        assert!(json.contains(r#""mode":"append""#));
    }

    #[test]
    fn sheet_metadata_command_contracts_are_stable() {
        let list = WorkspaceEngineCommand::ListSheets;
        let create = WorkspaceEngineCommand::CreateSheet(CreateSheetRequest {
            sheet_id: "sheet-2".to_string(),
            name: "Sheet 2".to_string(),
            position: 1,
        });
        let rename = WorkspaceEngineCommand::RenameSheet(RenameSheetRequest {
            sheet_id: "sheet-2".to_string(),
            name: "Cases".to_string(),
        });

        let list_json = serde_json::to_string(&list).expect("command serializes");
        let create_json = serde_json::to_string(&create).expect("command serializes");
        let rename_json = serde_json::to_string(&rename).expect("command serializes");

        assert_eq!(list_json, r#"{"command":"list_sheets"}"#);
        assert!(create_json.contains(r#""command":"create_sheet""#));
        assert!(create_json.contains(r#""sheetId":"sheet-2""#));
        assert!(create_json.contains(r#""name":"Sheet 2""#));
        assert!(create_json.contains(r#""position":1"#));
        assert!(rename_json.contains(r#""command":"rename_sheet""#));
        assert!(rename_json.contains(r#""sheetId":"sheet-2""#));
        assert!(rename_json.contains(r#""name":"Cases""#));
    }

    #[test]
    fn transfer_sheet_rows_command_contract_is_stable() {
        let command = WorkspaceEngineCommand::TransferSheetRows(TransferSheetRowsRequest {
            source_sheet_id: "sheet-1".to_string(),
            target_sheet_id: "sheet-2".to_string(),
            row_ids: vec!["row-1".to_string()],
            mode: TransferSheetRowsMode::Move,
        });

        let json = serde_json::to_string(&command).expect("command serializes");

        assert!(json.contains(r#""command":"transfer_sheet_rows""#));
        assert!(json.contains(r#""sourceSheetId":"sheet-1""#));
        assert!(json.contains(r#""targetSheetId":"sheet-2""#));
        assert!(json.contains(r#""rowIds":["row-1"]"#));
        assert!(json.contains(r#""mode":"move""#));
    }

    #[test]
    fn query_sheet_field_values_command_contract_is_stable() {
        let command = WorkspaceEngineCommand::QuerySheetFieldValues(QuerySheetFieldValuesRequest {
            query: SheetFieldValuesQuery {
                sheet_id: "sheet-1".to_string(),
                field: "status_akhir.status".to_string(),
                filters: vec![],
                value_filters: vec![],
                limit: 100,
            },
        });

        let json = serde_json::to_string(&command).expect("command serializes");

        assert!(json.contains(r#""command":"query_sheet_field_values""#));
        assert!(json.contains(r#""sheetId":"sheet-1""#));
        assert!(json.contains(r#""field":"status_akhir.status""#));
        assert!(json.contains(r#""limit":100"#));
    }

    #[test]
    fn copy_sheet_rows_command_contract_is_stable() {
        let command = WorkspaceEngineCommand::CopySheetRows(CopySheetRowsRequest {
            source_sheet_id: "sheet-1".to_string(),
            target_sheet_id: "sheet-2".to_string(),
        });

        let json = serde_json::to_string(&command).expect("command serializes");

        assert!(json.contains(r#""command":"copy_sheet_rows""#));
        assert!(json.contains(r#""sourceSheetId":"sheet-1""#));
        assert!(json.contains(r#""targetSheetId":"sheet-2""#));
    }

    #[test]
    fn delete_sheet_command_contract_is_stable() {
        let command = WorkspaceEngineCommand::DeleteSheet(DeleteSheetRequest {
            sheet_id: "sheet-2".to_string(),
        });

        let json = serde_json::to_string(&command).expect("command serializes");

        assert!(json.contains(r#""command":"delete_sheet""#));
        assert!(json.contains(r#""sheetId":"sheet-2""#));
    }
}
