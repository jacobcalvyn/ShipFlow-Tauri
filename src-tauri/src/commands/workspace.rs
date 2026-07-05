use shipflow_tauri_runtime::os_bridge::{
    pick_csv_export_path_runtime, pick_workspace_document_path_runtime,
};
use shipflow_tauri_runtime::service::launch_service_settings_app;
use shipflow_tauri_runtime::window_runtime::{
    claim_current_workspace_document_runtime, create_workspace_window_runtime,
    get_current_window_label_runtime, resolve_window_close_request_runtime,
    set_current_window_document_state_runtime, set_current_window_title_runtime,
    take_pending_workspace_window_request_runtime, WindowCloseGuardState, WindowDocumentState,
    WorkspaceDocumentClaimResult, WorkspaceDocumentRegistryState, WorkspaceWindowLaunchState,
    WorkspaceWindowRequest,
};
use shipflow_tauri_runtime::workspace_document::{
    list_workspace_recovery_snapshots, read_workspace_document_file, write_csv_export_file,
    write_workspace_document_file, WorkspaceCsvExportResult, WorkspaceDocumentFile,
    WorkspaceDocumentReadResult, WorkspaceDocumentWriteResult, WorkspaceRecoverySnapshot,
};

#[tauri::command]
pub fn pick_workspace_document_path(
    mode: String,
    suggested_name: Option<String>,
) -> Result<Option<String>, String> {
    let normalized_mode = mode.trim().to_lowercase();
    let suggested_name = suggested_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    pick_workspace_document_path_runtime(normalized_mode.as_str(), suggested_name)
}

#[tauri::command]
pub fn read_workspace_document(
    window: tauri::Window,
    registry: tauri::State<'_, WorkspaceDocumentRegistryState>,
    path: String,
) -> Result<WorkspaceDocumentReadResult, String> {
    let claimed_path = registry.ensure_window_claims_path(window.label(), &path)?;
    read_workspace_document_file(claimed_path)
}

#[tauri::command]
pub fn write_workspace_document(
    window: tauri::Window,
    registry: tauri::State<'_, WorkspaceDocumentRegistryState>,
    path: String,
    document: WorkspaceDocumentFile,
) -> Result<WorkspaceDocumentWriteResult, String> {
    let claimed_path = registry.ensure_window_claims_path(window.label(), &path)?;
    write_workspace_document_file(claimed_path, document)
}

#[tauri::command]
pub fn export_workspace_csv(
    suggested_name: String,
    csv_content: String,
    row_count: usize,
) -> Result<Option<WorkspaceCsvExportResult>, String> {
    let Some(path) = pick_csv_export_path_runtime(&suggested_name)? else {
        return Ok(None);
    };

    write_csv_export_file(path, csv_content, row_count).map(Some)
}

#[tauri::command]
pub fn list_workspace_recovery(path: String) -> Result<Vec<WorkspaceRecoverySnapshot>, String> {
    list_workspace_recovery_snapshots(path)
}

#[tauri::command]
pub fn set_current_window_title(window: tauri::Window, title: String) -> Result<(), String> {
    set_current_window_title_runtime(window, title)
}

#[tauri::command]
pub fn get_current_window_label(window: tauri::Window) -> String {
    get_current_window_label_runtime(window)
}

#[tauri::command]
pub fn set_current_window_document_state(
    window: tauri::Window,
    state: tauri::State<'_, WindowDocumentState>,
    is_dirty: bool,
    document_name: String,
) {
    set_current_window_document_state_runtime(window, &state, is_dirty, document_name);
}

#[tauri::command]
pub fn claim_current_workspace_document(
    app: tauri::AppHandle,
    window: tauri::Window,
    registry: tauri::State<'_, WorkspaceDocumentRegistryState>,
    path: Option<String>,
) -> Result<WorkspaceDocumentClaimResult, String> {
    claim_current_workspace_document_runtime(app, window, &registry, path)
}

#[tauri::command]
pub fn resolve_window_close_request(
    window: tauri::Window,
    close_guard: tauri::State<'_, WindowCloseGuardState>,
    action: String,
) -> Result<(), String> {
    resolve_window_close_request_runtime(window, &close_guard, action)
}

#[tauri::command]
pub fn create_workspace_window(
    app: tauri::AppHandle,
    launch_state: tauri::State<'_, WorkspaceWindowLaunchState>,
    registry: tauri::State<'_, WorkspaceDocumentRegistryState>,
    document_path: Option<String>,
) -> Result<WorkspaceDocumentClaimResult, String> {
    create_workspace_window_runtime(app, &launch_state, &registry, document_path)
}

#[tauri::command]
pub fn open_shipflow_service_app(app_handle: tauri::AppHandle) -> Result<(), String> {
    let _ = app_handle;
    launch_service_settings_app()
}

#[tauri::command]
pub fn take_pending_workspace_window_request(
    window: tauri::Window,
    launch_state: tauri::State<'_, WorkspaceWindowLaunchState>,
) -> Option<WorkspaceWindowRequest> {
    take_pending_workspace_window_request_runtime(window, &launch_state)
}
