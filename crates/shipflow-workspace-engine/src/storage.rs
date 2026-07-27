use std::error::Error;
use std::fmt::{Display, Formatter};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::types::{Value, ValueRef};
use rusqlite::{
    params, params_from_iter, Connection, OptionalExtension, Transaction, TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::imports::{
    ImportJobDetail, ImportJobItem, ImportJobItemStatus, ImportJobStatus, ImportJobSummary,
    ImportKind, ImportMode, ImportRetryTargets, ImportSourceItemKind,
};
use crate::jobs::{ImportAttemptRecord, ImportAttemptStatus, JobRecoverySummary};
use crate::schema::{SCHEMA_SQL, SCHEMA_VERSION, SQLITE_PRAGMAS};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SheetRowStatus {
    Empty,
    Pending,
    Loading,
    Loaded,
    Failed,
    Stale,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetRowProjection {
    pub row_id: String,
    pub row_generation: String,
    pub position: u32,
    pub display_tracking_id: String,
    pub lookup_tracking_id: String,
    pub row_status: SheetRowStatus,
    pub error_message: Option<String>,
    pub status_json: Option<serde_json::Value>,
    pub detail_json: Option<serde_json::Value>,
    pub history_json: Option<serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetRowWindow {
    pub sheet_id: String,
    pub offset: u32,
    pub limit: u32,
    pub total_count: u32,
    pub has_more: bool,
    pub next_offset: Option<u32>,
    pub rows: Vec<SheetRowProjection>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetFieldValueOption {
    pub value: String,
    pub count: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetFieldValuesResult {
    pub sheet_id: String,
    pub field: String,
    pub total_count: u32,
    pub values: Vec<SheetFieldValueOption>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetRowsQuery {
    pub sheet_id: String,
    pub offset: u32,
    pub limit: u32,
    pub filters: Vec<SheetFilter>,
    #[serde(default)]
    pub value_filters: Vec<SheetValueFilter>,
    pub sort: Vec<SheetSort>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetFilter {
    pub field: String,
    pub value: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetValueFilter {
    pub field: String,
    pub values: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SortDirection {
    Asc,
    Desc,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetSort {
    pub field: String,
    pub direction: SortDirection,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetFieldValuesQuery {
    pub sheet_id: String,
    pub field: String,
    pub filters: Vec<SheetFilter>,
    #[serde(default)]
    pub value_filters: Vec<SheetValueFilter>,
    pub limit: u32,
}

pub fn clamp_query_window(offset: u32, limit: u32, max_limit: u32) -> (u32, u32) {
    (offset, limit.min(max_limit))
}

#[derive(Debug)]
pub enum WorkspaceStoreError {
    Sqlite(rusqlite::Error),
    Json(serde_json::Error),
    MissingImportJob(String),
    RowOwnershipConflict {
        row_id: String,
        existing_sheet_id: String,
        requested_sheet_id: String,
    },
    InvalidValue {
        field: &'static str,
        value: String,
    },
}

impl Display for WorkspaceStoreError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sqlite(error) => write!(formatter, "sqlite error: {error}"),
            Self::Json(error) => write!(formatter, "json error: {error}"),
            Self::MissingImportJob(job_id) => write!(formatter, "missing import job: {job_id}"),
            Self::RowOwnershipConflict {
                row_id,
                existing_sheet_id,
                requested_sheet_id,
            } => write!(
                formatter,
                "row {row_id} belongs to sheet {existing_sheet_id}, not {requested_sheet_id}"
            ),
            Self::InvalidValue { field, value } => {
                write!(formatter, "invalid {field} value: {value}")
            }
        }
    }
}

impl Error for WorkspaceStoreError {}

impl From<rusqlite::Error> for WorkspaceStoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

impl From<serde_json::Error> for WorkspaceStoreError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

pub type WorkspaceStoreResult<T> = Result<T, WorkspaceStoreError>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecord {
    pub workspace_id: String,
    pub name: String,
    pub schema_version: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkspaceInput {
    pub workspace_id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetRecord {
    pub sheet_id: String,
    pub workspace_id: String,
    pub name: String,
    pub position: u32,
    pub view_mode: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSheetInput {
    pub sheet_id: String,
    pub workspace_id: String,
    pub name: String,
    pub position: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertSheetRowInput {
    pub row_id: String,
    pub sheet_id: String,
    pub position: u32,
    pub display_tracking_id: String,
    pub lookup_tracking_id: String,
    pub row_status: SheetRowStatus,
    pub error_message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TransferSheetRowsInput {
    pub source_sheet_id: String,
    pub target_sheet_id: String,
    pub row_ids: Vec<String>,
    pub delete_source_rows: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertTrackingRecordInput {
    pub record_id: String,
    pub display_tracking_id: String,
    pub lookup_tracking_id: String,
    pub normalized_status: Option<String>,
    pub status_json: serde_json::Value,
    pub detail_json: serde_json::Value,
    pub history_json: serde_json::Value,
    pub raw_blob_id: Option<String>,
    pub source_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachTrackingRecordToSheetRowInput {
    pub row_id: String,
    pub tracking_record_id: String,
    pub row_status: SheetRowStatus,
    pub error_message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSheetRowStatusInput {
    pub row_id: String,
    pub row_status: SheetRowStatus,
    pub error_message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateImportJobInput {
    pub job_id: String,
    pub sheet_id: String,
    pub kind: ImportKind,
    pub mode: ImportMode,
    pub total_count: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateImportJobItemInput {
    pub item_id: String,
    pub job_id: String,
    pub source_item_id: String,
    pub source_item_kind: ImportSourceItemKind,
    pub position: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateImportJobItemStatusInput {
    pub item_id: String,
    pub status: ImportJobItemStatus,
    pub tracking_ids: Vec<String>,
    pub error_message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartImportAttemptInput {
    pub attempt_id: String,
    pub item_id: String,
    pub raw_blob_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishImportAttemptInput {
    pub attempt_id: String,
    pub status: ImportAttemptStatus,
    pub tracking_ids: Vec<String>,
    pub error_message: Option<String>,
    pub raw_blob_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertRawBlobInput {
    pub blob_id: String,
    pub sha256: String,
    pub media_type: String,
    pub byte_len: u64,
    pub storage_path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawBlobRecord {
    pub blob_id: String,
    pub sha256: String,
    pub media_type: String,
    pub byte_len: u64,
    pub storage_path: String,
}

pub struct SqliteWorkspaceStore {
    connection: Connection,
}

impl SqliteWorkspaceStore {
    pub fn open(path: impl AsRef<Path>) -> WorkspaceStoreResult<Self> {
        let connection = Connection::open(path)?;
        Self::initialize(connection)
    }

    pub fn open_memory() -> WorkspaceStoreResult<Self> {
        let connection = Connection::open_in_memory()?;
        Self::initialize(connection)
    }

    fn initialize(connection: Connection) -> WorkspaceStoreResult<Self> {
        let store = Self { connection };
        store.apply_migrations()?;
        Ok(store)
    }

    fn apply_migrations(&self) -> WorkspaceStoreResult<()> {
        for statement in SQLITE_PRAGMAS {
            self.connection.execute_batch(statement)?;
        }
        self.connection.execute_batch(SCHEMA_SQL)?;
        if !self.table_has_column("sheet_rows", "row_generation")? {
            self.connection.execute(
                "ALTER TABLE sheet_rows ADD COLUMN row_generation TEXT NOT NULL DEFAULT ''",
                [],
            )?;
        }
        self.connection.execute(
            r#"
            UPDATE sheet_rows
            SET row_generation = id || ':' || created_at
            WHERE row_generation = ''
            "#,
            [],
        )?;
        Ok(())
    }

    fn table_has_column(&self, table: &str, column: &str) -> WorkspaceStoreResult<bool> {
        let mut statement = self
            .connection
            .prepare(&format!("PRAGMA table_info({table})"))?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            if row.get::<_, String>(1)? == column {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn invalidate_analytics_cache_for_row(&self, row_id: &str) -> WorkspaceStoreResult<()> {
        self.connection.execute(
            r#"
            DELETE FROM analytics_cache
            WHERE sheet_id = (
              SELECT sheet_id
              FROM sheet_rows
              WHERE id = ?1
            )
            "#,
            params![row_id],
        )?;
        Ok(())
    }

    fn invalidate_analytics_cache_for_tracking_record(
        &self,
        record_id: &str,
    ) -> WorkspaceStoreResult<()> {
        self.connection.execute(
            r#"
            DELETE FROM analytics_cache
            WHERE sheet_id IN (
              SELECT sheet_id
              FROM sheet_rows
              WHERE tracking_record_id = ?1
            )
            "#,
            params![record_id],
        )?;
        Ok(())
    }

    pub fn pragma_value(&self, name: &str) -> WorkspaceStoreResult<String> {
        let sql = format!("PRAGMA {name};");
        Ok(self.connection.query_row(&sql, [], |row| {
            let value = row.get_ref(0)?;
            match value {
                ValueRef::Null => Ok(String::new()),
                ValueRef::Integer(value) => Ok(value.to_string()),
                ValueRef::Real(value) => Ok(value.to_string()),
                ValueRef::Text(value) => Ok(String::from_utf8_lossy(value).into_owned()),
                ValueRef::Blob(value) => Ok(hex::encode(value)),
            }
        })?)
    }

    pub fn create_workspace(
        &mut self,
        input: &CreateWorkspaceInput,
    ) -> WorkspaceStoreResult<WorkspaceRecord> {
        let now = now_utc_text();
        self.connection.execute(
            r#"
            INSERT INTO workspaces (id, name, created_at, updated_at, schema_version)
            VALUES (?1, ?2, ?3, ?3, ?4)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              updated_at = excluded.updated_at,
              schema_version = excluded.schema_version
            "#,
            params![input.workspace_id, input.name, now, SCHEMA_VERSION],
        )?;

        Ok(WorkspaceRecord {
            workspace_id: input.workspace_id.clone(),
            name: input.name.clone(),
            schema_version: SCHEMA_VERSION,
        })
    }

    pub fn create_sheet(&mut self, input: &CreateSheetInput) -> WorkspaceStoreResult<SheetRecord> {
        let now = now_utc_text();
        self.connection.execute(
            r#"
            INSERT INTO sheets (id, workspace_id, name, position, view_mode, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, 'workspace', ?5, ?5)
            ON CONFLICT(id) DO NOTHING
            "#,
            params![
                input.sheet_id,
                input.workspace_id,
                input.name,
                input.position,
                now
            ],
        )?;

        self.get_sheet(&input.sheet_id)?
            .ok_or_else(|| WorkspaceStoreError::InvalidValue {
                field: "sheet",
                value: input.sheet_id.clone(),
            })
    }

    pub fn delete_sheet(&mut self, sheet_id: &str) -> WorkspaceStoreResult<()> {
        self.connection
            .execute("DELETE FROM sheets WHERE id = ?1", params![sheet_id])?;
        Ok(())
    }

    pub fn rename_sheet(
        &mut self,
        sheet_id: &str,
        name: &str,
    ) -> WorkspaceStoreResult<SheetRecord> {
        let now = now_utc_text();
        let updated = self.connection.execute(
            r#"
            UPDATE sheets
            SET name = ?2,
                updated_at = ?3
            WHERE id = ?1
            "#,
            params![sheet_id, name, now],
        )?;
        if updated == 0 {
            return Err(WorkspaceStoreError::InvalidValue {
                field: "sheet",
                value: sheet_id.to_string(),
            });
        }

        self.get_sheet(sheet_id)?
            .ok_or_else(|| WorkspaceStoreError::InvalidValue {
                field: "sheet",
                value: sheet_id.to_string(),
            })
    }

    pub fn get_sheet(&self, sheet_id: &str) -> WorkspaceStoreResult<Option<SheetRecord>> {
        self.connection
            .query_row(
                r#"
                SELECT id, workspace_id, name, position, view_mode
                FROM sheets
                WHERE id = ?1
                "#,
                params![sheet_id],
                |row| {
                    Ok(SheetRecord {
                        sheet_id: row.get(0)?,
                        workspace_id: row.get(1)?,
                        name: row.get(2)?,
                        position: row.get::<_, i64>(3)? as u32,
                        view_mode: row.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(WorkspaceStoreError::from)
    }

    pub fn list_sheets(&self) -> WorkspaceStoreResult<Vec<SheetRecord>> {
        let mut statement = self.connection.prepare(
            r#"
            SELECT id, workspace_id, name, position, view_mode
            FROM sheets
            ORDER BY position ASC, id ASC
            "#,
        )?;

        let sheets = statement
            .query_map([], |row| {
                Ok(SheetRecord {
                    sheet_id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    name: row.get(2)?,
                    position: row.get::<_, i64>(3)? as u32,
                    view_mode: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, rusqlite::Error>>()?;

        Ok(sheets)
    }

    pub fn sheet_exists(&self, sheet_id: &str) -> WorkspaceStoreResult<bool> {
        let count = self.connection.query_row(
            "SELECT COUNT(1) FROM sheets WHERE id = ?1",
            params![sheet_id],
            |row| row.get::<_, u32>(0),
        )?;

        Ok(count > 0)
    }

    pub fn primary_workspace_id(&self) -> WorkspaceStoreResult<Option<String>> {
        Ok(self
            .connection
            .query_row(
                "SELECT id FROM workspaces ORDER BY created_at ASC, id ASC LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?)
    }

    pub fn upsert_sheet_row(&mut self, input: &UpsertSheetRowInput) -> WorkspaceStoreResult<()> {
        self.upsert_sheet_rows_atomic(&input.sheet_id, std::slice::from_ref(input), false)
    }

    pub fn upsert_sheet_rows_atomic(
        &mut self,
        sheet_id: &str,
        inputs: &[UpsertSheetRowInput],
        replace_existing: bool,
    ) -> WorkspaceStoreResult<()> {
        if inputs.iter().any(|input| input.sheet_id != sheet_id) {
            return Err(WorkspaceStoreError::InvalidValue {
                field: "sheet_row_sheet_id",
                value: sheet_id.to_string(),
            });
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if replace_existing {
            transaction.execute(
                "DELETE FROM sheet_rows WHERE sheet_id = ?1",
                params![sheet_id],
            )?;
        }
        let now = now_utc_text();
        for input in inputs {
            upsert_sheet_row_on(&transaction, input, &now)?;
        }
        transaction.execute(
            "DELETE FROM analytics_cache WHERE sheet_id = ?1",
            params![sheet_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn upsert_tracking_record(
        &mut self,
        input: &UpsertTrackingRecordInput,
    ) -> WorkspaceStoreResult<()> {
        let now = now_utc_text();
        let status_json = serde_json::to_string(&input.status_json)?;
        let detail_json = serde_json::to_string(&input.detail_json)?;
        let history_json = serde_json::to_string(&input.history_json)?;

        self.connection.execute(
            r#"
            INSERT INTO tracking_records (
              id,
              display_tracking_id,
              lookup_tracking_id,
              normalized_status,
              status_json,
              detail_json,
              history_json,
              raw_blob_id,
              fetched_at,
              source_url
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            ON CONFLICT(id) DO UPDATE SET
              display_tracking_id = excluded.display_tracking_id,
              lookup_tracking_id = excluded.lookup_tracking_id,
              normalized_status = excluded.normalized_status,
              status_json = excluded.status_json,
              detail_json = excluded.detail_json,
              history_json = excluded.history_json,
              raw_blob_id = excluded.raw_blob_id,
              fetched_at = excluded.fetched_at,
              source_url = excluded.source_url
            "#,
            params![
                input.record_id,
                input.display_tracking_id,
                input.lookup_tracking_id,
                input.normalized_status,
                status_json,
                detail_json,
                history_json,
                input.raw_blob_id,
                now,
                input.source_url
            ],
        )?;

        self.invalidate_analytics_cache_for_tracking_record(&input.record_id)?;

        Ok(())
    }

    pub fn upsert_tracking_record_and_attach_if_row_matches(
        &mut self,
        record: &UpsertTrackingRecordInput,
        attachment: &AttachTrackingRecordToSheetRowInput,
        expected_lookup_tracking_id: &str,
        expected_row_generation: &str,
    ) -> WorkspaceStoreResult<bool> {
        let status_json = serde_json::to_string(&record.status_json)?;
        let detail_json = serde_json::to_string(&record.detail_json)?;
        let history_json = serde_json::to_string(&record.history_json)?;
        let now = now_utc_text();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let matches = transaction.query_row(
            r#"
            SELECT EXISTS(
              SELECT 1
              FROM sheet_rows
              WHERE id = ?1
                AND lookup_tracking_id = ?2
                AND row_generation = ?3
            )
            "#,
            params![
                attachment.row_id,
                expected_lookup_tracking_id,
                expected_row_generation
            ],
            |row| row.get::<_, bool>(0),
        )?;
        if !matches {
            return Ok(false);
        }

        transaction.execute(
            r#"
            INSERT INTO tracking_records (
              id,
              display_tracking_id,
              lookup_tracking_id,
              normalized_status,
              status_json,
              detail_json,
              history_json,
              raw_blob_id,
              fetched_at,
              source_url
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            ON CONFLICT(id) DO UPDATE SET
              display_tracking_id = excluded.display_tracking_id,
              lookup_tracking_id = excluded.lookup_tracking_id,
              normalized_status = excluded.normalized_status,
              status_json = excluded.status_json,
              detail_json = excluded.detail_json,
              history_json = excluded.history_json,
              raw_blob_id = excluded.raw_blob_id,
              fetched_at = excluded.fetched_at,
              source_url = excluded.source_url
            "#,
            params![
                record.record_id,
                record.display_tracking_id,
                record.lookup_tracking_id,
                record.normalized_status,
                status_json,
                detail_json,
                history_json,
                record.raw_blob_id,
                now,
                record.source_url
            ],
        )?;
        let changed = transaction.execute(
            r#"
            UPDATE sheet_rows
            SET tracking_record_id = ?2,
                row_status = ?3,
                error_message = ?4,
                updated_at = ?5
            WHERE id = ?1
              AND lookup_tracking_id = ?6
              AND row_generation = ?7
            "#,
            params![
                attachment.row_id,
                attachment.tracking_record_id,
                sheet_row_status_to_db(attachment.row_status),
                attachment.error_message,
                now,
                expected_lookup_tracking_id,
                expected_row_generation
            ],
        )?;
        if changed == 0 {
            return Ok(false);
        }
        transaction.execute(
            r#"
            DELETE FROM analytics_cache
            WHERE sheet_id IN (
              SELECT sheet_id
              FROM sheet_rows
              WHERE tracking_record_id = ?1 OR id = ?2
            )
            "#,
            params![record.record_id, attachment.row_id],
        )?;
        transaction.commit()?;
        Ok(true)
    }

    pub fn attach_tracking_record_to_sheet_row(
        &mut self,
        input: &AttachTrackingRecordToSheetRowInput,
    ) -> WorkspaceStoreResult<()> {
        let now = now_utc_text();
        self.connection.execute(
            r#"
            UPDATE sheet_rows
            SET tracking_record_id = ?2,
                row_status = ?3,
                error_message = ?4,
                updated_at = ?5
            WHERE id = ?1
            "#,
            params![
                input.row_id,
                input.tracking_record_id,
                sheet_row_status_to_db(input.row_status),
                input.error_message,
                now
            ],
        )?;

        self.invalidate_analytics_cache_for_row(&input.row_id)?;

        Ok(())
    }

    pub fn attach_tracking_record_to_sheet_row_if_lookup_matches(
        &mut self,
        input: &AttachTrackingRecordToSheetRowInput,
        expected_lookup_tracking_id: &str,
        expected_row_generation: &str,
    ) -> WorkspaceStoreResult<bool> {
        let now = now_utc_text();
        let changed = self.connection.execute(
            r#"
            UPDATE sheet_rows
            SET tracking_record_id = ?2,
                row_status = ?3,
                error_message = ?4,
                updated_at = ?5
            WHERE id = ?1
              AND lookup_tracking_id = ?6
              AND row_generation = ?7
            "#,
            params![
                input.row_id,
                input.tracking_record_id,
                sheet_row_status_to_db(input.row_status),
                input.error_message,
                now,
                expected_lookup_tracking_id,
                expected_row_generation
            ],
        )?;

        if changed > 0 {
            self.invalidate_analytics_cache_for_row(&input.row_id)?;
        }

        Ok(changed > 0)
    }

    pub fn update_sheet_row_status(
        &mut self,
        input: &UpdateSheetRowStatusInput,
    ) -> WorkspaceStoreResult<()> {
        let now = now_utc_text();
        self.connection.execute(
            r#"
            UPDATE sheet_rows
            SET row_status = ?2,
                error_message = ?3,
                updated_at = ?4
            WHERE id = ?1
            "#,
            params![
                input.row_id,
                sheet_row_status_to_db(input.row_status),
                input.error_message,
                now
            ],
        )?;

        self.invalidate_analytics_cache_for_row(&input.row_id)?;

        Ok(())
    }

    pub fn update_sheet_row_status_if_lookup_matches(
        &mut self,
        input: &UpdateSheetRowStatusInput,
        expected_lookup_tracking_id: &str,
        expected_row_generation: &str,
    ) -> WorkspaceStoreResult<bool> {
        let now = now_utc_text();
        let changed = self.connection.execute(
            r#"
            UPDATE sheet_rows
            SET row_status = ?2,
                error_message = ?3,
                updated_at = ?4
            WHERE id = ?1
              AND lookup_tracking_id = ?5
              AND row_generation = ?6
            "#,
            params![
                input.row_id,
                sheet_row_status_to_db(input.row_status),
                input.error_message,
                now,
                expected_lookup_tracking_id,
                expected_row_generation
            ],
        )?;

        if changed > 0 {
            self.invalidate_analytics_cache_for_row(&input.row_id)?;
        }

        Ok(changed > 0)
    }

    pub fn upsert_raw_blob(&mut self, input: &UpsertRawBlobInput) -> WorkspaceStoreResult<()> {
        let now = now_utc_text();
        self.connection.execute(
            r#"
            INSERT INTO raw_blobs (
              id,
              sha256,
              media_type,
              byte_len,
              storage_path,
              created_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(id) DO UPDATE SET
              sha256 = excluded.sha256,
              media_type = excluded.media_type,
              byte_len = excluded.byte_len,
              storage_path = excluded.storage_path
            "#,
            params![
                input.blob_id,
                input.sha256,
                input.media_type,
                input.byte_len as i64,
                input.storage_path,
                now
            ],
        )?;

        Ok(())
    }

    pub fn get_raw_blob(&self, blob_id: &str) -> WorkspaceStoreResult<Option<RawBlobRecord>> {
        Ok(self
            .connection
            .query_row(
                r#"
                SELECT id, sha256, media_type, byte_len, storage_path
                FROM raw_blobs
                WHERE id = ?1
                "#,
                params![blob_id],
                |row| {
                    Ok(RawBlobRecord {
                        blob_id: row.get(0)?,
                        sha256: row.get(1)?,
                        media_type: row.get(2)?,
                        byte_len: row.get::<_, i64>(3)?.max(0) as u64,
                        storage_path: row.get(4)?,
                    })
                },
            )
            .optional()?)
    }

    pub fn get_tracking_record_raw_blob_id(
        &self,
        record_id: &str,
    ) -> WorkspaceStoreResult<Option<String>> {
        Ok(self
            .connection
            .query_row(
                "SELECT raw_blob_id FROM tracking_records WHERE id = ?1",
                params![record_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    }

    pub fn clear_sheet_rows(&mut self, sheet_id: &str) -> WorkspaceStoreResult<()> {
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "DELETE FROM sheet_rows WHERE sheet_id = ?1",
            params![sheet_id],
        )?;
        transaction.execute(
            "DELETE FROM analytics_cache WHERE sheet_id = ?1",
            params![sheet_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn delete_sheet_rows(
        &mut self,
        sheet_id: &str,
        row_ids: &[String],
    ) -> WorkspaceStoreResult<()> {
        if row_ids.is_empty() {
            return Ok(());
        }

        let transaction = self.connection.transaction()?;
        for row_id in row_ids {
            transaction.execute(
                "DELETE FROM sheet_rows WHERE sheet_id = ?1 AND id = ?2",
                params![sheet_id, row_id],
            )?;
        }

        let remaining_row_ids = {
            let mut statement = transaction.prepare(
                r#"
                SELECT id
                FROM sheet_rows
                WHERE sheet_id = ?1
                ORDER BY position ASC, id ASC
                "#,
            )?;
            let row_ids = statement
                .query_map(params![sheet_id], |row| row.get(0))?
                .collect::<Result<Vec<String>, rusqlite::Error>>()?;
            row_ids
        };
        let now = now_utc_text();
        for (position, row_id) in remaining_row_ids.iter().enumerate() {
            transaction.execute(
                r#"
                UPDATE sheet_rows
                SET position = ?3,
                    updated_at = ?4
                WHERE sheet_id = ?1 AND id = ?2
                "#,
                params![sheet_id, row_id, position as u32, now],
            )?;
        }

        transaction.execute(
            "DELETE FROM analytics_cache WHERE sheet_id = ?1",
            params![sheet_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn transfer_sheet_rows(
        &mut self,
        input: &TransferSheetRowsInput,
    ) -> WorkspaceStoreResult<()> {
        if input.row_ids.is_empty() || input.source_sheet_id == input.target_sheet_id {
            return Ok(());
        }

        let transaction = self.connection.transaction()?;
        let mut next_position = transaction.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM sheet_rows WHERE sheet_id = ?1",
            params![input.target_sheet_id],
            |row| row.get::<_, i64>(0),
        )? as u32;
        let now = now_utc_text();
        let mut copied_source_row_ids = Vec::new();
        let mut seen_source_row_ids = std::collections::HashSet::new();

        for source_row_id in &input.row_ids {
            let source_row_id = source_row_id.trim();
            if source_row_id.is_empty() || !seen_source_row_ids.insert(source_row_id.to_string()) {
                continue;
            }

            let source_row = transaction
                .query_row(
                    r#"
                    SELECT
                      display_tracking_id,
                      lookup_tracking_id,
                      tracking_record_id,
                      row_status,
                      error_message
                    FROM sheet_rows
                    WHERE sheet_id = ?1 AND id = ?2
                    "#,
                    params![input.source_sheet_id, source_row_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, Option<String>>(4)?,
                        ))
                    },
                )
                .optional()?;
            let Some((
                display_tracking_id,
                lookup_tracking_id,
                tracking_record_id,
                row_status,
                error_message,
            )) = source_row
            else {
                continue;
            };

            let target_row_id = next_available_generated_sheet_row_id(
                &transaction,
                &input.target_sheet_id,
                next_position,
            )?;
            transaction.execute(
                r#"
                INSERT INTO sheet_rows (
                  id,
                  sheet_id,
                  position,
                  display_tracking_id,
                  lookup_tracking_id,
                  row_generation,
                  tracking_record_id,
                  row_status,
                  error_message,
                  created_at,
                  updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
                "#,
                params![
                    target_row_id,
                    input.target_sheet_id,
                    next_position,
                    display_tracking_id,
                    lookup_tracking_id,
                    next_row_generation(),
                    tracking_record_id,
                    row_status,
                    error_message,
                    now,
                ],
            )?;
            copied_source_row_ids.push(source_row_id.to_string());
            next_position = next_position.saturating_add(1);
        }

        if input.delete_source_rows {
            for row_id in copied_source_row_ids {
                transaction.execute(
                    "DELETE FROM sheet_rows WHERE sheet_id = ?1 AND id = ?2",
                    params![input.source_sheet_id, row_id],
                )?;
            }
            compact_sheet_row_positions(&transaction, &input.source_sheet_id, &now)?;
        }

        transaction.execute(
            "DELETE FROM analytics_cache WHERE sheet_id = ?1",
            params![input.target_sheet_id],
        )?;
        if input.delete_source_rows {
            transaction.execute(
                "DELETE FROM analytics_cache WHERE sheet_id = ?1",
                params![input.source_sheet_id],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn copy_sheet_rows(
        &mut self,
        source_sheet_id: &str,
        target_sheet_id: &str,
    ) -> WorkspaceStoreResult<()> {
        let row_ids = self.list_sheet_row_ids(source_sheet_id)?;
        self.transfer_sheet_rows(&TransferSheetRowsInput {
            source_sheet_id: source_sheet_id.to_string(),
            target_sheet_id: target_sheet_id.to_string(),
            row_ids,
            delete_source_rows: false,
        })
    }

    pub fn next_sheet_row_position(&self, sheet_id: &str) -> WorkspaceStoreResult<u32> {
        Ok(self.connection.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM sheet_rows WHERE sheet_id = ?1",
            params![sheet_id],
            |row| row.get::<_, i64>(0),
        )? as u32)
    }

    pub fn sheet_has_display_tracking_id(
        &self,
        sheet_id: &str,
        display_tracking_id: &str,
    ) -> WorkspaceStoreResult<bool> {
        let count = self.connection.query_row(
            r#"
            SELECT COUNT(*)
            FROM sheet_rows
            WHERE sheet_id = ?1 AND display_tracking_id = ?2
            "#,
            params![sheet_id, display_tracking_id],
            |row| row.get::<_, i64>(0),
        )?;
        Ok(count > 0)
    }

    pub fn list_sheet_row_ids(&self, sheet_id: &str) -> WorkspaceStoreResult<Vec<String>> {
        let mut statement = self.connection.prepare(
            r#"
            SELECT id
            FROM sheet_rows
            WHERE sheet_id = ?1
            ORDER BY position ASC, id ASC
            "#,
        )?;

        let row_ids = statement
            .query_map(params![sheet_id], |row| row.get(0))?
            .collect::<Result<Vec<_>, rusqlite::Error>>()?;
        Ok(row_ids)
    }

    pub fn query_sheet_rows(
        &self,
        query: &SheetRowsQuery,
        max_limit: u32,
    ) -> WorkspaceStoreResult<SheetRowWindow> {
        let (offset, limit) = clamp_query_window(query.offset, query.limit, max_limit);
        let (where_sql, filter_bindings) = build_sheet_filter_sql(query)?;
        let total_count = self.connection.query_row(
            &format!(
                r#"
                SELECT COUNT(*)
                FROM sheet_rows r
                LEFT JOIN tracking_records tr ON tr.id = r.tracking_record_id
                {where_sql}
                "#
            ),
            params_from_iter(filter_bindings.iter()),
            |row| row.get::<_, i64>(0),
        )? as u32;

        let order_sql = build_sheet_sort_sql(&query.sort);
        let mut row_bindings = filter_bindings;
        row_bindings.push(Value::Integer(limit as i64));
        row_bindings.push(Value::Integer(offset as i64));

        let mut statement = self.connection.prepare(&format!(
            r#"
            SELECT
              r.id,
              r.row_generation,
              r.position,
              r.display_tracking_id,
              r.lookup_tracking_id,
              r.row_status,
              r.error_message,
              tr.status_json,
              tr.detail_json,
              tr.history_json
            FROM sheet_rows r
            LEFT JOIN tracking_records tr ON tr.id = r.tracking_record_id
            {where_sql}
            ORDER BY {order_sql}
            LIMIT ?{} OFFSET ?{}
            "#,
            row_bindings.len() - 1,
            row_bindings.len()
        ))?;
        let rows = statement
            .query_map(params_from_iter(row_bindings.iter()), |row| {
                let row_status = sheet_row_status_from_db(row.get::<_, String>(5)?.as_str())?;
                let status_json = parse_optional_json(row.get::<_, Option<String>>(7)?)?;
                let detail_json = parse_optional_json(row.get::<_, Option<String>>(8)?)?;
                let history_json = parse_optional_json(row.get::<_, Option<String>>(9)?)?;

                Ok(SheetRowProjection {
                    row_id: row.get(0)?,
                    row_generation: row.get(1)?,
                    position: row.get::<_, i64>(2)? as u32,
                    display_tracking_id: row.get(3)?,
                    lookup_tracking_id: row.get(4)?,
                    row_status,
                    error_message: row.get(6)?,
                    status_json,
                    detail_json,
                    history_json,
                })
            })?
            .collect::<Result<Vec<_>, rusqlite::Error>>()?;

        let next_offset = offset.saturating_add(rows.len() as u32);
        let has_more = next_offset < total_count;

        Ok(SheetRowWindow {
            sheet_id: query.sheet_id.clone(),
            offset,
            limit,
            total_count,
            has_more,
            next_offset: has_more.then_some(next_offset),
            rows,
        })
    }

    pub fn query_sheet_field_values(
        &self,
        query: &SheetFieldValuesQuery,
        max_limit: u32,
    ) -> WorkspaceStoreResult<SheetFieldValuesResult> {
        let limit = query.limit.min(max_limit);
        let field_column = sheet_value_option_column(&query.field).ok_or_else(|| {
            WorkspaceStoreError::InvalidValue {
                field: "sheet_field_value",
                value: query.field.clone(),
            }
        })?;
        let row_query = SheetRowsQuery {
            sheet_id: query.sheet_id.clone(),
            offset: 0,
            limit: 0,
            filters: query.filters.clone(),
            value_filters: query.value_filters.clone(),
            sort: vec![],
        };
        let (where_sql, mut bindings) = build_sheet_filter_sql(&row_query)?;
        let value_sql = format!("CAST({field_column} AS TEXT)");
        let total_bindings = bindings.clone();
        let total_count = self.connection.query_row(
            &format!(
                r#"
                SELECT COUNT(*)
                FROM (
                    SELECT {value_sql} AS value
                    FROM sheet_rows r
                    LEFT JOIN tracking_records tr ON tr.id = r.tracking_record_id
                    {where_sql}
                )
                WHERE value <> '' AND value <> '-'
                "#
            ),
            params_from_iter(total_bindings.iter()),
            |row| row.get::<_, i64>(0),
        )? as u32;

        bindings.push(Value::Integer(limit as i64));
        let mut statement = self.connection.prepare(&format!(
            r#"
            SELECT value, COUNT(*) AS count
            FROM (
                SELECT {value_sql} AS value
                FROM sheet_rows r
                LEFT JOIN tracking_records tr ON tr.id = r.tracking_record_id
                {where_sql}
            )
            WHERE value <> '' AND value <> '-'
            GROUP BY value
            ORDER BY count DESC, value COLLATE NOCASE ASC
            LIMIT ?{}
            "#,
            bindings.len()
        ))?;
        let values = statement
            .query_map(params_from_iter(bindings.iter()), |row| {
                Ok(SheetFieldValueOption {
                    value: row.get(0)?,
                    count: row.get::<_, i64>(1)? as u32,
                })
            })?
            .collect::<Result<Vec<_>, rusqlite::Error>>()?;

        Ok(SheetFieldValuesResult {
            sheet_id: query.sheet_id.clone(),
            field: query.field.clone(),
            total_count,
            values,
        })
    }

    pub fn get_sheet_row(&self, row_id: &str) -> WorkspaceStoreResult<Option<SheetRowProjection>> {
        let mut statement = self.connection.prepare(
            r#"
            SELECT
              r.id,
              r.row_generation,
              r.position,
              r.display_tracking_id,
              r.lookup_tracking_id,
              r.row_status,
              r.error_message,
              tr.status_json,
              tr.detail_json,
              tr.history_json
            FROM sheet_rows r
            LEFT JOIN tracking_records tr ON tr.id = r.tracking_record_id
            WHERE r.id = ?1
            "#,
        )?;

        let row = statement
            .query_row(params![row_id], |row| {
                let row_status = sheet_row_status_from_db(row.get::<_, String>(5)?.as_str())?;
                let status_json = parse_optional_json(row.get::<_, Option<String>>(7)?)?;
                let detail_json = parse_optional_json(row.get::<_, Option<String>>(8)?)?;
                let history_json = parse_optional_json(row.get::<_, Option<String>>(9)?)?;

                Ok(SheetRowProjection {
                    row_id: row.get(0)?,
                    row_generation: row.get(1)?,
                    position: row.get::<_, i64>(2)? as u32,
                    display_tracking_id: row.get(3)?,
                    lookup_tracking_id: row.get(4)?,
                    row_status,
                    error_message: row.get(6)?,
                    status_json,
                    detail_json,
                    history_json,
                })
            })
            .optional()?;

        Ok(row)
    }

    pub fn sheet_row_belongs_to_sheet(
        &self,
        row_id: &str,
        sheet_id: &str,
    ) -> WorkspaceStoreResult<bool> {
        let count = self.connection.query_row(
            "SELECT COUNT(*) FROM sheet_rows WHERE id = ?1 AND sheet_id = ?2",
            params![row_id, sheet_id],
            |row| row.get::<_, i64>(0),
        )?;

        Ok(count > 0)
    }

    pub fn sheet_row_id_for_display_tracking_id(
        &self,
        sheet_id: &str,
        display_tracking_id: &str,
    ) -> WorkspaceStoreResult<Option<String>> {
        self.connection
            .query_row(
                r#"
                SELECT id
                FROM sheet_rows
                WHERE sheet_id = ?1 AND display_tracking_id = ?2
                ORDER BY position ASC, id ASC
                LIMIT 1
                "#,
                params![sheet_id, display_tracking_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(WorkspaceStoreError::from)
    }

    pub fn create_import_job(
        &mut self,
        input: &CreateImportJobInput,
    ) -> WorkspaceStoreResult<ImportJobSummary> {
        let now = now_utc_text();
        self.connection.execute(
            r#"
            INSERT INTO import_jobs (
              id,
              sheet_id,
              kind,
              mode,
              status,
              total_count,
              pending_count,
              created_at,
              updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?7)
            ON CONFLICT(id) DO UPDATE SET
              sheet_id = excluded.sheet_id,
              kind = excluded.kind,
              mode = excluded.mode,
              status = excluded.status,
              total_count = excluded.total_count,
              success_count = 0,
              failed_count = 0,
              pending_count = excluded.pending_count,
              completed_at = NULL,
              cancelled_at = NULL,
              updated_at = excluded.updated_at
            "#,
            params![
                input.job_id,
                input.sheet_id,
                import_kind_to_db(input.kind),
                import_mode_to_db(input.mode),
                import_job_status_to_db(ImportJobStatus::Pending),
                input.total_count,
                now
            ],
        )?;

        self.get_import_job_summary(&input.job_id)?
            .ok_or_else(|| WorkspaceStoreError::MissingImportJob(input.job_id.clone()))
    }

    pub fn create_import_job_with_items(
        &mut self,
        input: &CreateImportJobInput,
        items: &[CreateImportJobItemInput],
    ) -> WorkspaceStoreResult<ImportJobSummary> {
        if items.iter().any(|item| item.job_id != input.job_id) {
            return Err(WorkspaceStoreError::InvalidValue {
                field: "import_job_item_job_id",
                value: input.job_id.clone(),
            });
        }

        let now = now_utc_text();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if input.mode == ImportMode::Replace {
            transaction.execute(
                "DELETE FROM sheet_rows WHERE sheet_id = ?1",
                params![input.sheet_id],
            )?;
            transaction.execute(
                "DELETE FROM analytics_cache WHERE sheet_id = ?1",
                params![input.sheet_id],
            )?;
        }
        transaction.execute(
            r#"
            INSERT INTO import_jobs (
              id,
              sheet_id,
              kind,
              mode,
              status,
              total_count,
              pending_count,
              created_at,
              updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?7)
            ON CONFLICT(id) DO UPDATE SET
              sheet_id = excluded.sheet_id,
              kind = excluded.kind,
              mode = excluded.mode,
              status = excluded.status,
              total_count = excluded.total_count,
              success_count = 0,
              failed_count = 0,
              pending_count = excluded.pending_count,
              completed_at = NULL,
              cancelled_at = NULL,
              updated_at = excluded.updated_at
            "#,
            params![
                input.job_id,
                input.sheet_id,
                import_kind_to_db(input.kind),
                import_mode_to_db(input.mode),
                import_job_status_to_db(ImportJobStatus::Pending),
                items.len() as u32,
                now
            ],
        )?;
        transaction.execute(
            "DELETE FROM import_job_items WHERE job_id = ?1",
            params![input.job_id],
        )?;
        for item in items {
            transaction.execute(
                r#"
                INSERT INTO import_job_items (
                  id,
                  job_id,
                  source_item_id,
                  source_item_kind,
                  position,
                  status,
                  tracking_ids_json,
                  sheet_row_ids_json,
                  created_at,
                  updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, '[]', '[]', ?7, ?7)
                "#,
                params![
                    item.item_id,
                    item.job_id,
                    item.source_item_id,
                    import_source_item_kind_to_db(item.source_item_kind),
                    item.position,
                    import_job_item_status_to_db(ImportJobItemStatus::Pending),
                    now
                ],
            )?;
        }
        recompute_import_job_counts_on(&transaction, &input.job_id)?;
        transaction.commit()?;

        self.get_import_job_summary(&input.job_id)?
            .ok_or_else(|| WorkspaceStoreError::MissingImportJob(input.job_id.clone()))
    }

    pub fn create_import_job_item(
        &mut self,
        input: &CreateImportJobItemInput,
    ) -> WorkspaceStoreResult<ImportJobItem> {
        let now = now_utc_text();
        self.connection.execute(
            r#"
            INSERT INTO import_job_items (
              id,
              job_id,
              source_item_id,
              source_item_kind,
              position,
              status,
              tracking_ids_json,
              sheet_row_ids_json,
              created_at,
              updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, '[]', '[]', ?7, ?7)
            ON CONFLICT(job_id, source_item_id, source_item_kind) DO UPDATE SET
              position = excluded.position,
              status = excluded.status,
              tracking_ids_json = excluded.tracking_ids_json,
              sheet_row_ids_json = excluded.sheet_row_ids_json,
              error_message = NULL,
              updated_at = excluded.updated_at
            "#,
            params![
                input.item_id,
                input.job_id,
                input.source_item_id,
                import_source_item_kind_to_db(input.source_item_kind),
                input.position,
                import_job_item_status_to_db(ImportJobItemStatus::Pending),
                now
            ],
        )?;
        self.recompute_import_job_counts(&input.job_id)?;

        self.get_import_job_item(&input.item_id)?
            .ok_or_else(|| WorkspaceStoreError::InvalidValue {
                field: "import_job_item",
                value: input.item_id.clone(),
            })
    }

    pub fn next_import_job_item_position(&self, job_id: &str) -> WorkspaceStoreResult<u32> {
        Ok(self.connection.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM import_job_items WHERE job_id = ?1",
            params![job_id],
            |row| row.get::<_, i64>(0),
        )? as u32)
    }

    pub fn update_import_job_item_status(
        &mut self,
        input: &UpdateImportJobItemStatusInput,
    ) -> WorkspaceStoreResult<()> {
        let now = now_utc_text();
        let tracking_ids_json = serde_json::to_string(&input.tracking_ids)?;
        let job_id = self
            .connection
            .query_row(
                "SELECT job_id FROM import_job_items WHERE id = ?1",
                params![input.item_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| WorkspaceStoreError::InvalidValue {
                field: "import_job_item",
                value: input.item_id.clone(),
            })?;

        self.connection.execute(
            r#"
            UPDATE import_job_items
            SET status = ?2,
                tracking_ids_json = ?3,
                error_message = ?4,
                attempt_count = attempt_count + 1,
                updated_at = ?5
            WHERE id = ?1
            "#,
            params![
                input.item_id,
                import_job_item_status_to_db(input.status),
                tracking_ids_json,
                input.error_message,
                now
            ],
        )?;
        self.recompute_import_job_counts(&job_id)?;

        Ok(())
    }

    pub fn update_import_job_item_sheet_row_ids(
        &mut self,
        item_id: &str,
        sheet_row_ids: &[String],
    ) -> WorkspaceStoreResult<()> {
        let now = now_utc_text();
        let sheet_row_ids_json = serde_json::to_string(sheet_row_ids)?;
        self.connection.execute(
            r#"
            UPDATE import_job_items
            SET sheet_row_ids_json = ?2,
                updated_at = ?3
            WHERE id = ?1
            "#,
            params![item_id, sheet_row_ids_json, now],
        )?;

        Ok(())
    }

    pub fn claim_next_pending_import_job_item(
        &mut self,
        job_id: &str,
    ) -> WorkspaceStoreResult<Option<ImportJobItem>> {
        let transaction = self.connection.transaction()?;
        let Some(item_id) = transaction
            .query_row(
                r#"
                SELECT i.id
                FROM import_job_items i
                JOIN import_jobs j ON j.id = i.job_id
                WHERE i.job_id = ?1
                  AND i.status = ?2
                  AND j.status <> ?3
                ORDER BY i.position ASC, i.id ASC
                LIMIT 1
                "#,
                params![
                    job_id,
                    import_job_item_status_to_db(ImportJobItemStatus::Pending),
                    import_job_status_to_db(ImportJobStatus::Cancelled)
                ],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        else {
            return Ok(None);
        };

        let now = now_utc_text();
        let changed = transaction.execute(
            r#"
            UPDATE import_job_items
            SET status = ?2,
                error_message = NULL,
                updated_at = ?3
            WHERE id = ?1
              AND status = ?4
              AND EXISTS (
                SELECT 1
                FROM import_jobs
                WHERE id = import_job_items.job_id
                  AND status <> ?5
              )
            "#,
            params![
                item_id,
                import_job_item_status_to_db(ImportJobItemStatus::Running),
                now,
                import_job_item_status_to_db(ImportJobItemStatus::Pending),
                import_job_status_to_db(ImportJobStatus::Cancelled)
            ],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        recompute_import_job_counts_on(&transaction, job_id)?;
        transaction.commit()?;

        self.get_import_job_item(&item_id)
    }

    pub fn start_import_attempt(
        &mut self,
        input: &StartImportAttemptInput,
    ) -> WorkspaceStoreResult<ImportAttemptRecord> {
        let transaction = self.connection.transaction()?;
        let (job_id, item_status, job_status) = transaction
            .query_row(
                r#"
                SELECT i.job_id, i.status, j.status
                FROM import_job_items i
                JOIN import_jobs j ON j.id = i.job_id
                WHERE i.id = ?1
                "#,
                params![input.item_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| WorkspaceStoreError::InvalidValue {
                field: "import_job_item",
                value: input.item_id.clone(),
            })?;
        if item_status != import_job_item_status_to_db(ImportJobItemStatus::Running)
            || job_status == import_job_status_to_db(ImportJobStatus::Cancelled)
        {
            return Err(WorkspaceStoreError::InvalidValue {
                field: "import_attempt_state",
                value: input.item_id.clone(),
            });
        }
        let attempt_number = transaction.query_row(
            "SELECT COALESCE(MAX(attempt_number), 0) + 1 FROM import_attempts WHERE job_item_id = ?1",
            params![input.item_id],
            |row| row.get::<_, i64>(0),
        )? as u32;
        let now = now_utc_text();

        transaction.execute(
            r#"
            INSERT INTO import_attempts (
              id,
              job_item_id,
              attempt_number,
              status,
              raw_blob_id,
              started_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            "#,
            params![
                input.attempt_id,
                input.item_id,
                attempt_number,
                import_attempt_status_to_db(ImportAttemptStatus::Running),
                input.raw_blob_id,
                now
            ],
        )?;
        let changed = transaction.execute(
            r#"
            UPDATE import_job_items
            SET status = ?2,
                error_message = NULL,
                attempt_count = attempt_count + 1,
                updated_at = ?3
            WHERE id = ?1
              AND status = ?4
            "#,
            params![
                input.item_id,
                import_job_item_status_to_db(ImportJobItemStatus::Running),
                now,
                import_job_item_status_to_db(ImportJobItemStatus::Running)
            ],
        )?;
        if changed == 0 {
            return Err(WorkspaceStoreError::InvalidValue {
                field: "import_attempt_state",
                value: input.item_id.clone(),
            });
        }
        recompute_import_job_counts_on(&transaction, &job_id)?;
        transaction.commit()?;

        self.get_import_attempt(&input.attempt_id)?.ok_or_else(|| {
            WorkspaceStoreError::InvalidValue {
                field: "import_attempt",
                value: input.attempt_id.clone(),
            }
        })
    }

    pub fn finish_import_attempt(
        &mut self,
        input: &FinishImportAttemptInput,
    ) -> WorkspaceStoreResult<()> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !finish_running_import_attempt_on(&transaction, input)? {
            return Ok(());
        }
        transaction.commit()?;

        Ok(())
    }

    pub fn finish_manifest_import_attempt_with_items(
        &mut self,
        input: &FinishImportAttemptInput,
        items: &[CreateImportJobItemInput],
    ) -> WorkspaceStoreResult<bool> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some((_, job_id)) = running_import_attempt_context(&transaction, &input.attempt_id)?
        else {
            return Ok(false);
        };
        if items.iter().any(|item| item.job_id != job_id) {
            return Err(WorkspaceStoreError::InvalidValue {
                field: "import_job_item_job_id",
                value: job_id,
            });
        }
        let now = now_utc_text();
        for item in items {
            transaction.execute(
                r#"
                INSERT INTO import_job_items (
                  id,
                  job_id,
                  source_item_id,
                  source_item_kind,
                  position,
                  status,
                  tracking_ids_json,
                  sheet_row_ids_json,
                  created_at,
                  updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, '[]', '[]', ?7, ?7)
                ON CONFLICT(job_id, source_item_id, source_item_kind) DO NOTHING
                "#,
                params![
                    item.item_id,
                    item.job_id,
                    item.source_item_id,
                    import_source_item_kind_to_db(item.source_item_kind),
                    item.position,
                    import_job_item_status_to_db(ImportJobItemStatus::Pending),
                    now
                ],
            )?;
        }
        if !finish_running_import_attempt_on(&transaction, input)? {
            return Ok(false);
        }
        transaction.commit()?;
        Ok(true)
    }

    pub fn finish_bag_import_attempt_with_sheet_rows(
        &mut self,
        input: &FinishImportAttemptInput,
        item_id: &str,
        rows: &[UpsertSheetRowInput],
        sheet_row_ids: &[String],
    ) -> WorkspaceStoreResult<bool> {
        let sheet_row_ids_json = serde_json::to_string(sheet_row_ids)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some((running_item_id, _)) =
            running_import_attempt_context(&transaction, &input.attempt_id)?
        else {
            return Ok(false);
        };
        if running_item_id != item_id {
            return Err(WorkspaceStoreError::InvalidValue {
                field: "import_job_item",
                value: item_id.to_string(),
            });
        }

        let now = now_utc_text();
        for row in rows {
            upsert_sheet_row_on(&transaction, row, &now)?;
            transaction.execute(
                "DELETE FROM analytics_cache WHERE sheet_id = ?1",
                params![row.sheet_id],
            )?;
        }
        transaction.execute(
            r#"
            UPDATE import_job_items
            SET sheet_row_ids_json = ?2,
                updated_at = ?3
            WHERE id = ?1
              AND status = ?4
            "#,
            params![
                item_id,
                sheet_row_ids_json,
                now,
                import_job_item_status_to_db(ImportJobItemStatus::Running)
            ],
        )?;
        if !finish_running_import_attempt_on(&transaction, input)? {
            return Ok(false);
        }
        transaction.commit()?;
        Ok(true)
    }

    pub fn cancel_import_job(&mut self, job_id: &str) -> WorkspaceStoreResult<()> {
        if self.get_import_job_summary(job_id)?.is_none() {
            return Err(WorkspaceStoreError::MissingImportJob(job_id.to_string()));
        }

        let now = now_utc_text();
        let transaction = self.connection.transaction()?;
        transaction.execute(
            r#"
            UPDATE import_attempts
            SET status = ?2,
                error_message = COALESCE(error_message, 'cancelled'),
                finished_at = ?3
            WHERE job_item_id IN (SELECT id FROM import_job_items WHERE job_id = ?1)
              AND status = ?4
            "#,
            params![
                job_id,
                import_attempt_status_to_db(ImportAttemptStatus::Cancelled),
                now,
                import_attempt_status_to_db(ImportAttemptStatus::Running)
            ],
        )?;
        transaction.execute(
            r#"
            UPDATE import_job_items
            SET status = ?2,
                error_message = COALESCE(error_message, 'cancelled'),
                updated_at = ?3
            WHERE job_id = ?1
              AND status IN (?4, ?5)
            "#,
            params![
                job_id,
                import_job_item_status_to_db(ImportJobItemStatus::Cancelled),
                now,
                import_job_item_status_to_db(ImportJobItemStatus::Pending),
                import_job_item_status_to_db(ImportJobItemStatus::Running)
            ],
        )?;
        let success_count =
            count_import_items_by_status_on(&transaction, job_id, ImportJobItemStatus::Succeeded)?;
        let failed_count =
            count_import_items_by_status_on(&transaction, job_id, ImportJobItemStatus::Failed)?;
        transaction.execute(
            r#"
            UPDATE import_jobs
            SET status = ?2,
                success_count = ?3,
                failed_count = ?4,
                pending_count = 0,
                cancelled_at = ?5,
                updated_at = ?5
            WHERE id = ?1
            "#,
            params![
                job_id,
                import_job_status_to_db(ImportJobStatus::Cancelled),
                success_count,
                failed_count,
                now
            ],
        )?;
        transaction.commit()?;

        Ok(())
    }

    pub fn recover_interrupted_import_jobs(&mut self) -> WorkspaceStoreResult<JobRecoverySummary> {
        let mut summary = JobRecoverySummary::default();
        let now = now_utc_text();

        {
            let mut statement = self.connection.prepare(
                r#"
                SELECT id, job_item_id
                FROM import_attempts
                WHERE status = ?1 AND finished_at IS NULL
                ORDER BY started_at ASC, id ASC
                "#,
            )?;
            let attempts = statement
                .query_map(
                    params![import_attempt_status_to_db(ImportAttemptStatus::Running)],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )?
                .collect::<Result<Vec<_>, rusqlite::Error>>()?;
            for (attempt_id, item_id) in attempts {
                summary.interrupted_attempt_ids.push(attempt_id.clone());
                if !summary.recovered_item_ids.contains(&item_id) {
                    summary.recovered_item_ids.push(item_id);
                }
            }
        }

        self.connection.execute(
            r#"
            UPDATE import_attempts
            SET status = ?1,
                error_message = COALESCE(error_message, 'interrupted by shutdown'),
                finished_at = ?2
            WHERE status = ?3 AND finished_at IS NULL
            "#,
            params![
                import_attempt_status_to_db(ImportAttemptStatus::Interrupted),
                now,
                import_attempt_status_to_db(ImportAttemptStatus::Running)
            ],
        )?;

        {
            let mut statement = self.connection.prepare(
                r#"
                SELECT id, job_id
                FROM import_job_items
                WHERE status = ?1
                ORDER BY job_id ASC, position ASC, id ASC
                "#,
            )?;
            let running_items = statement
                .query_map(
                    params![import_job_item_status_to_db(ImportJobItemStatus::Running)],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )?
                .collect::<Result<Vec<_>, rusqlite::Error>>()?;
            for (item_id, job_id) in running_items {
                if !summary.recovered_item_ids.contains(&item_id) {
                    summary.recovered_item_ids.push(item_id);
                }
                if !summary.recovered_job_ids.contains(&job_id) {
                    summary.recovered_job_ids.push(job_id);
                }
            }
        }

        self.connection.execute(
            r#"
            UPDATE import_job_items
            SET status = ?1,
                error_message = NULL,
                next_retry_at = NULL,
                updated_at = ?2
            WHERE status = ?3
            "#,
            params![
                import_job_item_status_to_db(ImportJobItemStatus::Pending),
                now,
                import_job_item_status_to_db(ImportJobItemStatus::Running)
            ],
        )?;

        for job_id in summary.recovered_job_ids.clone() {
            self.recompute_import_job_counts(&job_id)?;
        }

        Ok(summary)
    }

    pub fn list_import_attempts_for_item(
        &self,
        item_id: &str,
    ) -> WorkspaceStoreResult<Vec<ImportAttemptRecord>> {
        let mut statement = self.connection.prepare(
            r#"
            SELECT
              id,
              job_item_id,
              attempt_number,
              status,
              error_message,
              raw_blob_id
            FROM import_attempts
            WHERE job_item_id = ?1
            ORDER BY attempt_number ASC, id ASC
            "#,
        )?;

        let attempts = statement
            .query_map(params![item_id], map_import_attempt)?
            .collect::<Result<Vec<_>, rusqlite::Error>>()
            .map_err(WorkspaceStoreError::from)?;

        Ok(attempts)
    }

    pub fn get_import_job(&self, job_id: &str) -> WorkspaceStoreResult<Option<ImportJobDetail>> {
        let Some(summary) = self.get_import_job_summary(job_id)? else {
            return Ok(None);
        };

        let mut statement = self.connection.prepare(
            r#"
            SELECT
              id,
              source_item_id,
              source_item_kind,
              position,
              status,
              tracking_ids_json,
              sheet_row_ids_json,
              error_message,
              attempt_count
            FROM import_job_items
            WHERE job_id = ?1
            ORDER BY position ASC, id ASC
            "#,
        )?;
        let items = statement
            .query_map(params![job_id], map_import_job_item)?
            .collect::<Result<Vec<_>, rusqlite::Error>>()?;

        Ok(Some(ImportJobDetail { summary, items }))
    }

    pub fn retry_import_job_failed(
        &mut self,
        job_id: &str,
        max_attempts: u32,
    ) -> WorkspaceStoreResult<ImportRetryTargets> {
        let Some(detail) = self.get_import_job(job_id)? else {
            return Err(WorkspaceStoreError::MissingImportJob(job_id.to_string()));
        };
        let mut retry_targets = ImportRetryTargets::default();
        let now = now_utc_text();

        for item in detail.items.iter().filter(|item| {
            item.status == ImportJobItemStatus::Failed && item.attempt_count < max_attempts
        }) {
            match item.source_item_kind {
                ImportSourceItemKind::ManifestBag => retry_targets
                    .manifest_bag_ids
                    .push(item.source_item_id.clone()),
                ImportSourceItemKind::Bag | ImportSourceItemKind::Manifest => retry_targets
                    .source_item_ids
                    .push(item.source_item_id.clone()),
            }

            self.connection.execute(
                r#"
                UPDATE import_job_items
                SET status = ?2,
                    tracking_ids_json = '[]',
                    sheet_row_ids_json = '[]',
                    error_message = NULL,
                    next_retry_at = NULL,
                    updated_at = ?3
                WHERE id = ?1
                "#,
                params![
                    item.item_id,
                    import_job_item_status_to_db(ImportJobItemStatus::Pending),
                    now
                ],
            )?;
        }

        self.recompute_import_job_counts(job_id)?;
        Ok(retry_targets)
    }

    fn get_import_job_summary(
        &self,
        job_id: &str,
    ) -> WorkspaceStoreResult<Option<ImportJobSummary>> {
        self.connection
            .query_row(
                r#"
                SELECT
                  id,
                  sheet_id,
                  kind,
                  mode,
                  status,
                  total_count,
                  success_count,
                  failed_count,
                  pending_count
                FROM import_jobs
                WHERE id = ?1
                "#,
                params![job_id],
                map_import_job_summary,
            )
            .optional()
            .map_err(WorkspaceStoreError::from)
    }

    fn get_import_job_item(&self, item_id: &str) -> WorkspaceStoreResult<Option<ImportJobItem>> {
        self.connection
            .query_row(
                r#"
                SELECT
                  id,
                  source_item_id,
                  source_item_kind,
                  position,
                  status,
                  tracking_ids_json,
                  sheet_row_ids_json,
                  error_message,
                  attempt_count
                FROM import_job_items
                WHERE id = ?1
                "#,
                params![item_id],
                map_import_job_item,
            )
            .optional()
            .map_err(WorkspaceStoreError::from)
    }

    fn get_import_attempt(
        &self,
        attempt_id: &str,
    ) -> WorkspaceStoreResult<Option<ImportAttemptRecord>> {
        self.connection
            .query_row(
                r#"
                SELECT
                  id,
                  job_item_id,
                  attempt_number,
                  status,
                  error_message,
                  raw_blob_id
                FROM import_attempts
                WHERE id = ?1
                "#,
                params![attempt_id],
                map_import_attempt,
            )
            .optional()
            .map_err(WorkspaceStoreError::from)
    }

    fn recompute_import_job_counts(&mut self, job_id: &str) -> WorkspaceStoreResult<()> {
        recompute_import_job_counts_on(&self.connection, job_id)
    }
}

fn recompute_import_job_counts_on(
    connection: &Connection,
    job_id: &str,
) -> WorkspaceStoreResult<()> {
    let success_count =
        count_import_items_by_status_on(connection, job_id, ImportJobItemStatus::Succeeded)?;
    let failed_count =
        count_import_items_by_status_on(connection, job_id, ImportJobItemStatus::Failed)?;
    let pending_count =
        count_import_items_by_status_on(connection, job_id, ImportJobItemStatus::Pending)?
            + count_import_items_by_status_on(connection, job_id, ImportJobItemStatus::Running)?;
    let total_count = connection.query_row(
        "SELECT COUNT(*) FROM import_job_items WHERE job_id = ?1",
        params![job_id],
        |row| row.get::<_, i64>(0),
    )?;
    let current_status = connection
        .query_row(
            "SELECT status FROM import_jobs WHERE id = ?1",
            params![job_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| WorkspaceStoreError::MissingImportJob(job_id.to_string()))?;
    let status = if current_status == import_job_status_to_db(ImportJobStatus::Cancelled) {
        ImportJobStatus::Cancelled
    } else if pending_count > 0 {
        ImportJobStatus::Running
    } else if failed_count > 0 {
        ImportJobStatus::Failed
    } else if total_count == success_count as i64 {
        ImportJobStatus::Completed
    } else {
        ImportJobStatus::Pending
    };
    let now = now_utc_text();
    let completed_at = (status == ImportJobStatus::Completed).then(|| now.clone());

    connection.execute(
        r#"
        UPDATE import_jobs
        SET success_count = ?2,
            failed_count = ?3,
            pending_count = ?4,
            total_count = ?5,
            status = ?6,
            completed_at = CASE
              WHEN ?6 = 'cancelled' THEN completed_at
              ELSE ?7
            END,
            updated_at = ?8
        WHERE id = ?1
        "#,
        params![
            job_id,
            success_count,
            failed_count,
            pending_count,
            total_count,
            import_job_status_to_db(status),
            completed_at,
            now
        ],
    )?;

    Ok(())
}

fn count_import_items_by_status_on(
    connection: &Connection,
    job_id: &str,
    status: ImportJobItemStatus,
) -> WorkspaceStoreResult<u32> {
    Ok(connection.query_row(
        "SELECT COUNT(*) FROM import_job_items WHERE job_id = ?1 AND status = ?2",
        params![job_id, import_job_item_status_to_db(status)],
        |row| row.get::<_, i64>(0),
    )? as u32)
}

fn upsert_sheet_row_on(
    connection: &Connection,
    input: &UpsertSheetRowInput,
    now: &str,
) -> WorkspaceStoreResult<()> {
    let existing_sheet_id = connection
        .query_row(
            "SELECT sheet_id FROM sheet_rows WHERE id = ?1",
            params![input.row_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if let Some(existing_sheet_id) = existing_sheet_id {
        if existing_sheet_id != input.sheet_id {
            return Err(WorkspaceStoreError::RowOwnershipConflict {
                row_id: input.row_id.clone(),
                existing_sheet_id,
                requested_sheet_id: input.sheet_id.clone(),
            });
        }
    }
    connection.execute(
        r#"
        DELETE FROM sheet_rows
        WHERE sheet_id = ?1
          AND position = ?2
          AND id <> ?3
        "#,
        params![input.sheet_id, input.position, input.row_id],
    )?;
    connection.execute(
        r#"
        INSERT INTO sheet_rows (
          id,
          sheet_id,
          position,
          display_tracking_id,
          lookup_tracking_id,
          row_generation,
          row_status,
          error_message,
          created_at,
          updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
        ON CONFLICT(id) DO UPDATE SET
          position = excluded.position,
          display_tracking_id = excluded.display_tracking_id,
          tracking_record_id = CASE
            WHEN sheet_rows.lookup_tracking_id <> excluded.lookup_tracking_id THEN NULL
            ELSE sheet_rows.tracking_record_id
          END,
          lookup_tracking_id = excluded.lookup_tracking_id,
          row_generation = CASE
            WHEN sheet_rows.lookup_tracking_id <> excluded.lookup_tracking_id
              THEN excluded.row_generation
            ELSE sheet_rows.row_generation
          END,
          row_status = excluded.row_status,
          error_message = excluded.error_message,
          updated_at = excluded.updated_at
        "#,
        params![
            input.row_id,
            input.sheet_id,
            input.position,
            input.display_tracking_id,
            input.lookup_tracking_id,
            next_row_generation(),
            sheet_row_status_to_db(input.row_status),
            input.error_message,
            now
        ],
    )?;
    Ok(())
}

fn running_import_attempt_context(
    connection: &Connection,
    attempt_id: &str,
) -> WorkspaceStoreResult<Option<(String, String)>> {
    let context = connection
        .query_row(
            r#"
            SELECT
              a.job_item_id,
              i.job_id,
              a.status,
              i.status,
              j.status
            FROM import_attempts a
            JOIN import_job_items i ON i.id = a.job_item_id
            JOIN import_jobs j ON j.id = i.job_id
            WHERE a.id = ?1
            "#,
            params![attempt_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?;
    let Some((item_id, job_id, attempt_status, item_status, job_status)) = context else {
        return Err(WorkspaceStoreError::InvalidValue {
            field: "import_attempt",
            value: attempt_id.to_string(),
        });
    };
    if attempt_status != import_attempt_status_to_db(ImportAttemptStatus::Running)
        || item_status != import_job_item_status_to_db(ImportJobItemStatus::Running)
        || job_status == import_job_status_to_db(ImportJobStatus::Cancelled)
    {
        return Ok(None);
    }
    Ok(Some((item_id, job_id)))
}

fn finish_running_import_attempt_on(
    connection: &Connection,
    input: &FinishImportAttemptInput,
) -> WorkspaceStoreResult<bool> {
    let Some((item_id, job_id)) = running_import_attempt_context(connection, &input.attempt_id)?
    else {
        return Ok(false);
    };
    let now = now_utc_text();
    let finished_at = (input.status != ImportAttemptStatus::Running).then(|| now.clone());
    let attempt_changed = connection.execute(
        r#"
        UPDATE import_attempts
        SET status = ?2,
            error_message = ?3,
            raw_blob_id = COALESCE(?4, raw_blob_id),
            finished_at = ?5
        WHERE id = ?1
          AND status = ?6
        "#,
        params![
            input.attempt_id,
            import_attempt_status_to_db(input.status),
            input.error_message,
            input.raw_blob_id,
            finished_at,
            import_attempt_status_to_db(ImportAttemptStatus::Running)
        ],
    )?;
    if attempt_changed == 0 {
        return Ok(false);
    }
    let tracking_ids_json = serde_json::to_string(&input.tracking_ids)?;
    let item_changed = connection.execute(
        r#"
        UPDATE import_job_items
        SET status = ?2,
            tracking_ids_json = ?3,
            error_message = ?4,
            updated_at = ?5
        WHERE id = ?1
          AND status = ?6
        "#,
        params![
            item_id,
            import_job_item_status_to_db(item_status_for_attempt_status(input.status)),
            tracking_ids_json,
            input.error_message,
            now,
            import_job_item_status_to_db(ImportJobItemStatus::Running)
        ],
    )?;
    if item_changed == 0 {
        return Ok(false);
    }
    recompute_import_job_counts_on(connection, &job_id)?;
    Ok(true)
}

fn build_sheet_filter_sql(query: &SheetRowsQuery) -> WorkspaceStoreResult<(String, Vec<Value>)> {
    let mut clauses = vec!["r.sheet_id = ?1".to_string()];
    let mut bindings = vec![Value::Text(query.sheet_id.clone())];

    for filter in &query.filters {
        let column = sheet_filter_column(&filter.field).ok_or_else(|| {
            WorkspaceStoreError::InvalidValue {
                field: "sheet_filter",
                value: filter.field.clone(),
            }
        })?;
        bindings.push(Value::Text(format!("%{}%", filter.value)));
        clauses.push(format!("CAST({column} AS TEXT) LIKE ?{}", bindings.len()));
    }

    for filter in &query.value_filters {
        if filter.values.is_empty() {
            continue;
        }

        let column = sheet_filter_column(&filter.field).ok_or_else(|| {
            WorkspaceStoreError::InvalidValue {
                field: "sheet_value_filter",
                value: filter.field.clone(),
            }
        })?;
        if filter.field == "detail.shipment_header.nomor_kiriman" {
            let mut prefix_clauses = Vec::with_capacity(filter.values.len());
            for value in &filter.values {
                bindings.push(Value::Text(format!("{value}%")));
                prefix_clauses.push(format!("CAST({column} AS TEXT) LIKE ?{}", bindings.len()));
            }
            clauses.push(format!("({})", prefix_clauses.join(" OR ")));
            continue;
        }

        let mut placeholders = Vec::with_capacity(filter.values.len());
        for value in &filter.values {
            bindings.push(Value::Text(value.clone()));
            placeholders.push(format!("?{}", bindings.len()));
        }
        clauses.push(format!(
            "CAST({column} AS TEXT) IN ({})",
            placeholders.join(", ")
        ));
    }

    Ok((format!("WHERE {}", clauses.join(" AND ")), bindings))
}

fn build_sheet_sort_sql(sort: &[SheetSort]) -> String {
    let clauses = sort
        .iter()
        .filter_map(|item| {
            sheet_sort_column(&item.field).map(|column| {
                let direction = match item.direction {
                    SortDirection::Asc => "ASC",
                    SortDirection::Desc => "DESC",
                };
                format!("{column} {direction}")
            })
        })
        .collect::<Vec<_>>();

    if clauses.is_empty() {
        "r.position ASC, r.id ASC".to_string()
    } else {
        format!("{}, r.position ASC, r.id ASC", clauses.join(", "))
    }
}

const DAYS_SINCE_TRANSACTION_FILTER_SQL: &str = "COALESCE(CAST(julianday(date('now', 'localtime')) - julianday(substr(json_extract(tr.detail_json, '$.origin_detail.tanggal_input'), 1, 10)) AS INTEGER), '')";
const DAYS_SINCE_TRANSACTION_SORT_SQL: &str = "CAST(COALESCE(julianday(date('now', 'localtime')) - julianday(substr(json_extract(tr.detail_json, '$.origin_detail.tanggal_input'), 1, 10)), 0) AS REAL)";
const DAYS_SINCE_LAST_UNBAGGING_FILTER_SQL: &str = "COALESCE((SELECT CAST(julianday(date('now', 'localtime')) - julianday(substr(json_extract(entry.value, '$.unbagging.tanggal'), 1, 10)) AS INTEGER) FROM json_each(json_extract(tr.history_json, '$.history_summary.bagging_unbagging')) AS entry WHERE json_type(entry.value, '$.unbagging') IS NOT NULL AND json_extract(entry.value, '$.unbagging.tanggal') IS NOT NULL ORDER BY COALESCE(julianday(json_extract(entry.value, '$.unbagging.tanggal') || ' ' || COALESCE(json_extract(entry.value, '$.unbagging.waktu'), '00:00:00')), 0) DESC, CAST(entry.key AS INTEGER) DESC LIMIT 1), '')";
const DAYS_SINCE_LAST_UNBAGGING_SORT_SQL: &str = "CAST(COALESCE((SELECT julianday(date('now', 'localtime')) - julianday(substr(json_extract(entry.value, '$.unbagging.tanggal'), 1, 10)) FROM json_each(json_extract(tr.history_json, '$.history_summary.bagging_unbagging')) AS entry WHERE json_type(entry.value, '$.unbagging') IS NOT NULL AND json_extract(entry.value, '$.unbagging.tanggal') IS NOT NULL ORDER BY COALESCE(julianday(json_extract(entry.value, '$.unbagging.tanggal') || ' ' || COALESCE(json_extract(entry.value, '$.unbagging.waktu'), '00:00:00')), 0) DESC, CAST(entry.key AS INTEGER) DESC LIMIT 1), 0) AS REAL)";
const LATEST_BAGGING_STATUS_FILTER_SQL: &str = "COALESCE((SELECT json_extract(entry.value, '$.nomor_kantung') || ' - ' || CASE WHEN json_type(entry.value, '$.unbagging') IS NOT NULL THEN 'Unbagging' ELSE 'Bagging' END FROM json_each(json_extract(tr.history_json, '$.history_summary.bagging_unbagging')) AS entry WHERE json_extract(entry.value, '$.nomor_kantung') IS NOT NULL AND (json_type(entry.value, '$.bagging') IS NOT NULL OR json_type(entry.value, '$.unbagging') IS NOT NULL) ORDER BY CAST(entry.key AS INTEGER) DESC LIMIT 1), '')";
const LATEST_BAGGING_STATUS_SORT_SQL: &str = "COALESCE((SELECT json_extract(entry.value, '$.nomor_kantung') || ' - ' || CASE WHEN json_type(entry.value, '$.unbagging') IS NOT NULL THEN 'Unbagging' ELSE 'Bagging' END FROM json_each(json_extract(tr.history_json, '$.history_summary.bagging_unbagging')) AS entry WHERE json_extract(entry.value, '$.nomor_kantung') IS NOT NULL AND (json_type(entry.value, '$.bagging') IS NOT NULL OR json_type(entry.value, '$.unbagging') IS NOT NULL) ORDER BY CAST(entry.key AS INTEGER) DESC LIMIT 1), '') COLLATE NOCASE";
const LATEST_MANIFEST_R7_FILTER_SQL: &str = "COALESCE((SELECT json_extract(entry.value, '$.nomor_r7') FROM json_each(json_extract(tr.history_json, '$.history_summary.manifest_r7')) AS entry WHERE json_extract(entry.value, '$.nomor_r7') IS NOT NULL ORDER BY CAST(entry.key AS INTEGER) DESC LIMIT 1), '')";
const LATEST_MANIFEST_R7_SORT_SQL: &str = "COALESCE((SELECT json_extract(entry.value, '$.nomor_r7') FROM json_each(json_extract(tr.history_json, '$.history_summary.manifest_r7')) AS entry WHERE json_extract(entry.value, '$.nomor_r7') IS NOT NULL ORDER BY CAST(entry.key AS INTEGER) DESC LIMIT 1), '') COLLATE NOCASE";
const LATEST_DELIVERY_RUNSHEET_FILTER_SQL: &str = "COALESCE((SELECT COALESCE((SELECT json_extract(update_entry.value, '$.status') FROM json_each(json_extract(entry.value, '$.updates')) AS update_entry ORDER BY CAST(update_entry.key AS INTEGER) DESC LIMIT 1), json_extract(entry.value, '$.status'), 'Delivery Runsheet') || ' | ' || COALESCE(substr(COALESCE((SELECT json_extract(update_entry.value, '$.tanggal') FROM json_each(json_extract(entry.value, '$.updates')) AS update_entry ORDER BY CAST(update_entry.key AS INTEGER) DESC LIMIT 1), json_extract(entry.value, '$.tanggal')), 1, 10), '-') || ' | ' || COALESCE((SELECT json_extract(update_entry.value, '$.petugas') FROM json_each(json_extract(entry.value, '$.updates')) AS update_entry ORDER BY CAST(update_entry.key AS INTEGER) DESC LIMIT 1), json_extract(entry.value, '$.petugas_kurir'), json_extract(entry.value, '$.petugas_mandor'), json_extract(entry.value, '$.lokasi'), '-') FROM json_each(json_extract(tr.history_json, '$.history_summary.delivery_runsheet')) AS entry ORDER BY CAST(entry.key AS INTEGER) DESC LIMIT 1), '')";
const LATEST_DELIVERY_RUNSHEET_SORT_SQL: &str = "COALESCE((SELECT COALESCE((SELECT json_extract(update_entry.value, '$.status') FROM json_each(json_extract(entry.value, '$.updates')) AS update_entry ORDER BY CAST(update_entry.key AS INTEGER) DESC LIMIT 1), json_extract(entry.value, '$.status'), 'Delivery Runsheet') || ' | ' || COALESCE(substr(COALESCE((SELECT json_extract(update_entry.value, '$.tanggal') FROM json_each(json_extract(entry.value, '$.updates')) AS update_entry ORDER BY CAST(update_entry.key AS INTEGER) DESC LIMIT 1), json_extract(entry.value, '$.tanggal')), 1, 10), '-') || ' | ' || COALESCE((SELECT json_extract(update_entry.value, '$.petugas') FROM json_each(json_extract(entry.value, '$.updates')) AS update_entry ORDER BY CAST(update_entry.key AS INTEGER) DESC LIMIT 1), json_extract(entry.value, '$.petugas_kurir'), json_extract(entry.value, '$.petugas_mandor'), json_extract(entry.value, '$.lokasi'), '-') FROM json_each(json_extract(tr.history_json, '$.history_summary.delivery_runsheet')) AS entry ORDER BY CAST(entry.key AS INTEGER) DESC LIMIT 1), '') COLLATE NOCASE";

fn sheet_filter_column(field: &str) -> Option<&'static str> {
    match field {
        "position" => Some("r.position"),
        "displayTrackingId" | "display_tracking_id" => Some("r.display_tracking_id"),
        "lookupTrackingId" | "lookup_tracking_id" => Some("r.lookup_tracking_id"),
        "rowStatus" | "row_status" => Some("r.row_status"),
        "detail.shipment_header.nomor_kiriman" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.shipment_header.nomor_kiriman'), r.display_tracking_id)")
        }
        "computed.days_since_transaction" => Some(DAYS_SINCE_TRANSACTION_FILTER_SQL),
        "computed.days_since_last_unbagging" => Some(DAYS_SINCE_LAST_UNBAGGING_FILTER_SQL),
        "history_summary.latest_bagging_status" => Some(LATEST_BAGGING_STATUS_FILTER_SQL),
        "history_summary.latest_manifest_r7" => Some(LATEST_MANIFEST_R7_FILTER_SQL),
        "history_summary.latest_delivery_runsheet" => Some(LATEST_DELIVERY_RUNSHEET_FILTER_SQL),
        "status_akhir.status" => Some("COALESCE(json_extract(tr.status_json, '$.status'), '')"),
        "status_akhir.location" => Some("COALESCE(json_extract(tr.status_json, '$.location'), '')"),
        "status_akhir.officer_name" => {
            Some("COALESCE(json_extract(tr.status_json, '$.officer_name'), '')")
        }
        "status_akhir.officer_id" => Some("COALESCE(json_extract(tr.status_json, '$.officer_id'), '')"),
        "status_akhir.datetime" => Some("COALESCE(json_extract(tr.status_json, '$.datetime'), '')"),
        "status_akhir.date" => Some("COALESCE(json_extract(tr.status_json, '$.date'), '')"),
        "status_akhir.time" => Some("COALESCE(json_extract(tr.status_json, '$.time'), '')"),
        "detail.actors.pengirim.nama" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.actors.pengirim.nama'), '')")
        }
        "detail.actors.pengirim.telepon" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.actors.pengirim.telepon'), '')")
        }
        "detail.actors.pengirim.alamat" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.actors.pengirim.alamat'), '')")
        }
        "detail.actors.penerima.nama" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.actors.penerima.nama'), '')")
        }
        "detail.actors.penerima.telepon" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.actors.penerima.telepon'), '')")
        }
        "detail.actors.penerima.alamat" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.actors.penerima.alamat'), '')")
        }
        "detail.actors.penerima.kode_pos" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.actors.penerima.kode_pos'), '')")
        }
        "detail.shipment_header.booking_code" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.shipment_header.booking_code'), '')")
        }
        "detail.shipment_header.id_pelanggan_korporat" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.shipment_header.id_pelanggan_korporat'), '')")
        }
        "detail.origin_detail.nama_kantor" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.origin_detail.nama_kantor'), '')")
        }
        "detail.origin_detail.id_kantor" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.origin_detail.id_kantor'), '')")
        }
        "detail.origin_detail.nama_petugas" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.origin_detail.nama_petugas'), '')")
        }
        "detail.origin_detail.id_petugas" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.origin_detail.id_petugas'), '')")
        }
        "detail.origin_detail.tanggal_input" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.origin_detail.tanggal_input'), '')")
        }
        "detail.origin_detail.waktu_input" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.origin_detail.waktu_input'), '')")
        }
        "detail.package_detail.jenis_layanan" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.package_detail.jenis_layanan'), '')")
        }
        "detail.package_detail.kriteria_kiriman" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.package_detail.kriteria_kiriman'), '')")
        }
        "detail.package_detail.isi_kiriman" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.package_detail.isi_kiriman'), '')")
        }
        "detail.package_detail.berat_actual" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.package_detail.berat_actual'), '')")
        }
        "detail.package_detail.berat_volumetric" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.package_detail.berat_volumetric'), '')")
        }
        "detail.billing_detail.type_pembayaran" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.billing_detail.type_pembayaran'), '')")
        }
        "detail.billing_detail.bea_dasar" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.billing_detail.bea_dasar'), '')")
        }
        "detail.billing_detail.nilai_barang" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.billing_detail.nilai_barang'), '')")
        }
        "detail.billing_detail.htnb" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.billing_detail.htnb'), '')")
        }
        "detail.billing_detail.cod_info.is_cod" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.billing_detail.cod_info.is_cod'), '')")
        }
        "detail.billing_detail.cod_info.virtual_account" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.billing_detail.cod_info.virtual_account'), '')")
        }
        "detail.billing_detail.cod_info.total_cod" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.billing_detail.cod_info.total_cod'), '')")
        }
        "detail.billing_detail.cod_info.status" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.billing_detail.cod_info.status'), '')")
        }
        "detail.billing_detail.cod_info.tanggal" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.billing_detail.cod_info.tanggal'), '')")
        }
        "detail.performance_detail.sla_target" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.performance_detail.sla_target'), '')")
        }
        "detail.performance_detail.sla_category" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.performance_detail.sla_category'), '')")
        }
        "detail.performance_detail.sla_days_diff" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.performance_detail.sla_days_diff'), '')")
        }
        "computed.delivery_runsheet_count" => {
            Some("COALESCE(json_array_length(json_extract(tr.history_json, '$.history_summary.delivery_runsheet')), 0)")
        }
        "pod.photo1_url" => Some("COALESCE(json_extract(tr.history_json, '$.pod.photo1_url'), '')"),
        "pod.photo2_url" => Some("COALESCE(json_extract(tr.history_json, '$.pod.photo2_url'), '')"),
        "history_summary.irregularity" => {
            Some("COALESCE(json_extract(tr.history_json, '$.history_summary.irregularity'), '')")
        }
        "history_summary.bagging_unbagging" => {
            Some("COALESCE(json_extract(tr.history_json, '$.history_summary.bagging_unbagging'), '')")
        }
        "history_summary.manifest_r7" => {
            Some("COALESCE(json_extract(tr.history_json, '$.history_summary.manifest_r7'), '')")
        }
        "history_summary.delivery_runsheet" => {
            Some("COALESCE(json_extract(tr.history_json, '$.history_summary.delivery_runsheet'), '')")
        }
        _ => None,
    }
}

fn sheet_value_option_column(field: &str) -> Option<&'static str> {
    match field {
        "detail.shipment_header.nomor_kiriman" => Some("substr(r.display_tracking_id, 1, 5)"),
        _ => sheet_filter_column(field),
    }
}

fn sheet_sort_column(field: &str) -> Option<&'static str> {
    match field {
        "position" => Some("r.position"),
        "displayTrackingId" | "display_tracking_id" => Some("r.display_tracking_id"),
        "lookupTrackingId" | "lookup_tracking_id" => Some("r.lookup_tracking_id"),
        "rowStatus" | "row_status" => Some("r.row_status"),
        "detail.shipment_header.nomor_kiriman" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.shipment_header.nomor_kiriman'), r.display_tracking_id) COLLATE NOCASE")
        }
        "computed.days_since_transaction" => Some(DAYS_SINCE_TRANSACTION_SORT_SQL),
        "computed.days_since_last_unbagging" => Some(DAYS_SINCE_LAST_UNBAGGING_SORT_SQL),
        "history_summary.latest_bagging_status" => Some(LATEST_BAGGING_STATUS_SORT_SQL),
        "history_summary.latest_manifest_r7" => Some(LATEST_MANIFEST_R7_SORT_SQL),
        "history_summary.latest_delivery_runsheet" => Some(LATEST_DELIVERY_RUNSHEET_SORT_SQL),
        "status_akhir.status" => {
            Some("COALESCE(json_extract(tr.status_json, '$.status'), '') COLLATE NOCASE")
        }
        "status_akhir.location" => {
            Some("COALESCE(json_extract(tr.status_json, '$.location'), '') COLLATE NOCASE")
        }
        "status_akhir.officer_name" => {
            Some("COALESCE(json_extract(tr.status_json, '$.officer_name'), '') COLLATE NOCASE")
        }
        "status_akhir.officer_id" => {
            Some("COALESCE(json_extract(tr.status_json, '$.officer_id'), '') COLLATE NOCASE")
        }
        "status_akhir.datetime" => {
            Some("COALESCE(json_extract(tr.status_json, '$.datetime'), '') COLLATE NOCASE")
        }
        "status_akhir.date" => {
            Some("COALESCE(json_extract(tr.status_json, '$.date'), '') COLLATE NOCASE")
        }
        "status_akhir.time" => {
            Some("COALESCE(json_extract(tr.status_json, '$.time'), '') COLLATE NOCASE")
        }
        "detail.actors.pengirim.nama" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.actors.pengirim.nama'), '') COLLATE NOCASE")
        }
        "detail.actors.pengirim.telepon" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.actors.pengirim.telepon'), '') COLLATE NOCASE")
        }
        "detail.actors.pengirim.alamat" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.actors.pengirim.alamat'), '') COLLATE NOCASE")
        }
        "detail.actors.penerima.nama" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.actors.penerima.nama'), '') COLLATE NOCASE")
        }
        "detail.actors.penerima.telepon" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.actors.penerima.telepon'), '') COLLATE NOCASE")
        }
        "detail.actors.penerima.alamat" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.actors.penerima.alamat'), '') COLLATE NOCASE")
        }
        "detail.actors.penerima.kode_pos" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.actors.penerima.kode_pos'), '') COLLATE NOCASE")
        }
        "detail.shipment_header.booking_code" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.shipment_header.booking_code'), '') COLLATE NOCASE")
        }
        "detail.shipment_header.id_pelanggan_korporat" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.shipment_header.id_pelanggan_korporat'), '') COLLATE NOCASE")
        }
        "detail.origin_detail.nama_kantor" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.origin_detail.nama_kantor'), '') COLLATE NOCASE")
        }
        "detail.origin_detail.id_kantor" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.origin_detail.id_kantor'), '') COLLATE NOCASE")
        }
        "detail.origin_detail.nama_petugas" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.origin_detail.nama_petugas'), '') COLLATE NOCASE")
        }
        "detail.origin_detail.id_petugas" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.origin_detail.id_petugas'), '') COLLATE NOCASE")
        }
        "detail.origin_detail.tanggal_input" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.origin_detail.tanggal_input'), '') COLLATE NOCASE")
        }
        "detail.origin_detail.waktu_input" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.origin_detail.waktu_input'), '') COLLATE NOCASE")
        }
        "detail.package_detail.jenis_layanan" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.package_detail.jenis_layanan'), '') COLLATE NOCASE")
        }
        "detail.package_detail.kriteria_kiriman" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.package_detail.kriteria_kiriman'), '') COLLATE NOCASE")
        }
        "detail.package_detail.isi_kiriman" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.package_detail.isi_kiriman'), '') COLLATE NOCASE")
        }
        "detail.package_detail.berat_actual" => {
            Some("CAST(COALESCE(json_extract(tr.detail_json, '$.package_detail.berat_actual'), 0) AS REAL)")
        }
        "detail.package_detail.berat_volumetric" => {
            Some("CAST(COALESCE(json_extract(tr.detail_json, '$.package_detail.berat_volumetric'), 0) AS REAL)")
        }
        "detail.billing_detail.type_pembayaran" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.billing_detail.type_pembayaran'), '') COLLATE NOCASE")
        }
        "detail.billing_detail.bea_dasar" => {
            Some("CAST(COALESCE(json_extract(tr.detail_json, '$.billing_detail.bea_dasar'), 0) AS REAL)")
        }
        "detail.billing_detail.nilai_barang" => {
            Some("CAST(COALESCE(json_extract(tr.detail_json, '$.billing_detail.nilai_barang'), 0) AS REAL)")
        }
        "detail.billing_detail.htnb" => {
            Some("CAST(COALESCE(json_extract(tr.detail_json, '$.billing_detail.htnb'), 0) AS REAL)")
        }
        "detail.billing_detail.cod_info.is_cod" => {
            Some("CAST(COALESCE(json_extract(tr.detail_json, '$.billing_detail.cod_info.is_cod'), 0) AS INTEGER)")
        }
        "detail.billing_detail.cod_info.virtual_account" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.billing_detail.cod_info.virtual_account'), '') COLLATE NOCASE")
        }
        "detail.billing_detail.cod_info.total_cod" => {
            Some("CAST(COALESCE(json_extract(tr.detail_json, '$.billing_detail.cod_info.total_cod'), 0) AS REAL)")
        }
        "detail.billing_detail.cod_info.status" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.billing_detail.cod_info.status'), '') COLLATE NOCASE")
        }
        "detail.billing_detail.cod_info.tanggal" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.billing_detail.cod_info.tanggal'), '') COLLATE NOCASE")
        }
        "detail.performance_detail.sla_target" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.performance_detail.sla_target'), '') COLLATE NOCASE")
        }
        "detail.performance_detail.sla_category" => {
            Some("COALESCE(json_extract(tr.detail_json, '$.performance_detail.sla_category'), '') COLLATE NOCASE")
        }
        "detail.performance_detail.sla_days_diff" => {
            Some("CAST(COALESCE(json_extract(tr.detail_json, '$.performance_detail.sla_days_diff'), 0) AS REAL)")
        }
        "computed.delivery_runsheet_count" => {
            Some("COALESCE(json_array_length(json_extract(tr.history_json, '$.history_summary.delivery_runsheet')), 0)")
        }
        "pod.photo1_url" => {
            Some("COALESCE(json_extract(tr.history_json, '$.pod.photo1_url'), '') COLLATE NOCASE")
        }
        "pod.photo2_url" => {
            Some("COALESCE(json_extract(tr.history_json, '$.pod.photo2_url'), '') COLLATE NOCASE")
        }
        "history_summary.irregularity" => {
            Some("COALESCE(json_extract(tr.history_json, '$.history_summary.irregularity'), '') COLLATE NOCASE")
        }
        "history_summary.bagging_unbagging" => {
            Some("COALESCE(json_extract(tr.history_json, '$.history_summary.bagging_unbagging'), '') COLLATE NOCASE")
        }
        "history_summary.manifest_r7" => {
            Some("COALESCE(json_extract(tr.history_json, '$.history_summary.manifest_r7'), '') COLLATE NOCASE")
        }
        "history_summary.delivery_runsheet" => {
            Some("COALESCE(json_extract(tr.history_json, '$.history_summary.delivery_runsheet'), '') COLLATE NOCASE")
        }
        _ => None,
    }
}

