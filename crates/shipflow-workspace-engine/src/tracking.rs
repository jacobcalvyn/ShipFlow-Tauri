use std::collections::HashSet;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;

use serde::{Deserialize, Serialize};
use serde_json::json;
use shipflow_core::model::{TrackResponse, TrackingError};

use crate::blob_store::{write_blob, BlobStoreError};
use crate::events::TrackingRefreshProgressEvent;
use crate::storage::{
    AttachTrackingRecordToSheetRowInput, SheetRowProjection, SheetRowStatus, SqliteWorkspaceStore,
    UpdateSheetRowStatusInput, UpsertRawBlobInput, UpsertTrackingRecordInput, WorkspaceStoreError,
};

const MAX_CONCURRENT_TRACKING_REFRESH_LOOKUPS: usize = 5;

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
    pub run_id: Option<String>,
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

pub trait TrackingLookupSource: Send {
    fn fetch_tracking<'a>(
        &'a mut self,
        lookup_tracking_id: &'a str,
        force_refresh: bool,
    ) -> TrackingLookupFuture<'a>;

    fn fetch_tracking_batch_with_progress<'a>(
        &'a mut self,
        lookup_tracking_ids: Vec<String>,
        force_refresh: bool,
        mut on_result: TrackingBatchResultCallback<'a>,
    ) -> TrackingBatchLookupFuture<'a> {
        Box::pin(async move {
            for lookup_tracking_id in lookup_tracking_ids {
                let result = self
                    .fetch_tracking(&lookup_tracking_id, force_refresh)
                    .await;
                if !on_result(lookup_tracking_id, result) {
                    break;
                }
            }

            Ok(())
        })
    }
}

pub type TrackingLookupFuture<'a> =
    Pin<Box<dyn Future<Output = Result<TrackResponse, TrackingLookupFailure>> + Send + 'a>>;

pub type TrackingBatchLookupFuture<'a> =
    Pin<Box<dyn Future<Output = Result<(), TrackingLookupFailure>> + Send + 'a>>;

