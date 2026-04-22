mod app_menu_runtime;
mod app_runtime;
mod os_bridge;
mod pod_preview;
mod runtime_log;
mod service;
mod service_runtime;
#[cfg(test)]
mod test_support;
mod tracking;
mod window_runtime;
mod workspace_document;

use std::sync::{Arc, Mutex};

use app_menu_runtime::{build_desktop_menu, handle_desktop_menu_event};
use app_runtime::{
    build_main_webview_navigation_guard_plugin, build_tracking_client, desktop_setup,
    handle_desktop_window_event, handle_service_settings_window_event, service_settings_setup,
};
use os_bridge::{
    copy_text_to_clipboard, open_external_url_runtime, pick_workspace_document_path_runtime,
};
use pod_preview::resolve_pod_image_source;
use runtime_log::log_runtime_event;
use service::{
    ensure_tracking_service_runtime, ApiServiceConfig, ApiServiceController, ApiServiceStatus,
};
use service_runtime::{
    configure_api_service_runtime, get_api_service_status_runtime,
    load_saved_api_service_config_runtime, test_external_tracking_source_runtime,
    track_bag_via_service, track_manifest_via_service, track_shipment_via_service,
    validate_tracking_source_config_runtime, TrayState,
};
use tracking::model::{TrackingClientState, TrackingSourceConfig};
use window_runtime::{
    claim_current_workspace_document_runtime, create_workspace_window_runtime,
    get_current_window_label_runtime, resolve_window_close_request_runtime,
    set_current_window_document_state_runtime, set_current_window_title_runtime,
    take_pending_workspace_window_request_runtime, WindowCloseGuardState, WindowDocumentState,
    WorkspaceDocumentClaimResult, WorkspaceDocumentRegistryState, WorkspaceWindowLaunchState,
    WorkspaceWindowRequest,
};
use workspace_document::{
    read_workspace_document_file, write_workspace_document_file, WorkspaceDocumentFile,
    WorkspaceDocumentReadResult, WorkspaceDocumentWriteResult,
};

const SERVICE_TRAY_ID: &str = "service-runtime";

#[tauri::command]
async fn track_shipment(
    shipment_id: String,
    sheet_id: Option<String>,
    row_key: Option<String>,
    client_state: tauri::State<'_, TrackingClientState>,
    service_controller: tauri::State<'_, ApiServiceController>,
) -> Result<tracking::model::TrackResponse, String> {
    let context = format!(
        "[sheetId={}, rowKey={}, shipmentId={}]",
        sheet_id.as_deref().unwrap_or("-"),
        row_key.as_deref().unwrap_or("-"),
        shipment_id.trim()
    );

    let saved_service_config = service_controller.load_saved_config().unwrap_or(None);
    let runtime_config =
        ensure_tracking_service_runtime(saved_service_config).map_err(|message| {
            log_runtime_event("ERROR", format!("[ShipFlowBackend] {context} {message}"));
            format!("{context} {message}")
        })?;

    let track_result =
        track_shipment_via_service(&client_state.client, &runtime_config, shipment_id.trim()).await;

    track_result.map_err(|error| match error {
        tracking::model::TrackingError::BadRequest(message)
        | tracking::model::TrackingError::NotFound(message)
        | tracking::model::TrackingError::Upstream(message) => {
            log_runtime_event("ERROR", format!("[ShipFlowBackend] {context} {message}"));
            format!("{context} {message}")
        }
    })
}

#[tauri::command]
async fn track_bag(
    bag_id: String,
    sheet_id: Option<String>,
    row_key: Option<String>,
    client_state: tauri::State<'_, TrackingClientState>,
    service_controller: tauri::State<'_, ApiServiceController>,
) -> Result<tracking::model::BagResponse, String> {
    let context = format!(
        "[sheetId={}, rowKey={}, bagId={}]",
        sheet_id.as_deref().unwrap_or("-"),
        row_key.as_deref().unwrap_or("-"),
        bag_id.trim()
    );

    let saved_service_config = service_controller.load_saved_config().unwrap_or(None);
    let runtime_config =
        ensure_tracking_service_runtime(saved_service_config).map_err(|message| {
            log_runtime_event("ERROR", format!("[ShipFlowBackend] {context} {message}"));
            format!("{context} {message}")
        })?;

    let track_result =
        track_bag_via_service(&client_state.client, &runtime_config, bag_id.trim()).await;

    track_result.map_err(|error| match error {
        tracking::model::TrackingError::BadRequest(message)
        | tracking::model::TrackingError::NotFound(message)
        | tracking::model::TrackingError::Upstream(message) => {
            log_runtime_event("ERROR", format!("[ShipFlowBackend] {context} {message}"));
            format!("{context} {message}")
        }
    })
}

