use std::collections::HashSet;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::future::Future;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use shipflow_core::model::{BagResponse, ManifestResponse, TrackingError};

use crate::blob_store::{write_blob, BlobStoreError};
use crate::events::{ImportJobItemDelta, ImportJobProgressEvent};
use crate::imports::{
    ImportJobDetail, ImportJobItem, ImportJobItemStatus, ImportKind, ImportMode,
    ImportSourceItemKind, ImportSourcePreviewItem, ImportSourcePreviewResult,
};
use crate::jobs::ImportAttemptStatus;
use crate::storage::{
    CreateImportJobInput, CreateImportJobItemInput, FinishImportAttemptInput, SheetRowStatus,
    SqliteWorkspaceStore, StartImportAttemptInput, UpsertRawBlobInput, UpsertSheetRowInput,
    WorkspaceStoreError,
};
use crate::tracking::resolve_tracking_id;

pub trait ImportLookupSource {
    fn fetch_bag<'a>(
        &'a mut self,
        bag_id: &'a str,
    ) -> impl Future<Output = Result<BagResponse, ImportLookupFailure>> + 'a;

    fn fetch_manifest<'a>(
        &'a mut self,
        manifest_id: &'a str,
    ) -> impl Future<Output = Result<ManifestResponse, ImportLookupFailure>> + 'a;
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportLookupFailure {
    pub message: String,
}

impl ImportLookupFailure {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl Display for ImportLookupFailure {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for ImportLookupFailure {}

impl From<TrackingError> for ImportLookupFailure {
    fn from(error: TrackingError) -> Self {
        Self {
            message: tracking_error_message(error),
        }
    }
}

#[derive(Debug)]
pub enum ImportEngineError {
    Store(WorkspaceStoreError),
    MissingJob(String),
    Json(serde_json::Error),
    Blob(BlobStoreError),
}

impl Display for ImportEngineError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(error) => write!(formatter, "{error}"),
            Self::MissingJob(job_id) => write!(formatter, "missing import job: {job_id}"),
            Self::Json(error) => write!(formatter, "json error: {error}"),
            Self::Blob(error) => write!(formatter, "{error}"),
        }
    }
}

impl Error for ImportEngineError {}

impl From<WorkspaceStoreError> for ImportEngineError {
    fn from(error: WorkspaceStoreError) -> Self {
        Self::Store(error)
    }
}

impl From<serde_json::Error> for ImportEngineError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

impl From<BlobStoreError> for ImportEngineError {
    fn from(error: BlobStoreError) -> Self {
        Self::Blob(error)
    }
}

pub type ImportEngineResult<T> = Result<T, ImportEngineError>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateImportJobPlan {
    pub job_id: String,
    pub sheet_id: String,
    pub kind: ImportKind,
    pub ids: Vec<String>,
    pub mode: ImportMode,
}

pub struct ImportEngine<'store, 'source, Source>
where
    Source: ImportLookupSource,
{
    store: &'store mut SqliteWorkspaceStore,
    source: &'source mut Source,
    blob_root_path: Option<PathBuf>,
}