fn next_available_generated_sheet_row_id(
    transaction: &Transaction<'_>,
    sheet_id: &str,
    position: u32,
) -> rusqlite::Result<String> {
    let mut suffix = 0_u32;
    loop {
        let row_id = if suffix == 0 {
            format!("{sheet_id}:row:{position}")
        } else {
            format!("{sheet_id}:row:{position}:{suffix}")
        };
        let count = transaction.query_row(
            "SELECT COUNT(*) FROM sheet_rows WHERE id = ?1",
            params![row_id],
            |row| row.get::<_, i64>(0),
        )?;
        if count == 0 {
            return Ok(row_id);
        }

        suffix = suffix.saturating_add(1);
    }
}

fn compact_sheet_row_positions(
    transaction: &Transaction<'_>,
    sheet_id: &str,
    updated_at: &str,
) -> rusqlite::Result<()> {
    let remaining_row_ids = {
        let mut statement = transaction.prepare(
            r#"
            SELECT id
            FROM sheet_rows
            WHERE sheet_id = ?1
            ORDER BY position ASC, id ASC
            "#,
        )?;
        let row_ids = statement
            .query_map(params![sheet_id], |row| row.get(0))?
            .collect::<Result<Vec<String>, rusqlite::Error>>()?;
        row_ids
    };

    for (position, row_id) in remaining_row_ids.iter().enumerate() {
        transaction.execute(
            r#"
            UPDATE sheet_rows
            SET position = ?3,
                updated_at = ?4
            WHERE sheet_id = ?1 AND id = ?2
            "#,
            params![sheet_id, row_id, position as u32, updated_at],
        )?;
    }

    Ok(())
}

