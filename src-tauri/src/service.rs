mod http_api;
mod process_runtime;
mod runtime_config;
mod state_store;
mod tray_runtime;

use std::{
    env,
    net::{IpAddr, Ipv4Addr},
    sync::{Arc, Mutex},
    time::Duration,
};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};

use self::http_api::run_service_process;
use self::process_runtime::{
    is_process_alive, is_service_port_ready, spawn_service_process, stop_service_process,
    wait_for_service_port,
};
use self::runtime_config::{
    build_tracking_runtime_config, error_status, running_status, stopped_status,
    tracking_runtime_matches, validate_service_config,
};
use self::state_store::{
    clear_recorded_desktop_pid, clear_recorded_service_settings_pid, load_runtime_config,
    load_saved_config, persist_desktop_activation_request, persist_runtime_config,
    persist_saved_config, persist_service_pid, persist_service_settings_activation_request,
    read_recorded_desktop_pid, read_recorded_pid, read_recorded_service_settings_pid,
};
use self::tray_runtime::run_service_tray_app;
use crate::tracking::model::{TrackingSource, TrackingSourceConfig};

pub use self::process_runtime::{launch_shipflow_service_app, sync_service_tray_companion};
pub use self::state_store::{
    clear_current_desktop_process, clear_current_service_settings_process,
    load_saved_api_service_config, register_current_desktop_process,
    register_current_service_settings_process, take_pending_desktop_activation_request,
    take_pending_service_settings_activation_request,
};

