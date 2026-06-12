use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::analytics::{AnalyticsEngineError, DuckDbAnalyticsEngine};
use crate::commands::{
    ClearSheetRowsRequest, CopySheetRowsRequest, CreateImportJobRequest, CreateSheetRequest,
    DeleteSheetRequest, DeleteSheetResponse, DeleteSheetRowsRequest, RenameSheetRequest,
    TransferSheetRowsMode, TransferSheetRowsRequest, UpsertSheetRowsRequest,
    WorkspaceEngineCommand, WorkspaceEngineResponse,
};
use crate::events::WorkspaceEngineEvent;
use crate::import_engine::{
    CreateImportJobPlan, ImportEngine, ImportEngineError, ImportLookupSource,
};
use crate::jobs::{JobRecoverySummary, RetryPolicy};
use crate::schema::SCHEMA_VERSION;
use crate::storage::{
    CreateSheetInput, CreateWorkspaceInput, SheetRecord, SheetRowStatus, SheetRowWindow,
    SheetRowsQuery, SqliteWorkspaceStore, TransferSheetRowsInput, UpsertSheetRowInput,
    WorkspaceRecord, WorkspaceStoreError,
};
use crate::tracking::{
    resolve_tracking_id, SheetRowsTrackingRefreshResult, TrackingEngine, TrackingEngineError,
    TrackingLookupSource,
};

const DEFAULT_MAX_SHEET_ROW_WINDOW: u32 = 1_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEngineConfig {
    pub schema_version: u32,
    pub max_concurrent_import_lookups: usize,
    pub max_concurrent_manifest_bag_lookups: usize,
    pub retry_policy: RetryPolicy,
}

