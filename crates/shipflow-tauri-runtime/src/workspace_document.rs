use std::path::{Path, PathBuf};
use std::{
    fs,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

const WORKSPACE_DOCUMENT_EXTENSION: &str = "shipflow";
const CSV_EXPORT_EXTENSION: &str = "csv";
const WORKSPACE_RECOVERY_EXTENSION: &str = "recovery";
const MAX_WORKSPACE_RECOVERY_FILES: usize = 8;

static WORKSPACE_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDocumentFile {
    pub version: u8,
    pub app: String,
    pub saved_at: String,
    pub workspace: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDocumentReadResult {
    pub path: String,
    pub document: WorkspaceDocumentFile,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDocumentWriteResult {
    pub path: String,
    pub saved_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCsvExportResult {
    pub path: String,
    pub row_count: usize,
    pub exported_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecoverySnapshot {
    pub path: String,
    pub created_at: String,
}

fn expand_document_path(value: &str) -> PathBuf {
    if let Some(stripped) = value.strip_prefix("~/") {
        if let Some(home_dir) = std::env::var_os("HOME").map(PathBuf::from) {
            return home_dir.join(stripped);
        }
    }

    PathBuf::from(value)
}

pub fn normalize_workspace_document_path(value: &str) -> Result<PathBuf, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Workspace file path is required.".into());
    }

    let mut path = expand_document_path(trimmed);
    if path.extension().is_none() {
        path.set_extension(WORKSPACE_DOCUMENT_EXTENSION);
    }

    Ok(path)
}

pub fn to_display_document_path(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}

pub fn validate_workspace_document(document: &WorkspaceDocumentFile) -> Result<(), String> {
    if document.version != 1 {
        return Err("Unsupported workspace document version.".into());
    }

    if document.app.trim() != "shipflow-desktop" {
        return Err("This file is not a ShipFlow workspace document.".into());
    }

    if !document.workspace.is_object() {
        return Err("Workspace document payload is invalid.".into());
    }

    Ok(())
}

fn unique_workspace_temp_path(path: &Path, suffix: &str) -> PathBuf {
    let file_name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "workspace.shipflow".into());
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let counter = WORKSPACE_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);

    path.with_file_name(format!(
        "{file_name}.{}.{}.{}.{}",
        std::process::id(),
        timestamp,
        counter,
        suffix
    ))
}

fn finalize_workspace_document_write(temp_path: &Path, target_path: &Path) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        fs::rename(temp_path, target_path)
            .map_err(|error| format!("Unable to finalize workspace file: {error}"))?;
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        if !target_path.exists() {
            fs::rename(temp_path, target_path)
                .map_err(|error| format!("Unable to finalize workspace file: {error}"))?;
            return Ok(());
        }

        let backup_path = unique_workspace_temp_path(target_path, "bak");
        fs::rename(target_path, &backup_path)
            .map_err(|error| format!("Unable to prepare workspace file replacement: {error}"))?;

        match fs::rename(temp_path, target_path) {
            Ok(()) => {
                let _ = fs::remove_file(&backup_path);
                Ok(())
            }
            Err(error) => {
                let _ = fs::rename(&backup_path, target_path);
                Err(format!(
                    "Unable to finalize workspace file; previous file was restored from {}: {error}",
                    backup_path.to_string_lossy()
                ))
            }
        }
    }
}

fn workspace_recovery_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "workspace.shipflow".into());
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    path.with_file_name(format!(
        "{file_name}.{timestamp}.{WORKSPACE_RECOVERY_EXTENSION}"
    ))
}

fn cleanup_workspace_recovery_files(path: &Path) {
    let Some(parent) = path.parent() else {
        return;
    };
    let Some(file_name) = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
    else {
        return;
    };

    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    let mut recovery_files = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|candidate| {
            candidate
                .file_name()
                .map(|name| name.to_string_lossy())
                .is_some_and(|name| {
                    name.starts_with(&format!("{file_name}."))
                        && name.ends_with(&format!(".{WORKSPACE_RECOVERY_EXTENSION}"))
                })
        })
        .collect::<Vec<_>>();

    recovery_files.sort();
    let excess_count = recovery_files
        .len()
        .saturating_sub(MAX_WORKSPACE_RECOVERY_FILES);
    for stale_path in recovery_files.into_iter().take(excess_count) {
        let _ = fs::remove_file(stale_path);
    }
}

