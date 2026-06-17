use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use shipflow_tauri_runtime::service::{load_desktop_service_connection_config, ApiServiceConfig};
use shipflow_tauri_runtime::service_client::{
    track_bag_via_service, track_manifest_via_service, track_shipment_via_service,
};
use shipflow_tauri_runtime::tracking::model::{BagResponse, ManifestResponse};
use shipflow_workspace_engine::commands::{
    JobIdRequest, RefreshSheetRowsTrackingRequest, WorkspaceEngineCommand, WorkspaceEngineResponse,
};
use shipflow_workspace_engine::engine::{
    WorkspaceEngineBootstrapConfig, WorkspaceEngineConfig, WorkspaceEngineRuntime,
};
use shipflow_workspace_engine::events::WorkspaceEngineEvent;
use shipflow_workspace_engine::import_engine::{ImportLookupFailure, ImportLookupSource};
use shipflow_workspace_engine::tracking::{
    TrackingBatchLookupFuture, TrackingBatchResultCallback, TrackingLookupFailure,
    TrackingLookupFuture, TrackingLookupSource,
};
use tauri::ipc::Channel;
use tauri::Manager;
use tokio::sync::Mutex;
use tokio::task::JoinSet;

type DesktopWorkspaceEngineRuntime = WorkspaceEngineRuntime<DesktopServiceLookupSource>;

const DEFAULT_WORKSPACE_ID: &str = "default-workspace";
const DEFAULT_WORKSPACE_NAME: &str = "Default Workspace";
const DEFAULT_WORKSPACE_SHEET_ID: &str = "default-sheet";
const DEFAULT_WORKSPACE_SHEET_NAME: &str = "Sheet 1";
const MAX_CONCURRENT_DESKTOP_TRACKING_LOOKUPS: usize = 5;
static DESKTOP_TRACKING_BATCH_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
pub struct WorkspaceEngineState {
    runtime: Mutex<Option<DesktopWorkspaceEngineRuntime>>,
}

