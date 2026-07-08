use std::sync::{Arc, Mutex};

#[cfg(target_os = "macos")]
use crate::app_runtime::{
    build_service_settings_menu, handle_service_settings_menu_event,
    open_service_settings_window_runtime,
};
use crate::app_runtime::{
    build_service_settings_single_instance_plugin, build_tracking_client,
    handle_service_settings_window_event, load_service_window_icon,
    maybe_install_signed_updater_plugin, service_settings_setup,
};
use crate::lookup_runtime::LookupCacheState;
use crate::os_bridge::{
    copy_text_to_clipboard, open_external_url_runtime, read_text_from_clipboard,
};
use crate::runtime_log::log_runtime_event;
use crate::service::{
    self, ensure_tracking_service_runtime, ApiServiceConfig, ApiServiceController, ApiServiceStatus,
};
use crate::service_client::{
    test_api_service_connection as test_api_service_connection_client, track_bag_via_service,
    track_manifest_via_service,
};
use crate::service_runtime::{
    configure_api_service_runtime, get_api_service_status_checked_runtime,
    load_saved_api_service_config_runtime, test_external_tracking_source_runtime,
    validate_tracking_source_config_runtime, TrayState,
};
use crate::tracking::model::{
    BagResponse, ManifestResponse, TrackingClientState, TrackingSourceConfig,
};
use crate::updater_runtime::{
    app_release_health, check_app_update_runtime, install_app_update_runtime, AppReleaseHealth,
    AppUpdateStatus,
};

#[tauri::command]
async fn track_bag(
    bag_id: String,
    force_refresh: Option<bool>,
    sheet_id: Option<String>,
    row_key: Option<String>,
    client_state: tauri::State<'_, TrackingClientState>,
    service_controller: tauri::State<'_, ApiServiceController>,
) -> Result<BagResponse, String> {
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

    track_bag_via_service(
        &client_state.client,
        &runtime_config,
        bag_id.trim(),
        force_refresh.unwrap_or(false),
    )
    .await
    .map_err(|error| match error {
        crate::tracking::model::TrackingError::BadRequest(message)
        | crate::tracking::model::TrackingError::NotFound(message)
        | crate::tracking::model::TrackingError::RateLimited(message)
        | crate::tracking::model::TrackingError::ServiceUnavailable(message)
        | crate::tracking::model::TrackingError::Upstream(message) => {
            log_runtime_event("ERROR", format!("[ShipFlowBackend] {context} {message}"));
            format!("{context} {message}")
        }
    })
}