fn map_import_job_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<ImportJobSummary> {
    let kind = import_kind_from_db(row.get::<_, String>(2)?.as_str())?;
    let mode = import_mode_from_db(row.get::<_, String>(3)?.as_str())?;
    let status = import_job_status_from_db(row.get::<_, String>(4)?.as_str())?;

    Ok(ImportJobSummary {
        job_id: row.get(0)?,
        sheet_id: row.get(1)?,
        kind,
        mode,
        status,
        total_count: row.get::<_, i64>(5)? as u32,
        success_count: row.get::<_, i64>(6)? as u32,
        failed_count: row.get::<_, i64>(7)? as u32,
        pending_count: row.get::<_, i64>(8)? as u32,
    })
}

fn map_import_job_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<ImportJobItem> {
    let source_item_kind = import_source_item_kind_from_db(row.get::<_, String>(2)?.as_str())?;
    let status = import_job_item_status_from_db(row.get::<_, String>(4)?.as_str())?;
    let tracking_ids_json = row.get::<_, String>(5)?;
    let tracking_ids = serde_json::from_str(&tracking_ids_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let sheet_row_ids_json = row.get::<_, String>(6)?;
    let sheet_row_ids = serde_json::from_str(&sheet_row_ids_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(6, rusqlite::types::Type::Text, Box::new(error))
    })?;

    Ok(ImportJobItem {
        item_id: row.get(0)?,
        source_item_id: row.get(1)?,
        source_item_kind,
        position: row.get::<_, i64>(3)? as u32,
        status,
        tracking_ids,
        sheet_row_ids,
        error_message: row.get(7)?,
        attempt_count: row.get::<_, i64>(8)? as u32,
    })
}