pub type TrackingBatchResultCallback<'a> =
    Box<dyn FnMut(String, Result<TrackResponse, TrackingLookupFailure>) -> bool + Send + 'a>;

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
            TrackingError::RateLimited(message) => format!("rate limited: {message}"),
            TrackingError::ServiceUnavailable(message) => format!("service unavailable: {message}"),
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
        force_refresh: bool,
    ) -> TrackingEngineResult<SheetRowProjection> {
        let row = self
            .store
            .get_sheet_row(row_id)?
            .ok_or_else(|| TrackingEngineError::MissingSheetRow(row_id.to_string()))?;

        let updated = self.store.update_sheet_row_status_if_lookup_matches(
            &UpdateSheetRowStatusInput {
                row_id: row.row_id.clone(),
                row_status: SheetRowStatus::Loading,
                error_message: None,
            },
            &row.lookup_tracking_id,
            &row.row_generation,
        )?;
        if !updated {
            return Err(TrackingEngineError::MissingSheetRow(row.row_id));
        }

        match self
            .source
            .fetch_tracking(&row.lookup_tracking_id, force_refresh)
            .await
        {
            Ok(response) => self.store_successful_tracking_response(&row, response),
            Err(error) => {
                let updated = self.store.update_sheet_row_status_if_lookup_matches(
                    &UpdateSheetRowStatusInput {
                        row_id: row.row_id.clone(),
                        row_status: SheetRowStatus::Failed,
                        error_message: Some(error.message.clone()),
                    },
                    &row.lookup_tracking_id,
                    &row.row_generation,
                )?;
                if !updated {
                    return Err(TrackingEngineError::MissingSheetRow(row.row_id));
                }
                Err(TrackingEngineError::Lookup(error))
            }
        }
    }

    fn store_successful_tracking_response(
        &mut self,
        row: &SheetRowProjection,
        response: TrackResponse,
    ) -> TrackingEngineResult<SheetRowProjection> {
        let stored = store_successful_tracking_response(
            self.store,
            self.blob_root_path.as_deref(),
            row,
            response,
        )?;
        stored.ok_or_else(|| TrackingEngineError::MissingSheetRow(row.row_id.clone()))
    }

    pub async fn refresh_sheet_rows(
        &mut self,
        sheet_id: &str,
        row_ids: &[String],
        force_refresh: bool,
    ) -> TrackingEngineResult<SheetRowsTrackingRefreshResult> {
        self.refresh_sheet_rows_with_progress(sheet_id, row_ids, force_refresh, None, |_| {})
            .await
    }

    pub async fn refresh_sheet_rows_with_progress<F>(
        &mut self,
        sheet_id: &str,
        row_ids: &[String],
        force_refresh: bool,
        run_id: Option<String>,
        mut on_progress: F,
    ) -> TrackingEngineResult<SheetRowsTrackingRefreshResult>
    where
        F: FnMut(TrackingRefreshProgressEvent) + Send,
    {
        let owned_row_ids;
        let row_ids = if row_ids.is_empty() {
            owned_row_ids = self.store.list_sheet_row_ids(sheet_id)?;
            owned_row_ids.as_slice()
        } else {
            row_ids
        };
        let mut seen = HashSet::new();
        let mut rows_by_lookup_id = Vec::<(String, Vec<SheetRowProjection>)>::new();
        let mut lookup_ids = Vec::new();
        let mut rows = Vec::new();
        let mut target_rows = Vec::<(String, String, String)>::new();
        let mut terminal_row_ids = HashSet::new();
        let mut success_count = 0;
        let mut failed_count = 0;
        let mut duplicate_or_empty_row_count = 0;
        let mut stale_or_missing_row_count = 0;

        for row_id in row_ids {
            let row_id = row_id.trim();
            if row_id.is_empty() || !seen.insert(row_id.to_string()) {
                duplicate_or_empty_row_count += 1;
                continue;
            }
            if !self.store.sheet_row_belongs_to_sheet(row_id, sheet_id)? {
                stale_or_missing_row_count += 1;
                continue;
            }

            let Some(row) = self.store.get_sheet_row(row_id)? else {
                stale_or_missing_row_count += 1;
                continue;
            };
            let updated = self.store.update_sheet_row_status_if_lookup_matches(
                &UpdateSheetRowStatusInput {
                    row_id: row.row_id.clone(),
                    row_status: SheetRowStatus::Pending,
                    error_message: None,
                },
                &row.lookup_tracking_id,
                &row.row_generation,
            )?;
            if !updated {
                continue;
            }
            let mut row = row;
            row.row_status = SheetRowStatus::Pending;
            row.error_message = None;
            target_rows.push((
                row.row_id.clone(),
                row.lookup_tracking_id.clone(),
                row.row_generation.clone(),
            ));

            if let Some((_, grouped_rows)) = rows_by_lookup_id
                .iter_mut()
                .find(|(lookup_id, _)| lookup_id == &row.lookup_tracking_id)
            {
                grouped_rows.push(row);
            } else {
                lookup_ids.push(row.lookup_tracking_id.clone());
                rows_by_lookup_id.push((row.lookup_tracking_id.clone(), vec![row]));
            }
        }

        let total_count = rows_by_lookup_id
            .iter()
            .map(|(_, grouped_rows)| grouped_rows.len() as u32)
            .sum::<u32>();
        let mut storage_error = None;

        let mut next_lookup_to_activate = rows_by_lookup_id
            .len()
            .min(MAX_CONCURRENT_TRACKING_REFRESH_LOOKUPS);
        eprintln!(
            "[ShipFlowWorkspaceEngine] tracking_batch_start sheetId={} requestedRows={} targetRows={} lookupGroups={} concurrency={} skippedDuplicateOrEmpty={} skippedStaleOrMissing={} forceRefresh={}",
            sheet_id,
            row_ids.len(),
            total_count,
            rows_by_lookup_id.len(),
            MAX_CONCURRENT_TRACKING_REFRESH_LOOKUPS,
            duplicate_or_empty_row_count,
            stale_or_missing_row_count,
            force_refresh
        );
        for (_, grouped_rows) in rows_by_lookup_id.iter_mut().take(next_lookup_to_activate) {
            let mut activation_context = TrackingLookupActivationContext {
                sheet_id,
                run_id: run_id.as_deref(),
                total_count,
                success_count,
                failed_count,
                on_progress: &mut on_progress,
            };
            activate_tracking_lookup_group(self.store, &mut activation_context, grouped_rows)?;
        }

        for (_, grouped_rows) in rows_by_lookup_id.iter() {
            for row in grouped_rows {
                if row.row_status != SheetRowStatus::Pending {
                    continue;
                }

                on_progress(TrackingRefreshProgressEvent {
                    run_id: run_id.clone(),
                    sheet_id: sheet_id.to_string(),
                    row: row.clone(),
                    total_count,
                    success_count,
                    failed_count,
                    pending_count: total_count,
                });
            }
        }

        let batch_result = self
            .source
            .fetch_tracking_batch_with_progress(
                lookup_ids,
                force_refresh,
                Box::new(|lookup_id, result| {
                    if storage_error.is_some() {
                        return false;
                    }

                    let Some((_, grouped_rows)) = rows_by_lookup_id
                        .iter_mut()
                        .find(|(candidate, _)| candidate == &lookup_id)
                    else {
                        eprintln!(
                            "[ShipFlowWorkspaceEngine] tracking_batch_unknown_lookup_result sheetId={} lookupId={}",
                            sheet_id, lookup_id
                        );
                        return true;
                    };
                    let grouped_rows = std::mem::take(grouped_rows);
                    let mut terminal_events = Vec::new();

                    match result {
                        Ok(response) => {
                            for row in grouped_rows {
                                match store_successful_tracking_response(
                                    self.store,
                                    self.blob_root_path.as_deref(),
                                    &row,
                                    response.clone(),
                                ) {
                                    Ok(Some(row)) => {
                                        success_count += 1;
                                        let pending_count = total_count
                                            .saturating_sub(success_count)
                                            .saturating_sub(failed_count);
                                        terminal_events.push(TrackingRefreshProgressEvent {
                                            run_id: run_id.clone(),
                                            sheet_id: sheet_id.to_string(),
                                            row: row.clone(),
                                            total_count,
                                            success_count,
                                            failed_count,
                                            pending_count,
                                        });
                                        terminal_row_ids.insert(row.row_id.clone());
                                        rows.push(row);
                                    }
                                    Ok(None) => {
                                        eprintln!(
                                            "[ShipFlowWorkspaceEngine] tracking_batch_stale_success_ignored sheetId={} rowId={} lookupId={}",
                                            sheet_id, row.row_id, row.lookup_tracking_id
                                        );
                                        continue;
                                    }
                                    Err(error) => {
                                        storage_error = Some(error);
                                        return false;
                                    }
                                }
                            }
                        }
                        Err(error) => {
                            for row in grouped_rows {
                                match store_failed_tracking_lookup(self.store, &row, &error) {
                                    Ok(Some(row)) => {
                                        failed_count += 1;
                                        let pending_count = total_count
                                            .saturating_sub(success_count)
                                            .saturating_sub(failed_count);
                                        terminal_events.push(TrackingRefreshProgressEvent {
                                            run_id: run_id.clone(),
                                            sheet_id: sheet_id.to_string(),
                                            row: row.clone(),
                                            total_count,
                                            success_count,
                                            failed_count,
                                            pending_count,
                                        });
                                        terminal_row_ids.insert(row.row_id.clone());
                                        rows.push(row);
                                    }
                                    Ok(None) => {
                                        eprintln!(
                                            "[ShipFlowWorkspaceEngine] tracking_batch_stale_failure_ignored sheetId={} rowId={} lookupId={}",
                                            sheet_id, row.row_id, row.lookup_tracking_id
                                        );
                                        continue;
                                    }
                                    Err(error) => {
                                        storage_error = Some(error);
                                        return false;
                                    }
                                }
                            }
                        }
                    }

                    for event in terminal_events {
                        on_progress(event);
                    }

                    if next_lookup_to_activate < rows_by_lookup_id.len() {
                        let activating_lookup_id =
                            rows_by_lookup_id[next_lookup_to_activate].0.clone();
                        let mut activation_context = TrackingLookupActivationContext {
                            sheet_id,
                            run_id: run_id.as_deref(),
                            total_count,
                            success_count,
                            failed_count,
                            on_progress: &mut on_progress,
                        };
                        if let Err(error) = activate_tracking_lookup_group(
                            self.store,
                            &mut activation_context,
                            &mut rows_by_lookup_id[next_lookup_to_activate].1,
                        ) {
                            storage_error = Some(error);
                            return false;
                        }
                        eprintln!(
                            "[ShipFlowWorkspaceEngine] tracking_batch_activate_next sheetId={} lookupId={} activeIndex={}",
                            sheet_id, activating_lookup_id, next_lookup_to_activate
                        );
                        next_lookup_to_activate += 1;
                    }

                    true
                }),
            )
            .await;

        if let Some(error) = storage_error {
            return Err(error);
        }

        let missing_result_error = batch_result.err().unwrap_or_else(|| {
            TrackingLookupFailure::new("tracking batch did not return a result")
        });
        for (_, grouped_rows) in rows_by_lookup_id.into_iter() {
            for row in grouped_rows {
                if let Some(row) =
                    store_failed_tracking_lookup(self.store, &row, &missing_result_error)?
                {
                    failed_count += 1;
                    let pending_count = total_count
                        .saturating_sub(success_count)
                        .saturating_sub(failed_count);
                    on_progress(TrackingRefreshProgressEvent {
                        run_id: run_id.clone(),
                        sheet_id: sheet_id.to_string(),
                        row: row.clone(),
                        total_count,
                        success_count,
                        failed_count,
                        pending_count,
                    });
                    terminal_row_ids.insert(row.row_id.clone());
                    rows.push(row);
                }
            }
        }

        for (row_id, lookup_tracking_id, row_generation) in target_rows {
            if terminal_row_ids.contains(&row_id) {
                continue;
            }

            let Some(current_row) = self.store.get_sheet_row(&row_id)? else {
                continue;
            };
            if current_row.lookup_tracking_id != lookup_tracking_id
                || current_row.row_generation != row_generation
            {
                continue;
            }
            if !matches!(
                current_row.row_status,
                SheetRowStatus::Pending | SheetRowStatus::Loading
            ) {
                continue;
            }

            if let Some(row) =
                store_failed_tracking_lookup(self.store, &current_row, &missing_result_error)?
            {
                failed_count += 1;
                let pending_count = total_count
                    .saturating_sub(success_count)
                    .saturating_sub(failed_count);
                on_progress(TrackingRefreshProgressEvent {
                    run_id: run_id.clone(),
                    sheet_id: sheet_id.to_string(),
                    row: row.clone(),
                    total_count,
                    success_count,
                    failed_count,
                    pending_count,
                });
                terminal_row_ids.insert(row.row_id.clone());
                rows.push(row);
            }
        }

        eprintln!(
            "[ShipFlowWorkspaceEngine] tracking_batch_complete sheetId={} targetRows={} success={} failed={} returnedRows={}",
            sheet_id,
            total_count,
            success_count,
            failed_count,
            rows.len()
        );

        Ok(SheetRowsTrackingRefreshResult {
            run_id,
            sheet_id: sheet_id.to_string(),
            success_count,
            failed_count,
            rows,
        })
    }
}