impl Default for WorkspaceEngineConfig {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            max_concurrent_import_lookups: 4,
            max_concurrent_manifest_bag_lookups: 4,
            retry_policy: RetryPolicy::default(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct WorkspaceEngine {
    config: WorkspaceEngineConfig,
}

impl WorkspaceEngine {
    pub fn new(config: WorkspaceEngineConfig) -> Self {
        Self { config }
    }

    pub fn config(&self) -> &WorkspaceEngineConfig {
        &self.config
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceEngineBootstrapConfig {
    pub database_path: PathBuf,
    pub workspace_id: String,
    pub workspace_name: String,
    pub initial_sheet_id: String,
    pub initial_sheet_name: String,
}

impl WorkspaceEngineBootstrapConfig {
    pub fn new(
        database_path: impl Into<PathBuf>,
        workspace_id: impl Into<String>,
        workspace_name: impl Into<String>,
        initial_sheet_id: impl Into<String>,
        initial_sheet_name: impl Into<String>,
    ) -> Self {
        Self {
            database_path: database_path.into(),
            workspace_id: workspace_id.into(),
            workspace_name: workspace_name.into(),
            initial_sheet_id: initial_sheet_id.into(),
            initial_sheet_name: initial_sheet_name.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceEngineBootstrapState {
    pub workspace: WorkspaceRecord,
    pub initial_sheet: SheetRecord,
    pub recovery: JobRecoverySummary,
}

pub struct WorkspaceEngineBootstrap<Source>
where
    Source: ImportLookupSource + TrackingLookupSource,
{
    pub runtime: WorkspaceEngineRuntime<Source>,
    pub state: WorkspaceEngineBootstrapState,
}

#[derive(Debug)]
pub enum WorkspaceEngineRuntimeError {
    Io(std::io::Error),
    Store(WorkspaceStoreError),
    Import(ImportEngineError),
    Tracking(TrackingEngineError),
    MissingImportJob(String),
    Analytics(AnalyticsEngineError),
}

impl std::fmt::Display for WorkspaceEngineRuntimeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "io error: {error}"),
            Self::Store(error) => write!(formatter, "{error}"),
            Self::Import(error) => write!(formatter, "{error}"),
            Self::Tracking(error) => write!(formatter, "{error}"),
            Self::MissingImportJob(job_id) => write!(formatter, "missing import job: {job_id}"),
            Self::Analytics(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for WorkspaceEngineRuntimeError {}

impl From<std::io::Error> for WorkspaceEngineRuntimeError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<WorkspaceStoreError> for WorkspaceEngineRuntimeError {
    fn from(error: WorkspaceStoreError) -> Self {
        Self::Store(error)
    }
}

impl From<ImportEngineError> for WorkspaceEngineRuntimeError {
    fn from(error: ImportEngineError) -> Self {
        Self::Import(error)
    }
}

impl From<TrackingEngineError> for WorkspaceEngineRuntimeError {
    fn from(error: TrackingEngineError) -> Self {
        Self::Tracking(error)
    }
}

impl From<AnalyticsEngineError> for WorkspaceEngineRuntimeError {
    fn from(error: AnalyticsEngineError) -> Self {
        Self::Analytics(error)
    }
}

pub type WorkspaceEngineRuntimeResult<T> = Result<T, WorkspaceEngineRuntimeError>;

pub struct WorkspaceEngineRuntime<Source>
where
    Source: ImportLookupSource + TrackingLookupSource,
{
    config: WorkspaceEngineConfig,
    store: SqliteWorkspaceStore,
    import_source: Source,
    analytics_engine: DuckDbAnalyticsEngine,
    blob_root_path: Option<PathBuf>,
    next_import_job_sequence: u64,
}

impl<Source> WorkspaceEngineRuntime<Source>
where
    Source: ImportLookupSource + TrackingLookupSource,
{
    pub fn open_persistent(
        config: WorkspaceEngineConfig,
        bootstrap: WorkspaceEngineBootstrapConfig,
        import_source: Source,
    ) -> WorkspaceEngineRuntimeResult<WorkspaceEngineBootstrap<Source>> {
        if let Some(parent) = bootstrap.database_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let blob_root_path = bootstrap.database_path.parent().map(PathBuf::from);
        let mut store = SqliteWorkspaceStore::open(&bootstrap.database_path)?;
        let workspace = store.create_workspace(&CreateWorkspaceInput {
            workspace_id: bootstrap.workspace_id,
            name: bootstrap.workspace_name,
        })?;
        let initial_sheet = store.create_sheet(&CreateSheetInput {
            sheet_id: bootstrap.initial_sheet_id,
            workspace_id: workspace.workspace_id.clone(),
            name: bootstrap.initial_sheet_name,
            position: 0,
        })?;
        let recovery = store.recover_interrupted_import_jobs()?;
        let runtime = Self::new_with_blob_root_path(config, store, import_source, blob_root_path);

        Ok(WorkspaceEngineBootstrap {
            runtime,
            state: WorkspaceEngineBootstrapState {
                workspace,
                initial_sheet,
                recovery,
            },
        })
    }

    pub fn new(
        config: WorkspaceEngineConfig,
        store: SqliteWorkspaceStore,
        import_source: Source,
    ) -> Self {
        Self::new_with_blob_root_path(config, store, import_source, None)
    }

    pub fn new_with_blob_root_path(
        config: WorkspaceEngineConfig,
        store: SqliteWorkspaceStore,
        import_source: Source,
        blob_root_path: Option<PathBuf>,
    ) -> Self {
        Self {
            analytics_engine: DuckDbAnalyticsEngine::new(DEFAULT_MAX_SHEET_ROW_WINDOW),
            config,
            store,
            import_source,
            blob_root_path,
            next_import_job_sequence: 0,
        }
    }

    pub fn config(&self) -> &WorkspaceEngineConfig {
        &self.config
    }

    pub fn store(&self) -> &SqliteWorkspaceStore {
        &self.store
    }

    pub fn store_mut(&mut self) -> &mut SqliteWorkspaceStore {
        &mut self.store
    }

    pub fn import_source(&self) -> &Source {
        &self.import_source
    }

    pub async fn handle_command(
        &mut self,
        command: WorkspaceEngineCommand,
    ) -> WorkspaceEngineRuntimeResult<WorkspaceEngineResponse> {
        match command {
            WorkspaceEngineCommand::CreateImportJob(request) => {
                let detail = self.create_import_job(request)?;
                Ok(WorkspaceEngineResponse::ImportJobDetail(detail))
            }
            WorkspaceEngineCommand::RunImportJob(request) => {
                let detail = self.run_import_job(&request.job_id).await?;
                Ok(WorkspaceEngineResponse::ImportJobDetail(detail))
            }
            WorkspaceEngineCommand::RetryImportJobFailed(request) => {
                let detail = self.retry_import_job_failed(&request.job_id).await?;
                Ok(WorkspaceEngineResponse::ImportJobDetail(detail))
            }
            WorkspaceEngineCommand::CancelImportJob(request) => {
                self.store.cancel_import_job(&request.job_id)?;
                let detail = self
                    .store
                    .get_import_job(&request.job_id)?
                    .ok_or_else(|| WorkspaceEngineRuntimeError::MissingImportJob(request.job_id))?;
                Ok(WorkspaceEngineResponse::ImportJobDetail(detail))
            }
            WorkspaceEngineCommand::GetImportJob(request) => {
                let detail = self
                    .store
                    .get_import_job(&request.job_id)?
                    .ok_or_else(|| WorkspaceEngineRuntimeError::MissingImportJob(request.job_id))?;
                Ok(WorkspaceEngineResponse::ImportJobDetail(detail))
            }
            WorkspaceEngineCommand::ListSheets => {
                let sheets = self.store.list_sheets()?;
                Ok(WorkspaceEngineResponse::Sheets(sheets))
            }
            WorkspaceEngineCommand::CreateSheet(request) => {
                let sheet = self.create_sheet(request)?;
                Ok(WorkspaceEngineResponse::Sheet(sheet))
            }
            WorkspaceEngineCommand::RenameSheet(request) => {
                let sheet = self.rename_sheet(request)?;
                Ok(WorkspaceEngineResponse::Sheet(sheet))
            }
            WorkspaceEngineCommand::QuerySheetRows(request) => {
                let rows = self
                    .store
                    .query_sheet_rows(&request.query, DEFAULT_MAX_SHEET_ROW_WINDOW)?;
                Ok(WorkspaceEngineResponse::SheetRows(rows))
            }
            WorkspaceEngineCommand::QuerySheetFieldValues(request) => {
                let values = self
                    .store
                    .query_sheet_field_values(&request.query, DEFAULT_MAX_SHEET_ROW_WINDOW)?;
                Ok(WorkspaceEngineResponse::SheetFieldValues(values))
            }
            WorkspaceEngineCommand::ClearSheetRows(request) => {
                let rows = self.clear_sheet_rows(request)?;
                Ok(WorkspaceEngineResponse::SheetRows(rows))
            }
            WorkspaceEngineCommand::DeleteSheet(request) => {
                let response = self.delete_sheet(request)?;
                Ok(WorkspaceEngineResponse::SheetDeleted(response))
            }
            WorkspaceEngineCommand::DeleteSheetRows(request) => {
                let rows = self.delete_sheet_rows(request)?;
                Ok(WorkspaceEngineResponse::SheetRows(rows))
            }
            WorkspaceEngineCommand::TransferSheetRows(request) => {
                let rows = self.transfer_sheet_rows(request)?;
                Ok(WorkspaceEngineResponse::SheetRows(rows))
            }
            WorkspaceEngineCommand::CopySheetRows(request) => {
                let rows = self.copy_sheet_rows(request)?;
                Ok(WorkspaceEngineResponse::SheetRows(rows))
            }
            WorkspaceEngineCommand::UpsertSheetRows(request) => {
                let rows = self.upsert_sheet_rows(request)?;
                Ok(WorkspaceEngineResponse::SheetRows(rows))
            }
            WorkspaceEngineCommand::RefreshSheetRowTracking(request) => {
                let row = self
                    .refresh_sheet_row_tracking(&request.row_id, request.force_refresh)
                    .await?;
                Ok(WorkspaceEngineResponse::SheetRow(row))
            }
            WorkspaceEngineCommand::RefreshSheetRowsTracking(request) => {
                let result = self
                    .refresh_sheet_rows_tracking(
                        &request.sheet_id,
                        &request.row_ids,
                        request.force_refresh,
                    )
                    .await?;
                Ok(WorkspaceEngineResponse::SheetRowsTrackingRefresh(result))
            }
            WorkspaceEngineCommand::PreviewImportSource(request) => {
                let preview = self
                    .preview_import_source(request.kind, &request.ids)
                    .await?;
                Ok(WorkspaceEngineResponse::ImportSourcePreview(preview))
            }
            WorkspaceEngineCommand::ResolveTrackingId { display_id } => Ok(
                WorkspaceEngineResponse::ResolvedTrackingId(resolve_tracking_id(&display_id)),
            ),
            WorkspaceEngineCommand::QueryPivot(query) => {
                let pivot = self.analytics_engine.query_pivot(&self.store, &query)?;
                Ok(WorkspaceEngineResponse::Pivot(pivot))
            }
            WorkspaceEngineCommand::QueryChart(query) => {
                let chart = self.analytics_engine.query_chart(&self.store, &query)?;
                Ok(WorkspaceEngineResponse::Chart(chart))
            }
        }
    }

    fn create_import_job(
        &mut self,
        request: CreateImportJobRequest,
    ) -> WorkspaceEngineRuntimeResult<crate::imports::ImportJobDetail> {
        self.ensure_sheet_exists(&request.sheet_id)?;
        let job_id = self.next_import_job_id();
        let mut import_engine = ImportEngine::with_blob_root_path(
            &mut self.store,
            &mut self.import_source,
            self.blob_root_path.clone(),
        );
        Ok(import_engine.create_job(&CreateImportJobPlan {
            job_id,
            sheet_id: request.sheet_id,
            kind: request.kind,
            ids: request.ids,
            mode: request.mode,
        })?)
    }

    fn clear_sheet_rows(
        &mut self,
        request: ClearSheetRowsRequest,
    ) -> WorkspaceEngineRuntimeResult<SheetRowWindow> {
        self.ensure_sheet_exists(&request.sheet_id)?;
        self.store.clear_sheet_rows(&request.sheet_id)?;
        Ok(self.query_first_sheet_row_window(request.sheet_id)?)
    }

    fn create_sheet(
        &mut self,
        request: CreateSheetRequest,
    ) -> WorkspaceEngineRuntimeResult<SheetRecord> {
        let name = request.name.trim();
        if name.is_empty() {
            return Err(WorkspaceStoreError::InvalidValue {
                field: "sheet_name",
                value: request.name,
            }
            .into());
        }

        let workspace_id = self.store.primary_workspace_id()?.ok_or_else(|| {
            WorkspaceStoreError::InvalidValue {
                field: "workspace",
                value: "primary".to_string(),
            }
        })?;
        Ok(self.store.create_sheet(&CreateSheetInput {
            sheet_id: request.sheet_id,
            workspace_id,
            name: name.to_string(),
            position: request.position,
        })?)
    }

    fn rename_sheet(
        &mut self,
        request: RenameSheetRequest,
    ) -> WorkspaceEngineRuntimeResult<SheetRecord> {
        let name = request.name.trim();
        if name.is_empty() {
            return Err(WorkspaceStoreError::InvalidValue {
                field: "sheet_name",
                value: request.name,
            }
            .into());
        }

        Ok(self.store.rename_sheet(&request.sheet_id, name)?)
    }

    fn delete_sheet_rows(
        &mut self,
        request: DeleteSheetRowsRequest,
    ) -> WorkspaceEngineRuntimeResult<SheetRowWindow> {
        self.ensure_sheet_exists(&request.sheet_id)?;
        self.store
            .delete_sheet_rows(&request.sheet_id, &request.row_ids)?;
        Ok(self.query_first_sheet_row_window(request.sheet_id)?)
    }

    fn delete_sheet(
        &mut self,
        request: DeleteSheetRequest,
    ) -> WorkspaceEngineRuntimeResult<DeleteSheetResponse> {
        self.store.delete_sheet(&request.sheet_id)?;
        Ok(DeleteSheetResponse {
            sheet_id: request.sheet_id,
        })
    }

    fn transfer_sheet_rows(
        &mut self,
        request: TransferSheetRowsRequest,
    ) -> WorkspaceEngineRuntimeResult<SheetRowWindow> {
        self.ensure_sheet_exists(&request.source_sheet_id)?;
        self.ensure_sheet_exists(&request.target_sheet_id)?;
        self.store.transfer_sheet_rows(&TransferSheetRowsInput {
            source_sheet_id: request.source_sheet_id,
            target_sheet_id: request.target_sheet_id.clone(),
            row_ids: request.row_ids,
            delete_source_rows: request.mode == TransferSheetRowsMode::Move,
        })?;
        Ok(self.query_first_sheet_row_window(request.target_sheet_id)?)
    }

    fn copy_sheet_rows(
        &mut self,
        request: CopySheetRowsRequest,
    ) -> WorkspaceEngineRuntimeResult<SheetRowWindow> {
        self.ensure_sheet_exists(&request.source_sheet_id)?;
        self.ensure_sheet_exists(&request.target_sheet_id)?;
        self.store
            .copy_sheet_rows(&request.source_sheet_id, &request.target_sheet_id)?;
        Ok(self.query_first_sheet_row_window(request.target_sheet_id)?)
    }

    fn upsert_sheet_rows(
        &mut self,
        request: UpsertSheetRowsRequest,
    ) -> WorkspaceEngineRuntimeResult<SheetRowWindow> {
        self.ensure_sheet_exists(&request.sheet_id)?;
        for row in request.rows {
            let display_tracking_id = row.display_tracking_id.trim();
            if display_tracking_id.is_empty() {
                continue;
            }

            let resolved = resolve_tracking_id(display_tracking_id);
            self.store.upsert_sheet_row(&UpsertSheetRowInput {
                row_id: row.row_id,
                sheet_id: request.sheet_id.clone(),
                position: row.position,
                display_tracking_id: resolved.display_id,
                lookup_tracking_id: resolved.lookup_id,
                row_status: SheetRowStatus::Empty,
                error_message: None,
            })?;
        }

        Ok(self.query_first_sheet_row_window(request.sheet_id)?)
    }

    fn query_first_sheet_row_window(
        &self,
        sheet_id: String,
    ) -> WorkspaceEngineRuntimeResult<SheetRowWindow> {
        Ok(self.store.query_sheet_rows(
            &SheetRowsQuery {
                sheet_id,
                offset: 0,
                limit: DEFAULT_MAX_SHEET_ROW_WINDOW,
                filters: vec![],
                value_filters: vec![],
                sort: vec![],
            },
            DEFAULT_MAX_SHEET_ROW_WINDOW,
        )?)
    }

    async fn run_import_job(
        &mut self,
        job_id: &str,
    ) -> WorkspaceEngineRuntimeResult<crate::imports::ImportJobDetail> {
        self.run_import_job_with_progress(job_id, |_| {}).await
    }

    pub async fn run_import_job_with_progress<F>(
        &mut self,
        job_id: &str,
        mut on_event: F,
    ) -> WorkspaceEngineRuntimeResult<crate::imports::ImportJobDetail>
    where
        F: FnMut(WorkspaceEngineEvent),
    {
        let mut import_engine = ImportEngine::with_blob_root_path(
            &mut self.store,
            &mut self.import_source,
            self.blob_root_path.clone(),
        );
        Ok(import_engine
            .run_job_with_progress(job_id, |event| {
                on_event(WorkspaceEngineEvent::ImportJobProgress(event));
            })
            .await?)
    }

    async fn retry_import_job_failed(
        &mut self,
        job_id: &str,
    ) -> WorkspaceEngineRuntimeResult<crate::imports::ImportJobDetail> {
        self.retry_import_job_failed_with_progress(job_id, |_| {})
            .await
    }

    pub async fn retry_import_job_failed_with_progress<F>(
        &mut self,
        job_id: &str,
        mut on_event: F,
    ) -> WorkspaceEngineRuntimeResult<crate::imports::ImportJobDetail>
    where
        F: FnMut(WorkspaceEngineEvent),
    {
        let mut import_engine = ImportEngine::with_blob_root_path(
            &mut self.store,
            &mut self.import_source,
            self.blob_root_path.clone(),
        );
        Ok(import_engine
            .retry_failed_and_run_with_progress(job_id, |event| {
                on_event(WorkspaceEngineEvent::ImportJobProgress(event));
            })
            .await?)
    }

    async fn preview_import_source(
        &mut self,
        kind: crate::imports::ImportKind,
        ids: &[String],
    ) -> WorkspaceEngineRuntimeResult<crate::imports::ImportSourcePreviewResult> {
        let mut import_engine = ImportEngine::with_blob_root_path(
            &mut self.store,
            &mut self.import_source,
            self.blob_root_path.clone(),
        );
        Ok(import_engine.preview_import_source(kind, ids).await)
    }

    fn ensure_sheet_exists(&mut self, sheet_id: &str) -> WorkspaceEngineRuntimeResult<()> {
        if self.store.sheet_exists(sheet_id)? {
            return Ok(());
        }

        let workspace_id = self.store.primary_workspace_id()?.ok_or_else(|| {
            WorkspaceStoreError::InvalidValue {
                field: "workspace",
                value: "primary".to_string(),
            }
        })?;
        self.store.create_sheet(&CreateSheetInput {
            sheet_id: sheet_id.to_string(),
            workspace_id,
            name: sheet_id.to_string(),
            position: 0,
        })?;

        Ok(())
    }

    async fn refresh_sheet_row_tracking(
        &mut self,
        row_id: &str,
        force_refresh: bool,
    ) -> WorkspaceEngineRuntimeResult<crate::storage::SheetRowProjection> {
        let result = {
            let mut tracking_engine = TrackingEngine::with_blob_root_path(
                &mut self.store,
                &mut self.import_source,
                self.blob_root_path.clone(),
            );
            tracking_engine
                .refresh_sheet_row(row_id, force_refresh)
                .await
        };

        match result {
            Ok(row) => Ok(row),
            Err(TrackingEngineError::Lookup(_)) => self
                .store
                .get_sheet_row(row_id)?
                .ok_or_else(|| TrackingEngineError::MissingSheetRow(row_id.to_string()).into()),
            Err(error) => Err(error.into()),
        }
    }

    async fn refresh_sheet_rows_tracking(
        &mut self,
        sheet_id: &str,
        row_ids: &[String],
        force_refresh: bool,
    ) -> WorkspaceEngineRuntimeResult<SheetRowsTrackingRefreshResult> {
        let mut tracking_engine = TrackingEngine::with_blob_root_path(
            &mut self.store,
            &mut self.import_source,
            self.blob_root_path.clone(),
        );
        Ok(tracking_engine
            .refresh_sheet_rows(sheet_id, row_ids, force_refresh)
            .await?)
    }

    fn next_import_job_id(&mut self) -> String {
        self.next_import_job_sequence = self.next_import_job_sequence.saturating_add(1);
        format!(
            "import-job-{}-{}",
            OffsetDateTime::now_utc().unix_timestamp_nanos(),
            self.next_import_job_sequence
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, VecDeque};
    use std::fs;
    use std::future::Future;
    use std::path::PathBuf;

    use shipflow_core::model::{
        BagItem, BagResponse, ManifestItem, ManifestResponse, TrackDetail, TrackResponse,
        TrackStatusAkhir,
    };

    use crate::blob_store::absolute_blob_path;
    use crate::commands::{
        ClearSheetRowsRequest, CopySheetRowsRequest, CreateImportJobRequest, CreateSheetRequest,
        DeleteSheetRequest, DeleteSheetRowsRequest, JobIdRequest, QuerySheetFieldValuesRequest,
        QuerySheetRowsRequest, RefreshSheetRowTrackingRequest, RefreshSheetRowsTrackingRequest,
        RenameSheetRequest, UpsertSheetRowRequest, UpsertSheetRowsRequest, WorkspaceEngineCommand,
        WorkspaceEngineResponse,
    };
    use crate::import_engine::{ImportLookupFailure, ImportLookupSource};
    use crate::imports::{ImportJobStatus, ImportKind, ImportMode, ImportSourcePreviewRequest};
    use crate::jobs::ImportAttemptStatus;
    use crate::storage::{
        CreateSheetInput, CreateWorkspaceInput, FinishImportAttemptInput, SheetFieldValuesQuery,
        SheetRowStatus, SheetRowsQuery, SqliteWorkspaceStore, StartImportAttemptInput,
        UpsertSheetRowInput,
    };
    use crate::tracking::{TrackingLookupFailure, TrackingLookupSource};

    #[test]
    fn default_engine_config_matches_big_bang_concurrency_contract() {
        let engine = WorkspaceEngine::new(WorkspaceEngineConfig::default());

        assert_eq!(engine.config().schema_version, SCHEMA_VERSION);
        assert_eq!(engine.config().max_concurrent_import_lookups, 4);
        assert_eq!(engine.config().max_concurrent_manifest_bag_lookups, 4);
    }

    #[tokio::test]
    async fn runtime_dispatches_import_and_query_commands() {
        let mut source = FakeImportSource::default();
        source.push_bag(
            "PID1",
            Ok(BagResponse {
                url: "https://example.test/bag/PID1".to_string(),
                nomor_kantung: Some("PID1".to_string()),
                items: vec![BagItem {
                    no_resi: Some("P2606020189412.30".to_string()),
                    ..BagItem::default()
                }],
            }),
        );
        let mut runtime = prepared_runtime(source);

        let created = runtime
            .handle_command(WorkspaceEngineCommand::CreateImportJob(
                CreateImportJobRequest {
                    sheet_id: "sheet-1".to_string(),
                    kind: ImportKind::Bag,
                    ids: vec!["PID1".to_string()],
                    mode: ImportMode::Append,
                },
            ))
            .await
            .expect("create command succeeds");
        let job_id = match created {
            WorkspaceEngineResponse::ImportJobDetail(detail) => {
                assert_eq!(detail.summary.status, ImportJobStatus::Running);
                detail.summary.job_id
            }
            response => panic!("unexpected response: {response:?}"),
        };

        let run = runtime
            .handle_command(WorkspaceEngineCommand::RunImportJob(JobIdRequest {
                job_id: job_id.clone(),
            }))
            .await
            .expect("run command succeeds");
        match run {
            WorkspaceEngineResponse::ImportJobDetail(detail) => {
                assert_eq!(detail.summary.status, ImportJobStatus::Completed);
                assert_eq!(detail.summary.success_count, 1);
            }
            response => panic!("unexpected response: {response:?}"),
        }

        let rows = runtime
            .handle_command(WorkspaceEngineCommand::QuerySheetRows(
                QuerySheetRowsRequest {
                    query: SheetRowsQuery {
                        sheet_id: "sheet-1".to_string(),
                        offset: 0,
                        limit: 10,
                        filters: vec![],
                        value_filters: vec![],
                        sort: vec![],
                    },
                },
            ))
            .await
            .expect("query rows command succeeds");
        match rows {
            WorkspaceEngineResponse::SheetRows(window) => {
                assert_eq!(window.total_count, 1);
                assert_eq!(window.rows[0].display_tracking_id, "P2606020189412.30");
                assert_eq!(window.rows[0].lookup_tracking_id, "P2606020189412");
            }
            response => panic!("unexpected response: {response:?}"),
        }

        let field_values = runtime
            .handle_command(WorkspaceEngineCommand::QuerySheetFieldValues(
                QuerySheetFieldValuesRequest {
                    query: SheetFieldValuesQuery {
                        sheet_id: "sheet-1".to_string(),
                        field: "detail.shipment_header.nomor_kiriman".to_string(),
                        filters: vec![],
                        value_filters: vec![],
                        limit: 10,
                    },
                },
            ))
            .await
            .expect("query field values command succeeds");
        match field_values {
            WorkspaceEngineResponse::SheetFieldValues(result) => {
                assert_eq!(result.sheet_id, "sheet-1");
                assert_eq!(result.field, "detail.shipment_header.nomor_kiriman");
                assert_eq!(result.total_count, 1);
                assert_eq!(result.values[0].value, "P2606");
                assert_eq!(result.values[0].count, 1);
            }
            response => panic!("unexpected response: {response:?}"),
        }

        let resolved = runtime
            .handle_command(WorkspaceEngineCommand::ResolveTrackingId {
                display_id: "P2606020189412.30".to_string(),
            })
            .await
            .expect("resolve command succeeds");
        match resolved {
            WorkspaceEngineResponse::ResolvedTrackingId(resolved) => {
                assert_eq!(resolved.display_id, "P2606020189412.30");
                assert_eq!(resolved.lookup_id, "P2606020189412");
            }
            response => panic!("unexpected response: {response:?}"),
        }
    }

    #[tokio::test]
    async fn runtime_dispatches_import_preview_without_creating_rows() {
        let mut source = FakeImportSource::default();
        source.push_manifest("MAN1", Ok(manifest_response(&["PID1"])));
        source.push_bag(
            "PID1",
            Ok(BagResponse {
                url: "https://example.test/bag/PID1".to_string(),
                nomor_kantung: Some("PID1".to_string()),
                items: vec![BagItem {
                    no_resi: Some("P2606020189412.30".to_string()),
                    ..BagItem::default()
                }],
            }),
        );
        let mut runtime = prepared_runtime(source);

        let preview = runtime
            .handle_command(WorkspaceEngineCommand::PreviewImportSource(
                ImportSourcePreviewRequest {
                    kind: ImportKind::Manifest,
                    ids: vec!["MAN1".to_string()],
                },
            ))
            .await
            .expect("preview command succeeds");

        match preview {
            WorkspaceEngineResponse::ImportSourcePreview(preview) => {
                assert_eq!(preview.kind, ImportKind::Manifest);
                assert_eq!(preview.source_items.len(), 1);
                assert_eq!(preview.source_items[0].tracking_ids, vec!["PID1"]);
                assert_eq!(preview.manifest_bags.len(), 1);
                assert_eq!(
                    preview.manifest_bags[0].tracking_ids,
                    vec!["P2606020189412.30"]
                );
                assert_eq!(preview.tracking_ids, vec!["P2606020189412.30"]);
            }
            response => panic!("unexpected response: {response:?}"),
        }

        let rows = query_all_rows(&mut runtime).await;
        assert_eq!(rows.total_count, 0);
    }

    #[tokio::test]
    async fn runtime_dispatches_manual_sheet_row_upserts() {
        let source = FakeImportSource::default();
        let mut runtime = prepared_runtime(source);

        let response = runtime
            .handle_command(WorkspaceEngineCommand::UpsertSheetRows(
                UpsertSheetRowsRequest {
                    sheet_id: "sheet-1".to_string(),
                    rows: vec![
                        UpsertSheetRowRequest {
                            row_id: "ui-row-1".to_string(),
                            position: 0,
                            display_tracking_id: " P2606020189412.30 ".to_string(),
                        },
                        UpsertSheetRowRequest {
                            row_id: "ui-row-2".to_string(),
                            position: 1,
                            display_tracking_id: "P2606020189413".to_string(),
                        },
                    ],
                },
            ))
            .await
            .expect("manual row upsert command succeeds");

        match response {
            WorkspaceEngineResponse::SheetRows(window) => {
                assert_eq!(window.total_count, 2);
                assert_eq!(window.rows[0].row_id, "ui-row-1");
                assert_eq!(window.rows[0].position, 0);
                assert_eq!(window.rows[0].display_tracking_id, "P2606020189412.30");
                assert_eq!(window.rows[0].lookup_tracking_id, "P2606020189412");
                assert_eq!(window.rows[0].row_status, SheetRowStatus::Empty);
                assert_eq!(window.rows[1].row_id, "ui-row-2");
                assert_eq!(window.rows[1].lookup_tracking_id, "P2606020189413");
            }
            response => panic!("unexpected response: {response:?}"),
        }

        let rows = query_all_rows(&mut runtime).await;
        assert_eq!(rows.total_count, 2);
        assert_eq!(rows.rows[0].display_tracking_id, "P2606020189412.30");
        assert_eq!(rows.rows[0].lookup_tracking_id, "P2606020189412");
    }

    #[tokio::test]
    async fn runtime_dispatches_copy_sheet_rows_command() {
        let source = FakeImportSource::default();
        let mut runtime = prepared_runtime(source);
        runtime
            .handle_command(WorkspaceEngineCommand::UpsertSheetRows(
                UpsertSheetRowsRequest {
                    sheet_id: "sheet-1".to_string(),
                    rows: vec![UpsertSheetRowRequest {
                        row_id: "ui-row-1".to_string(),
                        position: 0,
                        display_tracking_id: "P2606020189412.30".to_string(),
                    }],
                },
            ))
            .await
            .expect("source row is upserted");

        let response = runtime
            .handle_command(WorkspaceEngineCommand::CopySheetRows(
                CopySheetRowsRequest {
                    source_sheet_id: "sheet-1".to_string(),
                    target_sheet_id: "sheet-2".to_string(),
                },
            ))
            .await
            .expect("copy command succeeds");

        match response {
            WorkspaceEngineResponse::SheetRows(window) => {
                assert_eq!(window.sheet_id, "sheet-2");
                assert_eq!(window.total_count, 1);
                assert_eq!(window.rows[0].row_id, "sheet-2:row:0");
                assert_eq!(window.rows[0].display_tracking_id, "P2606020189412.30");
                assert_eq!(window.rows[0].lookup_tracking_id, "P2606020189412");
            }
            response => panic!("unexpected response: {response:?}"),
        }
    }

    #[tokio::test]
    async fn runtime_dispatches_sheet_metadata_commands() {
        let source = FakeImportSource::default();
        let mut runtime = prepared_runtime(source);

        let listed = runtime
            .handle_command(WorkspaceEngineCommand::ListSheets)
            .await
            .expect("list sheets command succeeds");

        match listed {
            WorkspaceEngineResponse::Sheets(sheets) => {
                assert_eq!(sheets.len(), 1);
                assert_eq!(sheets[0].sheet_id, "sheet-1");
                assert_eq!(sheets[0].name, "Sheet 1");
                assert_eq!(sheets[0].position, 0);
            }
            response => panic!("unexpected response: {response:?}"),
        }

        let created = runtime
            .handle_command(WorkspaceEngineCommand::CreateSheet(CreateSheetRequest {
                sheet_id: "sheet-2".to_string(),
                name: " Sheet 2 ".to_string(),
                position: 1,
            }))
            .await
            .expect("create sheet command succeeds");

        match created {
            WorkspaceEngineResponse::Sheet(sheet) => {
                assert_eq!(sheet.sheet_id, "sheet-2");
                assert_eq!(sheet.name, "Sheet 2");
                assert_eq!(sheet.position, 1);
            }
            response => panic!("unexpected response: {response:?}"),
        }

        let renamed = runtime
            .handle_command(WorkspaceEngineCommand::RenameSheet(RenameSheetRequest {
                sheet_id: "sheet-2".to_string(),
                name: "Cases".to_string(),
            }))
            .await
            .expect("rename sheet command succeeds");

        match renamed {
            WorkspaceEngineResponse::Sheet(sheet) => {
                assert_eq!(sheet.sheet_id, "sheet-2");
                assert_eq!(sheet.name, "Cases");
                assert_eq!(sheet.position, 1);
            }
            response => panic!("unexpected response: {response:?}"),
        }

        let listed = runtime
            .handle_command(WorkspaceEngineCommand::ListSheets)
            .await
            .expect("list sheets command succeeds");

        match listed {
            WorkspaceEngineResponse::Sheets(sheets) => {
                assert_eq!(
                    sheets
                        .iter()
                        .map(|sheet| sheet.sheet_id.as_str())
                        .collect::<Vec<_>>(),
                    vec!["sheet-1", "sheet-2"]
                );
                assert_eq!(sheets[1].name, "Cases");
            }
            response => panic!("unexpected response: {response:?}"),
        }
    }

    #[tokio::test]
    async fn runtime_dispatches_delete_sheet_command() {
        let source = FakeImportSource::default();
        let mut runtime = prepared_runtime(source);
        runtime
            .handle_command(WorkspaceEngineCommand::UpsertSheetRows(
                UpsertSheetRowsRequest {
                    sheet_id: "sheet-2".to_string(),
                    rows: vec![UpsertSheetRowRequest {
                        row_id: "ui-row-1".to_string(),
                        position: 0,
                        display_tracking_id: "P2606020189412.30".to_string(),
                    }],
                },
            ))
            .await
            .expect("target sheet row is upserted");

        let response = runtime
            .handle_command(WorkspaceEngineCommand::DeleteSheet(DeleteSheetRequest {
                sheet_id: "sheet-2".to_string(),
            }))
            .await
            .expect("delete sheet command succeeds");

        match response {
            WorkspaceEngineResponse::SheetDeleted(deleted) => {
                assert_eq!(deleted.sheet_id, "sheet-2");
            }
            response => panic!("unexpected response: {response:?}"),
        }

        assert!(!runtime
            .store
            .sheet_exists("sheet-2")
            .expect("sheet lookup succeeds"));
        let remaining_rows = runtime
            .store
            .query_sheet_rows(
                &SheetRowsQuery {
                    sheet_id: "sheet-2".to_string(),
                    offset: 0,
                    limit: 10,
                    filters: vec![],
                    value_filters: vec![],
                    sort: vec![],
                },
                DEFAULT_MAX_SHEET_ROW_WINDOW,
            )
            .expect("deleted sheet rows are queried");
        assert_eq!(remaining_rows.total_count, 0);
    }

    #[tokio::test]
    async fn runtime_dispatches_sheet_row_delete_and_clear_commands() {
        let source = FakeImportSource::default();
        let mut runtime = prepared_runtime(source);
        runtime
            .handle_command(WorkspaceEngineCommand::UpsertSheetRows(
                UpsertSheetRowsRequest {
                    sheet_id: "sheet-1".to_string(),
                    rows: vec![
                        UpsertSheetRowRequest {
                            row_id: "ui-row-1".to_string(),
                            position: 0,
                            display_tracking_id: "P1".to_string(),
                        },
                        UpsertSheetRowRequest {
                            row_id: "ui-row-2".to_string(),
                            position: 1,
                            display_tracking_id: "P2".to_string(),
                        },
                        UpsertSheetRowRequest {
                            row_id: "ui-row-3".to_string(),
                            position: 2,
                            display_tracking_id: "P3".to_string(),
                        },
                    ],
                },
            ))
            .await
            .expect("manual rows are seeded");

        let deleted = runtime
            .handle_command(WorkspaceEngineCommand::DeleteSheetRows(
                DeleteSheetRowsRequest {
                    sheet_id: "sheet-1".to_string(),
                    row_ids: vec!["ui-row-2".to_string()],
                },
            ))
            .await
            .expect("delete rows command succeeds");

        match deleted {
            WorkspaceEngineResponse::SheetRows(window) => {
                assert_eq!(window.total_count, 2);
                assert_eq!(window.rows[0].row_id, "ui-row-1");
                assert_eq!(window.rows[0].position, 0);
                assert_eq!(window.rows[1].row_id, "ui-row-3");
                assert_eq!(window.rows[1].position, 1);
            }
            response => panic!("unexpected response: {response:?}"),
        }

        let cleared = runtime
            .handle_command(WorkspaceEngineCommand::ClearSheetRows(
                ClearSheetRowsRequest {
                    sheet_id: "sheet-1".to_string(),
                },
            ))
            .await
            .expect("clear rows command succeeds");

        match cleared {
            WorkspaceEngineResponse::SheetRows(window) => {
                assert_eq!(window.total_count, 0);
                assert!(window.rows.is_empty());
            }
            response => panic!("unexpected response: {response:?}"),
        }
    }

    #[tokio::test]
    async fn runtime_streams_import_progress_events_from_committed_state() {
        let mut source = FakeImportSource::default();
        source.push_bag(
            "PID1",
            Ok(BagResponse {
                url: "https://example.test/bag/PID1".to_string(),
                nomor_kantung: Some("PID1".to_string()),
                items: vec![BagItem {
                    no_resi: Some("P2606020189412.30".to_string()),
                    ..BagItem::default()
                }],
            }),
        );
        let mut runtime = prepared_runtime(source);

        let created = runtime
            .handle_command(WorkspaceEngineCommand::CreateImportJob(
                CreateImportJobRequest {
                    sheet_id: "sheet-1".to_string(),
                    kind: ImportKind::Bag,
                    ids: vec!["PID1".to_string()],
                    mode: ImportMode::Append,
                },
            ))
            .await
            .expect("create command succeeds");
        let job_id = match created {
            WorkspaceEngineResponse::ImportJobDetail(detail) => detail.summary.job_id,
            response => panic!("unexpected response: {response:?}"),
        };

        let mut events = Vec::new();
        let detail = runtime
            .run_import_job_with_progress(&job_id, |event| events.push(event))
            .await
            .expect("run command streams progress");

        assert_eq!(detail.summary.status, ImportJobStatus::Completed);
        assert_eq!(events.len(), 2);
        assert!(matches!(
            events[0],
            WorkspaceEngineEvent::ImportJobProgress(_)
        ));
        let WorkspaceEngineEvent::ImportJobProgress(progress) = &events[1];
        assert_eq!(progress.success_count, 1);
        assert_eq!(progress.pending_count, 0);
        assert_eq!(
            progress.item_deltas[0].status,
            crate::imports::ImportJobItemStatus::Succeeded
        );
    }

    #[tokio::test]
    async fn runtime_create_import_job_ensures_unknown_sheet_exists() {
        let mut source = FakeImportSource::default();
        source.push_bag(
            "PID1",
            Ok(BagResponse {
                url: "https://example.test/bag/PID1".to_string(),
                nomor_kantung: Some("PID1".to_string()),
                items: vec![BagItem {
                    no_resi: Some("P2606020189412.30".to_string()),
                    ..BagItem::default()
                }],
            }),
        );
        let mut runtime = prepared_runtime(source);

        let created = runtime
            .handle_command(WorkspaceEngineCommand::CreateImportJob(
                CreateImportJobRequest {
                    sheet_id: "ui-sheet-2".to_string(),
                    kind: ImportKind::Bag,
                    ids: vec!["PID1".to_string()],
                    mode: ImportMode::Append,
                },
            ))
            .await
            .expect("create command ensures sheet");
        let job_id = match created {
            WorkspaceEngineResponse::ImportJobDetail(detail) => {
                assert_eq!(detail.summary.sheet_id, "ui-sheet-2");
                detail.summary.job_id
            }
            response => panic!("unexpected response: {response:?}"),
        };

        runtime
            .run_import_job_with_progress(&job_id, |_| {})
            .await
            .expect("job runs on ensured sheet");
        let rows = runtime
            .store()
            .query_sheet_rows(
                &SheetRowsQuery {
                    sheet_id: "ui-sheet-2".to_string(),
                    offset: 0,
                    limit: 10,
                    filters: vec![],
                    value_filters: vec![],
                    sort: vec![],
                },
                100,
            )
            .expect("ensured sheet rows are queryable");

        assert_eq!(rows.total_count, 1);
        assert_eq!(rows.rows[0].display_tracking_id, "P2606020189412.30");
    }

    #[tokio::test]
    async fn runtime_dispatches_cancel_command_without_running_job() {
        let source = FakeImportSource::default();
        let mut runtime = prepared_runtime(source);

        let created = runtime
            .handle_command(WorkspaceEngineCommand::CreateImportJob(
                CreateImportJobRequest {
                    sheet_id: "sheet-1".to_string(),
                    kind: ImportKind::Bag,
                    ids: vec!["PID1".to_string(), "PID2".to_string()],
                    mode: ImportMode::Append,
                },
            ))
            .await
            .expect("create command succeeds");
        let job_id = match created {
            WorkspaceEngineResponse::ImportJobDetail(detail) => detail.summary.job_id,
            response => panic!("unexpected response: {response:?}"),
        };

        let cancelled = runtime
            .handle_command(WorkspaceEngineCommand::CancelImportJob(JobIdRequest {
                job_id: job_id.clone(),
            }))
            .await
            .expect("cancel command succeeds");

        match cancelled {
            WorkspaceEngineResponse::ImportJobDetail(detail) => {
                assert_eq!(detail.summary.status, ImportJobStatus::Cancelled);
                assert_eq!(detail.summary.pending_count, 0);
            }
            response => panic!("unexpected response: {response:?}"),
        }
    }

    #[tokio::test]
    async fn runtime_dispatches_duckdb_pivot_commands() {
        let source = FakeImportSource::default();
        let mut runtime = prepared_runtime(source);
        runtime
            .store_mut()
            .upsert_sheet_row(&crate::storage::UpsertSheetRowInput {
                row_id: "row-1".to_string(),
                sheet_id: "sheet-1".to_string(),
                position: 0,
                display_tracking_id: "P2606020189412.30".to_string(),
                lookup_tracking_id: "P2606020189412".to_string(),
                row_status: crate::storage::SheetRowStatus::Loaded,
                error_message: None,
            })
            .expect("row is stored");

        let result = runtime
            .handle_command(WorkspaceEngineCommand::QueryPivot(
                crate::analytics::PivotQuery {
                    sheet_id: "sheet-1".to_string(),
                    source_scope: crate::analytics::AnalyticsSourceScope::AllRows,
                    filters: vec![],
                    value_filters: vec![],
                    selected_row_ids: vec![],
                    row_fields: vec!["detail.shipment_header.nomor_kiriman".to_string()],
                    column_fields: vec![],
                    values: vec![crate::analytics::AnalyticsValue {
                        field: "detail.shipment_header.nomor_kiriman".to_string(),
                        aggregation: crate::analytics::AnalyticsAggregation::CountUnique,
                    }],
                    sort: vec![crate::analytics::AnalyticsSort {
                        field: "count".to_string(),
                        direction: crate::analytics::AnalyticsSortDirection::Desc,
                    }],
                    limit: 10,
                },
            ))
            .await
            .expect("pivot command succeeds");

        match result {
            WorkspaceEngineResponse::Pivot(pivot) => {
                assert_eq!(pivot.source_row_count, 1);
                assert_eq!(pivot.rows[0]["rowValues"][0], "P2606020189412.30");
                assert_eq!(
                    pivot.rows[0]["metrics"]["detail.shipment_header.nomor_kiriman__count_unique"],
                    1
                );
            }
            response => panic!("unexpected response: {response:?}"),
        }
    }

    #[tokio::test]
    async fn runtime_dispatches_tracking_refresh_and_persists_detail() {
        let mut source = FakeImportSource::default();
        source.push_tracking("P2606020189412", Ok(track_response("P2606020189412")));
        let mut runtime = prepared_runtime(source);
        runtime
            .store_mut()
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

        let response = runtime
            .handle_command(WorkspaceEngineCommand::RefreshSheetRowTracking(
                RefreshSheetRowTrackingRequest {
                    row_id: "row-1".to_string(),
                    force_refresh: true,
                },
            ))
            .await
            .expect("tracking refresh command succeeds");

        match response {
            WorkspaceEngineResponse::SheetRow(row) => {
                assert_eq!(row.display_tracking_id, "P2606020189412.30");
                assert_eq!(row.lookup_tracking_id, "P2606020189412");
                assert_eq!(row.row_status, SheetRowStatus::Loaded);
                assert_eq!(row.status_json.as_ref().unwrap()["status"], "DELIVERED");
            }
            response => panic!("unexpected response: {response:?}"),
        }
    }

    #[tokio::test]
    async fn runtime_dispatches_tracking_refresh_failure_as_failed_row() {
        let mut source = FakeImportSource::default();
        source.push_tracking(
            "P2606020189412",
            Err(TrackingLookupFailure::new("tracking unavailable")),
        );
        let mut runtime = prepared_runtime(source);
        runtime
            .store_mut()
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

        let response = runtime
            .handle_command(WorkspaceEngineCommand::RefreshSheetRowTracking(
                RefreshSheetRowTrackingRequest {
                    row_id: "row-1".to_string(),
                    force_refresh: true,
                },
            ))
            .await
            .expect("tracking refresh command returns failed row");

        match response {
            WorkspaceEngineResponse::SheetRow(row) => {
                assert_eq!(row.display_tracking_id, "P2606020189412.30");
                assert_eq!(row.lookup_tracking_id, "P2606020189412");
                assert_eq!(row.row_status, SheetRowStatus::Failed);
                assert_eq!(row.error_message.as_deref(), Some("tracking unavailable"));
            }
            response => panic!("unexpected response: {response:?}"),
        }
    }

    #[tokio::test]
    async fn runtime_dispatches_batch_tracking_refresh_with_partial_failures() {
        let mut source = FakeImportSource::default();
        source.push_tracking("P2606020189412", Ok(track_response("P2606020189412")));
        source.push_tracking(
            "P2606020189413",
            Err(TrackingLookupFailure::new("tracking unavailable")),
        );
        let mut runtime = prepared_runtime(source);
        for (position, (row_id, display_id, lookup_id)) in [
            ("row-1", "P2606020189412.30", "P2606020189412"),
            ("row-2", "P2606020189413.31", "P2606020189413"),
        ]
        .into_iter()
        .enumerate()
        {
            runtime
                .store_mut()
                .upsert_sheet_row(&UpsertSheetRowInput {
                    row_id: row_id.to_string(),
                    sheet_id: "sheet-1".to_string(),
                    position: position as u32,
                    display_tracking_id: display_id.to_string(),
                    lookup_tracking_id: lookup_id.to_string(),
                    row_status: SheetRowStatus::Empty,
                    error_message: None,
                })
                .expect("row is stored");
        }

        let response = runtime
            .handle_command(WorkspaceEngineCommand::RefreshSheetRowsTracking(
                RefreshSheetRowsTrackingRequest {
                    sheet_id: "sheet-1".to_string(),
                    row_ids: vec![
                        "row-1".to_string(),
                        "row-2".to_string(),
                        "row-1".to_string(),
                    ],
                    force_refresh: true,
                },
            ))
            .await
            .expect("batch tracking refresh command succeeds");

        match response {
            WorkspaceEngineResponse::SheetRowsTrackingRefresh(result) => {
                assert_eq!(result.sheet_id, "sheet-1");
                assert_eq!(result.success_count, 1);
                assert_eq!(result.failed_count, 1);
                assert_eq!(result.rows.len(), 2);
                assert_eq!(result.rows[0].display_tracking_id, "P2606020189412.30");
                assert_eq!(result.rows[0].row_status, SheetRowStatus::Loaded);
                assert_eq!(
                    result.rows[0].status_json.as_ref().unwrap()["status"],
                    "DELIVERED"
                );
                assert_eq!(result.rows[1].display_tracking_id, "P2606020189413.31");
                assert_eq!(result.rows[1].row_status, SheetRowStatus::Failed);
                assert_eq!(
                    result.rows[1].error_message.as_deref(),
                    Some("tracking unavailable")
                );
            }
            response => panic!("unexpected response: {response:?}"),
        }
    }

    #[tokio::test]
    async fn persistent_bootstrap_keeps_rows_across_runtime_reopen() {
        let path = temp_db_path("persistent-reopen");

        {
            let mut source = FakeImportSource::default();
            source.push_bag(
                "PID1",
                Ok(BagResponse {
                    url: "https://example.test/bag/PID1".to_string(),
                    nomor_kantung: Some("PID1".to_string()),
                    items: vec![BagItem {
                        no_resi: Some("P2606020189412.30".to_string()),
                        ..BagItem::default()
                    }],
                }),
            );
            let bootstrap = WorkspaceEngineRuntime::open_persistent(
                WorkspaceEngineConfig::default(),
                bootstrap_config(&path),
                source,
            )
            .expect("runtime opens persistent store");
            assert_eq!(bootstrap.state.workspace.workspace_id, "workspace-1");
            assert_eq!(bootstrap.state.initial_sheet.sheet_id, "sheet-1");
            assert!(bootstrap.state.recovery.recovered_job_ids.is_empty());

            let mut runtime = bootstrap.runtime;
            let job_id = create_import_job(&mut runtime, vec!["PID1".to_string()]).await;
            let response = runtime
                .handle_command(WorkspaceEngineCommand::RunImportJob(JobIdRequest {
                    job_id,
                }))
                .await
                .expect("job runs");
            let detail = match response {
                WorkspaceEngineResponse::ImportJobDetail(detail) => detail,
                response => panic!("unexpected response: {response:?}"),
            };
            let attempts = runtime
                .store()
                .list_import_attempts_for_item(&detail.items[0].item_id)
                .expect("attempts load");
            let raw_blob_id = attempts[0]
                .raw_blob_id
                .as_deref()
                .expect("import attempt stores raw blob id");
            assert_blob_file_exists(&path, runtime.store(), raw_blob_id);
        }

        {
            let source = FakeImportSource::default();
            let bootstrap = WorkspaceEngineRuntime::open_persistent(
                WorkspaceEngineConfig::default(),
                bootstrap_config(&path),
                source,
            )
            .expect("runtime reopens persistent store");
            let mut runtime = bootstrap.runtime;
            let rows = query_all_rows(&mut runtime).await;

            assert_eq!(rows.total_count, 1);
            assert_eq!(rows.rows[0].display_tracking_id, "P2606020189412.30");
            assert_eq!(rows.rows[0].lookup_tracking_id, "P2606020189412");
        }

        cleanup_temp_db(&path);
    }

    #[tokio::test]
    async fn persistent_tracking_refresh_writes_raw_response_blob() {
        let path = temp_db_path("persistent-tracking-blob");
        let mut source = FakeImportSource::default();
        source.push_tracking("P2606020189412", Ok(track_response("P2606020189412")));
        let bootstrap = WorkspaceEngineRuntime::open_persistent(
            WorkspaceEngineConfig::default(),
            bootstrap_config(&path),
            source,
        )
        .expect("runtime opens persistent store");
        let mut runtime = bootstrap.runtime;
        runtime
            .store_mut()
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

        runtime
            .handle_command(WorkspaceEngineCommand::RefreshSheetRowTracking(
                RefreshSheetRowTrackingRequest {
                    row_id: "row-1".to_string(),
                    force_refresh: true,
                },
            ))
            .await
            .expect("tracking refresh succeeds");

        let raw_blob_id = runtime
            .store()
            .get_tracking_record_raw_blob_id("tracking:P2606020189412")
            .expect("tracking record raw blob loads")
            .expect("tracking record stores raw blob id");
        assert_blob_file_exists(&path, runtime.store(), &raw_blob_id);

        cleanup_temp_db(&path);
    }

    #[tokio::test]
    async fn persistent_bootstrap_recovers_interrupted_import_job() {
        let path = temp_db_path("persistent-recovery");
        let job_id;
        let resumed_item_id;
        let mut source_ids = vec!["PID_DONE".to_string(), "PID_RESUME".to_string()];
        source_ids.extend((0..498).map(|index| format!("PID_PENDING_{index:03}")));

        {
            let source = FakeImportSource::default();
            let bootstrap = WorkspaceEngineRuntime::open_persistent(
                WorkspaceEngineConfig::default(),
                bootstrap_config(&path),
                source,
            )
            .expect("runtime opens persistent store");
            let mut runtime = bootstrap.runtime;
            job_id = create_import_job(&mut runtime, source_ids.clone()).await;
            let detail = runtime
                .store()
                .get_import_job(&job_id)
                .expect("job loads")
                .expect("job exists");
            let completed_item_id = detail
                .items
                .iter()
                .find(|item| item.source_item_id == "PID_DONE")
                .expect("completed item exists")
                .item_id
                .clone();
            resumed_item_id = detail
                .items
                .iter()
                .find(|item| item.source_item_id == "PID_RESUME")
                .expect("resumed item exists")
                .item_id
                .clone();

            runtime
                .store_mut()
                .claim_next_pending_import_job_item(&job_id)
                .expect("completed item can be claimed")
                .expect("completed item exists");
            runtime
                .store_mut()
                .start_import_attempt(&StartImportAttemptInput {
                    attempt_id: "attempt-completed-1".to_string(),
                    item_id: completed_item_id,
                    raw_blob_id: None,
                })
                .expect("completed attempt starts");
            runtime
                .store_mut()
                .upsert_sheet_row(&UpsertSheetRowInput {
                    row_id: "sheet-1:row:0".to_string(),
                    sheet_id: "sheet-1".to_string(),
                    position: 0,
                    display_tracking_id: "P2606020189412.30".to_string(),
                    lookup_tracking_id: "P2606020189412".to_string(),
                    row_status: SheetRowStatus::Loaded,
                    error_message: None,
                })
                .expect("committed row is stored before crash");
            runtime
                .store_mut()
                .finish_import_attempt(&FinishImportAttemptInput {
                    attempt_id: "attempt-completed-1".to_string(),
                    status: ImportAttemptStatus::Succeeded,
                    tracking_ids: vec!["P2606020189412.30".to_string()],
                    error_message: None,
                    raw_blob_id: None,
                })
                .expect("completed attempt finishes");

            runtime
                .store_mut()
                .claim_next_pending_import_job_item(&job_id)
                .expect("resumed item can be claimed")
                .expect("resumed item exists");
            runtime
                .store_mut()
                .start_import_attempt(&StartImportAttemptInput {
                    attempt_id: "attempt-interrupted-1".to_string(),
                    item_id: resumed_item_id.clone(),
                    raw_blob_id: None,
                })
                .expect("interrupted attempt starts");
        }

        {
            let mut source = FakeImportSource::default();
            let resumed_tracking_id = "P2606020189412.31";
            source.push_bag(
                "PID_RESUME",
                Ok(BagResponse {
                    url: "https://example.test/bag/PID_RESUME".to_string(),
                    nomor_kantung: Some("PID_RESUME".to_string()),
                    items: vec![BagItem {
                        no_resi: Some(resumed_tracking_id.to_string()),
                        ..BagItem::default()
                    }],
                }),
            );
            for index in 0..498 {
                let source_id = format!("PID_PENDING_{index:03}");
                let tracking_id = format!("P{:013}.{}", 2_606_020_190_000_u64 + index, index % 100);
                source.push_bag(
                    &source_id,
                    Ok(BagResponse {
                        url: format!("https://example.test/bag/{source_id}"),
                        nomor_kantung: Some(source_id.clone()),
                        items: vec![BagItem {
                            no_resi: Some(tracking_id),
                            ..BagItem::default()
                        }],
                    }),
                );
            }
            let bootstrap = WorkspaceEngineRuntime::open_persistent(
                WorkspaceEngineConfig::default(),
                bootstrap_config(&path),
                source,
            )
            .expect("runtime recovers persistent store");
            assert_eq!(
                bootstrap.state.recovery.recovered_job_ids,
                vec![job_id.clone()]
            );
            assert_eq!(
                bootstrap.state.recovery.interrupted_attempt_ids,
                vec!["attempt-interrupted-1"]
            );
            assert_eq!(
                bootstrap.state.recovery.recovered_item_ids,
                vec![resumed_item_id.clone()]
            );

            let mut runtime = bootstrap.runtime;
            let run = runtime
                .handle_command(WorkspaceEngineCommand::RunImportJob(JobIdRequest {
                    job_id: job_id.clone(),
                }))
                .await
                .expect("recovered job runs");
            match run {
                WorkspaceEngineResponse::ImportJobDetail(detail) => {
                    assert_eq!(detail.summary.status, ImportJobStatus::Completed);
                    assert_eq!(detail.summary.total_count, 500);
                    assert_eq!(detail.summary.success_count, 500);
                    assert_eq!(detail.summary.failed_count, 0);
                }
                response => panic!("unexpected response: {response:?}"),
            }

            let rows = query_all_rows(&mut runtime).await;
            assert_eq!(rows.total_count, 500);
            assert_eq!(rows.rows[0].display_tracking_id, "P2606020189412.30");
            assert_eq!(rows.rows[1].display_tracking_id, resumed_tracking_id);

            let attempts = runtime
                .store()
                .list_import_attempts_for_item(&resumed_item_id)
                .expect("resumed item attempts load");
            assert_eq!(attempts.len(), 2);
            assert_eq!(attempts[0].status, ImportAttemptStatus::Interrupted);
            assert_eq!(attempts[1].status, ImportAttemptStatus::Succeeded);
        }

        cleanup_temp_db(&path);
    }

    #[derive(Default)]
    struct FakeImportSource {
        bags: HashMap<String, VecDeque<Result<BagResponse, ImportLookupFailure>>>,
        manifests: HashMap<String, VecDeque<Result<ManifestResponse, ImportLookupFailure>>>,
        tracks: HashMap<String, VecDeque<Result<TrackResponse, TrackingLookupFailure>>>,
    }

    impl FakeImportSource {
        fn push_bag(&mut self, id: &str, response: Result<BagResponse, ImportLookupFailure>) {
            self.bags
                .entry(id.to_string())
                .or_default()
                .push_back(response);
        }

        fn push_manifest(
            &mut self,
            id: &str,
            response: Result<ManifestResponse, ImportLookupFailure>,
        ) {
            self.manifests
                .entry(id.to_string())
                .or_default()
                .push_back(response);
        }

        fn push_tracking(
            &mut self,
            id: &str,
            response: Result<TrackResponse, TrackingLookupFailure>,
        ) {
            self.tracks
                .entry(id.to_string())
                .or_default()
                .push_back(response);
        }
    }

    impl ImportLookupSource for FakeImportSource {
        fn fetch_bag<'a>(
            &'a mut self,
            bag_id: &'a str,
        ) -> impl Future<Output = Result<BagResponse, ImportLookupFailure>> + 'a {
            async move {
                self.bags
                    .get_mut(bag_id)
                    .and_then(VecDeque::pop_front)
                    .unwrap_or_else(|| {
                        Err(ImportLookupFailure::new(format!("missing bag {bag_id}")))
                    })
            }
        }

        fn fetch_manifest<'a>(
            &'a mut self,
            manifest_id: &'a str,
        ) -> impl Future<Output = Result<ManifestResponse, ImportLookupFailure>> + 'a {
            async move {
                self.manifests
                    .get_mut(manifest_id)
                    .and_then(VecDeque::pop_front)
                    .unwrap_or_else(|| {
                        Err(ImportLookupFailure::new(format!(
                            "missing manifest {manifest_id}"
                        )))
                    })
            }
        }
    }

    impl TrackingLookupSource for FakeImportSource {
        fn fetch_tracking<'a>(
            &'a mut self,
            lookup_tracking_id: &'a str,
        ) -> impl Future<Output = Result<TrackResponse, TrackingLookupFailure>> + 'a {
            async move {
                self.tracks
                    .get_mut(lookup_tracking_id)
                    .and_then(VecDeque::pop_front)
                    .unwrap_or_else(|| {
                        Err(TrackingLookupFailure::new(format!(
                            "missing track {lookup_tracking_id}"
                        )))
                    })
            }
        }
    }

    fn prepared_runtime(source: FakeImportSource) -> WorkspaceEngineRuntime<FakeImportSource> {
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

        WorkspaceEngineRuntime::new(WorkspaceEngineConfig::default(), store, source)
    }

    async fn create_import_job(
        runtime: &mut WorkspaceEngineRuntime<FakeImportSource>,
        ids: Vec<String>,
    ) -> String {
        let created = runtime
            .handle_command(WorkspaceEngineCommand::CreateImportJob(
                CreateImportJobRequest {
                    sheet_id: "sheet-1".to_string(),
                    kind: ImportKind::Bag,
                    ids,
                    mode: ImportMode::Append,
                },
            ))
            .await
            .expect("create command succeeds");

        match created {
            WorkspaceEngineResponse::ImportJobDetail(detail) => detail.summary.job_id,
            response => panic!("unexpected response: {response:?}"),
        }
    }

    async fn query_all_rows(
        runtime: &mut WorkspaceEngineRuntime<FakeImportSource>,
    ) -> crate::storage::SheetRowWindow {
        let rows = runtime
            .handle_command(WorkspaceEngineCommand::QuerySheetRows(
                QuerySheetRowsRequest {
                    query: SheetRowsQuery {
                        sheet_id: "sheet-1".to_string(),
                        offset: 0,
                        limit: 10,
                        filters: vec![],
                        value_filters: vec![],
                        sort: vec![],
                    },
                },
            ))
            .await
            .expect("query rows command succeeds");

        match rows {
            WorkspaceEngineResponse::SheetRows(window) => window,
            response => panic!("unexpected response: {response:?}"),
        }
    }

    fn manifest_response(bag_ids: &[&str]) -> ManifestResponse {
        ManifestResponse {
            url: "https://example.test/manifest".to_string(),
            total_berat: None,
            items: bag_ids
                .iter()
                .map(|bag_id| ManifestItem {
                    nomor_kantung: Some((*bag_id).to_string()),
                    ..ManifestItem::default()
                })
                .collect(),
        }
    }

    fn track_response(tracking_id: &str) -> TrackResponse {
        TrackResponse {
            url: format!("https://example.test/track/{tracking_id}"),
            detail: TrackDetail {
                header: shipflow_core::model::ShipmentHeader {
                    nomor_kiriman: Some(tracking_id.to_string()),
                    ..Default::default()
                },
                ..Default::default()
            },
            status_akhir: TrackStatusAkhir {
                status: Some("DELIVERED".to_string()),
                ..Default::default()
            },
            pod: Default::default(),
            history: vec![],
            history_summary: Default::default(),
        }
    }

    fn bootstrap_config(path: &PathBuf) -> WorkspaceEngineBootstrapConfig {
        WorkspaceEngineBootstrapConfig::new(
            path.clone(),
            "workspace-1",
            "Main workspace",
            "sheet-1",
            "Sheet 1",
        )
    }

    fn temp_db_path(name: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "shipflow-workspace-engine-{name}-{}-{}",
            std::process::id(),
            OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        path.push("workspace.db");
        path
    }

    fn cleanup_temp_db(path: &PathBuf) {
        if let Some(parent) = path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }

    fn assert_blob_file_exists(
        database_path: &PathBuf,
        store: &SqliteWorkspaceStore,
        raw_blob_id: &str,
    ) {
        let blob = store
            .get_raw_blob(raw_blob_id)
            .expect("raw blob loads")
            .expect("raw blob record exists");
        let root = database_path.parent().expect("database has parent");
        let address = crate::blob_store::BlobAddress {
            id: blob.blob_id,
            sha256: blob.sha256,
            media_type: blob.media_type,
            byte_len: blob.byte_len,
            relative_path: blob.storage_path,
        };
        let path = absolute_blob_path(root, &address);

        assert!(path.exists(), "missing raw blob file {}", path.display());
    }
}