impl<'store, 'source, Source> ImportEngine<'store, 'source, Source>
where
    Source: ImportLookupSource,
{
    pub fn new(store: &'store mut SqliteWorkspaceStore, source: &'source mut Source) -> Self {
        Self {
            store,
            source,
            blob_root_path: None,
        }
    }

    pub fn with_blob_root_path(
        store: &'store mut SqliteWorkspaceStore,
        source: &'source mut Source,
        blob_root_path: Option<PathBuf>,
    ) -> Self {
        Self {
            store,
            source,
            blob_root_path,
        }
    }

    pub fn create_job(
        &mut self,
        plan: &CreateImportJobPlan,
    ) -> ImportEngineResult<ImportJobDetail> {
        let source_ids = dedupe_non_empty(plan.ids.iter().map(String::as_str));
        if plan.mode == ImportMode::Replace {
            self.store.clear_sheet_rows(&plan.sheet_id)?;
        }

        self.store.create_import_job(&CreateImportJobInput {
            job_id: plan.job_id.clone(),
            sheet_id: plan.sheet_id.clone(),
            kind: plan.kind,
            mode: plan.mode,
            total_count: source_ids.len() as u32,
        })?;

        for (position, source_id) in source_ids.iter().enumerate() {
            self.store
                .create_import_job_item(&CreateImportJobItemInput {
                    item_id: format!("{}:source:{position}", plan.job_id),
                    job_id: plan.job_id.clone(),
                    source_item_id: source_id.clone(),
                    source_item_kind: match plan.kind {
                        ImportKind::Bag => ImportSourceItemKind::Bag,
                        ImportKind::Manifest => ImportSourceItemKind::Manifest,
                    },
                    position: position as u32,
                })?;
        }

        self.store
            .get_import_job(&plan.job_id)?
            .ok_or_else(|| ImportEngineError::MissingJob(plan.job_id.clone()))
    }

    pub async fn run_job(&mut self, job_id: &str) -> ImportEngineResult<ImportJobDetail> {
        self.run_job_with_progress(job_id, |_| {}).await
    }

    pub async fn run_job_with_progress<F>(
        &mut self,
        job_id: &str,
        mut on_progress: F,
    ) -> ImportEngineResult<ImportJobDetail>
    where
        F: FnMut(ImportJobProgressEvent),
    {
        let sheet_id = self
            .store
            .get_import_job(job_id)?
            .ok_or_else(|| ImportEngineError::MissingJob(job_id.to_string()))?
            .summary
            .sheet_id;

        let initial_detail = self
            .store
            .get_import_job(job_id)?
            .ok_or_else(|| ImportEngineError::MissingJob(job_id.to_string()))?;
        on_progress(ImportJobProgressEvent::from_job_detail(
            &initial_detail,
            vec![],
        ));

        while let Some(item) = self.store.claim_next_pending_import_job_item(job_id)? {
            let item_id = item.item_id.clone();
            self.run_job_item(job_id, &sheet_id, &item).await?;
            let detail = self
                .store
                .get_import_job(job_id)?
                .ok_or_else(|| ImportEngineError::MissingJob(job_id.to_string()))?;
            let delta = detail
                .items
                .iter()
                .find(|candidate| candidate.item_id == item_id)
                .map(ImportJobItemDelta::from)
                .into_iter()
                .collect::<Vec<_>>();
            on_progress(ImportJobProgressEvent::from_job_detail(&detail, delta));
        }

        self.store
            .get_import_job(job_id)?
            .ok_or_else(|| ImportEngineError::MissingJob(job_id.to_string()))
    }

    pub async fn retry_failed_and_run(
        &mut self,
        job_id: &str,
    ) -> ImportEngineResult<ImportJobDetail> {
        self.retry_failed_and_run_with_progress(job_id, |_| {})
            .await
    }

    pub async fn retry_failed_and_run_with_progress<F>(
        &mut self,
        job_id: &str,
        on_progress: F,
    ) -> ImportEngineResult<ImportJobDetail>
    where
        F: FnMut(ImportJobProgressEvent),
    {
        self.store.retry_import_job_failed(job_id)?;
        self.run_job_with_progress(job_id, on_progress).await
    }

    pub async fn preview_import_source(
        &mut self,
        kind: ImportKind,
        ids: &[String],
    ) -> ImportSourcePreviewResult {
        let source_ids = dedupe_non_empty(ids.iter().map(String::as_str));

        match kind {
            ImportKind::Bag => self.preview_bag_sources(&source_ids).await,
            ImportKind::Manifest => self.preview_manifest_sources(&source_ids).await,
        }
    }

    async fn preview_bag_sources(&mut self, bag_ids: &[String]) -> ImportSourcePreviewResult {
        let mut source_items = Vec::new();
        let mut responses = Vec::new();
        let mut tracking_ids = Vec::new();

        for bag_id in bag_ids {
            match self.source.fetch_bag(bag_id).await {
                Ok(response) => {
                    let bag_tracking_ids = extract_bag_tracking_ids(&response);
                    extend_unique(&mut tracking_ids, &bag_tracking_ids);
                    source_items.push(preview_item(
                        bag_id,
                        ImportSourceItemKind::Bag,
                        ImportJobItemStatus::Succeeded,
                        bag_tracking_ids,
                        None,
                    ));
                    responses.push(response);
                }
                Err(error) => {
                    source_items.push(preview_item(
                        bag_id,
                        ImportSourceItemKind::Bag,
                        ImportJobItemStatus::Failed,
                        Vec::new(),
                        Some(error.message),
                    ));
                }
            }
        }

        ImportSourcePreviewResult {
            kind: ImportKind::Bag,
            source_items,
            manifest_bags: Vec::new(),
            tracking_ids,
            raw_response: stringify_responses(&responses),
        }
    }

    async fn preview_manifest_sources(
        &mut self,
        manifest_ids: &[String],
    ) -> ImportSourcePreviewResult {
        let mut source_items = Vec::new();
        let mut manifest_responses = Vec::new();
        let mut manifest_bag_ids = Vec::new();

        for manifest_id in manifest_ids {
            match self.source.fetch_manifest(manifest_id).await {
                Ok(response) => {
                    let bag_ids = extract_manifest_bag_ids(&response);
                    extend_unique(&mut manifest_bag_ids, &bag_ids);
                    source_items.push(preview_item(
                        manifest_id,
                        ImportSourceItemKind::Manifest,
                        ImportJobItemStatus::Succeeded,
                        bag_ids,
                        None,
                    ));
                    manifest_responses.push(response);
                }
                Err(error) => {
                    source_items.push(preview_item(
                        manifest_id,
                        ImportSourceItemKind::Manifest,
                        ImportJobItemStatus::Failed,
                        Vec::new(),
                        Some(error.message),
                    ));
                }
            }
        }

        let mut manifest_bags = Vec::new();
        let mut tracking_ids = Vec::new();
        for bag_id in &manifest_bag_ids {
            match self.source.fetch_bag(bag_id).await {
                Ok(response) => {
                    let bag_tracking_ids = extract_bag_tracking_ids(&response);
                    extend_unique(&mut tracking_ids, &bag_tracking_ids);
                    manifest_bags.push(preview_item(
                        bag_id,
                        ImportSourceItemKind::ManifestBag,
                        ImportJobItemStatus::Succeeded,
                        bag_tracking_ids,
                        None,
                    ));
                }
                Err(error) => {
                    manifest_bags.push(preview_item(
                        bag_id,
                        ImportSourceItemKind::ManifestBag,
                        ImportJobItemStatus::Failed,
                        Vec::new(),
                        Some(error.message),
                    ));
                }
            }
        }

        ImportSourcePreviewResult {
            kind: ImportKind::Manifest,
            source_items,
            manifest_bags,
            tracking_ids,
            raw_response: stringify_responses(&manifest_responses),
        }
    }

    async fn run_job_item(
        &mut self,
        job_id: &str,
        sheet_id: &str,
        item: &ImportJobItem,
    ) -> ImportEngineResult<()> {
        let attempt_id = format!("{}:attempt:{}", item.item_id, item.attempt_count + 1);
        self.store.start_import_attempt(&StartImportAttemptInput {
            attempt_id: attempt_id.clone(),
            item_id: item.item_id.clone(),
            raw_blob_id: None,
        })?;

        match item.source_item_kind {
            ImportSourceItemKind::Manifest => {
                self.run_manifest_item(job_id, item, &attempt_id).await?;
            }
            ImportSourceItemKind::Bag | ImportSourceItemKind::ManifestBag => {
                self.run_bag_item(sheet_id, item, &attempt_id).await?;
            }
        }

        Ok(())
    }

    async fn run_manifest_item(
        &mut self,
        job_id: &str,
        item: &ImportJobItem,
        attempt_id: &str,
    ) -> ImportEngineResult<()> {
        let response = self.source.fetch_manifest(&item.source_item_id).await;
        match response {
            Ok(response) => {
                let bag_ids = dedupe_non_empty(
                    response
                        .items
                        .iter()
                        .filter_map(|manifest_item| manifest_item.nomor_kantung.as_deref()),
                );
                let raw_blob_id = self.store_raw_response_blob(&response)?;

                for bag_id in &bag_ids {
                    let position = self.store.next_import_job_item_position(job_id)?;
                    self.store
                        .create_import_job_item(&CreateImportJobItemInput {
                            item_id: format!("{job_id}:manifest-bag:{position}"),
                            job_id: job_id.to_string(),
                            source_item_id: bag_id.clone(),
                            source_item_kind: ImportSourceItemKind::ManifestBag,
                            position,
                        })?;
                }

                self.store
                    .finish_import_attempt(&FinishImportAttemptInput {
                        attempt_id: attempt_id.to_string(),
                        status: ImportAttemptStatus::Succeeded,
                        tracking_ids: bag_ids,
                        error_message: None,
                        raw_blob_id,
                    })?;
            }
            Err(error) => {
                self.store
                    .finish_import_attempt(&FinishImportAttemptInput {
                        attempt_id: attempt_id.to_string(),
                        status: ImportAttemptStatus::Failed,
                        tracking_ids: Vec::new(),
                        error_message: Some(error.message),
                        raw_blob_id: None,
                    })?;
            }
        }

        Ok(())
    }

    async fn run_bag_item(
        &mut self,
        sheet_id: &str,
        item: &ImportJobItem,
        attempt_id: &str,
    ) -> ImportEngineResult<()> {
        let response = self.source.fetch_bag(&item.source_item_id).await;
        match response {
            Ok(response) => {
                let shipment_ids = dedupe_non_empty(
                    response
                        .items
                        .iter()
                        .filter_map(|bag_item| bag_item.no_resi.as_deref()),
                );
                let raw_blob_id = self.store_raw_response_blob(&response)?;
                let sheet_row_ids = self.append_unique_sheet_rows(sheet_id, &shipment_ids)?;

                self.store
                    .finish_import_attempt(&FinishImportAttemptInput {
                        attempt_id: attempt_id.to_string(),
                        status: ImportAttemptStatus::Succeeded,
                        tracking_ids: shipment_ids,
                        error_message: None,
                        raw_blob_id,
                    })?;
                self.store
                    .update_import_job_item_sheet_row_ids(&item.item_id, &sheet_row_ids)?;
            }
            Err(error) => {
                self.store
                    .finish_import_attempt(&FinishImportAttemptInput {
                        attempt_id: attempt_id.to_string(),
                        status: ImportAttemptStatus::Failed,
                        tracking_ids: Vec::new(),
                        error_message: Some(error.message),
                        raw_blob_id: None,
                    })?;
            }
        }

        Ok(())
    }

    fn store_raw_response_blob<T: Serialize>(
        &mut self,
        response: &T,
    ) -> ImportEngineResult<Option<String>> {
        let Some(root) = self.blob_root_path.as_deref() else {
            return Ok(None);
        };

        let bytes = serde_json::to_vec(response)?;
        let address = write_blob(root, &bytes, "application/json")?;
        self.store.upsert_raw_blob(&UpsertRawBlobInput {
            blob_id: address.id.clone(),
            sha256: address.sha256,
            media_type: address.media_type,
            byte_len: address.byte_len,
            storage_path: address.relative_path,
        })?;

        Ok(Some(address.id))
    }

    fn append_unique_sheet_rows(
        &mut self,
        sheet_id: &str,
        display_tracking_ids: &[String],
    ) -> ImportEngineResult<Vec<String>> {
        let mut position = self.store.next_sheet_row_position(sheet_id)?;
        let mut sheet_row_ids = Vec::new();

        for display_tracking_id in display_tracking_ids {
            if let Some(existing_row_id) = self
                .store
                .sheet_row_id_for_display_tracking_id(sheet_id, display_tracking_id)?
            {
                sheet_row_ids.push(existing_row_id);
                continue;
            }

            let resolved = resolve_tracking_id(display_tracking_id);
            let row_id = format!("{sheet_id}:row:{position}");
            self.store.upsert_sheet_row(&UpsertSheetRowInput {
                row_id: row_id.clone(),
                sheet_id: sheet_id.to_string(),
                position,
                display_tracking_id: resolved.display_id,
                lookup_tracking_id: resolved.lookup_id,
                row_status: SheetRowStatus::Loaded,
                error_message: None,
            })?;
            sheet_row_ids.push(row_id);
            position += 1;
        }

        Ok(sheet_row_ids)
    }
}