fn create_workspace_recovery_snapshot(path: &Path) {
    if !path.exists() {
        return;
    }

    let recovery_path = workspace_recovery_path(path);
    if fs::copy(path, &recovery_path).is_ok() {
        cleanup_workspace_recovery_files(path);
    }
}

pub fn write_workspace_document_to_path(
    path: &Path,
    document: &WorkspaceDocumentFile,
) -> Result<(), String> {
    validate_workspace_document(document)?;

    let parent = path
        .parent()
        .ok_or_else(|| "Workspace file must have a parent directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Unable to create workspace directory: {error}"))?;

    let serialized = serde_json::to_vec_pretty(document)
        .map_err(|error| format!("Unable to serialize workspace document: {error}"))?;
    let temp_path = unique_workspace_temp_path(path, "tmp");

    fs::write(&temp_path, serialized)
        .map_err(|error| format!("Unable to write workspace temp file: {error}"))?;

    create_workspace_recovery_snapshot(path);
    finalize_workspace_document_write(&temp_path, path)?;

    Ok(())
}

pub fn get_workspace_document_name_from_path(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "Untitled.shipflow".into())
}

pub fn read_workspace_document_file(path: String) -> Result<WorkspaceDocumentReadResult, String> {
    let normalized_path = normalize_workspace_document_path(&path)?;
    let raw = fs::read_to_string(&normalized_path)
        .map_err(|error| format!("Unable to read workspace file: {error}"))?;
    let document: WorkspaceDocumentFile = serde_json::from_str(&raw)
        .map_err(|error| format!("Unable to parse workspace file: {error}"))?;
    validate_workspace_document(&document)?;

    Ok(WorkspaceDocumentReadResult {
        path: to_display_document_path(&normalized_path),
        document,
    })
}

pub fn write_workspace_document_file(
    path: String,
    document: WorkspaceDocumentFile,
) -> Result<WorkspaceDocumentWriteResult, String> {
    let normalized_path = normalize_workspace_document_path(&path)?;
    write_workspace_document_to_path(&normalized_path, &document)?;

    Ok(WorkspaceDocumentWriteResult {
        path: to_display_document_path(&normalized_path),
        saved_at: document.saved_at,
    })
}

pub fn write_csv_export_file(
    path: String,
    csv_content: String,
    row_count: usize,
) -> Result<WorkspaceCsvExportResult, String> {
    let mut target_path = normalize_csv_export_path(&path)?;
    let parent = target_path
        .parent()
        .ok_or_else(|| "CSV export file must have a parent directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Unable to create CSV export directory: {error}"))?;

    if target_path.extension().is_none() {
        target_path.set_extension(CSV_EXPORT_EXTENSION);
    }

    let temp_path = unique_workspace_temp_path(&target_path, "csv.tmp");
    fs::write(&temp_path, csv_content)
        .map_err(|error| format!("Unable to write CSV export temp file: {error}"))?;
    finalize_workspace_document_write(&temp_path, &target_path)
        .map_err(|error| error.replace("workspace file", "CSV export"))?;

    Ok(WorkspaceCsvExportResult {
        path: to_display_document_path(&target_path),
        row_count,
        exported_at: current_timestamp_string(),
    })
}

pub fn list_workspace_recovery_snapshots(
    path: String,
) -> Result<Vec<WorkspaceRecoverySnapshot>, String> {
    let normalized_path = normalize_workspace_document_path(&path)?;
    let Some(parent) = normalized_path.parent() else {
        return Ok(Vec::new());
    };
    let Some(file_name) = normalized_path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
    else {
        return Ok(Vec::new());
    };

    let mut snapshots = fs::read_dir(parent)
        .map_err(|error| format!("Unable to read workspace recovery directory: {error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|candidate| {
            candidate
                .file_name()
                .map(|name| name.to_string_lossy())
                .is_some_and(|name| {
                    name.starts_with(&format!("{file_name}."))
                        && name.ends_with(&format!(".{WORKSPACE_RECOVERY_EXTENSION}"))
                })
        })
        .map(|candidate| WorkspaceRecoverySnapshot {
            created_at: fs::metadata(&candidate)
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                .map(|duration| format!("{}.{:03}Z", duration.as_secs(), duration.subsec_millis()))
                .unwrap_or_default(),
            path: to_display_document_path(&candidate),
        })
        .collect::<Vec<_>>();
    snapshots.sort_by(|left, right| right.path.cmp(&left.path));
    Ok(snapshots)
}

