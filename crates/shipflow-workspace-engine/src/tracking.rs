use std::collections::HashSet;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::future::Future;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::json;
use shipflow_core::model::{TrackResponse, TrackingError};

use crate::blob_store::{write_blob, BlobStoreError};
use crate::storage::{
    AttachTrackingRecordToSheetRowInput, SheetRowProjection, SheetRowStatus, SqliteWorkspaceStore,
    UpdateSheetRowStatusInput, UpsertRawBlobInput, UpsertTrackingRecordInput, WorkspaceStoreError,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrackingIdResolution {
    Exact,
    StrippedNumericSuffix,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTrackingId {
    pub display_id: String,
    pub lookup_id: String,
    pub resolution: TrackingIdResolution,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetRowsTrackingRefreshResult {
    pub sheet_id: String,
    pub success_count: u32,
    pub failed_count: u32,
    pub rows: Vec<SheetRowProjection>,
}

pub fn resolve_tracking_id(display_id: &str) -> ResolvedTrackingId {
    let display_id = display_id.trim().to_string();
    let stripped_lookup_id = display_id.rsplit_once('.').and_then(|(base, suffix)| {
        (!base.is_empty() && !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit()))
            .then(|| base.to_string())
    });

    match stripped_lookup_id {
        Some(lookup_id) => ResolvedTrackingId {
            display_id,
            lookup_id,
            resolution: TrackingIdResolution::StrippedNumericSuffix,
        },
        None => ResolvedTrackingId {
            lookup_id: display_id.clone(),
            display_id,
            resolution: TrackingIdResolution::Exact,
        },
    }
}

pub trait TrackingLookupSource {
    fn fetch_tracking<'a>(
        &'a mut self,
        lookup_tracking_id: &'a str,
    ) -> impl Future<Output = Result<TrackResponse, TrackingLookupFailure>> + 'a;
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackingLookupFailure {
    pub message: String,
}

impl TrackingLookupFailure {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl Display for TrackingLookupFailure {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for TrackingLookupFailure {}

impl From<TrackingError> for TrackingLookupFailure {
    fn from(error: TrackingError) -> Self {
        let message = match error {
            TrackingError::BadRequest(message) => format!("bad request: {message}"),
            TrackingError::NotFound(message) => format!("not found: {message}"),
            TrackingError::Upstream(message) => format!("upstream: {message}"),
        };

        Self { message }
    }
}

#[derive(Debug)]
pub enum TrackingEngineError {
    Store(WorkspaceStoreError),
    Lookup(TrackingLookupFailure),
    MissingSheetRow(String),
    Json(serde_json::Error),
    Blob(BlobStoreError),
}

impl Display for TrackingEngineError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(error) => write!(formatter, "{error}"),
            Self::Lookup(error) => write!(formatter, "{error}"),
            Self::MissingSheetRow(row_id) => write!(formatter, "missing sheet row: {row_id}"),
            Self::Json(error) => write!(formatter, "json error: {error}"),
            Self::Blob(error) => write!(formatter, "{error}"),
        }
    }
}

impl Error for TrackingEngineError {}

impl From<WorkspaceStoreError> for TrackingEngineError {
    fn from(error: WorkspaceStoreError) -> Self {
        Self::Store(error)
    }
}

impl From<serde_json::Error> for TrackingEngineError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

impl From<BlobStoreError> for TrackingEngineError {
    fn from(error: BlobStoreError) -> Self {
        Self::Blob(error)
    }
}

pub type TrackingEngineResult<T> = Result<T, TrackingEngineError>;

pub struct TrackingEngine<'store, 'source, Source>
where
    Source: TrackingLookupSource,
{
    store: &'store mut SqliteWorkspaceStore,
    source: &'source mut Source,
    blob_root_path: Option<PathBuf>,
}

impl<'store, 'source, Source> TrackingEngine<'store, 'source, Source>
where
    Source: TrackingLookupSource,
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

    pub async fn refresh_sheet_row(
        &mut self,
        row_id: &str,
        _force_refresh: bool,
    ) -> TrackingEngineResult<SheetRowProjection> {
        let row = self
            .store
            .get_sheet_row(row_id)?
            .ok_or_else(|| TrackingEngineError::MissingSheetRow(row_id.to_string()))?;

        self.store
            .update_sheet_row_status(&UpdateSheetRowStatusInput {
                row_id: row.row_id.clone(),
                row_status: SheetRowStatus::Loading,
                error_message: None,
            })?;

        match self.source.fetch_tracking(&row.lookup_tracking_id).await {
            Ok(response) => self.store_successful_tracking_response(&row, response),
            Err(error) => {
                self.store
                    .update_sheet_row_status(&UpdateSheetRowStatusInput {
                        row_id: row.row_id.clone(),
                        row_status: SheetRowStatus::Failed,
                        error_message: Some(error.message.clone()),
                    })?;
                Err(TrackingEngineError::Lookup(error))
            }
        }
    }

    fn store_successful_tracking_response(
        &mut self,
        row: &SheetRowProjection,
        response: TrackResponse,
    ) -> TrackingEngineResult<SheetRowProjection> {
        let record_id = tracking_record_id(&row.lookup_tracking_id);
        let raw_blob_id = self.store_raw_response_blob(&response)?;
        self.store
            .upsert_tracking_record(&UpsertTrackingRecordInput {
                record_id: record_id.clone(),
                display_tracking_id: response
                    .detail
                    .header
                    .nomor_kiriman
                    .clone()
                    .unwrap_or_else(|| row.lookup_tracking_id.clone()),
                lookup_tracking_id: row.lookup_tracking_id.clone(),
                normalized_status: response.status_akhir.status.clone(),
                status_json: serde_json::to_value(&response.status_akhir)?,
                detail_json: serde_json::to_value(&response.detail)?,
                history_json: json!({
                    "pod": response.pod,
                    "history": response.history,
                    "history_summary": response.history_summary,
                }),
                raw_blob_id,
                source_url: response.url,
            })?;
        self.store
            .attach_tracking_record_to_sheet_row(&AttachTrackingRecordToSheetRowInput {
                row_id: row.row_id.clone(),
                tracking_record_id: record_id,
                row_status: SheetRowStatus::Loaded,
                error_message: None,
            })?;

        self.store
            .get_sheet_row(&row.row_id)?
            .ok_or_else(|| TrackingEngineError::MissingSheetRow(row.row_id.clone()))
    }

    fn store_raw_response_blob(
        &mut self,
        response: &TrackResponse,
    ) -> TrackingEngineResult<Option<String>> {
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

    pub async fn refresh_sheet_rows(
        &mut self,
        sheet_id: &str,
        row_ids: &[String],
        force_refresh: bool,
    ) -> TrackingEngineResult<SheetRowsTrackingRefreshResult> {
        let return_rows = !row_ids.is_empty();
        let owned_row_ids;
        let row_ids = if row_ids.is_empty() {
            owned_row_ids = self.store.list_sheet_row_ids(sheet_id)?;
            owned_row_ids.as_slice()
        } else {
            row_ids
        };
        let mut seen = HashSet::new();
        let mut rows = Vec::new();
        let mut success_count = 0;
        let mut failed_count = 0;

        for row_id in row_ids {
            let row_id = row_id.trim();
            if row_id.is_empty() || !seen.insert(row_id.to_string()) {
                continue;
            }
            if !self.store.sheet_row_belongs_to_sheet(row_id, sheet_id)? {
                return Err(TrackingEngineError::MissingSheetRow(row_id.to_string()));
            }

            match self.refresh_sheet_row(row_id, force_refresh).await {
                Ok(row) => {
                    success_count += 1;
                    if return_rows {
                        rows.push(row);
                    }
                }
                Err(TrackingEngineError::Lookup(error)) => {
                    failed_count += 1;
                    let row = self
                        .store
                        .get_sheet_row(row_id)?
                        .ok_or_else(|| TrackingEngineError::MissingSheetRow(row_id.to_string()))?;
                    debug_assert_eq!(row.error_message.as_deref(), Some(error.message.as_str()));
                    if return_rows {
                        rows.push(row);
                    }
                }
                Err(error) => return Err(error),
            }
        }

        Ok(SheetRowsTrackingRefreshResult {
            sheet_id: sheet_id.to_string(),
            success_count,
            failed_count,
            rows,
        })
    }
}

fn tracking_record_id(lookup_tracking_id: &str) -> String {
    format!("tracking:{lookup_tracking_id}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, VecDeque};
    use std::future::Future;

    use shipflow_core::model::{
        PackageDetail, ShipmentHeader, TrackDetail, TrackHistoryEntry, TrackStatusAkhir,
    };

    use crate::storage::{
        CreateSheetInput, CreateWorkspaceInput, SheetRowsQuery, SqliteWorkspaceStore,
        UpsertSheetRowInput,
    };

    #[test]
    fn dotted_numeric_suffix_keeps_display_id_and_uses_base_lookup_id() {
        assert_eq!(
            resolve_tracking_id(" P2606020189412.30 "),
            ResolvedTrackingId {
                display_id: "P2606020189412.30".to_string(),
                lookup_id: "P2606020189412".to_string(),
                resolution: TrackingIdResolution::StrippedNumericSuffix,
            }
        );
    }

    #[test]
    fn non_numeric_dot_suffix_stays_exact() {
        assert_eq!(
            resolve_tracking_id("P2606020189412.A"),
            ResolvedTrackingId {
                display_id: "P2606020189412.A".to_string(),
                lookup_id: "P2606020189412.A".to_string(),
                resolution: TrackingIdResolution::Exact,
            }
        );
    }

    #[tokio::test]
    async fn refresh_sheet_row_preserves_display_id_and_attaches_tracking_detail() {
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
        let mut source = FakeTrackingSource::default();
        source.push_tracking("P2606020189412", Ok(track_response("P2606020189412")));

        {
            let mut engine = TrackingEngine::new(&mut store, &mut source);
            let row = engine
                .refresh_sheet_row("row-1", true)
                .await
                .expect("row refresh succeeds");

            assert_eq!(row.display_tracking_id, "P2606020189412.30");
            assert_eq!(row.lookup_tracking_id, "P2606020189412");
            assert_eq!(row.row_status, SheetRowStatus::Loaded);
            assert_eq!(row.status_json.as_ref().unwrap()["status"], "DELIVERED");
            assert_eq!(
                row.detail_json.as_ref().unwrap()["package_detail"]["jenis_layanan"],
                "PKH"
            );
            assert_eq!(
                row.history_json.as_ref().unwrap()["history_summary"]["irregularity"],
                json!([])
            );
        }
        assert_eq!(source.requested_ids, vec!["P2606020189412".to_string()]);

        let rows = store
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

        assert_eq!(rows.rows[0].display_tracking_id, "P2606020189412.30");
        assert_eq!(rows.rows[0].lookup_tracking_id, "P2606020189412");
        assert_eq!(
            rows.rows[0].status_json.as_ref().unwrap()["status"],
            "DELIVERED"
        );
    }

    #[tokio::test]
    async fn refresh_sheet_row_failure_marks_row_failed_without_losing_display_id() {
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
        let mut source = FakeTrackingSource::default();
        source.push_tracking(
            "P2606020189412",
            Err(TrackingLookupFailure::new("upstream timeout")),
        );

        let result = {
            let mut engine = TrackingEngine::new(&mut store, &mut source);
            engine.refresh_sheet_row("row-1", true).await
        };

        assert!(matches!(result, Err(TrackingEngineError::Lookup(_))));
        let row = store
            .get_sheet_row("row-1")
            .expect("row loads")
            .expect("row exists");
        assert_eq!(row.display_tracking_id, "P2606020189412.30");
        assert_eq!(row.lookup_tracking_id, "P2606020189412");
        assert_eq!(row.row_status, SheetRowStatus::Failed);
        assert_eq!(row.error_message, Some("upstream timeout".to_string()));
    }

    #[tokio::test]
    async fn refresh_sheet_rows_with_empty_ids_refreshes_the_whole_sheet() {
        let mut store = prepared_store();
        for (position, tracking_id) in ["P1", "P2"].iter().enumerate() {
            store
                .upsert_sheet_row(&UpsertSheetRowInput {
                    row_id: format!("row-{position}"),
                    sheet_id: "sheet-1".to_string(),
                    position: position as u32,
                    display_tracking_id: (*tracking_id).to_string(),
                    lookup_tracking_id: (*tracking_id).to_string(),
                    row_status: SheetRowStatus::Empty,
                    error_message: None,
                })
                .expect("row is stored");
        }
        let mut source = FakeTrackingSource::default();
        source.push_tracking("P1", Ok(track_response("P1")));
        source.push_tracking("P2", Ok(track_response("P2")));

        let result = {
            let mut engine = TrackingEngine::new(&mut store, &mut source);
            engine
                .refresh_sheet_rows("sheet-1", &[], true)
                .await
                .expect("sheet refresh succeeds")
        };

        assert_eq!(result.success_count, 2);
        assert_eq!(result.failed_count, 0);
        assert!(result.rows.is_empty());
        let rows = store
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
        assert_eq!(
            rows.rows
                .iter()
                .map(|row| row.display_tracking_id.as_str())
                .collect::<Vec<_>>(),
            ["P1", "P2"]
        );
        assert!(rows
            .rows
            .iter()
            .all(|row| row.row_status == SheetRowStatus::Loaded));
        assert!(source.tracks.values().all(VecDeque::is_empty));
    }

    #[derive(Default)]
    struct FakeTrackingSource {
        tracks: HashMap<String, VecDeque<Result<TrackResponse, TrackingLookupFailure>>>,
        requested_ids: Vec<String>,
    }

    impl FakeTrackingSource {
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

    impl TrackingLookupSource for FakeTrackingSource {
        fn fetch_tracking<'a>(
            &'a mut self,
            lookup_tracking_id: &'a str,
        ) -> impl Future<Output = Result<TrackResponse, TrackingLookupFailure>> + 'a {
            async move {
                self.requested_ids.push(lookup_tracking_id.to_string());
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

    fn track_response(tracking_id: &str) -> TrackResponse {
        TrackResponse {
            url: format!("https://example.test/track/{tracking_id}"),
            detail: TrackDetail {
                header: ShipmentHeader {
                    nomor_kiriman: Some(tracking_id.to_string()),
                    ..ShipmentHeader::default()
                },
                package: PackageDetail {
                    jenis_layanan: Some("PKH".to_string()),
                    ..PackageDetail::default()
                },
                ..TrackDetail::default()
            },
            status_akhir: TrackStatusAkhir {
                status: Some("DELIVERED".to_string()),
                location: Some("DC JAYAPURA".to_string()),
                ..TrackStatusAkhir::default()
            },
            pod: Default::default(),
            history: vec![TrackHistoryEntry {
                tanggal_update: "2026-06-11 10:00:00".to_string(),
                detail_history: "Delivered".to_string(),
            }],
            history_summary: Default::default(),
        }
    }
}
