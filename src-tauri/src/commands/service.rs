use shipflow_tauri_runtime::lookup_runtime::LookupCacheState;
use shipflow_tauri_runtime::service::{ApiServiceConfig, ApiServiceController, ApiServiceStatus};
use shipflow_tauri_runtime::service_client::test_api_service_connection as test_api_service_connection_client;
use shipflow_tauri_runtime::service_runtime::{
    configure_api_service_runtime, get_api_service_status_checked_runtime,
    load_saved_api_service_config_runtime, test_external_tracking_source_runtime,
    validate_tracking_source_config_runtime, TrayState,
};
use shipflow_tauri_runtime::tracking::model::TrackingClientState;

#[tauri::command]
pub async fn configure_api_service(
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
pub fn load_saved_api_service_config(
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
pub async fn get_api_service_status(
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
pub async fn test_external_tracking_source(
    config: ApiServiceConfig,
    client_state: tauri::State<'_, TrackingClientState>,
) -> Result<String, String> {
    test_external_tracking_source_runtime(config, &client_state).await
}

#[tauri::command]
pub async fn test_api_service_connection(
    config: ApiServiceConfig,
    client_state: tauri::State<'_, TrackingClientState>,
) -> Result<String, String> {
    test_api_service_connection_client(&client_state.client, &config).await
}

#[tauri::command]
pub fn validate_tracking_source_config(config: ApiServiceConfig) -> Result<(), String> {
    validate_tracking_source_config_runtime(config)
}
