use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Runtime};

use crate::lookup_runtime::LookupCacheState;
use crate::runtime_log::log_runtime_event;
use crate::service::{
    sync_service_tray_companion_for_config, ApiServiceConfig, ApiServiceController, ApiServiceMode,
    ApiServiceStatus, DesktopServiceConnectionMode,
};
use crate::service_client::test_api_service_connection;
use crate::tracking;
use crate::tracking::model::{TrackingClientState, TrackingSource, TrackingSourceConfig};
use crate::tracking::upstream::{
    probe_external_api_status, validate_tracking_source_config as validate_tracking_source_settings,
};

#[derive(Clone)]
struct TrayServiceSnapshot {
    service_config: ApiServiceConfig,
    service_status: ApiServiceStatus,
}

impl Default for TrayServiceSnapshot {
    fn default() -> Self {
        Self {
            service_config: ApiServiceConfig {
                version: 1,
                desktop_connection_mode: DesktopServiceConnectionMode::ManagedLocal,
                desktop_service_url: "http://127.0.0.1:18422".into(),
                desktop_service_auth_token: String::new(),
                enabled: false,
                mode: ApiServiceMode::Local,
                port: 18422,
                auth_token: String::new(),
                tracking_source: TrackingSource::Default,
                external_api_base_url: String::new(),
                external_api_auth_token: String::new(),
                allow_insecure_external_api_http: false,
                keep_running_in_tray: true,
                last_updated_at: String::new(),
            },
            service_status: ApiServiceStatus::default(),
        }
    }
}

#[derive(Clone, Default)]
pub struct TrayState {
    inner: Arc<Mutex<TrayServiceSnapshot>>,
}

impl TrayState {
    pub fn snapshot(&self) -> ApiServiceConfig {
        self.inner
            .lock()
            .expect("tray state lock poisoned")
            .service_config
            .clone()
    }

    pub fn update_service(&self, config: &ApiServiceConfig, status: &ApiServiceStatus) {
        let mut snapshot = self.inner.lock().expect("tray state lock poisoned");
        snapshot.service_config = config.clone();
        snapshot.service_status = status.clone();
    }
}

pub fn default_tray_service_config() -> ApiServiceConfig {
    TrayServiceSnapshot::default().service_config
}

pub fn sync_service_tray<R: Runtime>(
    app: &AppHandle<R>,
    tray_state: &TrayState,
) -> tauri::Result<()> {
    if let Some(tray) = app.tray_by_id(crate::service::SERVICE_TRAY_ID) {
        let _ = tray.set_visible(false);
    }

    let _ = tray_state;

    Ok(())
}

fn tracking_error_message(error: tracking::model::TrackingError) -> String {
    match error {
        tracking::model::TrackingError::BadRequest(message)
        | tracking::model::TrackingError::NotFound(message)
        | tracking::model::TrackingError::Upstream(message) => message,
    }
}

pub async fn configure_api_service_runtime<R: Runtime>(
    app_handle: AppHandle<R>,
    mut config: ApiServiceConfig,
    client_state: &TrackingClientState,
    service_controller: &ApiServiceController,
    tray_state: &TrayState,
    lookup_cache: &LookupCacheState,
) -> Result<ApiServiceStatus, String> {
    if config.uses_custom_desktop_service_connection() {
        config.enabled = true;
        test_api_service_connection(&client_state.client, &config).await?;
    } else {
        validate_tracking_source_settings(&config.tracking_source_config())
            .map_err(tracking_error_message)?;
    }

    let tracking_source_config = config.tracking_source_config();
    let result = service_controller.configure(config.clone()).await;
    let status = match &result {
        Ok(status) => status.clone(),
        Err(_) => service_controller.status(),
    };

    tray_state.update_service(&config, &status);
    if let Err(error) = sync_service_tray(&app_handle, tray_state) {
        log_runtime_event(
            "ERROR",
            format!("[ShipFlowTray] failed to sync tray after configure: {error}"),
        );
    }
    if !config.uses_custom_desktop_service_connection() {
        if let Err(error) = sync_service_tray_companion_for_config(&config) {
            log_runtime_event(
                "ERROR",
                format!("[ShipFlowTray] failed to sync tray companion after configure: {error}"),
            );
        }
    }

    if result.is_ok() && client_state.update_source_config(tracking_source_config) {
        lookup_cache.invalidate_all("service_command_configure_api_service");
    }

    result
}