const SERVICE_PROCESS_FLAG: &str = "--shipflow-service-process";
const SERVICE_TRAY_FLAG: &str = "--shipflow-service-tray";
const SERVICE_CONFIG_ARG: &str = "--service-config-base64";
pub(crate) const SERVICE_STATE_DIR_NAME: &str = "shipflow-service-runtime";
const SERVICE_CONFIG_FILE_NAME: &str = "config.json";
const SERVICE_RUNTIME_CONFIG_FILE_NAME: &str = "runtime-config.json";
const SERVICE_PID_FILE_NAME: &str = "pid";
const SERVICE_TRAY_PID_FILE_NAME: &str = "tray.pid";
const DESKTOP_PID_FILE_NAME: &str = "desktop.pid";
const DESKTOP_REQUEST_FILE_NAME: &str = "desktop-request.json";
const SERVICE_COMPANION_BINARY_BASENAME: &str = "shipflow-service";
const DESKTOP_BINARY_BASENAME: &str = "shipflow3-tauri";
const DESKTOP_PRODUCT_BASENAME: &str = "ShipFlow Desktop";
const SERVICE_TRAY_ID: &str = "shipflow-service-tray";
const SERVICE_TRAY_STATUS_ID: &str = "service-tray-status";
const SERVICE_TRAY_OPEN_SETTINGS_ID: &str = "service-tray-open-settings";
const SERVICE_TRAY_OPEN_DESKTOP_ID: &str = "service-tray-open-desktop";
const SERVICE_TRAY_COPY_ENDPOINT_ID: &str = "service-tray-copy-endpoint";
const SERVICE_TRAY_COPY_TOKEN_ID: &str = "service-tray-copy-token";
const SERVICE_TRAY_KEEP_RUNNING_ID: &str = "service-tray-keep-running";
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
    fn bind_address(&self) -> IpAddr {
        match self {
            Self::Local => IpAddr::V4(Ipv4Addr::LOCALHOST),
            Self::Lan => IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        }
    }

    pub fn bind_address_label(&self) -> &'static str {
        match self {
            Self::Local => "127.0.0.1",
            Self::Lan => "0.0.0.0",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApiServiceConfig {
    pub version: u8,
    pub enabled: bool,
    pub mode: ApiServiceMode,
    pub port: u16,
    pub auth_token: String,
    pub tracking_source: TrackingSource,
    pub external_api_base_url: String,
    pub external_api_auth_token: String,
    pub allow_insecure_external_api_http: bool,
    pub keep_running_in_tray: bool,
    pub last_updated_at: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
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
        persist_saved_config(&config)?;

        let bind_address = config.mode.bind_address_label().to_string();
        if !config.enabled {
            stop_service_process();
            let status = stopped_status(&config);
            self.set_status(status.clone());
            return Ok(status);
        }

        validate_service_config(&config, &bind_address)?;

        if let Some(saved_config) = self.load_saved_config()? {
            if saved_config == config
                && read_recorded_pid().is_some_and(is_process_alive)
                && is_service_port_ready(config.port, Duration::from_millis(200))
            {
                let _ = persist_runtime_config(&config);
                let status = running_status(&config);
                self.set_status(status.clone());
                return Ok(status);
            }
        }

        stop_service_process();
        let pid = spawn_service_process(&config)?;
        persist_service_pid(pid)?;
        persist_runtime_config(&config)?;

        if !wait_for_service_port(config.port, Duration::from_secs(5)) {
            stop_service_process();
            let status = error_status(
                &config,
                &bind_address,
                "API service companion failed to become ready.".into(),
            );
            self.set_status(status.clone());
            return Err(status
                .error_message
                .clone()
                .unwrap_or_else(|| "API service configuration failed.".into()));
        }

        let status = running_status(&config);
        self.set_status(status.clone());
        Ok(status)
    }

    pub fn status(&self) -> ApiServiceStatus {
        let status = match self.load_saved_config() {
            Ok(Some(config)) if !config.enabled => stopped_status(&config),
            Ok(Some(config)) => {
                let bind_address = config.mode.bind_address_label().to_string();
                match read_recorded_pid() {
                    Some(pid)
                        if is_process_alive(pid)
                            && is_service_port_ready(config.port, Duration::from_millis(200)) =>
                    {
                        running_status(&config)
                    }
                    Some(_) => error_status(
                        &config,
                        &bind_address,
                        "API service companion is not responding.".into(),
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
}

pub fn maybe_delegate_desktop_launch_to_existing_process() -> Result<bool, String> {
    if let Some(pid) = read_recorded_desktop_pid() {
        if is_process_alive(pid) {
            persist_desktop_activation_request(&DesktopActivationRequest {
                focus_main_window: true,
            })?;
            return Ok(true);
        }

        clear_recorded_desktop_pid();
    }

    Ok(false)
}

pub fn maybe_delegate_service_settings_launch_to_existing_process() -> Result<bool, String> {
    if let Some(pid) = read_recorded_service_settings_pid() {
        if is_process_alive(pid) {
            persist_service_settings_activation_request(&DesktopActivationRequest {
                focus_main_window: true,
            })?;
            return Ok(true);
        }

        clear_recorded_service_settings_pid();
    }

    Ok(false)
}

pub fn ensure_tracking_service_runtime(
    saved_config: Option<ApiServiceConfig>,
) -> Result<ApiServiceConfig, String> {
    let current_runtime_config = load_runtime_config().unwrap_or(None);
    let desired_runtime_config =
        build_tracking_runtime_config(saved_config, current_runtime_config.as_ref());

    if read_recorded_pid().is_some_and(is_process_alive)
        && is_service_port_ready(desired_runtime_config.port, Duration::from_millis(200))
        && current_runtime_config
            .as_ref()
            .is_some_and(|config| tracking_runtime_matches(config, &desired_runtime_config))
    {
        return Ok(current_runtime_config.unwrap_or(desired_runtime_config));
    }

    stop_service_process();
    let pid = spawn_service_process(&desired_runtime_config)?;
    persist_service_pid(pid)?;
    persist_runtime_config(&desired_runtime_config)?;

    if !wait_for_service_port(desired_runtime_config.port, Duration::from_secs(5)) {
        stop_service_process();
        return Err("ShipFlow Service runtime failed to become ready.".into());
    }

    Ok(desired_runtime_config)
}

pub fn maybe_run_service_tray_from_current_args() -> Result<bool, String> {
    let is_service_tray_process = env::args()
        .skip(1)
        .any(|argument| argument == SERVICE_TRAY_FLAG);
    if !is_service_tray_process {
        return Ok(false);
    }

    run_service_tray_app()
}

pub fn maybe_run_service_process_from_current_args() -> Result<bool, String> {
    let mut is_service_process = false;
    let mut encoded_config: Option<String> = None;
    let mut args = env::args().skip(1);

    while let Some(argument) = args.next() {
        if argument == SERVICE_PROCESS_FLAG {
            is_service_process = true;
            continue;
        }

        if argument == SERVICE_CONFIG_ARG {
            encoded_config = args.next();
        }
    }

    if !is_service_process {
        return Ok(false);
    }

    let encoded_config = encoded_config
        .ok_or_else(|| "Service process configuration argument is required.".to_string())?;
    let config_bytes = URL_SAFE_NO_PAD
        .decode(encoded_config)
        .map_err(|error| format!("Unable to decode service process configuration: {error}"))?;
    let config: ApiServiceConfig = serde_json::from_slice(&config_bytes)
        .map_err(|error| format!("Unable to parse service process configuration: {error}"))?;

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("Unable to create service runtime: {error}"))?;
    runtime.block_on(run_service_process(config))?;
    Ok(true)
}