fn map_import_attempt(row: &rusqlite::Row<'_>) -> rusqlite::Result<ImportAttemptRecord> {
    let status = import_attempt_status_from_db(row.get::<_, String>(3)?.as_str())?;

    Ok(ImportAttemptRecord {
        attempt_id: row.get(0)?,
        job_item_id: row.get(1)?,
        attempt_number: row.get::<_, i64>(2)? as u32,
        status,
        error_message: row.get(4)?,
        raw_blob_id: row.get(5)?,
    })
}

fn parse_optional_json(value: Option<String>) -> rusqlite::Result<Option<serde_json::Value>> {
    value
        .map(|json| {
            serde_json::from_str(&json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })
        })
        .transpose()
}

fn sheet_row_status_to_db(status: SheetRowStatus) -> &'static str {
    match status {
        SheetRowStatus::Empty => "empty",
        SheetRowStatus::Pending => "pending",
        SheetRowStatus::Loading => "loading",
        SheetRowStatus::Loaded => "loaded",
        SheetRowStatus::Failed => "failed",
        SheetRowStatus::Stale => "stale",
    }
}

fn sheet_row_status_from_db(value: &str) -> rusqlite::Result<SheetRowStatus> {
    match value {
        "empty" => Ok(SheetRowStatus::Empty),
        "pending" => Ok(SheetRowStatus::Pending),
        "loading" => Ok(SheetRowStatus::Loading),
        "loaded" => Ok(SheetRowStatus::Loaded),
        "failed" => Ok(SheetRowStatus::Failed),
        "stale" => Ok(SheetRowStatus::Stale),
        _ => Err(rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            Box::new(WorkspaceStoreError::InvalidValue {
                field: "sheet_row_status",
                value: value.to_string(),
            }),
        )),
    }
}

