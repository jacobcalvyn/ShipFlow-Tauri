use std::path::PathBuf;

use shipflow_tauri_runtime::tracking::model::TrackingClientState;
use shipflow_workspace_engine::commands::{
    JobIdRequest, WorkspaceEngineCommand, WorkspaceEngineResponse,
};
use shipflow_workspace_engine::engine::{
    WorkspaceEngineBootstrapConfig, WorkspaceEngineConfig, WorkspaceEngineRuntime,
};
use shipflow_workspace_engine::events::WorkspaceEngineEvent;
use shipflow_workspace_engine::import_engine::ShipflowCoreImportLookupSource;
use tauri::ipc::Channel;
use tauri::Manager;
use tokio::sync::Mutex;

type DesktopWorkspaceEngineRuntime = WorkspaceEngineRuntime<ShipflowCoreImportLookupSource>;

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
    client_state: tauri::State<'_, TrackingClientState>,
) -> Result<WorkspaceEngineResponse, String> {
    let mut runtime = state.runtime.lock().await;

    if runtime.is_none() {
        *runtime = Some(build_workspace_engine_runtime(&app, &client_state)?);
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
    client_state: tauri::State<'_, TrackingClientState>,
) -> Result<WorkspaceEngineResponse, String> {
    let mut runtime = state.runtime.lock().await;

    if runtime.is_none() {
        *runtime = Some(build_workspace_engine_runtime(&app, &client_state)?);
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
    client_state: tauri::State<'_, TrackingClientState>,
) -> Result<WorkspaceEngineResponse, String> {
    let mut runtime = state.runtime.lock().await;

    if runtime.is_none() {
        *runtime = Some(build_workspace_engine_runtime(&app, &client_state)?);
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
    client_state: &TrackingClientState,
) -> Result<DesktopWorkspaceEngineRuntime, String> {
    let source = ShipflowCoreImportLookupSource::with_client(
        client_state.client.clone(),
        client_state.current_source_config(),
    );
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