fn tracking_error_message(error: TrackingError) -> String {
    match error {
        TrackingError::BadRequest(message) => format!("bad request: {message}"),
        TrackingError::NotFound(message) => format!("not found: {message}"),
        TrackingError::Upstream(message) => format!("upstream: {message}"),
    }
}

fn dedupe_non_empty<'a>(values: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();

    for value in values {
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        if seen.insert(value.to_string()) {
            result.push(value.to_string());
        }
    }

    result
}

fn extract_bag_tracking_ids(response: &BagResponse) -> Vec<String> {
    dedupe_non_empty(
        response
            .items
            .iter()
            .filter_map(|bag_item| bag_item.no_resi.as_deref()),
    )
}

fn extract_manifest_bag_ids(response: &ManifestResponse) -> Vec<String> {
    dedupe_non_empty(
        response
            .items
            .iter()
            .filter_map(|manifest_item| manifest_item.nomor_kantung.as_deref()),
    )
}

fn preview_item(
    source_item_id: &str,
    source_item_kind: ImportSourceItemKind,
    status: ImportJobItemStatus,
    tracking_ids: Vec<String>,
    error_message: Option<String>,
) -> ImportSourcePreviewItem {
    ImportSourcePreviewItem {
        source_item_id: source_item_id.to_string(),
        source_item_kind,
        status,
        tracking_ids,
        error_message,
    }
}