fn import_kind_to_db(kind: ImportKind) -> &'static str {
    match kind {
        ImportKind::Bag => "bag",
        ImportKind::Manifest => "manifest",
    }
}

fn import_kind_from_db(value: &str) -> rusqlite::Result<ImportKind> {
    match value {
        "bag" => Ok(ImportKind::Bag),
        "manifest" => Ok(ImportKind::Manifest),
        _ => invalid_db_value("import_kind", value),
    }
}

fn import_mode_to_db(mode: ImportMode) -> &'static str {
    match mode {
        ImportMode::Replace => "replace",
        ImportMode::Append => "append",
    }
}

fn import_mode_from_db(value: &str) -> rusqlite::Result<ImportMode> {
    match value {
        "replace" => Ok(ImportMode::Replace),
        "append" => Ok(ImportMode::Append),
        _ => invalid_db_value("import_mode", value),
    }
}

fn import_job_status_to_db(status: ImportJobStatus) -> &'static str {
    match status {
        ImportJobStatus::Pending => "pending",
        ImportJobStatus::Running => "running",
        ImportJobStatus::Completed => "completed",
        ImportJobStatus::Failed => "failed",
        ImportJobStatus::Cancelled => "cancelled",
    }
}

fn import_job_status_from_db(value: &str) -> rusqlite::Result<ImportJobStatus> {
    match value {
        "pending" => Ok(ImportJobStatus::Pending),
        "running" => Ok(ImportJobStatus::Running),
        "completed" => Ok(ImportJobStatus::Completed),
        "failed" => Ok(ImportJobStatus::Failed),
        "cancelled" => Ok(ImportJobStatus::Cancelled),
        _ => invalid_db_value("import_job_status", value),
    }
}

fn import_job_item_status_to_db(status: ImportJobItemStatus) -> &'static str {
    match status {
        ImportJobItemStatus::Pending => "pending",
        ImportJobItemStatus::Running => "running",
        ImportJobItemStatus::Succeeded => "succeeded",
        ImportJobItemStatus::Failed => "failed",
        ImportJobItemStatus::Cancelled => "cancelled",
    }
}

fn import_job_item_status_from_db(value: &str) -> rusqlite::Result<ImportJobItemStatus> {
    match value {
        "pending" => Ok(ImportJobItemStatus::Pending),
        "running" => Ok(ImportJobItemStatus::Running),
        "succeeded" => Ok(ImportJobItemStatus::Succeeded),
        "failed" => Ok(ImportJobItemStatus::Failed),
        "cancelled" => Ok(ImportJobItemStatus::Cancelled),
        _ => invalid_db_value("import_job_item_status", value),
    }
}

fn import_attempt_status_to_db(status: ImportAttemptStatus) -> &'static str {
    match status {
        ImportAttemptStatus::Running => "running",
        ImportAttemptStatus::Succeeded => "succeeded",
        ImportAttemptStatus::Failed => "failed",
        ImportAttemptStatus::Cancelled => "cancelled",
        ImportAttemptStatus::Interrupted => "interrupted",
    }
}

fn import_attempt_status_from_db(value: &str) -> rusqlite::Result<ImportAttemptStatus> {
    match value {
        "running" => Ok(ImportAttemptStatus::Running),
        "succeeded" => Ok(ImportAttemptStatus::Succeeded),
        "failed" => Ok(ImportAttemptStatus::Failed),
        "cancelled" => Ok(ImportAttemptStatus::Cancelled),
        "interrupted" => Ok(ImportAttemptStatus::Interrupted),
        _ => invalid_db_value("import_attempt_status", value),
    }
}

fn item_status_for_attempt_status(status: ImportAttemptStatus) -> ImportJobItemStatus {
    match status {
        ImportAttemptStatus::Running => ImportJobItemStatus::Running,
        ImportAttemptStatus::Succeeded => ImportJobItemStatus::Succeeded,
        ImportAttemptStatus::Failed | ImportAttemptStatus::Interrupted => {
            ImportJobItemStatus::Failed
        }
        ImportAttemptStatus::Cancelled => ImportJobItemStatus::Cancelled,
    }
}

fn import_source_item_kind_to_db(kind: ImportSourceItemKind) -> &'static str {
    match kind {
        ImportSourceItemKind::Bag => "bag",
        ImportSourceItemKind::Manifest => "manifest",
        ImportSourceItemKind::ManifestBag => "manifest_bag",
    }
}

fn import_source_item_kind_from_db(value: &str) -> rusqlite::Result<ImportSourceItemKind> {
    match value {
        "bag" => Ok(ImportSourceItemKind::Bag),
        "manifest" => Ok(ImportSourceItemKind::Manifest),
        "manifest_bag" => Ok(ImportSourceItemKind::ManifestBag),
        _ => invalid_db_value("import_source_item_kind", value),
    }
}

fn invalid_db_value<T>(field: &'static str, value: &str) -> rusqlite::Result<T> {
    Err(rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(WorkspaceStoreError::InvalidValue {
            field,
            value: value.to_string(),
        }),
    ))
}

fn now_utc_text() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .expect("current UTC timestamp formats as RFC3339")
}