pub fn load_saved_api_service_config_runtime<R: Runtime>(
    service_controller: &ApiServiceController,
    client_state: &TrackingClientState,
    app_handle: AppHandle<R>,
    tray_state: &TrayState,
    lookup_cache: &LookupCacheState,
) -> Result<Option<ApiServiceConfig>, String> {
    let saved_config = service_controller.load_saved_config()?;

    let loaded_tracking_source = saved_config
        .as_ref()
        .map(ApiServiceConfig::tracking_source_config)
        .unwrap_or_else(TrackingSourceConfig::default);

    if client_state.update_source_config(loaded_tracking_source) {
        lookup_cache.invalidate_all("service_command_load_saved_config");
    }

    let status = service_controller.status();
    let tray_config = saved_config
        .clone()
        .unwrap_or_else(default_tray_service_config);

    tray_state.update_service(&tray_config, &status);
    if let Err(error) = sync_service_tray(&app_handle, tray_state) {
        log_runtime_event(
            "ERROR",
            format!("[ShipFlowTray] failed to sync tray after loading config: {error}"),
        );
    }

    Ok(saved_config)
}

pub fn get_api_service_status_runtime<R: Runtime>(
    service_controller: &ApiServiceController,
    app_handle: AppHandle<R>,
    tray_state: &TrayState,
) -> ApiServiceStatus {
    let status = service_controller.status();
    let config = tray_state.snapshot();
    tray_state.update_service(&config, &status);
    if let Err(error) = sync_service_tray(&app_handle, tray_state) {
        log_runtime_event(
            "ERROR",
            format!("[ShipFlowTray] failed to sync tray after status refresh: {error}"),
        );
    }
    status
}

fn custom_service_status_from_config(
    config: &ApiServiceConfig,
    status: crate::service::ApiServiceStatusKind,
    error_message: Option<String>,
) -> ApiServiceStatus {
    let base_url = config.service_client_base_url();
    let parsed_url = reqwest::Url::parse(&base_url).ok();

    ApiServiceStatus {
        status,
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
        error_message,
    }
}

pub async fn get_api_service_status_checked_runtime<R: Runtime>(
    service_controller: &ApiServiceController,
    client_state: &TrackingClientState,
    app_handle: AppHandle<R>,
    tray_state: &TrayState,
) -> ApiServiceStatus {
    match service_controller.load_saved_config() {
        Ok(Some(config)) if config.uses_custom_desktop_service_connection() => {
            let status = match test_api_service_connection(&client_state.client, &config).await {
                Ok(_) => custom_service_status_from_config(
                    &config,
                    crate::service::ApiServiceStatusKind::Running,
                    None,
                ),
                Err(error) => custom_service_status_from_config(
                    &config,
                    crate::service::ApiServiceStatusKind::Error,
                    Some(error),
                ),
            };

            tray_state.update_service(&config, &status);
            if let Err(error) = sync_service_tray(&app_handle, tray_state) {
                log_runtime_event(
                    "ERROR",
                    format!(
                        "[ShipFlowTray] failed to sync tray after checked status refresh: {error}"
                    ),
                );
            }

            status
        }
        _ => get_api_service_status_runtime(service_controller, app_handle, tray_state),
    }
}

pub async fn test_external_tracking_source_runtime(
    config: ApiServiceConfig,
    client_state: &TrackingClientState,
) -> Result<String, String> {
    probe_external_api_status(&client_state.client, &config.tracking_source_config())
        .await
        .map_err(tracking_error_message)
}

pub fn validate_tracking_source_config_runtime(config: ApiServiceConfig) -> Result<(), String> {
    validate_tracking_source_settings(&config.tracking_source_config())
        .map_err(tracking_error_message)
}
