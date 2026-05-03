use shipflow_tauri_runtime::lookup_runtime::LookupCacheState;
use shipflow_tauri_runtime::service::{
    load_desktop_service_connection_config, ApiServiceConfig, ApiServiceController,
    ApiServiceStatus, ApiServiceStatusKind,
};
use shipflow_tauri_runtime::service_client::test_api_service_connection as test_api_service_connection_client;
use shipflow_tauri_runtime::service_runtime::{
    configure_api_service_runtime, test_external_tracking_source_runtime,
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
    _service_controller: tauri::State<'_, ApiServiceController>,
    _client_state: tauri::State<'_, TrackingClientState>,
    _app_handle: tauri::AppHandle,
    _tray_state: tauri::State<'_, TrayState>,
    _lookup_cache: tauri::State<'_, LookupCacheState>,
) -> Result<Option<ApiServiceConfig>, String> {
    load_desktop_service_connection_config()
}

#[tauri::command]
pub async fn get_api_service_status(
    _service_controller: tauri::State<'_, ApiServiceController>,
    client_state: tauri::State<'_, TrackingClientState>,
    _app_handle: tauri::AppHandle,
    _tray_state: tauri::State<'_, TrayState>,
) -> Result<ApiServiceStatus, String> {
    let Some(config) = load_desktop_service_connection_config()? else {
        return Ok(ApiServiceStatus::default());
    };

    let base_url = config.service_client_base_url();
    let parsed_url = tauri::Url::parse(&base_url).ok();
    let status = match test_api_service_connection_client(&client_state.client, &config).await {
        Ok(_) => ApiServiceStatus {
            status: ApiServiceStatusKind::Running,
            enabled: true,
            mode: Some(config.mode.clone()),
            bind_address: parsed_url
                .as_ref()
                .and_then(|url| url.host_str())
                .map(ToOwned::to_owned)
                .or(Some(base_url)),
            port: parsed_url
                .as_ref()
                .and_then(|url| url.port_or_known_default()),
            error_message: None,
        },
        Err(error) => ApiServiceStatus {
            status: ApiServiceStatusKind::Error,
            enabled: true,
            mode: Some(config.mode.clone()),
            bind_address: parsed_url
                .as_ref()
                .and_then(|url| url.host_str())
                .map(ToOwned::to_owned)
                .or(Some(base_url)),
            port: parsed_url
                .as_ref()
                .and_then(|url| url.port_or_known_default()),
            error_message: Some(error),
        },
    };

    Ok(status)
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