fn next_row_generation() -> String {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    format!(
        "{}:{}",
        OffsetDateTime::now_utc().unix_timestamp_nanos(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn query_window_is_limited_by_engine_cap() {
        assert_eq!(clamp_query_window(20, 1_000, 250), (20, 250));
        assert_eq!(clamp_query_window(20, 100, 250), (20, 100));
    }

    #[test]
    fn sqlite_store_applies_schema_and_file_wal_pragmas() {
        let path = temp_db_path("wal");
        let mut store = SqliteWorkspaceStore::open(&path).expect("store opens");

        assert_eq!(store.pragma_value("journal_mode").unwrap(), "wal");
        assert_eq!(store.pragma_value("foreign_keys").unwrap(), "1");
        assert_eq!(store.pragma_value("busy_timeout").unwrap(), "5000");

        let workspace = store
            .create_workspace(&CreateWorkspaceInput {
                workspace_id: "workspace-1".to_string(),
                name: "Main workspace".to_string(),
            })
            .expect("workspace is created");
        let sheet = store
            .create_sheet(&CreateSheetInput {
                sheet_id: "sheet-1".to_string(),
                workspace_id: workspace.workspace_id.clone(),
                name: "Sheet 1".to_string(),
                position: 0,
            })
            .expect("sheet is created");

        assert_eq!(workspace.schema_version, SCHEMA_VERSION);
        assert_eq!(sheet.workspace_id, workspace.workspace_id);

        cleanup_temp_db(&path);
    }

    #[test]
    fn existing_schema_backfills_row_generation_without_losing_rows() {
        let path = temp_db_path("row-generation-migration");
        {
            let connection = Connection::open(&path).expect("legacy database opens");
            connection
                .execute_batch(
                    r#"
                    CREATE TABLE workspaces (
                      id TEXT PRIMARY KEY,
                      name TEXT NOT NULL,
                      created_at TEXT NOT NULL,
                      updated_at TEXT NOT NULL,
                      schema_version INTEGER NOT NULL
                    );
                    CREATE TABLE sheets (
                      id TEXT PRIMARY KEY,
                      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                      name TEXT NOT NULL,
                      position INTEGER NOT NULL,
                      view_mode TEXT NOT NULL DEFAULT 'workspace',
                      created_at TEXT NOT NULL,
                      updated_at TEXT NOT NULL
                    );
                    CREATE TABLE sheet_rows (
                      id TEXT PRIMARY KEY,
                      sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
                      position INTEGER NOT NULL,
                      display_tracking_id TEXT NOT NULL,
                      lookup_tracking_id TEXT NOT NULL,
                      tracking_record_id TEXT,
                      row_status TEXT NOT NULL,
                      error_message TEXT,
                      created_at TEXT NOT NULL,
                      updated_at TEXT NOT NULL,
                      UNIQUE(sheet_id, position)
                    );
                    INSERT INTO workspaces
                      (id, name, created_at, updated_at, schema_version)
                    VALUES
                      ('workspace-1', 'Workspace', '2026-01-01T00:00:00Z',
                       '2026-01-01T00:00:00Z', 1);
                    INSERT INTO sheets
                      (id, workspace_id, name, position, view_mode, created_at, updated_at)
                    VALUES
                      ('sheet-1', 'workspace-1', 'Sheet 1', 0, 'workspace',
                       '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
                    INSERT INTO sheet_rows
                      (id, sheet_id, position, display_tracking_id, lookup_tracking_id,
                       row_status, created_at, updated_at)
                    VALUES
                      ('row-1', 'sheet-1', 0, 'P1', 'P1', 'loaded',
                       '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
                    "#,
                )
                .expect("legacy schema is seeded");
        }

        let store = SqliteWorkspaceStore::open(&path).expect("migration succeeds");
        let row = store
            .get_sheet_row("row-1")
            .expect("legacy row lookup succeeds")
            .expect("legacy row remains");

        assert_eq!(row.display_tracking_id, "P1");
        assert_eq!(row.row_generation, "row-1:2026-01-01T00:00:00Z");
        cleanup_temp_db(&path);
    }

    #[test]
    fn create_sheet_does_not_overwrite_existing_sheet_metadata() {
        let mut store = prepared_store();
        store
            .rename_sheet("sheet-1", "Renamed Sheet")
            .expect("sheet is renamed");

        let sheet = store
            .create_sheet(&CreateSheetInput {
                sheet_id: "sheet-1".to_string(),
                workspace_id: "workspace-1".to_string(),
                name: "Bootstrap Sheet".to_string(),
                position: 99,
            })
            .expect("existing sheet is returned");

        assert_eq!(sheet.name, "Renamed Sheet");
        assert_eq!(sheet.position, 0);
        assert_eq!(
            store
                .get_sheet("sheet-1")
                .expect("sheet lookup succeeds")
                .expect("sheet exists")
                .name,
            "Renamed Sheet"
        );
    }

    #[test]
    fn sheet_metadata_can_be_created_and_renamed() {
        let mut store = prepared_store();
        let sheet = store
            .create_sheet(&CreateSheetInput {
                sheet_id: "sheet-2".to_string(),
                workspace_id: "workspace-1".to_string(),
                name: "Operations".to_string(),
                position: 1,
            })
            .expect("sheet is created");

        assert_eq!(sheet.name, "Operations");
        assert_eq!(sheet.position, 1);

        let renamed = store
            .rename_sheet("sheet-2", "SLA Cases")
            .expect("sheet is renamed");

        assert_eq!(renamed.sheet_id, "sheet-2");
        assert_eq!(renamed.name, "SLA Cases");
        assert_eq!(renamed.position, 1);
        assert_eq!(
            store
                .get_sheet("sheet-2")
                .expect("sheet lookup succeeds")
                .expect("sheet exists")
                .name,
            "SLA Cases"
        );
    }

    #[test]
    fn sheet_metadata_can_be_listed_by_position() {
        let mut store = prepared_store();
        store
            .create_sheet(&CreateSheetInput {
                sheet_id: "sheet-3".to_string(),
                workspace_id: "workspace-1".to_string(),
                name: "Third".to_string(),
                position: 2,
            })
            .expect("third sheet is created");
        store
            .create_sheet(&CreateSheetInput {
                sheet_id: "sheet-2".to_string(),
                workspace_id: "workspace-1".to_string(),
                name: "Second".to_string(),
                position: 1,
            })
            .expect("second sheet is created");

        let sheets = store.list_sheets().expect("sheets are listed");

        assert_eq!(
            sheets
                .iter()
                .map(|sheet| sheet.sheet_id.as_str())
                .collect::<Vec<_>>(),
            vec!["sheet-1", "sheet-2", "sheet-3"]
        );
        assert_eq!(sheets[1].name, "Second");
        assert_eq!(sheets[2].position, 2);
    }

    #[test]
    fn sheet_rows_preserve_dotted_display_id_and_query_windows() {
        let mut store = prepared_store();

        store
            .upsert_sheet_row(&UpsertSheetRowInput {
                row_id: "row-1".to_string(),
                sheet_id: "sheet-1".to_string(),
                position: 0,
                display_tracking_id: "P2606020189412.30".to_string(),
                lookup_tracking_id: "P2606020189412".to_string(),
                row_status: SheetRowStatus::Loaded,
                error_message: None,
            })
            .expect("first row is stored");
        store
            .upsert_sheet_row(&UpsertSheetRowInput {
                row_id: "row-2".to_string(),
                sheet_id: "sheet-1".to_string(),
                position: 1,
                display_tracking_id: "P2606020189412.31".to_string(),
                lookup_tracking_id: "P2606020189412".to_string(),
                row_status: SheetRowStatus::Failed,
                error_message: Some("upstream timeout".to_string()),
            })
            .expect("second row is stored");

        let window = store
            .query_sheet_rows(
                &SheetRowsQuery {
                    sheet_id: "sheet-1".to_string(),
                    offset: 0,
                    limit: 1,
                    filters: vec![SheetFilter {
                        field: "displayTrackingId".to_string(),
                        value: ".30".to_string(),
                    }],
                    value_filters: vec![],
                    sort: vec![SheetSort {
                        field: "position".to_string(),
                        direction: SortDirection::Asc,
                    }],
                },
                250,
            )
            .expect("rows are queried");

        assert_eq!(window.total_count, 1);
        assert_eq!(window.rows.len(), 1);
        assert_eq!(window.rows[0].display_tracking_id, "P2606020189412.30");
        assert_eq!(window.rows[0].lookup_tracking_id, "P2606020189412");
        assert_eq!(window.rows[0].row_status, SheetRowStatus::Loaded);
    }

    #[test]
    fn sheet_row_upsert_replaces_existing_row_at_same_position() {
        let mut store = prepared_store();

        store
            .upsert_sheet_row(&UpsertSheetRowInput {
                row_id: "stale-local-row".to_string(),
                sheet_id: "sheet-1".to_string(),
                position: 0,
                display_tracking_id: "POLD".to_string(),
                lookup_tracking_id: "POLD".to_string(),
                row_status: SheetRowStatus::Loaded,
                error_message: None,
            })
            .expect("initial row is stored");

        store
            .upsert_sheet_row(&UpsertSheetRowInput {
                row_id: "new-local-row".to_string(),
                sheet_id: "sheet-1".to_string(),
                position: 0,
                display_tracking_id: "PNEW".to_string(),
                lookup_tracking_id: "PNEW".to_string(),
                row_status: SheetRowStatus::Empty,
                error_message: None,
            })
            .expect("new row replaces the existing position");

        let window = store
            .query_sheet_rows(
                &SheetRowsQuery {
                    sheet_id: "sheet-1".to_string(),
                    offset: 0,
                    limit: 10,
                    filters: vec![],
                    value_filters: vec![],
                    sort: vec![],
                },
                250,
            )
            .expect("rows are queried");

        assert_eq!(window.total_count, 1);
        assert_eq!(window.rows[0].row_id, "new-local-row");
        assert_eq!(window.rows[0].display_tracking_id, "PNEW");
        assert_eq!(window.rows[0].position, 0);
    }

    #[test]
    fn sheet_row_upsert_rejects_cross_sheet_row_reassignment() {
        let mut store = prepared_store();
        store
            .create_sheet(&CreateSheetInput {
                sheet_id: "sheet-2".to_string(),
                workspace_id: "workspace-1".to_string(),
                name: "Second".to_string(),
                position: 1,
            })
            .expect("second sheet is created");
        store
            .upsert_sheet_row(&UpsertSheetRowInput {
                row_id: "shared-row-id".to_string(),
                sheet_id: "sheet-1".to_string(),
                position: 0,
                display_tracking_id: "PORIGINAL".to_string(),
                lookup_tracking_id: "PORIGINAL".to_string(),
                row_status: SheetRowStatus::Loaded,
                error_message: None,
            })
            .expect("source row is stored");

        let error = store
            .upsert_sheet_row(&UpsertSheetRowInput {
                row_id: "shared-row-id".to_string(),
                sheet_id: "sheet-2".to_string(),
                position: 0,
                display_tracking_id: "PATTACKER".to_string(),
                lookup_tracking_id: "PATTACKER".to_string(),
                row_status: SheetRowStatus::Empty,
                error_message: None,
            })
            .expect_err("cross-sheet row reassignment is rejected");

        assert!(matches!(
            error,
            WorkspaceStoreError::RowOwnershipConflict {
                row_id,
                existing_sheet_id,
                requested_sheet_id,
            } if row_id == "shared-row-id"
                && existing_sheet_id == "sheet-1"
                && requested_sheet_id == "sheet-2"
        ));
        assert!(store
            .sheet_row_belongs_to_sheet("shared-row-id", "sheet-1")
            .expect("source ownership is queried"));
        assert!(!store
            .sheet_row_belongs_to_sheet("shared-row-id", "sheet-2")
            .expect("target ownership is queried"));
        assert_eq!(
            store
                .get_sheet_row("shared-row-id")
                .expect("row lookup succeeds")
                .expect("row still exists")
                .display_tracking_id,
            "PORIGINAL"
        );
    }

    #[test]
    fn atomic_replace_rolls_back_all_sheet_rows_when_one_row_fails() {
        let mut store = prepared_store();
        store
            .create_sheet(&CreateSheetInput {
                sheet_id: "sheet-2".to_string(),
                workspace_id: "workspace-1".to_string(),
                name: "Second".to_string(),
                position: 1,
            })
            .expect("second sheet is created");
        for (row_id, sheet_id, position) in
            [("old-row", "sheet-1", 0), ("foreign-row", "sheet-2", 0)]
        {
            store
                .upsert_sheet_row(&UpsertSheetRowInput {
                    row_id: row_id.to_string(),
                    sheet_id: sheet_id.to_string(),
                    position,
                    display_tracking_id: row_id.to_string(),
                    lookup_tracking_id: row_id.to_string(),
                    row_status: SheetRowStatus::Empty,
                    error_message: None,
                })
                .expect("seed row is stored");
        }

        let error = store
            .upsert_sheet_rows_atomic(
                "sheet-1",
                &[
                    UpsertSheetRowInput {
                        row_id: "new-row".to_string(),
                        sheet_id: "sheet-1".to_string(),
                        position: 0,
                        display_tracking_id: "PNEW".to_string(),
                        lookup_tracking_id: "PNEW".to_string(),
                        row_status: SheetRowStatus::Empty,
                        error_message: None,
                    },
                    UpsertSheetRowInput {
                        row_id: "foreign-row".to_string(),
                        sheet_id: "sheet-1".to_string(),
                        position: 1,
                        display_tracking_id: "PFOREIGN".to_string(),
                        lookup_tracking_id: "PFOREIGN".to_string(),
                        row_status: SheetRowStatus::Empty,
                        error_message: None,
                    },
                ],
                true,
            )
            .expect_err("ownership failure aborts the replace transaction");

        assert!(matches!(
            error,
            WorkspaceStoreError::RowOwnershipConflict { row_id, .. }
                if row_id == "foreign-row"
        ));
        assert!(store
            .get_sheet_row("old-row")
            .expect("old row lookup succeeds")
            .is_some());
        assert!(store
            .get_sheet_row("new-row")
            .expect("new row lookup succeeds")
            .is_none());
        assert!(store
            .get_sheet_row("foreign-row")
            .expect("foreign row lookup succeeds")
            .is_some());
    }

    #[test]
    fn conditional_tracking_updates_do_not_touch_reused_row_ids_with_new_lookup() {
        let mut store = prepared_store();

        store
            .upsert_sheet_row(&UpsertSheetRowInput {
                row_id: "row-1".to_string(),
                sheet_id: "sheet-1".to_string(),
                position: 0,
                display_tracking_id: "POLD".to_string(),
                lookup_tracking_id: "POLD".to_string(),
                row_status: SheetRowStatus::Loading,
                error_message: None,
            })
            .expect("initial row is stored");
        store
            .upsert_sheet_row(&UpsertSheetRowInput {
                row_id: "row-1".to_string(),
                sheet_id: "sheet-1".to_string(),
                position: 0,
                display_tracking_id: "PNEW".to_string(),
                lookup_tracking_id: "PNEW".to_string(),
                row_status: SheetRowStatus::Empty,
                error_message: None,
            })
            .expect("row id is reused with new lookup");
        store
            .upsert_tracking_record(&UpsertTrackingRecordInput {
                record_id: "track-old".to_string(),
                display_tracking_id: "POLD".to_string(),
                lookup_tracking_id: "POLD".to_string(),
                normalized_status: Some("DELIVERED".to_string()),
                status_json: serde_json::json!({ "status": "DELIVERED" }),
                detail_json: serde_json::json!({
                    "shipment_header": {
                        "nomor_kiriman": "POLD"
                    }
                }),
                history_json: serde_json::json!({
                    "history": [],
                    "history_summary": {}
                }),
                raw_blob_id: None,
                source_url: "https://example.test/old".to_string(),
            })
            .expect("old tracking record is stored");

        let attached = store
            .attach_tracking_record_to_sheet_row_if_lookup_matches(
                &AttachTrackingRecordToSheetRowInput {
                    row_id: "row-1".to_string(),
                    tracking_record_id: "track-old".to_string(),
                    row_status: SheetRowStatus::Loaded,
                    error_message: None,
                },
                "POLD",
                "stale-generation",
            )
            .expect("conditional attach succeeds");
        let failed = store
            .update_sheet_row_status_if_lookup_matches(
                &UpdateSheetRowStatusInput {
                    row_id: "row-1".to_string(),
                    row_status: SheetRowStatus::Failed,
                    error_message: Some("old failure".to_string()),
                },
                "POLD",
                "stale-generation",
            )
            .expect("conditional status update succeeds");
        let row = store
            .get_sheet_row("row-1")
            .expect("row lookup succeeds")
            .expect("row exists");

        assert!(!attached);
        assert!(!failed);
        assert_eq!(row.lookup_tracking_id, "PNEW");
        assert_eq!(row.row_status, SheetRowStatus::Empty);
        assert_eq!(row.error_message, None);
        assert_eq!(row.status_json, None);
    }

    #[test]
    fn changing_row_lookup_clears_the_attached_tracking_record() {
        let mut store = prepared_store();
        store
            .upsert_sheet_row(&UpsertSheetRowInput {
                row_id: "row-1".to_string(),
                sheet_id: "sheet-1".to_string(),
                position: 0,
                display_tracking_id: "POLD".to_string(),
                lookup_tracking_id: "POLD".to_string(),
                row_status: SheetRowStatus::Loaded,
                error_message: None,
            })
            .expect("row is stored");
        store
            .upsert_tracking_record(&UpsertTrackingRecordInput {
                record_id: "track-old".to_string(),
                display_tracking_id: "POLD".to_string(),
                lookup_tracking_id: "POLD".to_string(),
                normalized_status: Some("DELIVERED".to_string()),
                status_json: serde_json::json!({ "status": "DELIVERED" }),
                detail_json: serde_json::json!({ "shipment_header": { "nomor_kiriman": "POLD" } }),
                history_json: serde_json::json!({ "history": [] }),
                raw_blob_id: None,
                source_url: "https://example.test/old".to_string(),
            })
            .expect("tracking record is stored");
        store
            .attach_tracking_record_to_sheet_row(&AttachTrackingRecordToSheetRowInput {
                row_id: "row-1".to_string(),
                tracking_record_id: "track-old".to_string(),
                row_status: SheetRowStatus::Loaded,
                error_message: None,
            })
            .expect("tracking record is attached");

        store
            .upsert_sheet_row(&UpsertSheetRowInput {
                row_id: "row-1".to_string(),
                sheet_id: "sheet-1".to_string(),
                position: 0,
                display_tracking_id: "PNEW".to_string(),
                lookup_tracking_id: "PNEW".to_string(),
                row_status: SheetRowStatus::Empty,
                error_message: None,
            })
            .expect("lookup is replaced");

        let tracking_record_id = store
            .connection
            .query_row(
                "SELECT tracking_record_id FROM sheet_rows WHERE id = 'row-1'",
                [],
                |row| row.get::<_, Option<String>>(0),
            )
            .expect("tracking attachment is queried");
        let row = store
            .get_sheet_row("row-1")
            .expect("row lookup succeeds")
            .expect("row exists");
        assert_eq!(tracking_record_id, None);
        assert_eq!(row.lookup_tracking_id, "PNEW");
        assert_eq!(row.status_json, None);
    }

    #[test]
    fn analytics_cache_is_invalidated_by_sheet_row_and_tracking_record_mutations() {
        let mut store = prepared_store();
        store
            .upsert_sheet_row(&UpsertSheetRowInput {
                row_id: "row-1".to_string(),
                sheet_id: "sheet-1".to_string(),
                position: 0,
                display_tracking_id: "P2606020189412.30".to_string(),
                lookup_tracking_id: "P2606020189412".to_string(),
                row_status: SheetRowStatus::Empty,
                error_message: None,
            })
            .expect("row is stored");

        seed_analytics_cache(&mut store, "sheet-1", "cache-status");
        store
            .update_sheet_row_status(&UpdateSheetRowStatusInput {
                row_id: "row-1".to_string(),
                row_status: SheetRowStatus::Failed,
                error_message: Some("timeout".to_string()),
            })
            .expect("row status is updated");
        assert_eq!(analytics_cache_count(&store, "sheet-1"), 0);

        store
            .upsert_tracking_record(&UpsertTrackingRecordInput {
                record_id: "track-1".to_string(),
                display_tracking_id: "P2606020189412.30".to_string(),
                lookup_tracking_id: "P2606020189412".to_string(),
                normalized_status: Some("DELIVERED".to_string()),
                status_json: serde_json::json!({ "status": "DELIVERED" }),
                detail_json: serde_json::json!({
                    "shipment_header": {
                        "nomor_kiriman": "P2606020189412.30"
                    }
                }),
                history_json: serde_json::json!({
                    "history": [],
                    "history_summary": {}
                }),
                raw_blob_id: None,
                source_url: "https://example.test/one".to_string(),
            })
            .expect("tracking record is stored");
        store
            .attach_tracking_record_to_sheet_row(&AttachTrackingRecordToSheetRowInput {
                row_id: "row-1".to_string(),
                tracking_record_id: "track-1".to_string(),
                row_status: SheetRowStatus::Loaded,
                error_message: None,
            })
            .expect("tracking record is attached");

        seed_analytics_cache(&mut store, "sheet-1", "cache-tracking-record");
        store
            .upsert_tracking_record(&UpsertTrackingRecordInput {
                record_id: "track-1".to_string(),
                display_tracking_id: "P2606020189412.30".to_string(),
                lookup_tracking_id: "P2606020189412".to_string(),
                normalized_status: Some("INLOCATION".to_string()),
                status_json: serde_json::json!({ "status": "INLOCATION" }),
                detail_json: serde_json::json!({
                    "shipment_header": {
                        "nomor_kiriman": "P2606020189412.30"
                    }
                }),
                history_json: serde_json::json!({
                    "history": [],
                    "history_summary": {}
                }),
                raw_blob_id: None,
                source_url: "https://example.test/two".to_string(),
            })
            .expect("tracking record is updated");
        assert_eq!(analytics_cache_count(&store, "sheet-1"), 0);

        seed_analytics_cache(&mut store, "sheet-1", "cache-clear");
        store.clear_sheet_rows("sheet-1").expect("rows are cleared");
        assert_eq!(analytics_cache_count(&store, "sheet-1"), 0);
    }

    #[test]
    fn analytics_cache_is_invalidated_for_moved_sheet_rows() {
        let mut store = prepared_store();
        store
            .create_sheet(&CreateSheetInput {
                sheet_id: "sheet-2".to_string(),
                workspace_id: "workspace-1".to_string(),
                name: "Sheet 2".to_string(),
                position: 1,
            })
            .expect("target sheet is created");
        store
            .upsert_sheet_row(&UpsertSheetRowInput {
                row_id: "row-1".to_string(),
                sheet_id: "sheet-1".to_string(),
                position: 0,
                display_tracking_id: "P2606020189412.30".to_string(),
                lookup_tracking_id: "P2606020189412".to_string(),
                row_status: SheetRowStatus::Loaded,
                error_message: None,
            })
            .expect("source row is stored");

        seed_analytics_cache(&mut store, "sheet-1", "cache-source");
        seed_analytics_cache(&mut store, "sheet-2", "cache-target");

        store
            .transfer_sheet_rows(&TransferSheetRowsInput {
                source_sheet_id: "sheet-1".to_string(),
                target_sheet_id: "sheet-2".to_string(),
                row_ids: vec!["row-1".to_string()],
                delete_source_rows: true,
            })
            .expect("row is moved");

        assert_eq!(analytics_cache_count(&store, "sheet-1"), 0);
        assert_eq!(analytics_cache_count(&store, "sheet-2"), 0);
    }

    #[test]
    fn row_deletion_rolls_back_when_cache_invalidation_fails() {
        let mut store = prepared_store();
        store
            .upsert_sheet_row(&UpsertSheetRowInput {
                row_id: "row-1".to_string(),
                sheet_id: "sheet-1".to_string(),
                position: 0,
                display_tracking_id: "P1".to_string(),
                lookup_tracking_id: "P1".to_string(),
                row_status: SheetRowStatus::Loaded,
                error_message: None,
            })
            .expect("row is stored");
        seed_analytics_cache(&mut store, "sheet-1", "cache-source");
        store
            .connection
            .execute_batch(
                r#"
                CREATE TRIGGER reject_cache_invalidation
                BEFORE DELETE ON analytics_cache
                BEGIN
                  SELECT RAISE(ABORT, 'cache invalidation blocked');
                END;
                "#,
            )
            .expect("failure trigger is installed");

        let result = store.delete_sheet_rows("sheet-1", &["row-1".to_string()]);

        assert!(result.is_err());
        assert!(store
            .get_sheet_row("row-1")
            .expect("row lookup succeeds")
            .is_some());
        assert_eq!(analytics_cache_count(&store, "sheet-1"), 1);
    }

    #[test]
    fn clear_sheet_rows_rolls_back_when_cache_invalidation_fails() {
        let mut store = prepared_store();
        store
            .upsert_sheet_row(&UpsertSheetRowInput {
                row_id: "row-1".to_string(),
                sheet_id: "sheet-1".to_string(),
                position: 0,
                display_tracking_id: "P1".to_string(),
                lookup_tracking_id: "P1".to_string(),
                row_status: SheetRowStatus::Loaded,
                error_message: None,
            })
            .expect("row is stored");
        seed_analytics_cache(&mut store, "sheet-1", "cache-source");
        store
            .connection
            .execute_batch(
                r#"
                CREATE TRIGGER reject_cache_invalidation
                BEFORE DELETE ON analytics_cache
                BEGIN
                  SELECT RAISE(ABORT, 'cache invalidation blocked');
                END;
                "#,
            )
            .expect("failure trigger is installed");

        let result = store.clear_sheet_rows("sheet-1");

        assert!(result.is_err());
        assert!(store
            .get_sheet_row("row-1")
            .expect("row lookup succeeds")
            .is_some());
        assert_eq!(analytics_cache_count(&store, "sheet-1"), 1);
    }

    #[test]
    fn row_transfer_rolls_back_when_cache_invalidation_fails() {
        let mut store = prepared_store();
        store
            .create_sheet(&CreateSheetInput {
                sheet_id: "sheet-2".to_string(),
                workspace_id: "workspace-1".to_string(),
                name: "Sheet 2".to_string(),
                position: 1,
            })
            .expect("target sheet is created");
        store
            .upsert_sheet_row(&UpsertSheetRowInput {
                row_id: "row-1".to_string(),
                sheet_id: "sheet-1".to_string(),
                position: 0,
                display_tracking_id: "P1".to_string(),
                lookup_tracking_id: "P1".to_string(),
                row_status: SheetRowStatus::Loaded,
                error_message: None,
            })
            .expect("source row is stored");
        seed_analytics_cache(&mut store, "sheet-1", "cache-source");
        seed_analytics_cache(&mut store, "sheet-2", "cache-target");
        store
            .connection
            .execute_batch(
                r#"
                CREATE TRIGGER reject_cache_invalidation
                BEFORE DELETE ON analytics_cache
                BEGIN
                  SELECT RAISE(ABORT, 'cache invalidation blocked');
                END;
                "#,
            )
            .expect("failure trigger is installed");

        let result = store.transfer_sheet_rows(&TransferSheetRowsInput {
            source_sheet_id: "sheet-1".to_string(),
            target_sheet_id: "sheet-2".to_string(),
            row_ids: vec!["row-1".to_string()],
            delete_source_rows: true,
        });

        assert!(result.is_err());
        let source = store
            .query_sheet_rows(
                &SheetRowsQuery {
                    sheet_id: "sheet-1".to_string(),
                    offset: 0,
                    limit: 10,
                    filters: vec![],
                    value_filters: vec![],
                    sort: vec![],
                },
                250,
            )
            .expect("source rows are queried");
        let target = store
            .query_sheet_rows(
                &SheetRowsQuery {
                    sheet_id: "sheet-2".to_string(),
                    offset: 0,
                    limit: 10,
                    filters: vec![],
                    value_filters: vec![],
                    sort: vec![],
                },
                250,
            )
            .expect("target rows are queried");
        assert_eq!(source.total_count, 1);
        assert_eq!(target.total_count, 0);
        assert_eq!(analytics_cache_count(&store, "sheet-1"), 1);
        assert_eq!(analytics_cache_count(&store, "sheet-2"), 1);
    }

    #[test]
    fn transfer_sheet_rows_copies_tracking_detail_and_move_deletes_source() {
        let mut store = prepared_store();
        store
            .create_sheet(&CreateSheetInput {
                sheet_id: "sheet-2".to_string(),
                workspace_id: "workspace-1".to_string(),
                name: "Sheet 2".to_string(),
                position: 1,
            })
            .expect("target sheet is created");
        store
            .upsert_sheet_row(&UpsertSheetRowInput {
                row_id: "row-1".to_string(),
                sheet_id: "sheet-1".to_string(),
                position: 0,
                display_tracking_id: "P2606020189412.30".to_string(),
                lookup_tracking_id: "P2606020189412".to_string(),
                row_status: SheetRowStatus::Loaded,
                error_message: None,
            })
            .expect("source row is stored");
        store
            .upsert_tracking_record(&UpsertTrackingRecordInput {
                record_id: "track-1".to_string(),
                display_tracking_id: "P2606020189412.30".to_string(),
                lookup_tracking_id: "P2606020189412".to_string(),
                normalized_status: Some("DELIVERED".to_string()),
                status_json: serde_json::json!({ "status": "DELIVERED" }),
                detail_json: serde_json::json!({
                    "shipment_header": {
                        "nomor_kiriman": "P2606020189412.30"
                    }
                }),
                history_json: serde_json::json!({
                    "history": [],
                    "history_summary": {}
                }),
                raw_blob_id: None,
                source_url: "https://example.test".to_string(),
            })
            .expect("tracking record is stored");
        store
            .attach_tracking_record_to_sheet_row(&AttachTrackingRecordToSheetRowInput {
                row_id: "row-1".to_string(),
                tracking_record_id: "track-1".to_string(),
                row_status: SheetRowStatus::Loaded,
                error_message: None,
            })
            .expect("tracking record is attached");

        store
            .transfer_sheet_rows(&TransferSheetRowsInput {
                source_sheet_id: "sheet-1".to_string(),
                target_sheet_id: "sheet-2".to_string(),
                row_ids: vec!["row-1".to_string()],
                delete_source_rows: false,
            })
            .expect("row is copied");
        let target = store
            .query_sheet_rows(
                &SheetRowsQuery {
                    sheet_id: "sheet-2".to_string(),
                    offset: 0,
                    limit: 10,
                    filters: vec![],
                    value_filters: vec![],
                    sort: vec![],
                },
                250,
            )
            .expect("target rows are queried");

        assert_eq!(target.total_count, 1);
        assert_eq!(target.rows[0].display_tracking_id, "P2606020189412.30");
        assert_eq!(target.rows[0].lookup_tracking_id, "P2606020189412");
        assert_eq!(
            target.rows[0].status_json,
            Some(serde_json::json!({ "status": "DELIVERED" }))
        );
        assert_eq!(
            target.rows[0]
                .detail_json
                .as_ref()
                .and_then(|value| value.pointer("/shipment_header/nomor_kiriman"))
                .and_then(|value| value.as_str()),
            Some("P2606020189412.30")
        );

        store
            .transfer_sheet_rows(&TransferSheetRowsInput {
                source_sheet_id: "sheet-1".to_string(),
                target_sheet_id: "sheet-2".to_string(),
                row_ids: vec!["row-1".to_string()],
                delete_source_rows: true,
            })
            .expect("row is moved");
        let source = store
            .query_sheet_rows(
                &SheetRowsQuery {
                    sheet_id: "sheet-1".to_string(),
                    offset: 0,
                    limit: 10,
                    filters: vec![],
                    value_filters: vec![],
                    sort: vec![],
                },
                250,
            )
            .expect("source rows are queried");
        let target_after_move = store
            .query_sheet_rows(
                &SheetRowsQuery {
                    sheet_id: "sheet-2".to_string(),
                    offset: 0,
                    limit: 10,
                    filters: vec![],
                    value_filters: vec![],
                    sort: vec![],
                },
                250,
            )
            .expect("target rows are queried");

        assert_eq!(source.total_count, 0);
        assert_eq!(target_after_move.total_count, 2);
    }

    #[test]
    fn copy_sheet_rows_copies_all_source_rows_without_mutating_source() {
        let mut store = prepared_store();
        store
            .create_sheet(&CreateSheetInput {
                sheet_id: "sheet-2".to_string(),
                workspace_id: "workspace-1".to_string(),
                name: "Sheet 2".to_string(),
                position: 1,
            })
            .expect("target sheet is created");
        for (position, display_tracking_id) in ["P2606020189412.30", "P2606020189412.31"]
            .iter()
            .enumerate()
        {
            store
                .upsert_sheet_row(&UpsertSheetRowInput {
                    row_id: format!("row-{}", position + 1),
                    sheet_id: "sheet-1".to_string(),
                    position: position as u32,
                    display_tracking_id: (*display_tracking_id).to_string(),
                    lookup_tracking_id: "P2606020189412".to_string(),
                    row_status: SheetRowStatus::Loaded,
                    error_message: None,
                })
                .expect("source row is stored");
        }

        store
            .copy_sheet_rows("sheet-1", "sheet-2")
            .expect("sheet rows are copied");

        let source = store
            .query_sheet_rows(
                &SheetRowsQuery {
                    sheet_id: "sheet-1".to_string(),
                    offset: 0,
                    limit: 10,
                    filters: vec![],
                    value_filters: vec![],
                    sort: vec![],
                },
                250,
            )
            .expect("source rows are queried");
        let target = store
            .query_sheet_rows(
                &SheetRowsQuery {
                    sheet_id: "sheet-2".to_string(),
                    offset: 0,
                    limit: 10,
                    filters: vec![],
                    value_filters: vec![],
                    sort: vec![],
                },
                250,
            )
            .expect("target rows are queried");

        assert_eq!(source.total_count, 2);
        assert_eq!(target.total_count, 2);
        assert_eq!(target.rows[0].row_id, "sheet-2:row:0");
        assert_eq!(target.rows[0].display_tracking_id, "P2606020189412.30");
        assert_eq!(target.rows[0].lookup_tracking_id, "P2606020189412");
        assert_eq!(target.rows[1].row_id, "sheet-2:row:1");
        assert_eq!(target.rows[1].display_tracking_id, "P2606020189412.31");
        assert_eq!(target.rows[1].lookup_tracking_id, "P2606020189412");
    }

    #[test]
    fn delete_sheet_removes_sheet_rows_through_foreign_key_cascade() {
        let mut store = prepared_store();
        store
            .upsert_sheet_row(&UpsertSheetRowInput {
                row_id: "row-1".to_string(),
                sheet_id: "sheet-1".to_string(),
                position: 0,
                display_tracking_id: "P2606020189412.30".to_string(),
                lookup_tracking_id: "P2606020189412".to_string(),
                row_status: SheetRowStatus::Loaded,
                error_message: None,
            })
            .expect("source row is stored");

        store.delete_sheet("sheet-1").expect("sheet is deleted");

        assert!(!store
            .sheet_exists("sheet-1")
            .expect("sheet lookup succeeds"));
        let remaining_row_count = store
            .connection
            .query_row("SELECT COUNT(*) FROM sheet_rows", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("row count is queried");
        assert_eq!(remaining_row_count, 0);
    }

    #[test]
    fn sheet_row_windows_expose_pagination_metadata_for_grid_cutover() {
        let mut store = prepared_store();

        for (position, tracking_id) in [
            (0, "P260000000001"),
            (1, "P260000000003"),
            (2, "P260000000002"),
        ] {
            store
                .upsert_sheet_row(&UpsertSheetRowInput {
                    row_id: format!("row-{position}"),
                    sheet_id: "sheet-1".to_string(),
                    position,
                    display_tracking_id: tracking_id.to_string(),
                    lookup_tracking_id: tracking_id.to_string(),
                    row_status: SheetRowStatus::Loaded,
                    error_message: None,
                })
                .expect("row is stored");
        }

        let first_window = store
            .query_sheet_rows(
                &SheetRowsQuery {
                    sheet_id: "sheet-1".to_string(),
                    offset: 0,
                    limit: 2,
                    filters: vec![],
                    value_filters: vec![],
                    sort: vec![SheetSort {
                        field: "displayTrackingId".to_string(),
                        direction: SortDirection::Desc,
                    }],
                },
                250,
            )
            .expect("first window is queried");

        assert_eq!(first_window.total_count, 3);
        assert!(first_window.has_more);
        assert_eq!(first_window.next_offset, Some(2));
        assert_eq!(
            first_window
                .rows
                .iter()
                .map(|row| row.display_tracking_id.as_str())
                .collect::<Vec<_>>(),
            vec!["P260000000003", "P260000000002"]
        );

        let second_window = store
            .query_sheet_rows(
                &SheetRowsQuery {
                    sheet_id: "sheet-1".to_string(),
                    offset: first_window.next_offset.expect("next offset exists"),
                    limit: 2,
                    filters: vec![],
                    value_filters: vec![],
                    sort: vec![SheetSort {
                        field: "displayTrackingId".to_string(),
                        direction: SortDirection::Desc,
                    }],
                },
                250,
            )
            .expect("second window is queried");

        assert_eq!(second_window.total_count, 3);
        assert!(!second_window.has_more);
        assert_eq!(second_window.next_offset, None);
        assert_eq!(second_window.rows[0].display_tracking_id, "P260000000001");
    }

    #[test]
    fn sheet_row_windows_filter_and_sort_tracking_json_fields() {
        let mut store = prepared_store();

        for (position, tracking_id, status, service, total_cod) in [
            (0, "P260000000001", "INLOCATION", "PKH", 100_000),
            (1, "P260000000002", "INVEHICLE", "PKH", 250_000),
            (2, "P260000000003", "DELIVERED", "EC3", 50_000),
        ] {
            let row_id = format!("row-{position}");
            let record_id = format!("record-{position}");
            store
                .upsert_sheet_row(&UpsertSheetRowInput {
                    row_id: row_id.clone(),
                    sheet_id: "sheet-1".to_string(),
                    position,
                    display_tracking_id: tracking_id.to_string(),
                    lookup_tracking_id: tracking_id.to_string(),
                    row_status: SheetRowStatus::Loaded,
                    error_message: None,
                })
                .expect("row is stored");
            store
                .upsert_tracking_record(&UpsertTrackingRecordInput {
                    record_id: record_id.clone(),
                    display_tracking_id: tracking_id.to_string(),
                    lookup_tracking_id: tracking_id.to_string(),
                    normalized_status: Some(status.to_string()),
                    status_json: serde_json::json!({
                        "status": status,
                        "location": "DC JAYAPURA 9910A"
                    }),
                    detail_json: serde_json::json!({
                        "shipment_header": {
                            "nomor_kiriman": tracking_id
                        },
                        "package_detail": {
                            "jenis_layanan": service
                        },
                        "billing_detail": {
                            "cod_info": {
                                "is_cod": total_cod > 0,
                                "total_cod": total_cod
                            }
                        }
                    }),
                    history_json: serde_json::json!({
                        "history_summary": {
                            "delivery_runsheet": [{ "status": status }]
                        }
                    }),
                    raw_blob_id: None,
                    source_url: format!("https://example.test/{tracking_id}"),
                })
                .expect("tracking record is stored");
            store
                .attach_tracking_record_to_sheet_row(&AttachTrackingRecordToSheetRowInput {
                    row_id,
                    tracking_record_id: record_id,
                    row_status: SheetRowStatus::Loaded,
                    error_message: None,
                })
                .expect("tracking record is attached");
        }

        let window = store
            .query_sheet_rows(
                &SheetRowsQuery {
                    sheet_id: "sheet-1".to_string(),
                    offset: 0,
                    limit: 10,
                    filters: vec![SheetFilter {
                        field: "status_akhir.status".to_string(),
                        value: "IN".to_string(),
                    }],
                    value_filters: vec![SheetValueFilter {
                        field: "detail.package_detail.jenis_layanan".to_string(),
                        values: vec!["PKH".to_string()],
                    }],
                    sort: vec![SheetSort {
                        field: "detail.billing_detail.cod_info.total_cod".to_string(),
                        direction: SortDirection::Desc,
                    }],
                },
                250,
            )
            .expect("rows are queried");

        assert_eq!(window.total_count, 2);
        assert_eq!(
            window
                .rows
                .iter()
                .map(|row| row.display_tracking_id.as_str())
                .collect::<Vec<_>>(),
            vec!["P260000000002", "P260000000001"]
        );
        assert_eq!(
            window.rows[0].detail_json.as_ref().and_then(|detail| {
                detail
                    .pointer("/billing_detail/cod_info/total_cod")
                    .and_then(serde_json::Value::as_i64)
            }),
            Some(250_000)
        );

        let value_window = store
            .query_sheet_rows(
                &SheetRowsQuery {
                    sheet_id: "sheet-1".to_string(),
                    offset: 0,
                    limit: 10,
                    filters: vec![],
                    value_filters: vec![SheetValueFilter {
                        field: "detail.package_detail.jenis_layanan".to_string(),
                        values: vec!["EC3".to_string()],
                    }],
                    sort: vec![],
                },
                250,
            )
            .expect("value-filtered rows are queried");

        assert_eq!(value_window.total_count, 1);
        assert_eq!(
            value_window
                .rows
                .iter()
                .map(|row| row.display_tracking_id.as_str())
                .collect::<Vec<_>>(),
            vec!["P260000000003"]
        );

        let numeric_value_window = store
            .query_sheet_rows(
                &SheetRowsQuery {
                    sheet_id: "sheet-1".to_string(),
                    offset: 0,
                    limit: 10,
                    filters: vec![],
                    value_filters: vec![SheetValueFilter {
                        field: "detail.billing_detail.cod_info.total_cod".to_string(),
                        values: vec!["250000".to_string()],
                    }],
                    sort: vec![],
                },
                250,
            )
            .expect("numeric value-filtered rows are queried");

        assert_eq!(numeric_value_window.total_count, 1);
        assert_eq!(
            numeric_value_window.rows[0].display_tracking_id,
            "P260000000002"
        );
    }

    #[test]
    fn sheet_field_values_return_distinct_counts_and_tracking_prefix_buckets() {
        let mut store = prepared_store();

        for (position, tracking_id, status, service) in [
            (0, "P260600000001", "INLOCATION", "PKH"),
            (1, "P260600000002", "INLOCATION", "PKH"),
            (2, "P260500000003", "DELIVERED", "EC3"),
        ] {
            let row_id = format!("row-{position}");
            let record_id = format!("record-{position}");
            store
                .upsert_sheet_row(&UpsertSheetRowInput {
                    row_id: row_id.clone(),
                    sheet_id: "sheet-1".to_string(),
                    position,
                    display_tracking_id: tracking_id.to_string(),
                    lookup_tracking_id: tracking_id.to_string(),
                    row_status: SheetRowStatus::Loaded,
                    error_message: None,
                })
                .expect("row is stored");
            store
                .upsert_tracking_record(&UpsertTrackingRecordInput {
                    record_id: record_id.clone(),
                    display_tracking_id: tracking_id.to_string(),
                    lookup_tracking_id: tracking_id.to_string(),
                    normalized_status: Some(status.to_string()),
                    status_json: serde_json::json!({
                        "status": status,
                    }),
                    detail_json: serde_json::json!({
                        "shipment_header": {
                            "nomor_kiriman": tracking_id
                        },
                        "package_detail": {
                            "jenis_layanan": service
                        }
                    }),
                    history_json: serde_json::json!({
                        "history": [],
                        "history_summary": {}
                    }),
                    raw_blob_id: None,
                    source_url: format!("https://example.test/{tracking_id}"),
                })
                .expect("tracking record is stored");
            store
                .attach_tracking_record_to_sheet_row(&AttachTrackingRecordToSheetRowInput {
                    row_id,
                    tracking_record_id: record_id,
                    row_status: SheetRowStatus::Loaded,
                    error_message: None,
                })
                .expect("tracking record is attached");
        }

        let status_values = store
            .query_sheet_field_values(
                &SheetFieldValuesQuery {
                    sheet_id: "sheet-1".to_string(),
                    field: "status_akhir.status".to_string(),
                    filters: vec![],
                    value_filters: vec![],
                    limit: 10,
                },
                100,
            )
            .expect("status value options are queried");

        assert_eq!(status_values.total_count, 3);
        assert_eq!(
            status_values.values,
            vec![
                SheetFieldValueOption {
                    value: "INLOCATION".to_string(),
                    count: 2,
                },
                SheetFieldValueOption {
                    value: "DELIVERED".to_string(),
                    count: 1,
                },
            ]
        );

        let tracking_prefix_values = store
            .query_sheet_field_values(
                &SheetFieldValuesQuery {
                    sheet_id: "sheet-1".to_string(),
                    field: "detail.shipment_header.nomor_kiriman".to_string(),
                    filters: vec![],
                    value_filters: vec![],
                    limit: 10,
                },
                100,
            )
            .expect("tracking prefix value options are queried");

        assert_eq!(
            tracking_prefix_values.values,
            vec![
                SheetFieldValueOption {
                    value: "P2606".to_string(),
                    count: 2,
                },
                SheetFieldValueOption {
                    value: "P2605".to_string(),
                    count: 1,
                },
            ]
        );

        let prefix_filtered_window = store
            .query_sheet_rows(
                &SheetRowsQuery {
                    sheet_id: "sheet-1".to_string(),
                    offset: 0,
                    limit: 10,
                    filters: vec![],
                    value_filters: vec![SheetValueFilter {
                        field: "detail.shipment_header.nomor_kiriman".to_string(),
                        values: vec!["P2606".to_string()],
                    }],
                    sort: vec![],
                },
                100,
            )
            .expect("prefix value filter is queried");

        assert_eq!(prefix_filtered_window.total_count, 2);
        assert_eq!(
            prefix_filtered_window
                .rows
                .iter()
                .map(|row| row.display_tracking_id.as_str())
                .collect::<Vec<_>>(),
            vec!["P260600000001", "P260600000002"]
        );
    }

    #[test]
    fn sheet_field_values_include_derived_history_columns() {
        let mut store = prepared_store();
        store
            .upsert_sheet_row(&UpsertSheetRowInput {
                row_id: "row-1".to_string(),
                sheet_id: "sheet-1".to_string(),
                position: 0,
                display_tracking_id: "P260000000001".to_string(),
                lookup_tracking_id: "P260000000001".to_string(),
                row_status: SheetRowStatus::Loaded,
                error_message: None,
            })
            .expect("row is stored");
        store
            .upsert_tracking_record(&UpsertTrackingRecordInput {
                record_id: "record-1".to_string(),
                display_tracking_id: "P260000000001".to_string(),
                lookup_tracking_id: "P260000000001".to_string(),
                normalized_status: Some("INLOCATION".to_string()),
                status_json: serde_json::json!({
                    "status": "INLOCATION",
                }),
                detail_json: serde_json::json!({
                    "shipment_header": {
                        "nomor_kiriman": "P260000000001"
                    },
                    "origin_detail": {
                        "tanggal_input": "2026-06-10"
                    }
                }),
                history_json: serde_json::json!({
                    "history": [],
                    "history_summary": {
                        "bagging_unbagging": [
                            {
                                "nomor_kantung": "PID99827450",
                                "bagging": {
                                    "tanggal": "2026-06-12",
                                    "waktu": "08:00:00"
                                }
                            },
                            {
                                "nomor_kantung": "PID98937705",
                                "unbagging": {
                                    "tanggal": "2026-06-13",
                                    "waktu": "09:00:00"
                                }
                            }
                        ],
                        "manifest_r7": [
                            { "nomor_r7": "P20260607095605151" },
                            { "nomor_r7": "P20260617083040393" }
                        ],
                        "delivery_runsheet": [
                            {
                                "status": "INVEHICLE",
                                "tanggal": "2026-06-10",
                                "petugas_kurir": "Enos"
                            },
                            {
                                "status": "DELIVERYRUNSHEET",
                                "tanggal": "2026-06-11",
                                "petugas_kurir": "Junaidi",
                                "updates": [
                                    {
                                        "status": "FAILEDTODELIVERED",
                                        "tanggal": "2026-06-11",
                                        "petugas": "Junaidi"
                                    }
                                ]
                            }
                        ]
                    }
                }),
                raw_blob_id: None,
                source_url: "https://example.test/P260000000001".to_string(),
            })
            .expect("tracking record is stored");
        store
            .attach_tracking_record_to_sheet_row(&AttachTrackingRecordToSheetRowInput {
                row_id: "row-1".to_string(),
                tracking_record_id: "record-1".to_string(),
                row_status: SheetRowStatus::Loaded,
                error_message: None,
            })
            .expect("tracking record is attached");

        let bag_values = store
            .query_sheet_field_values(
                &SheetFieldValuesQuery {
                    sheet_id: "sheet-1".to_string(),
                    field: "history_summary.latest_bagging_status".to_string(),
                    filters: vec![],
                    value_filters: vec![],
                    limit: 10,
                },
                100,
            )
            .expect("latest bag value options are queried");
        assert_eq!(
            bag_values.values,
            vec![SheetFieldValueOption {
                value: "PID98937705 - Unbagging".to_string(),
                count: 1,
            }]
        );

        let manifest_values = store
            .query_sheet_field_values(
                &SheetFieldValuesQuery {
                    sheet_id: "sheet-1".to_string(),
                    field: "history_summary.latest_manifest_r7".to_string(),
                    filters: vec![],
                    value_filters: vec![],
                    limit: 10,
                },
                100,
            )
            .expect("latest manifest value options are queried");
        assert_eq!(
            manifest_values.values,
            vec![SheetFieldValueOption {
                value: "P20260617083040393".to_string(),
                count: 1,
            }]
        );

        let delivery_values = store
            .query_sheet_field_values(
                &SheetFieldValuesQuery {
                    sheet_id: "sheet-1".to_string(),
                    field: "history_summary.latest_delivery_runsheet".to_string(),
                    filters: vec![],
                    value_filters: vec![],
                    limit: 10,
                },
                100,
            )
            .expect("latest delivery value options are queried");
        assert_eq!(
            delivery_values.values,
            vec![SheetFieldValueOption {
                value: "FAILEDTODELIVERED | 2026-06-11 | Junaidi".to_string(),
                count: 1,
            }]
        );

        let unbag_values = store
            .query_sheet_field_values(
                &SheetFieldValuesQuery {
                    sheet_id: "sheet-1".to_string(),
                    field: "computed.days_since_last_unbagging".to_string(),
                    filters: vec![],
                    value_filters: vec![],
                    limit: 10,
                },
                100,
            )
            .expect("unbag elapsed day value options are queried");
        assert_eq!(unbag_values.total_count, 1);
        assert_eq!(unbag_values.values.len(), 1);
        assert_eq!(unbag_values.values[0].count, 1);
        assert!(unbag_values.values[0].value.parse::<i64>().is_ok());
    }

    #[test]
    fn import_job_state_tracks_counts_and_failed_only_retry_targets() {
        let mut store = prepared_store();

        let summary = store
            .create_import_job(&CreateImportJobInput {
                job_id: "job-1".to_string(),
                sheet_id: "sheet-1".to_string(),
                kind: ImportKind::Manifest,
                mode: ImportMode::Append,
                total_count: 3,
            })
            .expect("job is created");
        assert_eq!(summary.pending_count, 3);

        for (position, item_id, source_item_id, source_item_kind) in [
            (
                0,
                "item-1",
                "P20260611084606832",
                ImportSourceItemKind::Manifest,
            ),
            (
                1,
                "item-2",
                "PID99429465",
                ImportSourceItemKind::ManifestBag,
            ),
            (
                2,
                "item-3",
                "PID99380748",
                ImportSourceItemKind::ManifestBag,
            ),
        ] {
            store
                .create_import_job_item(&CreateImportJobItemInput {
                    item_id: item_id.to_string(),
                    job_id: "job-1".to_string(),
                    source_item_id: source_item_id.to_string(),
                    source_item_kind,
                    position,
                })
                .expect("job item is created");
        }

        store
            .update_import_job_item_status(&UpdateImportJobItemStatusInput {
                item_id: "item-1".to_string(),
                status: ImportJobItemStatus::Succeeded,
                tracking_ids: vec!["PID99380748".to_string()],
                error_message: None,
            })
            .expect("first item succeeds");
        store
            .update_import_job_item_status(&UpdateImportJobItemStatusInput {
                item_id: "item-2".to_string(),
                status: ImportJobItemStatus::Failed,
                tracking_ids: vec![],
                error_message: Some("failed to fetch bag".to_string()),
            })
            .expect("second item fails");
        store
            .update_import_job_item_sheet_row_ids("item-2", &["sheet-1:row:stale".to_string()])
            .expect("stale sheet row ids are recorded");

        let detail = store
            .get_import_job("job-1")
            .expect("job loads")
            .expect("job exists");
        assert_eq!(detail.summary.success_count, 1);
        assert_eq!(detail.summary.failed_count, 1);
        assert_eq!(detail.summary.pending_count, 1);
        assert_eq!(detail.summary.status, ImportJobStatus::Running);

        let retry_targets = store
            .retry_import_job_failed("job-1", 3)
            .expect("failed items become retry targets");
        assert!(retry_targets.source_item_ids.is_empty());
        assert_eq!(retry_targets.manifest_bag_ids, vec!["PID99429465"]);

        let detail = store
            .get_import_job("job-1")
            .expect("job loads")
            .expect("job exists");
        let retried_item = detail
            .items
            .iter()
            .find(|item| item.item_id == "item-2")
            .expect("retried item exists");
        assert_eq!(retried_item.status, ImportJobItemStatus::Pending);
        assert_eq!(retried_item.error_message, None);
        assert!(retried_item.sheet_row_ids.is_empty());
    }

    #[test]
    fn replace_import_creation_rolls_back_sheet_clear_when_item_insert_fails() {
        let mut store = prepared_store();
        store
            .upsert_sheet_row(&UpsertSheetRowInput {
                row_id: "old-row".to_string(),
                sheet_id: "sheet-1".to_string(),
                position: 0,
                display_tracking_id: "POLD".to_string(),
                lookup_tracking_id: "POLD".to_string(),
                row_status: SheetRowStatus::Loaded,
                error_message: None,
            })
            .expect("existing row is stored");
        let job = CreateImportJobInput {
            job_id: "job-replace".to_string(),
            sheet_id: "sheet-1".to_string(),
            kind: ImportKind::Bag,
            mode: ImportMode::Replace,
            total_count: 2,
        };
        let duplicate_item_id = [
            CreateImportJobItemInput {
                item_id: "duplicate-item".to_string(),
                job_id: job.job_id.clone(),
                source_item_id: "BAG-1".to_string(),
                source_item_kind: ImportSourceItemKind::Bag,
                position: 0,
            },
            CreateImportJobItemInput {
                item_id: "duplicate-item".to_string(),
                job_id: job.job_id.clone(),
                source_item_id: "BAG-2".to_string(),
                source_item_kind: ImportSourceItemKind::Bag,
                position: 1,
            },
        ];

        store
            .create_import_job_with_items(&job, &duplicate_item_id)
            .expect_err("duplicate item primary key aborts the transaction");

        assert!(store
            .get_sheet_row("old-row")
            .expect("old row lookup succeeds")
            .is_some());
        assert!(store
            .get_import_job("job-replace")
            .expect("job lookup succeeds")
            .is_none());
    }

    #[test]
    fn import_retry_does_not_requeue_items_at_attempt_limit() {
        let mut store = prepared_store();
        seed_import_job_with_items(
            &mut store,
            "job-at-limit",
            &[("item-1", "PID99429465", ImportSourceItemKind::Bag)],
        );
        for attempt in 1..=3 {
            store
                .update_import_job_item_status(&UpdateImportJobItemStatusInput {
                    item_id: "item-1".to_string(),
                    status: ImportJobItemStatus::Failed,
                    tracking_ids: vec![],
                    error_message: Some(format!("attempt {attempt} failed")),
                })
                .expect("failed attempt is recorded");
        }

        let targets = store
            .retry_import_job_failed("job-at-limit", 3)
            .expect("retry selection succeeds");
        let detail = store
            .get_import_job("job-at-limit")
            .expect("job loads")
            .expect("job exists");

        assert!(targets.source_item_ids.is_empty());
        assert_eq!(detail.items[0].status, ImportJobItemStatus::Failed);
        assert_eq!(detail.items[0].attempt_count, 3);
        assert_eq!(detail.summary.failed_count, 1);
        assert_eq!(detail.summary.pending_count, 0);
    }

    #[test]
    fn import_attempt_lifecycle_marks_item_and_job_completed() {
        let mut store = prepared_store();
        seed_import_job_with_items(
            &mut store,
            "job-1",
            &[
                ("item-1", "PID99429465", ImportSourceItemKind::Bag),
                ("item-2", "PID99380748", ImportSourceItemKind::Bag),
            ],
        );

        let claimed = store
            .claim_next_pending_import_job_item("job-1")
            .expect("item can be claimed")
            .expect("pending item exists");
        assert_eq!(claimed.item_id, "item-1");
        assert_eq!(claimed.status, ImportJobItemStatus::Running);

        let attempt = store
            .start_import_attempt(&StartImportAttemptInput {
                attempt_id: "attempt-1".to_string(),
                item_id: "item-1".to_string(),
                raw_blob_id: None,
            })
            .expect("attempt starts");
        assert_eq!(attempt.attempt_number, 1);
        assert_eq!(attempt.status, ImportAttemptStatus::Running);

        store
            .finish_import_attempt(&FinishImportAttemptInput {
                attempt_id: "attempt-1".to_string(),
                status: ImportAttemptStatus::Succeeded,
                tracking_ids: vec!["P2606020189412.30".to_string()],
                error_message: None,
                raw_blob_id: None,
            })
            .expect("attempt finishes");
        store
            .update_import_job_item_status(&UpdateImportJobItemStatusInput {
                item_id: "item-2".to_string(),
                status: ImportJobItemStatus::Succeeded,
                tracking_ids: vec!["P2606020189412.31".to_string()],
                error_message: None,
            })
            .expect("second item finishes");

        let detail = store
            .get_import_job("job-1")
            .expect("job loads")
            .expect("job exists");
        assert_eq!(detail.summary.status, ImportJobStatus::Completed);
        assert_eq!(detail.summary.success_count, 2);
        assert_eq!(detail.summary.pending_count, 0);
        assert_eq!(detail.items[0].attempt_count, 1);
        assert_eq!(
            detail.items[0].tracking_ids,
            vec!["P2606020189412.30".to_string()]
        );

        let attempts = store
            .list_import_attempts_for_item("item-1")
            .expect("attempts load");
        assert_eq!(attempts.len(), 1);
        assert_eq!(attempts[0].status, ImportAttemptStatus::Succeeded);
    }

    #[test]
    fn recovery_requeues_running_items_and_closes_interrupted_attempts() {
        let mut store = prepared_store();
        seed_import_job_with_items(
            &mut store,
            "job-1",
            &[
                ("item-1", "PID99429465", ImportSourceItemKind::ManifestBag),
                ("item-2", "PID99380748", ImportSourceItemKind::ManifestBag),
            ],
        );
        store
            .claim_next_pending_import_job_item("job-1")
            .expect("claim succeeds");
        store
            .start_import_attempt(&StartImportAttemptInput {
                attempt_id: "attempt-1".to_string(),
                item_id: "item-1".to_string(),
                raw_blob_id: None,
            })
            .expect("attempt starts");

        let recovery = store
            .recover_interrupted_import_jobs()
            .expect("recovery succeeds");
        assert_eq!(recovery.recovered_job_ids, vec!["job-1"]);
        assert_eq!(recovery.recovered_item_ids, vec!["item-1"]);
        assert_eq!(recovery.interrupted_attempt_ids, vec!["attempt-1"]);

        let detail = store
            .get_import_job("job-1")
            .expect("job loads")
            .expect("job exists");
        assert_eq!(detail.summary.status, ImportJobStatus::Running);
        assert_eq!(detail.summary.pending_count, 2);
        assert_eq!(detail.items[0].status, ImportJobItemStatus::Pending);
        assert_eq!(detail.items[0].attempt_count, 1);

        let attempts = store
            .list_import_attempts_for_item("item-1")
            .expect("attempts load");
        assert_eq!(attempts[0].status, ImportAttemptStatus::Interrupted);
        assert_eq!(
            attempts[0].error_message.as_deref(),
            Some("interrupted by shutdown")
        );
    }

    #[test]
    fn cancel_import_job_closes_running_attempts_and_pending_items() {
        let mut store = prepared_store();
        seed_import_job_with_items(
            &mut store,
            "job-1",
            &[
                ("item-1", "PID99429465", ImportSourceItemKind::Bag),
                ("item-2", "PID99380748", ImportSourceItemKind::Bag),
            ],
        );
        store
            .claim_next_pending_import_job_item("job-1")
            .expect("claim succeeds");
        store
            .start_import_attempt(&StartImportAttemptInput {
                attempt_id: "attempt-1".to_string(),
                item_id: "item-1".to_string(),
                raw_blob_id: None,
            })
            .expect("attempt starts");

        store.cancel_import_job("job-1").expect("job is cancelled");

        let detail = store
            .get_import_job("job-1")
            .expect("job loads")
            .expect("job exists");
        assert_eq!(detail.summary.status, ImportJobStatus::Cancelled);
        assert_eq!(detail.summary.pending_count, 0);
        assert_eq!(detail.items[0].status, ImportJobItemStatus::Cancelled);
        assert_eq!(detail.items[1].status, ImportJobItemStatus::Cancelled);

        let attempts = store
            .list_import_attempts_for_item("item-1")
            .expect("attempts load");
        assert_eq!(attempts[0].status, ImportAttemptStatus::Cancelled);
        assert_eq!(attempts[0].error_message.as_deref(), Some("cancelled"));

        store
            .finish_import_attempt(&FinishImportAttemptInput {
                attempt_id: "attempt-1".to_string(),
                status: ImportAttemptStatus::Succeeded,
                tracking_ids: vec!["PSTALE".to_string()],
                error_message: None,
                raw_blob_id: None,
            })
            .expect("late completion is ignored");
        let stale_row = UpsertSheetRowInput {
            row_id: "sheet-1:row:0".to_string(),
            sheet_id: "sheet-1".to_string(),
            position: 0,
            display_tracking_id: "PSTALE".to_string(),
            lookup_tracking_id: "PSTALE".to_string(),
            row_status: SheetRowStatus::Loaded,
            error_message: None,
        };
        let committed = store
            .finish_bag_import_attempt_with_sheet_rows(
                &FinishImportAttemptInput {
                    attempt_id: "attempt-1".to_string(),
                    status: ImportAttemptStatus::Succeeded,
                    tracking_ids: vec!["PSTALE".to_string()],
                    error_message: None,
                    raw_blob_id: None,
                },
                "item-1",
                &[stale_row],
                &["sheet-1:row:0".to_string()],
            )
            .expect("late bag commit is checked");
        let detail = store
            .get_import_job("job-1")
            .expect("job loads")
            .expect("job exists");
        let attempts = store
            .list_import_attempts_for_item("item-1")
            .expect("attempts load");
        assert!(!committed);
        assert_eq!(detail.summary.status, ImportJobStatus::Cancelled);
        assert_eq!(detail.items[0].status, ImportJobItemStatus::Cancelled);
        assert_eq!(attempts[0].status, ImportAttemptStatus::Cancelled);
        assert!(store
            .get_sheet_row("sheet-1:row:0")
            .expect("stale row lookup succeeds")
            .is_none());
    }

    fn prepared_store() -> SqliteWorkspaceStore {
        let mut store = SqliteWorkspaceStore::open_memory().expect("memory store opens");
        store
            .create_workspace(&CreateWorkspaceInput {
                workspace_id: "workspace-1".to_string(),
                name: "Main workspace".to_string(),
            })
            .expect("workspace is created");
        store
            .create_sheet(&CreateSheetInput {
                sheet_id: "sheet-1".to_string(),
                workspace_id: "workspace-1".to_string(),
                name: "Sheet 1".to_string(),
                position: 0,
            })
            .expect("sheet is created");
        store
    }

    fn seed_analytics_cache(store: &mut SqliteWorkspaceStore, sheet_id: &str, cache_id: &str) {
        store
            .connection
            .execute(
                r#"
                INSERT INTO analytics_cache (
                  id,
                  sheet_id,
                  query_hash,
                  result_json,
                  source_revision,
                  created_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                "#,
                params![
                    cache_id,
                    sheet_id,
                    format!("{cache_id}-query"),
                    "{}",
                    1_i64,
                    "2026-01-01T00:00:00Z"
                ],
            )
            .expect("analytics cache is seeded");
    }

    fn analytics_cache_count(store: &SqliteWorkspaceStore, sheet_id: &str) -> u32 {
        store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM analytics_cache WHERE sheet_id = ?1",
                params![sheet_id],
                |row| row.get::<_, i64>(0),
            )
            .expect("analytics cache count is read") as u32
    }

    fn seed_import_job_with_items(
        store: &mut SqliteWorkspaceStore,
        job_id: &str,
        items: &[(&str, &str, ImportSourceItemKind)],
    ) {
        store
            .create_import_job(&CreateImportJobInput {
                job_id: job_id.to_string(),
                sheet_id: "sheet-1".to_string(),
                kind: ImportKind::Bag,
                mode: ImportMode::Append,
                total_count: items.len() as u32,
            })
            .expect("job is created");

        for (position, (item_id, source_item_id, source_item_kind)) in items.iter().enumerate() {
            store
                .create_import_job_item(&CreateImportJobItemInput {
                    item_id: (*item_id).to_string(),
                    job_id: job_id.to_string(),
                    source_item_id: (*source_item_id).to_string(),
                    source_item_kind: *source_item_kind,
                    position: position as u32,
                })
                .expect("job item is created");
        }
    }

    fn temp_db_path(name: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "shipflow-workspace-engine-{name}-{}-{}.db",
            std::process::id(),
            OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        path
    }

    fn cleanup_temp_db(path: &PathBuf) {
        let _ = fs::remove_file(path);
        let _ = fs::remove_file(path.with_extension("db-wal"));
        let _ = fs::remove_file(path.with_extension("db-shm"));
    }
}
