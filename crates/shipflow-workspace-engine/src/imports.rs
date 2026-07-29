use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportKind {
    Bag,
    Manifest,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportMode {
    Replace,
    Append,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportJobStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportJobItemStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportSourceItemKind {
    Bag,
    Manifest,
    ManifestBag,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportJobSummary {
    pub job_id: String,
    pub sheet_id: String,
    pub kind: ImportKind,
    pub mode: ImportMode,
    pub status: ImportJobStatus,
    pub total_count: u32,
    pub success_count: u32,
    pub failed_count: u32,
    pub pending_count: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportJobItem {
    pub item_id: String,
    pub source_item_id: String,
    pub source_item_kind: ImportSourceItemKind,
    pub position: u32,
    pub status: ImportJobItemStatus,
    pub tracking_ids: Vec<String>,
    pub sheet_row_ids: Vec<String>,
    pub error_message: Option<String>,
    pub attempt_count: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportJobDetail {
    pub summary: ImportJobSummary,
    pub items: Vec<ImportJobItem>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRetryTargets {
    pub source_item_ids: Vec<String>,
    pub manifest_bag_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSourcePreviewRequest {
    pub kind: ImportKind,
    pub ids: Vec<String>,
    #[serde(default)]
    pub scope_key: Option<String>,
    #[serde(default)]
    pub request_key: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSourcePreviewItem {
    pub source_item_id: String,
    pub source_item_kind: ImportSourceItemKind,
    pub status: ImportJobItemStatus,
    pub tracking_ids: Vec<String>,
    pub error_message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSourcePreviewResult {
    pub kind: ImportKind,
    pub source_items: Vec<ImportSourcePreviewItem>,
    pub manifest_bags: Vec<ImportSourcePreviewItem>,
    pub tracking_ids: Vec<String>,
    pub raw_response: String,
}

pub fn parse_import_ids(value: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut ids = Vec::new();

    value
        .split(|character: char| character.is_whitespace() || character == ',' || character == ';')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .for_each(|id| {
            if seen.insert(id.to_string()) {
                ids.push(id.to_string());
            }
        });

    ids
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_import_ids_splits_and_dedupes_without_reordering() {
        assert_eq!(
            parse_import_ids(" PID1\nPID2, PID2;PID3\tPID1 "),
            vec!["PID1", "PID2", "PID3"]
        );
    }

    #[test]
    fn import_summary_uses_camel_case_json_contract() {
        let summary = ImportJobSummary {
            job_id: "job-1".to_string(),
            sheet_id: "sheet-1".to_string(),
            kind: ImportKind::Bag,
            mode: ImportMode::Replace,
            status: ImportJobStatus::Running,
            total_count: 3,
            success_count: 1,
            failed_count: 1,
            pending_count: 1,
        };

        let json = serde_json::to_string(&summary).expect("summary serializes");

        assert!(json.contains(r#""jobId":"job-1""#));
        assert!(json.contains(r#""sheetId":"sheet-1""#));
        assert!(json.contains(r#""status":"running""#));
    }
}