struct TrackingLookupActivationContext<'a, F>
where
    F: FnMut(TrackingRefreshProgressEvent),
{
    sheet_id: &'a str,
    run_id: Option<&'a str>,
    total_count: u32,
    success_count: u32,
    failed_count: u32,
    on_progress: &'a mut F,
}

fn activate_tracking_lookup_group<F>(
    store: &mut SqliteWorkspaceStore,
    context: &mut TrackingLookupActivationContext<'_, F>,
    grouped_rows: &mut [SheetRowProjection],
) -> TrackingEngineResult<()>
where
    F: FnMut(TrackingRefreshProgressEvent),
{
    let pending_count = context
        .total_count
        .saturating_sub(context.success_count)
        .saturating_sub(context.failed_count);
    if let Some(first_row) = grouped_rows.first() {
        eprintln!(
            "[ShipFlowWorkspaceEngine] tracking_batch_activate sheetId={} lookupId={} rowCount={} success={} failed={} pending={}",
            context.sheet_id,
            first_row.lookup_tracking_id,
            grouped_rows.len(),
            context.success_count,
            context.failed_count,
            pending_count
        );
    }
    for row in grouped_rows {
        let updated = store.update_sheet_row_status_if_lookup_matches(
            &UpdateSheetRowStatusInput {
                row_id: row.row_id.clone(),
                row_status: SheetRowStatus::Loading,
                error_message: None,
            },
            &row.lookup_tracking_id,
            &row.row_generation,
        )?;
        if !updated {
            continue;
        }
        row.row_status = SheetRowStatus::Loading;
        row.error_message = None;
        (context.on_progress)(TrackingRefreshProgressEvent {
            run_id: context.run_id.map(ToOwned::to_owned),
            sheet_id: context.sheet_id.to_string(),
            row: row.clone(),
            total_count: context.total_count,
            success_count: context.success_count,
            failed_count: context.failed_count,
            pending_count,
        });
    }

    Ok(())
}

