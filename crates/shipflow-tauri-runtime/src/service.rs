mod http_api;
mod process_runtime;
mod runtime_config;
mod state_store;
mod tray_runtime;

use std::{
    env,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::{Deserialize, Serialize};

use self::http_api::run_service_process;
use self::process_runtime::{
    claim_current_service_tray_process, ensure_service_tray_process_running,
    is_expected_service_process, is_service_runtime_ready,
    launch_shipflow_service_settings_companion, service_runtime_readiness_failure_hint,
    spawn_service_process, stop_service_process as stop_api_service_process,
    stop_service_settings_process as stop_settings_ui_process,
    stop_service_tray_process as stop_tray_process, sync_service_tray_companion,
    wait_for_service_runtime,
};
#[cfg(target_os = "windows")]
use self::process_runtime::{
    claim_desktop_ui_single_instance, claim_service_settings_ui_single_instance,
    request_desktop_activation_and_wait, request_service_settings_activation_and_wait,
};
use self::runtime_config::{
    error_status, running_status, stopped_status, validate_desktop_service_connection_config,
    validate_service_config,
};
#[cfg(target_os = "windows")]
use self::state_store::clear_recorded_service_settings_pid;
use self::state_store::{
    load_desktop_service_config, load_runtime_config, load_saved_config,
    persist_desktop_service_config, persist_runtime_config, persist_saved_config,
    persist_service_pid, read_recorded_pid,
};
use self::tray_runtime::run_service_tray_app;
use crate::tracking::model::{TrackingSource, TrackingSourceConfig};

pub use self::state_store::{
    clear_current_desktop_process, clear_current_service_settings_process,
    load_saved_api_service_config, load_window_state, persist_window_state,
    register_current_desktop_process, register_current_service_settings_process,
    take_pending_desktop_activation_request, take_pending_service_settings_activation_request,
    SavedWindowState,
};

const SERVICE_PROCESS_FLAG: &str = "--shipflow-service-process";
const SERVICE_AUTOSTART_FLAG: &str = "--shipflow-service-autostart";
const SERVICE_TRAY_FLAG: &str = "--shipflow-service-tray";
const SERVICE_OPEN_SETTINGS_FLAG: &str = "--shipflow-service-open-settings";
pub use shipflow_service_runtime::SERVICE_STATUS_PRODUCT;
pub const SERVICE_STATE_DIR_NAME: &str = "shipflow-service-runtime";
const SERVICE_CONFIG_FILE_NAME: &str = "config.json";
const DESKTOP_SERVICE_CONFIG_FILE_NAME: &str = "desktop-service-config.json";
const SERVICE_RUNTIME_CONFIG_FILE_NAME: &str = "runtime-config.json";
const SERVICE_TOKEN_VAULT_FILE_NAME: &str = "tokens.json";
const WINDOW_STATE_FILE_NAME: &str = "window-state.json";
const SERVICE_PID_FILE_NAME: &str = "pid";
const SERVICE_TRAY_PID_FILE_NAME: &str = "tray.pid";
const SERVICE_TRAY_LAUNCH_LOCK_FILE_NAME: &str = "tray-launch.lock";
const DESKTOP_PID_FILE_NAME: &str = "desktop.pid";
const DESKTOP_REQUEST_FILE_NAME: &str = "desktop-request.json";
const SERVICE_COMPANION_BINARY_BASENAME: &str = "shipflow-service";
const DESKTOP_BINARY_BASENAME: &str = "shipflow3-tauri";
const DESKTOP_PRODUCT_BASENAME: &str = "ShipFlow Desktop";
pub const SERVICE_TRAY_ID: &str = "shipflow-service-tray";
const SERVICE_TRAY_STATUS_ID: &str = "service-tray-status";
const SERVICE_TRAY_OPEN_SETTINGS_ID: &str = "service-tray-open-settings";
const SERVICE_TRAY_OPEN_DESKTOP_ID: &str = "service-tray-open-desktop";
const SERVICE_TRAY_COPY_ENDPOINT_ID: &str = "service-tray-copy-endpoint";
const SERVICE_TRAY_COPY_TOKEN_ID: &str = "service-tray-copy-token";
const SERVICE_TRAY_RESTART_SERVICE_ID: &str = "service-tray-restart-service";
const SERVICE_TRAY_STOP_SERVICE_ID: &str = "service-tray-stop-service";
const SERVICE_TRAY_QUIT_ID: &str = "service-tray-quit";
const SERVICE_TRAY_REFRESH_INTERVAL: Duration = Duration::from_secs(5);
const SERVICE_SETTINGS_PID_FILE_NAME: &str = "service-settings.pid";
const SERVICE_SETTINGS_REQUEST_FILE_NAME: &str = "service-settings-request.json";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ApiServiceMode {
    Local,
    Lan,
}

impl ApiServiceMode {
    pub fn bind_address_label(&self) -> &'static str {
        match self {
            Self::Local => "127.0.0.1",
            Self::Lan => "0.0.0.0",
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DesktopServiceConnectionMode {
    #[default]
    ManagedLocal,
    Custom,
}

fn default_desktop_service_url() -> String {
    "http://127.0.0.1:18422".into()
}

fn default_start_at_login() -> bool {
    false
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApiServiceConfig {
    pub version: u8,
    #[serde(default)]
    pub desktop_connection_mode: DesktopServiceConnectionMode,
    #[serde(default = "default_desktop_service_url")]
    pub desktop_service_url: String,
    #[serde(default)]
    pub desktop_service_auth_token: String,
    pub enabled: bool,
    pub mode: ApiServiceMode,
    pub port: u16,
    pub auth_token: String,
    pub tracking_source: TrackingSource,
    pub external_api_base_url: String,
    pub external_api_auth_token: String,
    pub allow_insecure_external_api_http: bool,
    pub keep_running_in_tray: bool,
    #[serde(default = "default_start_at_login")]
    pub start_at_login: bool,
    pub last_updated_at: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum ApiServiceStatusKind {
    Stopped,
    Running,
    Error,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiServiceStatus {
    pub status: ApiServiceStatusKind,
    pub enabled: bool,
    pub mode: Option<ApiServiceMode>,
    pub bind_address: Option<String>,
    pub port: Option<u16>,
    pub error_message: Option<String>,
}

impl Default for ApiServiceStatus {
    fn default() -> Self {
        Self {
            status: ApiServiceStatusKind::Stopped,
            enabled: false,
            mode: None,
            bind_address: None,
            port: None,
            error_message: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActivationRequest {
    pub focus_main_window: bool,
}

#[derive(Default)]
struct ApiServiceRuntime {
    status: ApiServiceStatus,
}

#[derive(Clone, Default)]
pub struct ApiServiceController {
    inner: Arc<Mutex<ApiServiceRuntime>>,
}

impl ApiServiceController {
    pub async fn configure(&self, config: ApiServiceConfig) -> Result<ApiServiceStatus, String> {
        let bind_address = config.mode.bind_address_label().to_string();
        validate_desktop_service_connection_config(&config)?;

        if config.uses_custom_desktop_service_connection() {
            persist_desktop_service_connection_config(&config)?;
            let status = running_status(&config);
            self.set_status(status.clone());
            return Ok(status);
        }

        if !config.enabled {
            stop_service_process();
            persist_saved_config(&config)?;
            let status = stopped_status(&config);
            self.set_status(status.clone());
            return Ok(status);
        }

        validate_service_config(&config, &bind_address)?;
        persist_saved_config(&config)?;

        if let Some(saved_config) = self.load_saved_config()? {
            if saved_config == config
                && read_recorded_pid().is_some_and(|pid| {
                    is_expected_service_process(pid, SERVICE_PROCESS_FLAG)
                        && is_service_runtime_ready(&config, Duration::from_millis(200))
                })
            {
                persist_runtime_config(&config)?;
                let status = running_status(&config);
                self.set_status(status.clone());
                return Ok(status);
            }
        }

        stop_service_process();
        // `stop_service_process` clears runtime-config.json, so the config must be written
        // after stopping the old process and before spawning the new one.
        persist_runtime_config(&config)?;
        let pid = match spawn_service_process(&config) {
            Ok(pid) => pid,
            Err(error) => {
                let status = error_status(&config, &bind_address, error);
                self.set_status(status.clone());
                return Ok(status);
            }
        };
        if let Err(error) = persist_service_pid(pid) {
            let status = error_status(&config, &bind_address, error);
            self.set_status(status.clone());
            return Ok(status);
        }

        let runtime_ready = wait_for_service_runtime(&config, Duration::from_secs(5));
        let expected_process = is_expected_service_process(pid, SERVICE_PROCESS_FLAG);
        if !runtime_ready || !expected_process {
            let mut readiness_error =
                service_runtime_readiness_failure_hint(&config, Duration::from_millis(300))
                    .unwrap_or_else(|| "API service failed to become ready.".into());
            if !expected_process {
                readiness_error.push_str(
                    " The launched service process exited or did not match the expected ShipFlow Service background command.",
                );
            }
            stop_service_process();
            let status = error_status(&config, &bind_address, readiness_error);
            self.set_status(status.clone());
            return Ok(status);
        }

        let status = running_status(&config);
        self.set_status(status.clone());
        Ok(status)
    }

    pub fn status(&self) -> ApiServiceStatus {
        let status = match self.load_saved_config() {
            Ok(Some(config)) if config.uses_custom_desktop_service_connection() => error_status(
                &config,
                &config.service_client_base_url(),
                "ShipFlow Service status has not been checked yet.".into(),
            ),
            Ok(Some(config)) if !config.enabled => stopped_status(&config),
            Ok(Some(config)) => {
                let bind_address = config.mode.bind_address_label().to_string();
                match read_recorded_pid() {
                    Some(pid)
                        if is_expected_service_process(pid, SERVICE_PROCESS_FLAG)
                            && is_service_runtime_ready(&config, Duration::from_millis(200)) =>
                    {
                        running_status(&config)
                    }
                    Some(_) => error_status(
                        &config,
                        &bind_address,
                        "API service is not responding.".into(),
                    ),
                    None => stopped_status(&config),
                }
            }
            Ok(None) | Err(_) => ApiServiceStatus::default(),
        };

        self.set_status(status.clone());
        status
    }

    pub fn load_saved_config(&self) -> Result<Option<ApiServiceConfig>, String> {
        load_saved_config()
    }

    fn set_status(&self, status: ApiServiceStatus) {
        let mut runtime = self.inner.lock().expect("service runtime lock poisoned");
        runtime.status = status;
    }
}

impl ApiServiceConfig {
    pub fn tracking_source_config(&self) -> TrackingSourceConfig {
        TrackingSourceConfig {
            tracking_source: self.tracking_source.clone(),
            external_api_base_url: self.external_api_base_url.clone(),
            external_api_auth_token: self.external_api_auth_token.clone(),
            allow_insecure_external_api_http: self.allow_insecure_external_api_http,
        }
    }

    pub fn uses_custom_desktop_service_connection(&self) -> bool {
        self.desktop_connection_mode == DesktopServiceConnectionMode::Custom
    }

    pub fn service_client_base_url(&self) -> String {
        if self.uses_custom_desktop_service_connection() {
            let trimmed_url = self.desktop_service_url.trim().trim_end_matches('/');
            if !trimmed_url.is_empty() {
                return trimmed_url.to_string();
            }
        }

        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn service_client_auth_token(&self) -> &str {
        if self.uses_custom_desktop_service_connection() {
            return self.desktop_service_auth_token.trim();
        }

        self.auth_token.trim()
    }
}

pub fn config_as_desktop_service_connection(mut config: ApiServiceConfig) -> ApiServiceConfig {
    if !config.uses_custom_desktop_service_connection() {
        config.desktop_connection_mode = DesktopServiceConnectionMode::Custom;
        config.desktop_service_url = format!("http://127.0.0.1:{}", config.port);
        config.desktop_service_auth_token = config.auth_token.clone();
    }

    config
}

pub fn maybe_delegate_desktop_launch_to_existing_process() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        if !claim_desktop_ui_single_instance()? {
            request_desktop_activation_and_wait()?;
            return Ok(true);
        }

        Ok(false)
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(false)
    }
}

pub fn maybe_delegate_service_settings_launch_to_existing_process() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let should_show_window = should_show_service_settings_window_from_current_args();
        if !claim_service_settings_ui_single_instance()? {
            request_service_settings_activation_and_wait(should_show_window)?;
            return Ok(true);
        }

        clear_recorded_service_settings_pid();
        Ok(false)
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(false)
    }
}

pub fn launch_service_settings_app() -> Result<(), String> {
    launch_shipflow_service_settings_companion()
}

pub fn should_show_service_settings_window_from_current_args() -> bool {
    should_show_service_settings_window_for_args(env::args())
}

pub fn should_show_service_settings_window_for_args<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut has_open_settings_flag = false;
    let mut has_background_flag = false;

    for argument in args {
        match argument.as_ref() {
            SERVICE_OPEN_SETTINGS_FLAG => has_open_settings_flag = true,
            SERVICE_AUTOSTART_FLAG | SERVICE_TRAY_FLAG | SERVICE_PROCESS_FLAG => {
                has_background_flag = true
            }
            _ => {}
        }
    }

    has_open_settings_flag || !has_background_flag
}

pub fn ensure_tracking_service_runtime(
    saved_config: Option<ApiServiceConfig>,
) -> Result<ApiServiceConfig, String> {
    let Some(config) = saved_config else {
        return Err(
            "ShipFlow Desktop requires a standalone ShipFlow Service URL and token before tracking."
                .into(),
        );
    };

    let config = config_as_desktop_service_connection(config);
    validate_desktop_service_connection_config(&config)?;
    Ok(config)
}

pub fn load_desktop_tracking_service_config() -> Result<Option<ApiServiceConfig>, String> {
    if let Some(config) = load_desktop_service_config()? {
        return Ok(Some(config));
    }

    load_saved_config()
}

pub fn load_desktop_service_connection_config() -> Result<Option<ApiServiceConfig>, String> {
    match load_desktop_tracking_service_config()? {
        Some(config) => Ok(Some(config_as_desktop_service_connection(config))),
        None => Ok(None),
    }
}

pub fn persist_desktop_service_connection_config(config: &ApiServiceConfig) -> Result<(), String> {
    let config = config_as_desktop_service_connection(config.clone());
    validate_desktop_service_connection_config(&config)?;
    persist_desktop_service_config(&config)
}

pub fn maybe_run_service_autostart_from_current_args() -> Result<bool, String> {
    let is_service_autostart = env::args()
        .skip(1)
        .any(|argument| argument == SERVICE_AUTOSTART_FLAG);
    if !is_service_autostart {
        return Ok(false);
    }

    let Some(config) = load_saved_config()? else {
        return Ok(true);
    };

    if !config.start_at_login || config.uses_custom_desktop_service_connection() {
        return Ok(true);
    }

    if config.enabled {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| format!("Unable to create service autostart runtime: {error}"))?;
        runtime.block_on(ApiServiceController::default().configure(config.clone()))?;
    }

    if config.keep_running_in_tray {
        ensure_service_tray_process_running()?;
    }

    Ok(true)
}

pub fn maybe_run_service_tray_from_current_args() -> Result<bool, String> {
    let is_service_tray_process = env::args()
        .skip(1)
        .any(|argument| argument == SERVICE_TRAY_FLAG);
    if !is_service_tray_process {
        return Ok(false);
    }

    if !claim_current_service_tray_process()? {
        return Ok(true);
    }

    run_service_tray_app()
}

pub fn sync_service_tray_companion_for_config(config: &ApiServiceConfig) -> Result<(), String> {
    sync_service_tray_companion(config)
}

pub fn ensure_service_tray_companion_running() -> Result<(), String> {
    ensure_service_tray_process_running()
}

pub fn stop_service_process() {
    stop_api_service_process();
}

pub fn stop_service_tray_companion() {
    stop_tray_process();
}

pub fn stop_service_settings_companion() {
    stop_settings_ui_process();
}

pub fn maybe_run_service_process_from_current_args() -> Result<bool, String> {
    let mut is_service_process = false;

    for argument in env::args().skip(1) {
        if argument == SERVICE_PROCESS_FLAG {
            is_service_process = true;
        }
    }

    if !is_service_process {
        return Ok(false);
    }

    let config = load_runtime_config()?
        .ok_or_else(|| "Service process runtime configuration is required.".to_string())?;

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("Unable to create service runtime: {error}"))?;
    runtime.block_on(run_service_process(config))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        panic::{self, AssertUnwindSafe},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::{
        ensure_tracking_service_runtime, should_show_service_settings_window_for_args,
        state_store::{
            load_desktop_service_config, load_runtime_config, load_saved_config,
            persist_runtime_config, persist_saved_config,
        },
        ApiServiceConfig, ApiServiceController, ApiServiceMode, DesktopServiceConnectionMode,
    };
    use crate::test_support::runtime_state_dir_test_lock;
    use crate::tracking::model::TrackingSource;

    fn unique_temp_dir(prefix: &str) -> std::path::PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}-{timestamp}-{}", std::process::id()))
    }

    fn with_state_dir<T>(prefix: &str, run: impl FnOnce() -> T) -> T {
        let _guard = runtime_state_dir_test_lock()
            .lock()
            .expect("state dir test lock should not be poisoned");
        let state_dir = unique_temp_dir(prefix);
        let _ = fs::create_dir_all(&state_dir);
        std::env::set_var("SHIPFLOW_SERVICE_STATE_DIR_OVERRIDE", &state_dir);

        let result = panic::catch_unwind(AssertUnwindSafe(run));

        std::env::remove_var("SHIPFLOW_SERVICE_STATE_DIR_OVERRIDE");
        let _ = fs::remove_dir_all(&state_dir);

        match result {
            Ok(value) => value,
            Err(panic_payload) => panic::resume_unwind(panic_payload),
        }
    }

    fn service_runtime_config() -> ApiServiceConfig {
        ApiServiceConfig {
            version: 1,
            desktop_connection_mode: DesktopServiceConnectionMode::ManagedLocal,
            desktop_service_url: "http://127.0.0.1:18422".into(),
            desktop_service_auth_token: String::new(),
            enabled: true,
            mode: ApiServiceMode::Local,
            port: 18422,
            auth_token: "sf_service_token".into(),
            tracking_source: TrackingSource::Default,
            external_api_base_url: String::new(),
            external_api_auth_token: String::new(),
            allow_insecure_external_api_http: false,
            keep_running_in_tray: true,
            start_at_login: true,
            last_updated_at: "2026-04-21T00:00:00.000Z".into(),
        }
    }

    fn desktop_custom_connection_config() -> ApiServiceConfig {
        ApiServiceConfig {
            desktop_connection_mode: DesktopServiceConnectionMode::Custom,
            desktop_service_url: "http://127.0.0.1:18422".into(),
            desktop_service_auth_token: "sf_desktop_token".into(),
            enabled: true,
            auth_token: String::new(),
            ..service_runtime_config()
        }
    }

    #[test]
    fn missing_start_at_login_deserializes_to_opt_in_disabled() {
        let config = serde_json::from_str::<ApiServiceConfig>(
            r#"{
              "version": 1,
              "desktopConnectionMode": "managedLocal",
              "desktopServiceUrl": "http://127.0.0.1:18422",
              "desktopServiceAuthToken": "",
              "enabled": true,
              "mode": "local",
              "port": 18422,
              "authToken": "sf_service_token",
              "trackingSource": "default",
              "externalApiBaseUrl": "",
              "externalApiAuthToken": "",
              "allowInsecureExternalApiHttp": false,
              "keepRunningInTray": true,
              "lastUpdatedAt": "2026-04-21T00:00:00.000Z"
            }"#,
        )
        .expect("legacy service config should deserialize");

        assert!(!config.start_at_login);
    }

    #[test]
    fn saving_custom_desktop_connection_preserves_service_runtime_config() {
        with_state_dir("shipflow-custom-desktop-config-test", || {
            let runtime_config = service_runtime_config();
            persist_runtime_config(&runtime_config).expect("runtime config should persist");

            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("test runtime should build");
            runtime
                .block_on(
                    ApiServiceController::default().configure(desktop_custom_connection_config()),
                )
                .expect("custom desktop connection should save");

            let loaded_runtime_config = load_runtime_config()
                .expect("runtime config should load")
                .expect("runtime config should still exist");
            assert_eq!(loaded_runtime_config, runtime_config);
        });
    }

    #[test]
    fn saving_custom_desktop_connection_does_not_replace_service_config() {
        with_state_dir("shipflow-custom-desktop-split-config-test", || {
            let service_config = service_runtime_config();
            let desktop_config = desktop_custom_connection_config();
            persist_saved_config(&service_config).expect("service config should persist");

            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("test runtime should build");
            runtime
                .block_on(ApiServiceController::default().configure(desktop_config.clone()))
                .expect("custom desktop connection should save");

            let loaded_service_config = load_saved_config()
                .expect("service config should load")
                .expect("service config should still exist");
            let loaded_desktop_config = load_desktop_service_config()
                .expect("desktop config should load")
                .expect("desktop config should exist");

            assert_eq!(loaded_service_config, service_config);
            assert_eq!(loaded_desktop_config, desktop_config);
        });
    }

    #[test]
    fn stopping_service_process_clears_runtime_config() {
        with_state_dir("shipflow-stop-clears-runtime-config-test", || {
            let runtime_config = service_runtime_config();
            persist_runtime_config(&runtime_config).expect("runtime config should persist");
            assert!(load_runtime_config()
                .expect("runtime config should load")
                .is_some());

            crate::service::stop_service_process();

            assert!(load_runtime_config()
                .expect("runtime config should load after stop")
                .is_none());
        });
    }

    #[test]
    fn desktop_tracking_uses_service_runtime_config_as_standalone_connection() {
        let runtime_config = service_runtime_config();
        let resolved = ensure_tracking_service_runtime(Some(runtime_config))
            .expect("service runtime config should resolve to desktop service connection");

        assert_eq!(
            resolved.desktop_connection_mode,
            DesktopServiceConnectionMode::Custom
        );
        assert_eq!(resolved.desktop_service_url, "http://127.0.0.1:18422");
        assert_eq!(resolved.desktop_service_auth_token, "sf_service_token");
    }

    #[test]
    fn desktop_tracking_rejects_service_runtime_config_without_token() {
        let mut runtime_config = service_runtime_config();
        runtime_config.auth_token.clear();

        let error = ensure_tracking_service_runtime(Some(runtime_config))
            .expect_err("desktop tracking should still require the service API token");

        assert!(error.contains("token"));
    }

    #[test]
    fn service_settings_launch_shows_window_for_user_open_but_not_background_flags() {
        assert!(should_show_service_settings_window_for_args(
            std::iter::empty::<&str>()
        ));
        assert!(should_show_service_settings_window_for_args([
            "shipflow-service"
        ]));
        assert!(should_show_service_settings_window_for_args([
            "shipflow-service",
            super::SERVICE_OPEN_SETTINGS_FLAG
        ]));
        assert!(should_show_service_settings_window_for_args([
            super::SERVICE_OPEN_SETTINGS_FLAG
        ]));
        assert!(!should_show_service_settings_window_for_args([
            "shipflow-service",
            super::SERVICE_TRAY_FLAG
        ]));
        assert!(!should_show_service_settings_window_for_args([
            super::SERVICE_TRAY_FLAG
        ]));
        assert!(!should_show_service_settings_window_for_args([
            "shipflow-service",
            super::SERVICE_AUTOSTART_FLAG
        ]));
        assert!(!should_show_service_settings_window_for_args([
            super::SERVICE_AUTOSTART_FLAG
        ]));
        assert!(!should_show_service_settings_window_for_args([
            "shipflow-service",
            super::SERVICE_PROCESS_FLAG
        ]));
        assert!(!should_show_service_settings_window_for_args([
            super::SERVICE_PROCESS_FLAG
        ]));
    }

    #[test]
    fn service_settings_explicit_open_wins_over_background_launch_flags() {
        assert!(should_show_service_settings_window_for_args([
            "shipflow-service",
            super::SERVICE_TRAY_FLAG,
            super::SERVICE_OPEN_SETTINGS_FLAG
        ]));
        assert!(should_show_service_settings_window_for_args([
            "shipflow-service",
            super::SERVICE_AUTOSTART_FLAG,
            super::SERVICE_OPEN_SETTINGS_FLAG
        ]));
        assert!(should_show_service_settings_window_for_args([
            "shipflow-service",
            super::SERVICE_PROCESS_FLAG,
            super::SERVICE_OPEN_SETTINGS_FLAG
        ]));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn non_windows_ui_launch_delegation_is_owned_by_tauri_lifecycle() {
        assert!(!super::maybe_delegate_desktop_launch_to_existing_process()
            .expect("desktop pre-delegation should not fail off Windows"));
        assert!(
            !super::maybe_delegate_service_settings_launch_to_existing_process()
                .expect("service settings pre-delegation should not fail off Windows")
        );
    }
}