#[tauri::command]
pub async fn workspace_engine_command(
    app: tauri::AppHandle,
    command: WorkspaceEngineCommand,
    state: tauri::State<'_, WorkspaceEngineState>,
) -> Result<WorkspaceEngineResponse, String> {
    let mut runtime = state.runtime.lock().await;

    if runtime.is_none() {
        *runtime = Some(build_workspace_engine_runtime(&app)?);
    }

    runtime
        .as_mut()
        .expect("runtime initialized above")
        .handle_command(command)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn workspace_engine_run_import_job_with_progress(
    app: tauri::AppHandle,
    request: JobIdRequest,
    on_event: Channel<WorkspaceEngineEvent>,
    state: tauri::State<'_, WorkspaceEngineState>,
) -> Result<WorkspaceEngineResponse, String> {
    let mut runtime = state.runtime.lock().await;

    if runtime.is_none() {
        *runtime = Some(build_workspace_engine_runtime(&app)?);
    }

    runtime
        .as_mut()
        .expect("runtime initialized above")
        .run_import_job_with_progress(&request.job_id, |event| {
            let _ = on_event.send(event);
        })
        .await
        .map(WorkspaceEngineResponse::ImportJobDetail)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn workspace_engine_retry_import_job_failed_with_progress(
    app: tauri::AppHandle,
    request: JobIdRequest,
    on_event: Channel<WorkspaceEngineEvent>,
    state: tauri::State<'_, WorkspaceEngineState>,
) -> Result<WorkspaceEngineResponse, String> {
    let mut runtime = state.runtime.lock().await;

    if runtime.is_none() {
        *runtime = Some(build_workspace_engine_runtime(&app)?);
    }

    runtime
        .as_mut()
        .expect("runtime initialized above")
        .retry_import_job_failed_with_progress(&request.job_id, |event| {
            let _ = on_event.send(event);
        })
        .await
        .map(WorkspaceEngineResponse::ImportJobDetail)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn workspace_engine_refresh_sheet_rows_tracking_with_progress(
    app: tauri::AppHandle,
    request: RefreshSheetRowsTrackingRequest,
    on_event: Channel<WorkspaceEngineEvent>,
    _state: tauri::State<'_, WorkspaceEngineState>,
) -> Result<WorkspaceEngineResponse, String> {
    let mut runtime = build_workspace_engine_runtime(&app)?;

    runtime
        .refresh_sheet_rows_tracking_with_progress(
            &request.sheet_id,
            &request.row_ids,
            request.force_refresh,
            |event| {
                let _ = on_event.send(event);
            },
        )
        .await
        .map(WorkspaceEngineResponse::SheetRowsTrackingRefresh)
        .map_err(|error| error.to_string())
}

pub fn workspace_engine_db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Unable to resolve ShipFlow app data directory: {error}"))?
        .join("workspace-engine")
        .join("workspace.sqlite3"))
}

fn build_workspace_engine_runtime(
    app: &tauri::AppHandle,
) -> Result<DesktopWorkspaceEngineRuntime, String> {
    let source = DesktopServiceLookupSource::new();
    let bootstrap = WorkspaceEngineRuntime::open_persistent(
        WorkspaceEngineConfig::default(),
        WorkspaceEngineBootstrapConfig::new(
            workspace_engine_db_path(app)?,
            DEFAULT_WORKSPACE_ID,
            DEFAULT_WORKSPACE_NAME,
            DEFAULT_WORKSPACE_SHEET_ID,
            DEFAULT_WORKSPACE_SHEET_NAME,
        ),
        source,
    )
    .map_err(|error| error.to_string())?;

    Ok(bootstrap.runtime)
}

#[derive(Clone)]
struct DesktopServiceLookupSource {
    client: reqwest::Client,
}

impl DesktopServiceLookupSource {
    fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }

    fn load_config() -> Result<ApiServiceConfig, String> {
        load_desktop_service_connection_config()?.ok_or_else(|| {
            "ShipFlow Desktop requires a configured ShipFlow Service connection.".to_string()
        })
    }
}

impl ImportLookupSource for DesktopServiceLookupSource {
    async fn fetch_bag<'a>(
        &'a mut self,
        bag_id: &'a str,
    ) -> Result<BagResponse, ImportLookupFailure> {
        let config = Self::load_config().map_err(ImportLookupFailure::new)?;
        track_bag_via_service(&self.client, &config, bag_id, false)
            .await
            .map_err(ImportLookupFailure::from)
    }

    async fn fetch_manifest<'a>(
        &'a mut self,
        manifest_id: &'a str,
    ) -> Result<ManifestResponse, ImportLookupFailure> {
        let config = Self::load_config().map_err(ImportLookupFailure::new)?;
        track_manifest_via_service(&self.client, &config, manifest_id, false)
            .await
            .map_err(ImportLookupFailure::from)
    }
}