#[tauri::command]
async fn track_manifest(
    manifest_id: String,
    sheet_id: Option<String>,
    row_key: Option<String>,
    client_state: tauri::State<'_, TrackingClientState>,
    service_controller: tauri::State<'_, ApiServiceController>,
) -> Result<tracking::model::ManifestResponse, String> {
    let context = format!(
        "[sheetId={}, rowKey={}, manifestId={}]",
        sheet_id.as_deref().unwrap_or("-"),
        row_key.as_deref().unwrap_or("-"),
        manifest_id.trim()
    );

    let saved_service_config = service_controller.load_saved_config().unwrap_or(None);
    let runtime_config =
        ensure_tracking_service_runtime(saved_service_config).map_err(|message| {
            log_runtime_event("ERROR", format!("[ShipFlowBackend] {context} {message}"));
            format!("{context} {message}")
        })?;

    let track_result =
        track_manifest_via_service(&client_state.client, &runtime_config, manifest_id.trim())
            .await;

    track_result.map_err(|error| match error {
        tracking::model::TrackingError::BadRequest(message)
        | tracking::model::TrackingError::NotFound(message)
        | tracking::model::TrackingError::Upstream(message) => {
            log_runtime_event("ERROR", format!("[ShipFlowBackend] {context} {message}"));
            format!("{context} {message}")
        }
    })
}

#[tauri::command]
async fn resolve_pod_image(image_source: String) -> Result<String, String> {
    resolve_pod_image_source(image_source.trim(), 0).await
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    open_external_url_runtime(&url)
}

#[tauri::command]
fn copy_to_clipboard(text: String) -> Result<(), String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("Clipboard text is required.".into());
    }

    copy_text_to_clipboard(trimmed)
}