fn store_successful_tracking_response(
    store: &mut SqliteWorkspaceStore,
    blob_root_path: Option<&std::path::Path>,
    row: &SheetRowProjection,
    response: TrackResponse,
) -> TrackingEngineResult<Option<SheetRowProjection>> {
    let record_id = tracking_record_id(&row.lookup_tracking_id);
    let raw_blob_id = store_raw_response_blob(store, blob_root_path, &response)?;
    let record = UpsertTrackingRecordInput {
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
            "shipment_identity": response.shipment_identity,
            "multi_koli": response.multi_koli,
        }),
        raw_blob_id,
        source_url: response.url,
    };
    let attached = store.upsert_tracking_record_and_attach_if_row_matches(
        &record,
        &AttachTrackingRecordToSheetRowInput {
            row_id: row.row_id.clone(),
            tracking_record_id: record_id,
            row_status: SheetRowStatus::Loaded,
            error_message: None,
        },
        &row.lookup_tracking_id,
        &row.row_generation,
    )?;
    if !attached {
        return Ok(None);
    }

    Ok(store.get_sheet_row(&row.row_id)?.filter(|current| {
        current.lookup_tracking_id == row.lookup_tracking_id
            && current.row_generation == row.row_generation
    }))
}

fn store_failed_tracking_lookup(
    store: &mut SqliteWorkspaceStore,
    row: &SheetRowProjection,
    error: &TrackingLookupFailure,
) -> TrackingEngineResult<Option<SheetRowProjection>> {
    let updated = store.update_sheet_row_status_if_lookup_matches(
        &UpdateSheetRowStatusInput {
            row_id: row.row_id.clone(),
            row_status: SheetRowStatus::Failed,
            error_message: Some(error.message.clone()),
        },
        &row.lookup_tracking_id,
        &row.row_generation,
    )?;
    if !updated {
        return Ok(None);
    }
    Ok(store.get_sheet_row(&row.row_id)?.filter(|current| {
        current.lookup_tracking_id == row.lookup_tracking_id
            && current.row_generation == row.row_generation
    }))
}