impl TrackingLookupSource for DesktopServiceLookupSource {
    fn fetch_tracking<'a>(
        &'a mut self,
        lookup_tracking_id: &'a str,
        force_refresh: bool,
    ) -> TrackingLookupFuture<'a> {
        Box::pin(async move {
            let config = Self::load_config().map_err(TrackingLookupFailure::new)?;
            track_shipment_via_service(&self.client, &config, lookup_tracking_id, force_refresh)
                .await
                .map_err(TrackingLookupFailure::from)
        })
    }

    fn fetch_tracking_batch_with_progress<'a>(
        &'a mut self,
        lookup_tracking_ids: Vec<String>,
        force_refresh: bool,
        mut on_result: TrackingBatchResultCallback<'a>,
    ) -> TrackingBatchLookupFuture<'a> {
        Box::pin(async move {
            let config = Self::load_config().map_err(TrackingLookupFailure::new)?;
            let batch_id = DESKTOP_TRACKING_BATCH_SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1;
            let total_count = lookup_tracking_ids.len();
            let mut queue = VecDeque::from(lookup_tracking_ids);
            let mut tasks = JoinSet::new();
            let mut dispatched_count = 0usize;
            let mut completed_count = 0usize;

            eprintln!(
                "[ShipFlowDesktopTrackingBatch] start batchId={} total={} concurrency={} forceRefresh={} baseUrl={}",
                batch_id,
                total_count,
                MAX_CONCURRENT_DESKTOP_TRACKING_LOOKUPS,
                force_refresh,
                config.desktop_service_url
            );

            loop {
                while tasks.len() < MAX_CONCURRENT_DESKTOP_TRACKING_LOOKUPS && !queue.is_empty() {
                    let Some(lookup_tracking_id) = queue.pop_front() else {
                        break;
                    };
                    dispatched_count += 1;
                    eprintln!(
                        "[ShipFlowDesktopTrackingBatch] dispatch batchId={} id={} dispatched={} completed={} inFlight={} remaining={}",
                        batch_id,
                        lookup_tracking_id,
                        dispatched_count,
                        completed_count,
                        tasks.len() + 1,
                        queue.len()
                    );
                    let client = self.client.clone();
                    let config = config.clone();
                    tasks.spawn(async move {
                        let result = track_shipment_via_service(
                            &client,
                            &config,
                            lookup_tracking_id.trim(),
                            force_refresh,
                        )
                        .await
                        .map_err(TrackingLookupFailure::from);
                        (lookup_tracking_id, result)
                    });
                }

                if tasks.is_empty() {
                    break;
                }

                match tasks.join_next().await {
                    Some(Ok((lookup_tracking_id, result))) => {
                        completed_count += 1;
                        let result_label = if result.is_ok() { "ok" } else { "error" };
                        eprintln!(
                            "[ShipFlowDesktopTrackingBatch] complete batchId={} id={} result={} dispatched={} completed={} inFlight={} remaining={}",
                            batch_id,
                            lookup_tracking_id,
                            result_label,
                            dispatched_count,
                            completed_count,
                            tasks.len(),
                            queue.len()
                        );
                        if !on_result(lookup_tracking_id, result) {
                            eprintln!(
                                "[ShipFlowDesktopTrackingBatch] callback_stop batchId={} dispatched={} completed={} inFlight={} remaining={}",
                                batch_id,
                                dispatched_count,
                                completed_count,
                                tasks.len(),
                                queue.len()
                            );
                            tasks.abort_all();
                            break;
                        }
                    }
                    Some(Err(error)) => {
                        eprintln!(
                            "[ShipFlowDesktopTrackingBatch] worker_failed batchId={} dispatched={} completed={} inFlight={} remaining={} error={}",
                            batch_id,
                            dispatched_count,
                            completed_count,
                            tasks.len(),
                            queue.len(),
                            error
                        );
                        tasks.abort_all();
                        return Err(TrackingLookupFailure::new(format!(
                            "tracking worker failed: {error}"
                        )));
                    }
                    None => break,
                }
            }

            eprintln!(
                "[ShipFlowDesktopTrackingBatch] finish batchId={} total={} dispatched={} completed={} remaining={}",
                batch_id,
                total_count,
                dispatched_count,
                completed_count,
                queue.len()
            );
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_state_starts_without_runtime() {
        let state = WorkspaceEngineState::default();

        assert!(state
            .runtime
            .try_lock()
            .expect("state lock available")
            .is_none());
    }

    #[test]
    fn default_workspace_bootstrap_contract_matches_frontend() {
        assert_eq!(DEFAULT_WORKSPACE_ID, "default-workspace");
        assert_eq!(DEFAULT_WORKSPACE_SHEET_ID, "default-sheet");
        assert_eq!(DEFAULT_WORKSPACE_SHEET_NAME, "Sheet 1");
    }
}