fn normalize_csv_export_path(value: &str) -> Result<PathBuf, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("CSV export file path is required.".into());
    }

    let mut path = expand_document_path(trimmed);
    if path.extension().is_none() {
        path.set_extension(CSV_EXPORT_EXTENSION);
    }
    Ok(path)
}

fn current_timestamp_string() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}.{:03}Z", duration.as_secs(), duration.subsec_millis())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use serde_json::json;

    use super::{
        finalize_workspace_document_write, normalize_workspace_document_path,
        read_workspace_document_file, write_workspace_document_file, WorkspaceDocumentFile,
    };

    fn unique_temp_dir(prefix: &str) -> std::path::PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}-{timestamp}"))
    }

    #[test]
    fn workspace_document_roundtrip_preserves_workspace_payload() {
        let temp_dir = unique_temp_dir("shipflow-doc-test");
        let _ = fs::create_dir_all(&temp_dir);
        let target_path = temp_dir.join("workspace");
        let target_path_string = target_path.to_string_lossy().to_string();

        let document = WorkspaceDocumentFile {
            version: 1,
            app: "shipflow-desktop".into(),
            saved_at: "2026-04-18T16:00:00.000Z".into(),
            workspace: json!({
                "version": 1,
                "activeSheetId": "sheet-1",
                "sheetOrder": ["sheet-1"],
                "sheetMetaById": {
                    "sheet-1": {
                        "name": "Sheet 1",
                        "color": "slate",
                        "icon": "sheet"
                    }
                },
                "sheetsById": {
                    "sheet-1": {
                        "rows": [],
                        "filters": {},
                        "valueFilters": {},
                        "sortState": {
                            "path": null,
                            "direction": "asc"
                        },
                        "selectedRowKeys": [],
                        "selectionFollowsVisibleRows": false,
                        "columnWidths": {},
                        "hiddenColumnPaths": [],
                        "pinnedColumnPaths": [],
                        "openColumnMenuPath": null,
                        "highlightedColumnPath": null,
                        "deleteAllArmed": false
                    }
                }
            }),
        };

        let write_result =
            write_workspace_document_file(target_path_string.clone(), document.clone())
                .expect("workspace document should write");
        assert!(write_result.path.ends_with(".shipflow"));

        let read_result = read_workspace_document_file(target_path_string)
            .expect("workspace document should read");
        assert_eq!(read_result.document.workspace, document.workspace);

        let _ = fs::remove_file(
            normalize_workspace_document_path(
                temp_dir.join("workspace").to_string_lossy().as_ref(),
            )
            .expect("document path should normalize"),
        );
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn workspace_document_requires_shipflow_signature() {
        let temp_dir = unique_temp_dir("shipflow-doc-invalid-test");
        let _ = fs::create_dir_all(&temp_dir);
        let target_path = temp_dir.join("invalid.shipflow");

        fs::write(
            &target_path,
            serde_json::to_vec_pretty(&json!({
                "version": 1,
                "app": "not-shipflow",
                "savedAt": "2026-04-18T16:00:00.000Z",
                "workspace": {}
            }))
            .expect("invalid document json should serialize"),
        )
        .expect("invalid document should write");

        let error = read_workspace_document_file(target_path.to_string_lossy().to_string())
            .expect_err("invalid app signature should fail");
        assert!(error.contains("not a ShipFlow workspace"));

        let _ = fs::remove_file(&target_path);
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn failed_workspace_finalize_keeps_existing_file() {
        let temp_dir = unique_temp_dir("shipflow-doc-finalize-failure-test");
        let _ = fs::create_dir_all(&temp_dir);
        let target_path = temp_dir.join("workspace.shipflow");
        let missing_temp_path = temp_dir.join("missing-temp-file.tmp");
        let previous_payload = r#"{"version":1,"app":"shipflow-desktop","savedAt":"2026-04-18T16:00:00.000Z","workspace":{"rows":["old"]}}"#;

        fs::write(&target_path, previous_payload).expect("existing workspace should write");

        let error = finalize_workspace_document_write(&missing_temp_path, &target_path)
            .expect_err("missing temp file should fail finalize");
        assert!(error.contains("finalize workspace file"));

        let restored_payload =
            fs::read_to_string(&target_path).expect("existing workspace should remain readable");
        assert_eq!(restored_payload, previous_payload);

        let _ = fs::remove_file(&target_path);
        let _ = fs::remove_dir_all(&temp_dir);
    }
}