#[tauri::command]
async fn track_manifest(
    manifest_id: String,
    force_refresh: Option<bool>,
    sheet_id: Option<String>,
    row_key: Option<String>,
    client_state: tauri::State<'_, TrackingClientState>,
    service_controller: tauri::State<'_, ApiServiceController>,
) -> Result<ManifestResponse, String> {
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

    track_manifest_via_service(
        &client_state.client,
        &runtime_config,
        manifest_id.trim(),
        force_refresh.unwrap_or(false),
    )
    .await
    .map_err(|error| match error {
        crate::tracking::model::TrackingError::BadRequest(message)
        | crate::tracking::model::TrackingError::NotFound(message)
        | crate::tracking::model::TrackingError::RateLimited(message)
        | crate::tracking::model::TrackingError::ServiceUnavailable(message)
        | crate::tracking::model::TrackingError::Upstream(message) => {
            log_runtime_event("ERROR", format!("[ShipFlowBackend] {context} {message}"));
            format!("{context} {message}")
        }
    })
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
fn read_from_clipboard() -> Result<String, String> {
    read_text_from_clipboard()
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
    log_runtime_event(
        level,
        format!("[ShipFlowFrontend][{level}] {trimmed_message}"),
    );
}

#[tauri::command]
async fn configure_api_service(
    app_handle: tauri::AppHandle,
    config: ApiServiceConfig,
    client_state: tauri::State<'_, TrackingClientState>,
    service_controller: tauri::State<'_, ApiServiceController>,
    tray_state: tauri::State<'_, TrayState>,
    lookup_cache: tauri::State<'_, LookupCacheState>,
) -> Result<ApiServiceStatus, String> {
    configure_api_service_runtime(
        app_handle,
        config,
        &client_state,
        &service_controller,
        &tray_state,
        &lookup_cache,
    )
    .await
}

#[tauri::command]
fn load_saved_api_service_config(
    service_controller: tauri::State<'_, ApiServiceController>,
    client_state: tauri::State<'_, TrackingClientState>,
    app_handle: tauri::AppHandle,
    tray_state: tauri::State<'_, TrayState>,
    lookup_cache: tauri::State<'_, LookupCacheState>,
) -> Result<Option<ApiServiceConfig>, String> {
    load_saved_api_service_config_runtime(
        &service_controller,
        &client_state,
        app_handle,
        &tray_state,
        &lookup_cache,
    )
}

#[tauri::command]
async fn get_api_service_status(
    service_controller: tauri::State<'_, ApiServiceController>,
    client_state: tauri::State<'_, TrackingClientState>,
    app_handle: tauri::AppHandle,
    tray_state: tauri::State<'_, TrayState>,
) -> Result<ApiServiceStatus, String> {
    Ok(get_api_service_status_checked_runtime(
        &service_controller,
        &client_state,
        app_handle,
        &tray_state,
    )
    .await)
}

#[tauri::command]
async fn test_external_tracking_source(
    config: ApiServiceConfig,
    client_state: tauri::State<'_, TrackingClientState>,
) -> Result<String, String> {
    test_external_tracking_source_runtime(config, &client_state).await
}

#[tauri::command]
async fn test_api_service_connection(
    config: ApiServiceConfig,
    client_state: tauri::State<'_, TrackingClientState>,
) -> Result<String, String> {
    test_api_service_connection_client(&client_state.client, &config).await
}

#[tauri::command]
fn validate_tracking_source_config(config: ApiServiceConfig) -> Result<(), String> {
    validate_tracking_source_config_runtime(config)
}

#[tauri::command]
fn get_release_health(app_handle: tauri::AppHandle) -> AppReleaseHealth {
    app_release_health(&app_handle)
}

#[tauri::command]
async fn check_app_update(app_handle: tauri::AppHandle) -> Result<AppUpdateStatus, String> {
    check_app_update_runtime(app_handle).await
}

#[tauri::command]
async fn install_app_update(app_handle: tauri::AppHandle) -> Result<AppUpdateStatus, String> {
    install_app_update_runtime(app_handle).await
}

pub fn run_service_settings_with_context(mut context: tauri::Context<tauri::Wry>) {
    crate::install_runtime_logging();
    let tracking_client = build_tracking_client("ShipFlow Service/0.1");
    match load_service_window_icon() {
        Ok(icon) => {
            context.set_default_window_icon(Some(icon.clone()));
            context.set_tray_icon(Some(icon));
        }
        Err(error) => log_runtime_event(
            "ERROR",
            format!("[ShipFlowService] failed to load service icon: {error}"),
        ),
    }
    context.config_mut().app.windows.clear();

    let builder = tauri::Builder::default()
        .plugin(build_service_settings_single_instance_plugin())
        .manage(TrackingClientState {
            client: tracking_client,
            source_config: Arc::new(Mutex::new(TrackingSourceConfig::default())),
        })
        .manage(LookupCacheState::with_log_sink(|level, message| {
            log_runtime_event(level, message)
        }))
        .manage(ApiServiceController::default())
        .manage(TrayState::default())
        .setup(service_settings_setup)
        .on_window_event(handle_service_settings_window_event);

    let builder = maybe_install_signed_updater_plugin(builder, context.config());

    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(build_service_settings_menu)
        .on_menu_event(|app, event| handle_service_settings_menu_event(app, event.id().as_ref()));

    let app = builder
        .invoke_handler(tauri::generate_handler![
            track_bag,
            track_manifest,
            open_external_url,
            copy_to_clipboard,
            read_from_clipboard,
            log_frontend_runtime_event,
            configure_api_service,
            load_saved_api_service_config,
            get_api_service_status,
            test_api_service_connection,
            test_external_tracking_source,
            validate_tracking_source_config,
            get_release_health,
            check_app_update,
            install_app_update
        ])
        .build(context)
        .expect("error while building ShipFlow Service");

    app.run(handle_service_settings_run_event);
}

fn handle_service_settings_run_event(_app: &tauri::AppHandle, event: tauri::RunEvent) {
    match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            service::stop_service_process();
            service::stop_service_tray_companion();
            service::clear_current_service_settings_process();
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            if let Err(error) = open_service_settings_window_runtime(_app) {
                log_runtime_event(
                    "ERROR",
                    format!("[ShipFlowService] failed to reopen service settings window: {error}"),
                );
            }
        }
        _ => {}
    }
}