fn store_raw_response_blob(
    store: &mut SqliteWorkspaceStore,
    blob_root_path: Option<&std::path::Path>,
    response: &TrackResponse,
) -> TrackingEngineResult<Option<String>> {
    let Some(root) = blob_root_path else {
        return Ok(None);
    };

    let bytes = serde_json::to_vec(response)?;
    let address = write_blob(root, &bytes, "application/json")?;
    store.upsert_raw_blob(&UpsertRawBlobInput {
        blob_id: address.id.clone(),
        sha256: address.sha256,
        media_type: address.media_type,
        byte_len: address.byte_len,
        storage_path: address.relative_path,
    })?;

    Ok(Some(address.id))
}

fn tracking_record_id(lookup_tracking_id: &str) -> String {
    format!("tracking:{lookup_tracking_id}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, VecDeque};

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
        let mut response = track_response("P2606020189412");
        response.shipment_identity = shipflow_core::model::ShipmentIdentity {
            requested_id: Some("P2606020189412.30".to_string()),
            parent_shipment_id: Some("P2606020189412".to_string()),
            is_koli: true,
            koli_number: Some(30),
        };
        response.multi_koli = shipflow_core::model::MultiKoliSummary {
            is_multi_koli: true,
            jumlah_koli: 2,
            nomor_koli: vec![
                "P2606020189412.1".to_string(),
                "P2606020189412.30".to_string(),
            ],
            status_agregat: Some("PARTIALLY_DELIVERED".to_string()),
            koli: vec![],
        };
        source.push_tracking("P2606020189412", Ok(response));

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
            assert_eq!(
                row.history_json.as_ref().unwrap()["shipment_identity"]["requested_id"],
                "P2606020189412.30"
            );
            assert_eq!(
                row.history_json.as_ref().unwrap()["multi_koli"]["status_agregat"],
                "PARTIALLY_DELIVERED"
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
        assert_eq!(
            rows.rows[0].history_json.as_ref().unwrap()["multi_koli"]["nomor_koli"],
            json!(["P2606020189412.1", "P2606020189412.30"])
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
        assert_eq!(
            result
                .rows
                .iter()
                .map(|row| row.display_tracking_id.as_str())
                .collect::<Vec<_>>(),
            ["P1", "P2"]
        );
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

    #[tokio::test]
    async fn refresh_sheet_rows_emits_loading_before_pending_queue_snapshots() {
        let mut store = prepared_store();
        for (position, tracking_id) in ["P1", "P2", "P3", "P4", "P5", "P6"].iter().enumerate() {
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
        for tracking_id in ["P1", "P2", "P3", "P4", "P5", "P6"] {
            source.push_tracking(tracking_id, Ok(track_response(tracking_id)));
        }
        let mut events = Vec::new();

        {
            let mut engine = TrackingEngine::new(&mut store, &mut source);
            engine
                .refresh_sheet_rows_with_progress("sheet-1", &[], true, None, |event| {
                    events.push((event.row.display_tracking_id.clone(), event.row.row_status));
                })
                .await
                .expect("sheet refresh succeeds");
        }

        assert_eq!(
            events.iter().take(6).cloned().collect::<Vec<_>>(),
            vec![
                ("P1".to_string(), SheetRowStatus::Loading),
                ("P2".to_string(), SheetRowStatus::Loading),
                ("P3".to_string(), SheetRowStatus::Loading),
                ("P4".to_string(), SheetRowStatus::Loading),
                ("P5".to_string(), SheetRowStatus::Loading),
                ("P6".to_string(), SheetRowStatus::Pending),
            ]
        );
        assert_eq!(
            events.iter().skip(6).take(2).cloned().collect::<Vec<_>>(),
            vec![
                ("P1".to_string(), SheetRowStatus::Loaded),
                ("P6".to_string(), SheetRowStatus::Loading),
            ]
        );
    }

    #[tokio::test]
    async fn refresh_sheet_rows_finalizes_missing_batch_results_as_failed() {
        let mut store = prepared_store();
        for (position, tracking_id) in ["P1", "P2", "P3"].iter().enumerate() {
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
        let mut source = PartialBatchTrackingSource;
        let result = {
            let mut engine = TrackingEngine::new(&mut store, &mut source);
            engine
                .refresh_sheet_rows_with_progress("sheet-1", &[], true, None, |_| {})
                .await
                .expect("sheet refresh completes")
        };
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

        assert_eq!(result.success_count, 1);
        assert_eq!(result.failed_count, 2);
        assert_eq!(rows.rows[0].row_status, SheetRowStatus::Loaded);
        assert_eq!(rows.rows[1].row_status, SheetRowStatus::Failed);
        assert_eq!(rows.rows[2].row_status, SheetRowStatus::Failed);
        assert!(rows.rows.iter().all(|row| {
            !matches!(
                row.row_status,
                SheetRowStatus::Pending | SheetRowStatus::Loading
            )
        }));
    }

    #[tokio::test]
    async fn refresh_sheet_rows_skips_stale_requested_row_ids_without_aborting_batch() {
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
                .refresh_sheet_rows_with_progress(
                    "sheet-1",
                    &[
                        "row-0".to_string(),
                        "deleted-row".to_string(),
                        "row-1".to_string(),
                    ],
                    true,
                    None,
                    |_| {},
                )
                .await
                .expect("stale row ids are skipped")
        };
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

        assert_eq!(result.success_count, 2);
        assert_eq!(result.failed_count, 0);
        assert!(rows
            .rows
            .iter()
            .all(|row| row.row_status == SheetRowStatus::Loaded));
    }

    #[tokio::test]
    async fn refresh_sheet_rows_finalizes_batch_source_error_as_failed_rows() {
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
        let mut source = FailedBatchTrackingSource;
        let result = {
            let mut engine = TrackingEngine::new(&mut store, &mut source);
            engine
                .refresh_sheet_rows_with_progress("sheet-1", &[], true, None, |_| {})
                .await
                .expect("batch source errors become row failures")
        };
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

        assert_eq!(result.success_count, 0);
        assert_eq!(result.failed_count, 2);
        assert!(rows
            .rows
            .iter()
            .all(|row| row.row_status == SheetRowStatus::Failed));
        assert!(rows
            .rows
            .iter()
            .all(|row| { row.error_message.as_deref() == Some("service batch unavailable") }));
    }

    #[test]
    fn stale_success_result_does_not_overwrite_reused_row_id() {
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
            .expect("old row is stored");
        let old_row = store
            .get_sheet_row("row-1")
            .expect("row lookup succeeds")
            .expect("old row exists");
        store.clear_sheet_rows("sheet-1").expect("rows are cleared");
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
            .expect("new row is stored");

        let stored =
            store_successful_tracking_response(&mut store, None, &old_row, track_response("POLD"))
                .expect("stale success is ignored");
        let current = store
            .get_sheet_row("row-1")
            .expect("row lookup succeeds")
            .expect("new row exists");

        assert!(stored.is_none());
        assert_eq!(current.lookup_tracking_id, "PNEW");
        assert_eq!(current.row_status, SheetRowStatus::Empty);
        assert_eq!(current.status_json, None);
    }

    #[test]
    fn stale_loading_activation_does_not_overwrite_reused_row_id() {
        let mut store = prepared_store();
        store
            .upsert_sheet_row(&UpsertSheetRowInput {
                row_id: "row-1".to_string(),
                sheet_id: "sheet-1".to_string(),
                position: 0,
                display_tracking_id: "POLD".to_string(),
                lookup_tracking_id: "POLD".to_string(),
                row_status: SheetRowStatus::Pending,
                error_message: None,
            })
            .expect("old row is stored");
        let old_row = store
            .get_sheet_row("row-1")
            .expect("row lookup succeeds")
            .expect("old row exists");
        store.clear_sheet_rows("sheet-1").expect("rows are cleared");
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
            .expect("new row is stored");
        let mut grouped_rows = vec![old_row];
        let mut events = Vec::new();
        {
            let mut collect_event = |event| events.push(event);
            let mut activation_context = TrackingLookupActivationContext {
                sheet_id: "sheet-1",
                run_id: None,
                total_count: 1,
                success_count: 0,
                failed_count: 0,
                on_progress: &mut collect_event,
            };

            activate_tracking_lookup_group(&mut store, &mut activation_context, &mut grouped_rows)
                .expect("stale activation is ignored");
        }
        let current = store
            .get_sheet_row("row-1")
            .expect("row lookup succeeds")
            .expect("new row exists");

        assert!(events.is_empty());
        assert_eq!(current.lookup_tracking_id, "PNEW");
        assert_eq!(current.row_status, SheetRowStatus::Empty);
    }

    #[test]
    fn stale_success_does_not_overwrite_recreated_row_with_same_lookup() {
        let mut store = prepared_store();
        store
            .upsert_sheet_row(&UpsertSheetRowInput {
                row_id: "row-1".to_string(),
                sheet_id: "sheet-1".to_string(),
                position: 0,
                display_tracking_id: "P1".to_string(),
                lookup_tracking_id: "P1".to_string(),
                row_status: SheetRowStatus::Loading,
                error_message: None,
            })
            .expect("old row is stored");
        let old_row = store
            .get_sheet_row("row-1")
            .expect("row lookup succeeds")
            .expect("old row exists");
        store.clear_sheet_rows("sheet-1").expect("rows are cleared");
        store
            .upsert_sheet_row(&UpsertSheetRowInput {
                row_id: "row-1".to_string(),
                sheet_id: "sheet-1".to_string(),
                position: 0,
                display_tracking_id: "P1".to_string(),
                lookup_tracking_id: "P1".to_string(),
                row_status: SheetRowStatus::Empty,
                error_message: None,
            })
            .expect("replacement row is stored");

        let stored =
            store_successful_tracking_response(&mut store, None, &old_row, track_response("P1"))
                .expect("stale response is fenced");
        let current = store
            .get_sheet_row("row-1")
            .expect("row lookup succeeds")
            .expect("replacement row exists");

        assert!(stored.is_none());
        assert_ne!(old_row.row_generation, current.row_generation);
        assert_eq!(current.row_status, SheetRowStatus::Empty);
        assert_eq!(current.status_json, None);
    }

    #[test]
    fn same_lookup_upsert_preserves_generation_for_active_tracking() {
        let mut store = prepared_store();
        store
            .upsert_sheet_row(&UpsertSheetRowInput {
                row_id: "row-1".to_string(),
                sheet_id: "sheet-1".to_string(),
                position: 0,
                display_tracking_id: "P1".to_string(),
                lookup_tracking_id: "P1".to_string(),
                row_status: SheetRowStatus::Loading,
                error_message: None,
            })
            .expect("row is stored");
        let active_row = store
            .get_sheet_row("row-1")
            .expect("row lookup succeeds")
            .expect("row exists");
        store
            .upsert_sheet_row(&UpsertSheetRowInput {
                row_id: "row-1".to_string(),
                sheet_id: "sheet-1".to_string(),
                position: 1,
                display_tracking_id: "P1".to_string(),
                lookup_tracking_id: "P1".to_string(),
                row_status: SheetRowStatus::Loading,
                error_message: None,
            })
            .expect("same logical row is updated");

        let stored =
            store_successful_tracking_response(&mut store, None, &active_row, track_response("P1"))
                .expect("active response is stored")
                .expect("active row still matches");

        assert_eq!(stored.row_generation, active_row.row_generation);
        assert_eq!(stored.position, 1);
        assert_eq!(stored.row_status, SheetRowStatus::Loaded);
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
            _force_refresh: bool,
        ) -> TrackingLookupFuture<'a> {
            Box::pin(async move {
                self.requested_ids.push(lookup_tracking_id.to_string());
                self.tracks
                    .get_mut(lookup_tracking_id)
                    .and_then(VecDeque::pop_front)
                    .unwrap_or_else(|| {
                        Err(TrackingLookupFailure::new(format!(
                            "missing track {lookup_tracking_id}"
                        )))
                    })
            })
        }
    }

    struct PartialBatchTrackingSource;

    impl TrackingLookupSource for PartialBatchTrackingSource {
        fn fetch_tracking<'a>(
            &'a mut self,
            _lookup_tracking_id: &'a str,
            _force_refresh: bool,
        ) -> TrackingLookupFuture<'a> {
            Box::pin(async { Err(TrackingLookupFailure::new("unused")) })
        }

        fn fetch_tracking_batch_with_progress<'a>(
            &'a mut self,
            lookup_tracking_ids: Vec<String>,
            _force_refresh: bool,
            mut on_result: TrackingBatchResultCallback<'a>,
        ) -> TrackingBatchLookupFuture<'a> {
            Box::pin(async move {
                if let Some(first_id) = lookup_tracking_ids.into_iter().next() {
                    on_result(first_id.clone(), Ok(track_response(&first_id)));
                }

                Ok(())
            })
        }
    }

    struct FailedBatchTrackingSource;

    impl TrackingLookupSource for FailedBatchTrackingSource {
        fn fetch_tracking<'a>(
            &'a mut self,
            _lookup_tracking_id: &'a str,
            _force_refresh: bool,
        ) -> TrackingLookupFuture<'a> {
            Box::pin(async { Err(TrackingLookupFailure::new("unused")) })
        }

        fn fetch_tracking_batch_with_progress<'a>(
            &'a mut self,
            _lookup_tracking_ids: Vec<String>,
            _force_refresh: bool,
            _on_result: TrackingBatchResultCallback<'a>,
        ) -> TrackingBatchLookupFuture<'a> {
            Box::pin(async { Err(TrackingLookupFailure::new("service batch unavailable")) })
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
            shipment_identity: Default::default(),
            multi_koli: Default::default(),
            contact_enrichment: None,
        }
    }
}