fn extend_unique(target: &mut Vec<String>, values: &[String]) {
    let mut seen = target.iter().cloned().collect::<HashSet<_>>();
    for value in values {
        if seen.insert(value.clone()) {
            target.push(value.clone());
        }
    }
}

fn stringify_responses<T>(responses: &[T]) -> String
where
    T: Serialize,
{
    if responses.len() == 1 {
        return serde_json::to_string(&responses[0]).unwrap_or_else(|_| "null".to_string());
    }

    serde_json::to_string(responses).unwrap_or_else(|_| "[]".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, VecDeque};
    use std::time::{Duration, Instant};

    use shipflow_core::model::{BagItem, ManifestItem};

    use crate::imports::ImportJobItemStatus;
    use crate::storage::{
        CreateSheetInput, CreateWorkspaceInput, SheetRowsQuery, SqliteWorkspaceStore,
    };

    #[tokio::test]
    async fn bag_import_preserves_dotted_ids_and_dedupes_sheet_rows() {
        let mut store = prepared_store();
        let mut source = FakeImportSource::default();
        source.push_bag(
            "PID1",
            Ok(bag_response(&[
                "P2606020189412.30",
                "P2606020189412.30",
                "P2606020189412.31",
            ])),
        );

        {
            let mut engine = ImportEngine::new(&mut store, &mut source);
            engine
                .create_job(&CreateImportJobPlan {
                    job_id: "job-1".to_string(),
                    sheet_id: "sheet-1".to_string(),
                    kind: ImportKind::Bag,
                    ids: vec!["PID1".to_string()],
                    mode: ImportMode::Append,
                })
                .expect("job is created");
            let detail = engine.run_job("job-1").await.expect("job runs");

            assert_eq!(detail.summary.success_count, 1);
            assert_eq!(detail.summary.failed_count, 0);
            assert_eq!(detail.items[0].tracking_ids.len(), 2);
            assert_eq!(
                detail.items[0].sheet_row_ids,
                vec!["sheet-1:row:0", "sheet-1:row:1"]
            );
        }

        let rows = store
            .query_sheet_rows(
                &SheetRowsQuery {
                    sheet_id: "sheet-1".to_string(),
                    offset: 0,
                    limit: 20,
                    filters: vec![],
                    value_filters: vec![],
                    sort: vec![],
                },
                250,
            )
            .expect("rows load");

        assert_eq!(rows.total_count, 2);
        assert_eq!(rows.rows[0].display_tracking_id, "P2606020189412.30");
        assert_eq!(rows.rows[0].lookup_tracking_id, "P2606020189412");
        assert_eq!(rows.rows[1].display_tracking_id, "P2606020189412.31");
        assert_eq!(rows.rows[1].lookup_tracking_id, "P2606020189412");
    }

    #[tokio::test]
    async fn bag_import_handles_10k_rows_performance_smoke() {
        let started = Instant::now();
        let mut store = prepared_store();
        let mut source = FakeImportSource::default();
        let tracking_ids = (0..10_000)
            .map(|index| format!("P{index:013}.{}", index % 100))
            .collect::<Vec<_>>();
        source.push_bag(
            "PID_10K",
            Ok(BagResponse {
                url: "https://example.test/bag/PID_10K".to_string(),
                nomor_kantung: Some("PID_10K".to_string()),
                items: tracking_ids
                    .iter()
                    .map(|tracking_id| BagItem {
                        no_resi: Some(tracking_id.clone()),
                        ..BagItem::default()
                    })
                    .collect(),
            }),
        );

        {
            let mut engine = ImportEngine::new(&mut store, &mut source);
            engine
                .create_job(&CreateImportJobPlan {
                    job_id: "job-10k".to_string(),
                    sheet_id: "sheet-1".to_string(),
                    kind: ImportKind::Bag,
                    ids: vec!["PID_10K".to_string()],
                    mode: ImportMode::Replace,
                })
                .expect("job is created");
            let detail = engine.run_job("job-10k").await.expect("job runs");

            assert_eq!(detail.summary.success_count, 1);
            assert_eq!(detail.summary.failed_count, 0);
            assert_eq!(detail.items[0].tracking_ids.len(), 10_000);
            assert_eq!(detail.items[0].sheet_row_ids.len(), 10_000);
        }

        let rows = store
            .query_sheet_rows(
                &SheetRowsQuery {
                    sheet_id: "sheet-1".to_string(),
                    offset: 0,
                    limit: 25,
                    filters: vec![],
                    value_filters: vec![],
                    sort: vec![],
                },
                1_000,
            )
            .expect("10k imported rows load");

        assert_eq!(rows.total_count, 10_000);
        assert_eq!(rows.rows.len(), 25);
        assert_eq!(rows.rows[0].display_tracking_id, "P0000000000000.0");
        assert_eq!(rows.rows[0].lookup_tracking_id, "P0000000000000");
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "10k bag import smoke exceeded 30s"
        );
    }

    #[tokio::test]
    async fn manifest_import_keeps_partial_success_and_retry_failed_bags_only() {
        let mut store = prepared_store();
        let mut source = FakeImportSource::default();
        source.push_manifest("MAN1", Ok(manifest_response(&["PID_OK", "PID_FAIL"])));
        source.push_bag("PID_OK", Ok(bag_response(&["P2606020189412.40"])));
        source.push_bag("PID_FAIL", Err(ImportLookupFailure::new("bag timeout")));
        source.push_bag("PID_FAIL", Ok(bag_response(&["P2606020189412.41"])));

        {
            let mut engine = ImportEngine::new(&mut store, &mut source);
            engine
                .create_job(&CreateImportJobPlan {
                    job_id: "job-1".to_string(),
                    sheet_id: "sheet-1".to_string(),
                    kind: ImportKind::Manifest,
                    ids: vec!["MAN1".to_string()],
                    mode: ImportMode::Replace,
                })
                .expect("job is created");

            let first_run = engine.run_job("job-1").await.expect("first run completes");
            assert_eq!(first_run.summary.total_count, 3);
            assert_eq!(first_run.summary.success_count, 2);
            assert_eq!(first_run.summary.failed_count, 1);
            assert_eq!(
                first_run
                    .items
                    .iter()
                    .filter(|item| item.status == ImportJobItemStatus::Failed)
                    .map(|item| item.source_item_id.as_str())
                    .collect::<Vec<_>>(),
                vec!["PID_FAIL"]
            );

            let second_run = engine
                .retry_failed_and_run("job-1")
                .await
                .expect("failed bag retries");
            assert_eq!(second_run.summary.total_count, 3);
            assert_eq!(second_run.summary.success_count, 3);
            assert_eq!(second_run.summary.failed_count, 0);
        }

        let rows = store
            .query_sheet_rows(
                &SheetRowsQuery {
                    sheet_id: "sheet-1".to_string(),
                    offset: 0,
                    limit: 20,
                    filters: vec![],
                    value_filters: vec![],
                    sort: vec![],
                },
                250,
            )
            .expect("rows load");

        assert_eq!(rows.total_count, 2);
        assert_eq!(rows.rows[0].display_tracking_id, "P2606020189412.40");
        assert_eq!(rows.rows[1].display_tracking_id, "P2606020189412.41");

        let manifest_attempts = store
            .list_import_attempts_for_item("job-1:source:0")
            .expect("manifest attempts load");
        assert_eq!(manifest_attempts.len(), 1);
        assert_eq!(manifest_attempts[0].status, ImportAttemptStatus::Succeeded);

        let successful_bag_attempts = store
            .list_import_attempts_for_item("job-1:manifest-bag:1")
            .expect("successful bag attempts load");
        assert_eq!(successful_bag_attempts.len(), 1);
        assert_eq!(
            successful_bag_attempts[0].status,
            ImportAttemptStatus::Succeeded
        );

        let retried_bag_attempts = store
            .list_import_attempts_for_item("job-1:manifest-bag:2")
            .expect("retried bag attempts load");
        assert_eq!(retried_bag_attempts.len(), 2);
        assert_eq!(retried_bag_attempts[0].status, ImportAttemptStatus::Failed);
        assert_eq!(
            retried_bag_attempts[1].status,
            ImportAttemptStatus::Succeeded
        );
    }

    #[tokio::test]
    async fn bag_import_emits_progress_events_after_each_committed_item() {
        let mut store = prepared_store();
        let mut source = FakeImportSource::default();
        source.push_bag("PID_OK", Ok(bag_response(&["P2606020189412.40"])));
        source.push_bag("PID_FAIL", Err(ImportLookupFailure::new("bag timeout")));

        let mut events = Vec::new();
        {
            let mut engine = ImportEngine::new(&mut store, &mut source);
            engine
                .create_job(&CreateImportJobPlan {
                    job_id: "job-1".to_string(),
                    sheet_id: "sheet-1".to_string(),
                    kind: ImportKind::Bag,
                    ids: vec!["PID_OK".to_string(), "PID_FAIL".to_string()],
                    mode: ImportMode::Append,
                })
                .expect("job is created");
            let detail = engine
                .run_job_with_progress("job-1", |event| events.push(event))
                .await
                .expect("job runs with progress");

            assert_eq!(detail.summary.total_count, 2);
            assert_eq!(detail.summary.success_count, 1);
            assert_eq!(detail.summary.failed_count, 1);
        }

        assert_eq!(events.len(), 3);
        assert!(events[0].item_deltas.is_empty());
        assert_eq!(events[0].pending_count, 2);
        assert_eq!(events[1].success_count, 1);
        assert_eq!(events[1].failed_count, 0);
        assert_eq!(events[1].item_deltas[0].item_id, "job-1:source:0");
        assert_eq!(events[1].item_deltas[0].source_item_id, "PID_OK");
        assert_eq!(
            events[1].item_deltas[0].source_item_kind,
            ImportSourceItemKind::Bag
        );
        assert_eq!(
            events[1].item_deltas[0].status,
            ImportJobItemStatus::Succeeded
        );
        assert_eq!(
            events[1].item_deltas[0].tracking_ids,
            vec!["P2606020189412.40"]
        );
        assert_eq!(events[2].success_count, 1);
        assert_eq!(events[2].failed_count, 1);
        assert_eq!(events[2].pending_count, 0);
        assert_eq!(events[2].item_deltas[0].item_id, "job-1:source:1");
        assert_eq!(events[2].item_deltas[0].status, ImportJobItemStatus::Failed);
        assert_eq!(
            events[2].item_deltas[0].error_message.as_deref(),
            Some("bag timeout")
        );
    }

    #[tokio::test]
    async fn bag_preview_reports_partial_failure_without_mutating_sheet_rows() {
        let mut store = prepared_store();
        let mut source = FakeImportSource::default();
        source.push_bag("PID_OK", Ok(bag_response(&["P2606020189412.40"])));
        source.push_bag("PID_FAIL", Err(ImportLookupFailure::new("bag timeout")));

        let preview = {
            let mut engine = ImportEngine::new(&mut store, &mut source);
            engine
                .preview_import_source(
                    ImportKind::Bag,
                    &["PID_OK".to_string(), "PID_FAIL".to_string()],
                )
                .await
        };

        assert_eq!(preview.kind, ImportKind::Bag);
        assert_eq!(preview.tracking_ids, vec!["P2606020189412.40"]);
        assert!(preview.manifest_bags.is_empty());
        assert_eq!(preview.source_items.len(), 2);
        assert_eq!(
            preview.source_items[0].status,
            ImportJobItemStatus::Succeeded
        );
        assert_eq!(
            preview.source_items[0].tracking_ids,
            vec!["P2606020189412.40"]
        );
        assert_eq!(preview.source_items[1].status, ImportJobItemStatus::Failed);
        assert_eq!(
            preview.source_items[1].error_message.as_deref(),
            Some("bag timeout")
        );
        assert!(preview.raw_response.contains("P2606020189412.40"));

        let rows = store
            .query_sheet_rows(
                &SheetRowsQuery {
                    sheet_id: "sheet-1".to_string(),
                    offset: 0,
                    limit: 20,
                    filters: vec![],
                    value_filters: vec![],
                    sort: vec![],
                },
                250,
            )
            .expect("rows load");
        assert_eq!(rows.total_count, 0);
    }

    #[tokio::test]
    async fn manifest_preview_resolves_bags_without_mutating_sheet_rows() {
        let mut store = prepared_store();
        let mut source = FakeImportSource::default();
        source.push_manifest("MAN1", Ok(manifest_response(&["PID_OK", "PID_FAIL"])));
        source.push_bag("PID_OK", Ok(bag_response(&["P2606020189412.40"])));
        source.push_bag("PID_FAIL", Err(ImportLookupFailure::new("bag timeout")));

        let preview = {
            let mut engine = ImportEngine::new(&mut store, &mut source);
            engine
                .preview_import_source(ImportKind::Manifest, &["MAN1".to_string()])
                .await
        };

        assert_eq!(preview.kind, ImportKind::Manifest);
        assert_eq!(preview.source_items.len(), 1);
        assert_eq!(preview.source_items[0].source_item_id, "MAN1");
        assert_eq!(
            preview.source_items[0].tracking_ids,
            vec!["PID_OK", "PID_FAIL"]
        );
        assert_eq!(preview.manifest_bags.len(), 2);
        assert_eq!(
            preview.manifest_bags[0].status,
            ImportJobItemStatus::Succeeded
        );
        assert_eq!(
            preview.manifest_bags[0].tracking_ids,
            vec!["P2606020189412.40"]
        );
        assert_eq!(preview.manifest_bags[1].status, ImportJobItemStatus::Failed);
        assert_eq!(
            preview.manifest_bags[1].error_message.as_deref(),
            Some("bag timeout")
        );
        assert_eq!(preview.tracking_ids, vec!["P2606020189412.40"]);
        assert!(preview.raw_response.contains("PID_OK"));

        let rows = store
            .query_sheet_rows(
                &SheetRowsQuery {
                    sheet_id: "sheet-1".to_string(),
                    offset: 0,
                    limit: 20,
                    filters: vec![],
                    value_filters: vec![],
                    sort: vec![],
                },
                250,
            )
            .expect("rows load");
        assert_eq!(rows.total_count, 0);
    }

    #[test]
    fn core_tracking_errors_are_mapped_to_operator_safe_messages() {
        assert_eq!(
            ImportLookupFailure::from(TrackingError::BadRequest("invalid id".to_string())).message,
            "bad request: invalid id"
        );
        assert_eq!(
            ImportLookupFailure::from(TrackingError::Upstream("timeout".to_string())).message,
            "upstream: timeout"
        );
    }

    #[derive(Default)]
    struct FakeImportSource {
        bags: HashMap<String, VecDeque<Result<BagResponse, ImportLookupFailure>>>,
        manifests: HashMap<String, VecDeque<Result<ManifestResponse, ImportLookupFailure>>>,
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
    }

    impl ImportLookupSource for FakeImportSource {
        async fn fetch_bag<'a>(
            &'a mut self,
            bag_id: &'a str,
        ) -> Result<BagResponse, ImportLookupFailure> {
            self.bags
                .get_mut(bag_id)
                .and_then(VecDeque::pop_front)
                .unwrap_or_else(|| Err(ImportLookupFailure::new(format!("missing bag {bag_id}"))))
        }

        async fn fetch_manifest<'a>(
            &'a mut self,
            manifest_id: &'a str,
        ) -> Result<ManifestResponse, ImportLookupFailure> {
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

    fn bag_response(tracking_ids: &[&str]) -> BagResponse {
        BagResponse {
            url: "https://example.test/bag".to_string(),
            nomor_kantung: Some("PID".to_string()),
            items: tracking_ids
                .iter()
                .map(|tracking_id| BagItem {
                    no_resi: Some((*tracking_id).to_string()),
                    ..BagItem::default()
                })
                .collect(),
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
}