#[tauri::command]
fn pick_workspace_document_path(
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
fn read_workspace_document(path: String) -> Result<WorkspaceDocumentReadResult, String> {
    read_workspace_document_file(path)
}

#[tauri::command]
fn write_workspace_document(
    path: String,
    document: WorkspaceDocumentFile,
) -> Result<WorkspaceDocumentWriteResult, String> {
    write_workspace_document_file(path, document)
}

#[tauri::command]
fn set_current_window_title(window: tauri::Window, title: String) -> Result<(), String> {
    set_current_window_title_runtime(window, title)
}

#[tauri::command]
fn get_current_window_label(window: tauri::Window) -> String {
    get_current_window_label_runtime(window)
}

#[tauri::command]
fn set_current_window_document_state(
    window: tauri::Window,
    state: tauri::State<'_, WindowDocumentState>,
    is_dirty: bool,
    document_name: String,
) {
    set_current_window_document_state_runtime(window, &state, is_dirty, document_name);
}

#[tauri::command]
fn claim_current_workspace_document(
    app: tauri::AppHandle,
    window: tauri::Window,
    registry: tauri::State<'_, WorkspaceDocumentRegistryState>,
    path: Option<String>,
) -> Result<WorkspaceDocumentClaimResult, String> {
    claim_current_workspace_document_runtime(app, window, &registry, path)
}

#[tauri::command]
fn resolve_window_close_request(
    window: tauri::Window,
    close_guard: tauri::State<'_, WindowCloseGuardState>,
    action: String,
) -> Result<(), String> {
    resolve_window_close_request_runtime(window, &close_guard, action)
}

#[tauri::command]
fn create_workspace_window(
    app: tauri::AppHandle,
    launch_state: tauri::State<'_, WorkspaceWindowLaunchState>,
    registry: tauri::State<'_, WorkspaceDocumentRegistryState>,
    document_path: Option<String>,
) -> Result<WorkspaceDocumentClaimResult, String> {
    create_workspace_window_runtime(app, &launch_state, &registry, document_path)
}

#[tauri::command]
fn open_shipflow_service_app() -> Result<(), String> {
    service::launch_shipflow_service_app()
}

#[tauri::command]
fn take_pending_workspace_window_request(
    window: tauri::Window,
    launch_state: tauri::State<'_, WorkspaceWindowLaunchState>,
) -> Option<WorkspaceWindowRequest> {
    take_pending_workspace_window_request_runtime(window, &launch_state)
}

#[tauri::command]
async fn configure_api_service(
    app_handle: tauri::AppHandle,
    config: ApiServiceConfig,
    client_state: tauri::State<'_, TrackingClientState>,
    service_controller: tauri::State<'_, ApiServiceController>,
    tray_state: tauri::State<'_, TrayState>,
) -> Result<ApiServiceStatus, String> {
    configure_api_service_runtime(
        app_handle,
        config,
        &client_state,
        &service_controller,
        &tray_state,
    )
    .await
}

#[tauri::command]
fn load_saved_api_service_config(
    service_controller: tauri::State<'_, ApiServiceController>,
    client_state: tauri::State<'_, TrackingClientState>,
    app_handle: tauri::AppHandle,
    tray_state: tauri::State<'_, TrayState>,
) -> Result<Option<ApiServiceConfig>, String> {
    load_saved_api_service_config_runtime(
        &service_controller,
        &client_state,
        app_handle,
        &tray_state,
    )
}

#[tauri::command]
fn get_api_service_status(
    service_controller: tauri::State<'_, ApiServiceController>,
    app_handle: tauri::AppHandle,
    tray_state: tauri::State<'_, TrayState>,
) -> ApiServiceStatus {
    get_api_service_status_runtime(&service_controller, app_handle, &tray_state)
}

#[tauri::command]
async fn test_external_tracking_source(
    config: ApiServiceConfig,
    client_state: tauri::State<'_, TrackingClientState>,
) -> Result<String, String> {
    test_external_tracking_source_runtime(config, &client_state).await
}

#[tauri::command]
fn validate_tracking_source_config(config: ApiServiceConfig) -> Result<(), String> {
    validate_tracking_source_config_runtime(config)
}

#[tauri::command]
fn log_frontend_runtime_event(level: String, message: String) {
    let normalized_level = level.trim().to_lowercase();
    let trimmed_message = message.trim();

    if trimmed_message.is_empty() {
        return;
    }

    let level = if normalized_level.is_empty() {
        "info"
    } else {
        &normalized_level
    };
    log_runtime_event(level, format!("[ShipFlowFrontend][{level}] {trimmed_message}"));
}

pub fn maybe_run_service_process_from_current_args() -> Result<bool, String> {
    service::maybe_run_service_process_from_current_args()
}

pub fn maybe_run_service_tray_from_current_args() -> Result<bool, String> {
    service::maybe_run_service_tray_from_current_args()
}

pub fn maybe_delegate_to_existing_desktop_process() -> Result<bool, String> {
    service::maybe_delegate_desktop_launch_to_existing_process()
}

pub fn maybe_delegate_to_existing_service_settings_process() -> Result<bool, String> {
    service::maybe_delegate_service_settings_launch_to_existing_process()
}

pub fn install_runtime_logging() {
    runtime_log::install_runtime_logging();
}

fn build_base_context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

pub fn run() {
    install_runtime_logging();
    let tracking_client = build_tracking_client("ShipFlow Desktop/0.1");
    let context = build_base_context();

    tauri::Builder::default()
        .menu(build_desktop_menu)
        .manage(TrackingClientState {
            client: tracking_client,
            source_config: Arc::new(Mutex::new(TrackingSourceConfig::default())),
        })
        .manage(ApiServiceController::default())
        .manage(TrayState::default())
        .manage(WorkspaceWindowLaunchState::default())
        .manage(WorkspaceDocumentRegistryState::default())
        .manage(WindowDocumentState::default())
        .manage(WindowCloseGuardState::default())
        .setup(desktop_setup)
        .on_menu_event(|app, event| handle_desktop_menu_event(app, event.id().as_ref()))
        .on_window_event(handle_desktop_window_event)
        .plugin(build_main_webview_navigation_guard_plugin())
        .invoke_handler(tauri::generate_handler![
            track_shipment,
            track_bag,
            track_manifest,
            resolve_pod_image,
            open_external_url,
            copy_to_clipboard,
            pick_workspace_document_path,
            read_workspace_document,
            write_workspace_document,
            set_current_window_title,
            get_current_window_label,
            set_current_window_document_state,
            claim_current_workspace_document,
            resolve_window_close_request,
            create_workspace_window,
            open_shipflow_service_app,
            take_pending_workspace_window_request,
            log_frontend_runtime_event,
            configure_api_service,
            load_saved_api_service_config,
            get_api_service_status,
            test_external_tracking_source,
            validate_tracking_source_config
        ])
        .run(context)
        .expect("error while running tauri application");
}

pub fn run_service_settings() {
    install_runtime_logging();
    let tracking_client = build_tracking_client("ShipFlow Service/0.1");
    let mut context = build_base_context();
    context.config_mut().app.windows.clear();

    tauri::Builder::default()
        .manage(TrackingClientState {
            client: tracking_client,
            source_config: Arc::new(Mutex::new(TrackingSourceConfig::default())),
        })
        .manage(ApiServiceController::default())
        .manage(TrayState::default())
        .setup(service_settings_setup)
        .on_window_event(handle_service_settings_window_event)
        .invoke_handler(tauri::generate_handler![
            track_bag,
            track_manifest,
            open_external_url,
            copy_to_clipboard,
            log_frontend_runtime_event,
            configure_api_service,
            load_saved_api_service_config,
            get_api_service_status,
            test_external_tracking_source,
            validate_tracking_source_config
        ])
        .run(context)
        .expect("error while running ShipFlow Service");
}
