use std::future::Future;
use std::path::PathBuf;

use shipflow_tauri_runtime::service::{load_desktop_service_connection_config, ApiServiceConfig};
use shipflow_tauri_runtime::service_client::{
    track_bag_via_service, track_manifest_via_service, track_shipment_via_service,
};
use shipflow_tauri_runtime::tracking::model::{BagResponse, ManifestResponse, TrackResponse};
use shipflow_workspace_engine::commands::{
    JobIdRequest, WorkspaceEngineCommand, WorkspaceEngineResponse,
};
use shipflow_workspace_engine::engine::{
    WorkspaceEngineBootstrapConfig, WorkspaceEngineConfig, WorkspaceEngineRuntime,
};
use shipflow_workspace_engine::events::WorkspaceEngineEvent;
use shipflow_workspace_engine::import_engine::{ImportLookupFailure, ImportLookupSource};
use shipflow_workspace_engine::tracking::{TrackingLookupFailure, TrackingLookupSource};
use tauri::ipc::Channel;
use tauri::Manager;
use tokio::sync::Mutex;

type DesktopWorkspaceEngineRuntime = WorkspaceEngineRuntime<DesktopServiceLookupSource>;

const DEFAULT_WORKSPACE_ID: &str = "default-workspace";
const DEFAULT_WORKSPACE_NAME: &str = "Default Workspace";
const DEFAULT_WORKSPACE_SHEET_ID: &str = "default-sheet";
const DEFAULT_WORKSPACE_SHEET_NAME: &str = "Sheet 1";

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
    fn fetch_bag<'a>(
        &'a mut self,
        bag_id: &'a str,
    ) -> impl Future<Output = Result<BagResponse, ImportLookupFailure>> + 'a {
        async move {
            let config = Self::load_config().map_err(ImportLookupFailure::new)?;
            track_bag_via_service(&self.client, &config, bag_id, false)
                .await
                .map_err(ImportLookupFailure::from)
        }
    }

    fn fetch_manifest<'a>(
        &'a mut self,
        manifest_id: &'a str,
    ) -> impl Future<Output = Result<ManifestResponse, ImportLookupFailure>> + 'a {
        async move {
            let config = Self::load_config().map_err(ImportLookupFailure::new)?;
            track_manifest_via_service(&self.client, &config, manifest_id, false)
                .await
                .map_err(ImportLookupFailure::from)
        }
    }
}

impl TrackingLookupSource for DesktopServiceLookupSource {
    fn fetch_tracking<'a>(
        &'a mut self,
        lookup_tracking_id: &'a str,
    ) -> impl Future<Output = Result<TrackResponse, TrackingLookupFailure>> + 'a {
        async move {
            let config = Self::load_config().map_err(TrackingLookupFailure::new)?;
            track_shipment_via_service(&self.client, &config, lookup_tracking_id, false)
                .await
                .map_err(TrackingLookupFailure::from)
        }
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
