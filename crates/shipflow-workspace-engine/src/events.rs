use serde::{Deserialize, Serialize};

use crate::imports::{
    ImportJobDetail, ImportJobItem, ImportJobItemStatus, ImportJobStatus, ImportKind, ImportMode,
    ImportSourceItemKind,
};
use crate::storage::SheetRowProjection;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportJobProgressEvent {
    pub job_id: String,
    pub sheet_id: String,
    pub kind: ImportKind,
    pub mode: ImportMode,
    pub status: ImportJobStatus,
    pub total_count: u32,
    pub success_count: u32,
    pub failed_count: u32,
    pub pending_count: u32,
    pub item_deltas: Vec<ImportJobItemDelta>,
}

impl ImportJobProgressEvent {
    pub fn from_job_detail(detail: &ImportJobDetail, item_deltas: Vec<ImportJobItemDelta>) -> Self {
        Self {
            job_id: detail.summary.job_id.clone(),
            sheet_id: detail.summary.sheet_id.clone(),
            kind: detail.summary.kind,
            mode: detail.summary.mode,
            status: detail.summary.status,
            total_count: detail.summary.total_count,
            success_count: detail.summary.success_count,
            failed_count: detail.summary.failed_count,
            pending_count: detail.summary.pending_count,
            item_deltas,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportJobItemDelta {
    pub item_id: String,
    pub source_item_id: String,
    pub source_item_kind: ImportSourceItemKind,
    pub status: ImportJobItemStatus,
    pub tracking_ids: Vec<String>,
    pub sheet_row_ids: Vec<String>,
    pub error_message: Option<String>,
}

impl From<&ImportJobItem> for ImportJobItemDelta {
    fn from(item: &ImportJobItem) -> Self {
        Self {
            item_id: item.item_id.clone(),
            source_item_id: item.source_item_id.clone(),
            source_item_kind: item.source_item_kind,
            status: item.status,
            tracking_ids: item.tracking_ids.clone(),
            sheet_row_ids: item.sheet_row_ids.clone(),
            error_message: item.error_message.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackingRefreshProgressEvent {
    pub run_id: Option<String>,
    pub sheet_id: String,
    pub row: SheetRowProjection,
    pub total_count: u32,
    pub success_count: u32,
    pub failed_count: u32,
    pub pending_count: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum WorkspaceEngineEvent {
    ImportJobProgress(ImportJobProgressEvent),
    TrackingRefreshProgress(TrackingRefreshProgressEvent),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_contract_uses_tagged_payload() {
        let event = WorkspaceEngineEvent::ImportJobProgress(ImportJobProgressEvent {
            job_id: "job-1".to_string(),
            sheet_id: "sheet-1".to_string(),
            kind: ImportKind::Bag,
            mode: ImportMode::Append,
            status: ImportJobStatus::Running,
            total_count: 2,
            success_count: 1,
            failed_count: 0,
            pending_count: 1,
            item_deltas: vec![ImportJobItemDelta {
                item_id: "PID1".to_string(),
                source_item_id: "PID1".to_string(),
                source_item_kind: crate::imports::ImportSourceItemKind::Bag,
                status: ImportJobItemStatus::Succeeded,
                tracking_ids: vec!["P1".to_string()],
                sheet_row_ids: vec!["sheet-1:row:0".to_string()],
                error_message: None,
            }],
        });

        let json = serde_json::to_string(&event).expect("event serializes");

        assert!(json.contains(r#""type":"import_job_progress""#));
        assert!(json.contains(r#""itemDeltas""#));
    }
}
