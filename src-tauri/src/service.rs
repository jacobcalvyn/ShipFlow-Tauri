use std::{
    env, fs,
    io::{Cursor, ErrorKind},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
    path::{Path as FsPath, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{Path, State},
    http::{header::AUTHORIZATION, HeaderMap, StatusCode},
    routing::get,
    Json, Router,
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use png::Decoder as PngDecoder;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tao::{
    event::{Event, StartCause},
    event_loop::{ControlFlow, EventLoopBuilder},
};
use tray_icon::{
    menu::{CheckMenuItem, Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem},
    Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent,
};

use crate::tracking::{
    model::{TrackResponse, TrackingError, TrackingSource, TrackingSourceConfig},
    upstream::{resolve_tracking_request, validate_tracking_source_config},
};

const SERVICE_PROCESS_FLAG: &str = "--shipflow-service-process";
const SERVICE_TRAY_FLAG: &str = "--shipflow-service-tray";
const SERVICE_CONFIG_ARG: &str = "--service-config-base64";
const SERVICE_STATE_DIR_NAME: &str = "shipflow-service-runtime";
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

#[derive(Clone)]
struct HttpApiState {
    client: Client,
    auth_token: String,
    mode: ApiServiceMode,
    bind_address: String,
    port: u16,
    tracking_source: TrackingSourceConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

pub fn load_saved_api_service_config() -> Result<Option<ApiServiceConfig>, String> {
    load_saved_config()
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

pub fn register_current_desktop_process() -> Result<(), String> {
    ensure_service_state_dir()?;
    fs::write(desktop_pid_path(), std::process::id().to_string())
        .map_err(|error| format!("Unable to persist desktop process id: {error}"))
}

pub fn register_current_service_settings_process() -> Result<(), String> {
    ensure_service_state_dir()?;
    fs::write(service_settings_pid_path(), std::process::id().to_string())
        .map_err(|error| format!("Unable to persist service settings process id: {error}"))
}

pub fn clear_current_desktop_process() {
    clear_recorded_desktop_pid();
}

pub fn clear_current_service_settings_process() {
    clear_recorded_service_settings_pid();
}

pub fn take_pending_desktop_activation_request() -> Result<Option<DesktopActivationRequest>, String>
{
    let path = desktop_request_path();
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Unable to read pending desktop activation request: {error}"
            ))
        }
    };

    let _ = fs::remove_file(&path);
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| format!("Unable to parse desktop activation request: {error}"))
}

pub fn take_pending_service_settings_activation_request(
) -> Result<Option<DesktopActivationRequest>, String> {
    let path = service_settings_request_path();
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Unable to read pending service settings activation request: {error}"
            ))
        }
    };

    let _ = fs::remove_file(&path);
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| format!("Unable to parse service settings activation request: {error}"))
}

pub fn sync_service_tray_companion(config: &ApiServiceConfig) -> Result<(), String> {
    sync_service_tray_autostart(config)?;

    if config.enabled && config.keep_running_in_tray {
        ensure_service_tray_process_running()
    } else {
        stop_service_tray_process();
        Ok(())
    }
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

fn running_status(config: &ApiServiceConfig) -> ApiServiceStatus {
    ApiServiceStatus {
        status: ApiServiceStatusKind::Running,
        enabled: true,
        mode: Some(config.mode.clone()),
        bind_address: Some(config.mode.bind_address_label().to_string()),
        port: Some(config.port),
        error_message: None,
    }
}

fn stopped_status(config: &ApiServiceConfig) -> ApiServiceStatus {
    ApiServiceStatus {
        status: ApiServiceStatusKind::Stopped,
        enabled: false,
        mode: Some(config.mode.clone()),
        bind_address: Some(config.mode.bind_address_label().to_string()),
        port: Some(config.port),
        error_message: None,
    }
}

fn error_status(
    config: &ApiServiceConfig,
    bind_address: &str,
    message: String,
) -> ApiServiceStatus {
    ApiServiceStatus {
        status: ApiServiceStatusKind::Error,
        enabled: config.enabled,
        mode: Some(config.mode.clone()),
        bind_address: Some(bind_address.to_string()),
        port: Some(config.port),
        error_message: Some(message),
    }
}

fn validate_service_config(config: &ApiServiceConfig, bind_address: &str) -> Result<(), String> {
    if config.auth_token.trim().is_empty() {
        return Err("Auth token is required before enabling API service.".into());
    }

    let tracking_source = config.tracking_source_config();
    validate_tracking_source_config(&tracking_source).map_err(|error| match error {
        TrackingError::BadRequest(message)
        | TrackingError::NotFound(message)
        | TrackingError::Upstream(message) => message,
    })?;

    if config.port == 0 {
        return Err(format!(
            "Unable to start API service on {}:{}: invalid port.",
            bind_address, config.port
        ));
    }

    Ok(())
}

fn service_state_dir() -> PathBuf {
    env::temp_dir().join(SERVICE_STATE_DIR_NAME)
}

fn service_config_path() -> PathBuf {
    service_state_dir().join(SERVICE_CONFIG_FILE_NAME)
}

fn service_runtime_config_path() -> PathBuf {
    service_state_dir().join(SERVICE_RUNTIME_CONFIG_FILE_NAME)
}

fn service_pid_path() -> PathBuf {
    service_state_dir().join(SERVICE_PID_FILE_NAME)
}

fn service_tray_pid_path() -> PathBuf {
    service_state_dir().join(SERVICE_TRAY_PID_FILE_NAME)
}

fn service_settings_pid_path() -> PathBuf {
    service_state_dir().join(SERVICE_SETTINGS_PID_FILE_NAME)
}

fn desktop_pid_path() -> PathBuf {
    service_state_dir().join(DESKTOP_PID_FILE_NAME)
}

fn service_settings_request_path() -> PathBuf {
    service_state_dir().join(SERVICE_SETTINGS_REQUEST_FILE_NAME)
}

fn desktop_request_path() -> PathBuf {
    service_state_dir().join(DESKTOP_REQUEST_FILE_NAME)
}

fn ensure_service_state_dir() -> Result<(), String> {
    fs::create_dir_all(service_state_dir())
        .map_err(|error| format!("Unable to prepare service state directory: {error}"))
}

fn persist_saved_config(config: &ApiServiceConfig) -> Result<(), String> {
    ensure_service_state_dir()?;
    let serialized = serde_json::to_vec_pretty(config)
        .map_err(|error| format!("Unable to serialize API service configuration: {error}"))?;
    fs::write(service_config_path(), serialized)
        .map_err(|error| format!("Unable to persist API service configuration: {error}"))
}

fn persist_runtime_config(config: &ApiServiceConfig) -> Result<(), String> {
    ensure_service_state_dir()?;
    let serialized = serde_json::to_vec_pretty(config)
        .map_err(|error| format!("Unable to serialize runtime service configuration: {error}"))?;
    fs::write(service_runtime_config_path(), serialized)
        .map_err(|error| format!("Unable to persist runtime service configuration: {error}"))
}

fn load_saved_config() -> Result<Option<ApiServiceConfig>, String> {
    let path = service_config_path();
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Unable to read persisted API service configuration: {error}"
            ))
        }
    };

    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| format!("Unable to parse persisted API service configuration: {error}"))
}

fn load_runtime_config() -> Result<Option<ApiServiceConfig>, String> {
    let path = service_runtime_config_path();
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Unable to read runtime service configuration: {error}"
            ))
        }
    };

    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| format!("Unable to parse runtime service configuration: {error}"))
}

fn persist_service_pid(pid: u32) -> Result<(), String> {
    ensure_service_state_dir()?;
    fs::write(service_pid_path(), pid.to_string())
        .map_err(|error| format!("Unable to persist API service process id: {error}"))
}

fn persist_service_tray_pid(pid: u32) -> Result<(), String> {
    ensure_service_state_dir()?;
    fs::write(service_tray_pid_path(), pid.to_string())
        .map_err(|error| format!("Unable to persist API service tray process id: {error}"))
}

fn read_recorded_pid() -> Option<u32> {
    let raw_value = fs::read_to_string(service_pid_path()).ok()?;
    raw_value.trim().parse::<u32>().ok()
}

fn read_recorded_tray_pid() -> Option<u32> {
    let raw_value = fs::read_to_string(service_tray_pid_path()).ok()?;
    raw_value.trim().parse::<u32>().ok()
}

fn read_recorded_service_settings_pid() -> Option<u32> {
    let raw_value = fs::read_to_string(service_settings_pid_path()).ok()?;
    raw_value.trim().parse::<u32>().ok()
}

fn read_recorded_desktop_pid() -> Option<u32> {
    let raw_value = fs::read_to_string(desktop_pid_path()).ok()?;
    raw_value.trim().parse::<u32>().ok()
}

fn clear_recorded_pid() {
    let _ = fs::remove_file(service_pid_path());
}

fn clear_runtime_config() {
    let _ = fs::remove_file(service_runtime_config_path());
}

fn clear_recorded_tray_pid() {
    let _ = fs::remove_file(service_tray_pid_path());
}

fn clear_recorded_service_settings_pid() {
    let _ = fs::remove_file(service_settings_pid_path());
}

fn clear_recorded_desktop_pid() {
    let _ = fs::remove_file(desktop_pid_path());
}

fn persist_service_settings_activation_request(
    request: &DesktopActivationRequest,
) -> Result<(), String> {
    ensure_service_state_dir()?;
    let payload = serde_json::to_vec(request).map_err(|error| {
        format!("Unable to serialize service settings activation request: {error}")
    })?;
    fs::write(service_settings_request_path(), payload)
        .map_err(|error| format!("Unable to persist service settings activation request: {error}"))
}

fn persist_desktop_activation_request(request: &DesktopActivationRequest) -> Result<(), String> {
    ensure_service_state_dir()?;
    let payload = serde_json::to_vec(request)
        .map_err(|error| format!("Unable to serialize desktop activation request: {error}"))?;
    fs::write(desktop_request_path(), payload)
        .map_err(|error| format!("Unable to persist desktop activation request: {error}"))
}

fn spawn_service_process(config: &ApiServiceConfig) -> Result<u32, String> {
    let executable = resolve_service_companion_executable()?;
    let encoded_config = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(config)
            .map_err(|error| format!("Unable to serialize API service configuration: {error}"))?,
    );

    let child = Command::new(executable)
        .arg(SERVICE_PROCESS_FLAG)
        .arg(SERVICE_CONFIG_ARG)
        .arg(encoded_config)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Unable to launch API service companion: {error}"))?;

    Ok(child.id())
}

fn ensure_service_tray_process_running() -> Result<(), String> {
    if read_recorded_tray_pid().is_some_and(is_process_alive) {
        return Ok(());
    }

    let pid = spawn_service_tray_process()?;
    persist_service_tray_pid(pid)
}

fn spawn_service_tray_process() -> Result<u32, String> {
    let executable = resolve_service_companion_executable()?;
    let child = Command::new(executable)
        .arg(SERVICE_TRAY_FLAG)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Unable to launch API service tray companion: {error}"))?;

    Ok(child.id())
}

fn launch_shipflow_service_settings() -> Result<(), String> {
    let executable = resolve_service_companion_executable()?;
    Command::new(executable)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Unable to launch ShipFlow Service: {error}"))?;
    Ok(())
}

pub fn launch_shipflow_service_app() -> Result<(), String> {
    launch_shipflow_service_settings()
}

fn resolve_service_companion_executable() -> Result<PathBuf, String> {
    let current_executable = env::current_exe()
        .map_err(|error| format!("Unable to resolve ShipFlow executable path: {error}"))?;

    for candidate in service_companion_candidates(&current_executable) {
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    Ok(current_executable)
}

fn resolve_desktop_companion_executable() -> Result<PathBuf, String> {
    let current_executable = env::current_exe()
        .map_err(|error| format!("Unable to resolve ShipFlow executable path: {error}"))?;

    for candidate in desktop_companion_candidates(&current_executable) {
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    Ok(current_executable)
}

fn service_companion_candidates(current_executable: &FsPath) -> Vec<PathBuf> {
    let Some(parent_dir) = current_executable.parent() else {
        return Vec::new();
    };

    let mut candidates = Vec::new();

    #[cfg(target_os = "windows")]
    {
        candidates.push(parent_dir.join(format!("{SERVICE_COMPANION_BINARY_BASENAME}.exe")));
    }

    #[cfg(not(target_os = "windows"))]
    {
        candidates.push(parent_dir.join(SERVICE_COMPANION_BINARY_BASENAME));
    }

    candidates
}

fn desktop_companion_candidates(current_executable: &FsPath) -> Vec<PathBuf> {
    let Some(parent_dir) = current_executable.parent() else {
        return Vec::new();
    };

    let mut candidates = Vec::new();

    #[cfg(target_os = "windows")]
    {
        candidates.push(parent_dir.join(format!("{DESKTOP_BINARY_BASENAME}.exe")));
        candidates.push(parent_dir.join(format!("{DESKTOP_PRODUCT_BASENAME}.exe")));
    }

    #[cfg(not(target_os = "windows"))]
    {
        candidates.push(parent_dir.join(DESKTOP_BINARY_BASENAME));
        candidates.push(parent_dir.join(DESKTOP_PRODUCT_BASENAME));
    }

    candidates
}

fn launch_shipflow_desktop() -> Result<(), String> {
    let executable = resolve_desktop_companion_executable()?;
    Command::new(executable)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Unable to launch ShipFlow Desktop: {error}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn service_tray_autostart_command() -> Result<String, String> {
    let executable = resolve_service_companion_executable()?;
    Ok(format!(
        "\"{}\" {}",
        executable.to_string_lossy(),
        SERVICE_TRAY_FLAG
    ))
}

fn sync_service_tray_autostart(config: &ApiServiceConfig) -> Result<(), String> {
    if config.enabled && config.keep_running_in_tray {
        enable_service_tray_autostart()
    } else {
        disable_service_tray_autostart()
    }
}

fn enable_service_tray_autostart() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let home_dir = env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "Unable to resolve HOME directory for autostart.".to_string())?;
        let launch_agents_dir = home_dir.join("Library/LaunchAgents");
        fs::create_dir_all(&launch_agents_dir)
            .map_err(|error| format!("Unable to create LaunchAgents directory: {error}"))?;
        let plist_path = launch_agents_dir.join("com.shipflow.service-tray.plist");
        let executable = resolve_service_companion_executable()?;
        let plist = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.shipflow.service-tray</string>
  <key>ProgramArguments</key>
  <array>
    <string>{}</string>
    <string>{}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
"#,
            xml_escape(&executable.to_string_lossy()),
            SERVICE_TRAY_FLAG
        );
        fs::write(plist_path, plist)
            .map_err(|error| format!("Unable to write LaunchAgent plist: {error}"))?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        let command = service_tray_autostart_command()?;
        let status = Command::new("reg")
            .args([
                "add",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                "ShipFlowServiceTray",
                "/t",
                "REG_SZ",
                "/d",
                &command,
                "/f",
            ])
            .status()
            .map_err(|error| format!("Unable to configure Windows autostart: {error}"))?;

        if !status.success() {
            return Err("Windows autostart command failed.".into());
        }
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let home_dir = env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "Unable to resolve HOME directory for autostart.".to_string())?;
        let autostart_dir = home_dir.join(".config/autostart");
        fs::create_dir_all(&autostart_dir)
            .map_err(|error| format!("Unable to create autostart directory: {error}"))?;
        let desktop_path = autostart_dir.join("shipflow-service-tray.desktop");
        let executable = resolve_service_companion_executable()?;
        let desktop_file = format!(
            "[Desktop Entry]\nType=Application\nName=ShipFlow Service Tray\nExec=\"{}\" {}\nX-GNOME-Autostart-enabled=true\nTerminal=false\n",
            executable.to_string_lossy(),
            SERVICE_TRAY_FLAG
        );
        fs::write(desktop_path, desktop_file)
            .map_err(|error| format!("Unable to write autostart desktop entry: {error}"))?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Ok(())
}

fn disable_service_tray_autostart() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let home_dir = env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "Unable to resolve HOME directory for autostart.".to_string())?;
        let plist_path = home_dir.join("Library/LaunchAgents/com.shipflow.service-tray.plist");
        if plist_path.exists() {
            fs::remove_file(plist_path)
                .map_err(|error| format!("Unable to remove LaunchAgent plist: {error}"))?;
        }
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("reg")
            .args([
                "delete",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                "ShipFlowServiceTray",
                "/f",
            ])
            .status();
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let home_dir = env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "Unable to resolve HOME directory for autostart.".to_string())?;
        let desktop_path = home_dir.join(".config/autostart/shipflow-service-tray.desktop");
        if desktop_path.exists() {
            fs::remove_file(desktop_path)
                .map_err(|error| format!("Unable to remove autostart desktop entry: {error}"))?;
        }
        return Ok(());
    }

    #[allow(unreachable_code)]
    Ok(())
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn stop_service_process() {
    if let Some(pid) = read_recorded_pid() {
        let _ = terminate_process(pid);
    }

    clear_recorded_pid();
    clear_runtime_config();
}

fn generate_internal_service_token() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("sf_internal_{timestamp:x}_{}", std::process::id())
}

fn build_tracking_runtime_config(
    saved_config: Option<ApiServiceConfig>,
    current_runtime_config: Option<&ApiServiceConfig>,
) -> ApiServiceConfig {
    let base_config = saved_config.unwrap_or(ApiServiceConfig {
        version: 1,
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
    });

    let auth_token = if base_config.auth_token.trim().is_empty() {
        current_runtime_config
            .map(|config| config.auth_token.trim())
            .filter(|token| !token.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(generate_internal_service_token)
    } else {
        base_config.auth_token.clone()
    };

    ApiServiceConfig {
        version: 1,
        enabled: true,
        mode: if base_config.enabled {
            base_config.mode
        } else {
            ApiServiceMode::Local
        },
        port: base_config.port,
        auth_token,
        tracking_source: base_config.tracking_source,
        external_api_base_url: base_config.external_api_base_url,
        external_api_auth_token: base_config.external_api_auth_token,
        allow_insecure_external_api_http: base_config.allow_insecure_external_api_http,
        keep_running_in_tray: if base_config.enabled {
            base_config.keep_running_in_tray
        } else {
            false
        },
        last_updated_at: base_config.last_updated_at,
    }
}

fn tracking_runtime_matches(left: &ApiServiceConfig, right: &ApiServiceConfig) -> bool {
    left.mode == right.mode
        && left.port == right.port
        && left.auth_token == right.auth_token
        && left.tracking_source == right.tracking_source
        && left.external_api_base_url == right.external_api_base_url
        && left.external_api_auth_token == right.external_api_auth_token
        && left.allow_insecure_external_api_http == right.allow_insecure_external_api_http
}

fn stop_service_tray_process() {
    if let Some(pid) = read_recorded_tray_pid() {
        let _ = terminate_process(pid);
    }

    clear_recorded_tray_pid();
}

fn terminate_process(pid: u32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let status = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status()
            .map_err(|error| format!("Unable to terminate API service companion: {error}"))?;

        if !status.success() {
            return Err("Unable to terminate API service companion.".into());
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let status = Command::new("kill")
            .arg(pid.to_string())
            .status()
            .map_err(|error| format!("Unable to terminate API service companion: {error}"))?;

        if !status.success() {
            return Err("Unable to terminate API service companion.".into());
        }

        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if !is_process_alive(pid) {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(75));
        }

        let force_status = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status()
            .map_err(|error| format!("Unable to force-stop API service companion: {error}"))?;

        if !force_status.success() {
            return Err("Unable to force-stop API service companion.".into());
        }
    }

    Ok(())
}

fn is_process_alive(pid: u32) -> bool {
    #[cfg(target_os = "windows")]
    {
        return Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}")])
            .output()
            .map(|output| {
                let stdout = String::from_utf8_lossy(&output.stdout);
                stdout.contains(&pid.to_string())
            })
            .unwrap_or(false);
    }

    #[cfg(not(target_os = "windows"))]
    {
        return Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
    }
}

fn service_probe_socket_addr(port: u16) -> SocketAddr {
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)
}

fn is_service_port_ready(port: u16, timeout: Duration) -> bool {
    TcpStream::connect_timeout(&service_probe_socket_addr(port), timeout).is_ok()
}

fn wait_for_service_port(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if is_service_port_ready(port, Duration::from_millis(200)) {
            return true;
        }
        thread::sleep(Duration::from_millis(75));
    }
    false
}

async fn run_service_process(config: ApiServiceConfig) -> Result<(), String> {
    let bind_address = config.mode.bind_address_label().to_string();
    validate_service_config(&config, &bind_address)?;

    let tracking_source = config.tracking_source_config();
    let socket_addr = SocketAddr::new(config.mode.bind_address(), config.port);
    let listener = tokio::net::TcpListener::bind(socket_addr)
        .await
        .map_err(|error| {
            format!(
                "Unable to start API service on {}:{}: {error}",
                bind_address, config.port
            )
        })?;

    let app_state = HttpApiState {
        client: Client::new(),
        auth_token: config.auth_token.clone(),
        mode: config.mode,
        bind_address,
        port: config.port,
        tracking_source,
    };
    let router = build_router(app_state);

    axum::serve(listener, router)
        .await
        .map_err(|error| format!("API service stopped unexpectedly: {error}"))
}

fn build_router(app_state: HttpApiState) -> Router {
    Router::new()
        .route("/health", get(health_handler))
        .route("/status", get(status_handler))
        .route("/track/:shipment_id", get(track_handler))
        .with_state(app_state)
}

async fn health_handler() -> Json<Value> {
    Json(json!({ "ok": true }))
}

async fn status_handler(
    State(state): State<HttpApiState>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    authorize_request(&headers, &state.auth_token)?;

    Ok(Json(json!({
        "service": "running",
        "mode": state.mode,
        "bindAddress": state.bind_address,
        "port": state.port,
    })))
}

async fn track_handler(
    State(state): State<HttpApiState>,
    headers: HeaderMap,
    Path(shipment_id): Path<String>,
) -> Result<Json<TrackResponse>, (StatusCode, Json<Value>)> {
    authorize_request(&headers, &state.auth_token)?;

    resolve_tracking_request(&state.client, &state.tracking_source, shipment_id.trim())
        .await
        .map(Json)
        .map_err(map_tracking_error)
}

fn authorize_request(
    headers: &HeaderMap,
    expected_token: &str,
) -> Result<(), (StatusCode, Json<Value>)> {
    let Some(raw_header) = headers.get(AUTHORIZATION) else {
        return Err(error_response(
            StatusCode::UNAUTHORIZED,
            "Authorization header is required.",
        ));
    };

    let Ok(header_value) = raw_header.to_str() else {
        return Err(error_response(
            StatusCode::UNAUTHORIZED,
            "Authorization header is invalid.",
        ));
    };

    let Some(token) = header_value.strip_prefix("Bearer ") else {
        return Err(error_response(
            StatusCode::UNAUTHORIZED,
            "Authorization header must use Bearer token.",
        ));
    };

    if token != expected_token {
        return Err(error_response(
            StatusCode::UNAUTHORIZED,
            "Bearer token is invalid.",
        ));
    }

    Ok(())
}

fn map_tracking_error(error: TrackingError) -> (StatusCode, Json<Value>) {
    match error {
        TrackingError::BadRequest(message) => error_response(StatusCode::BAD_REQUEST, &message),
        TrackingError::NotFound(message) => error_response(StatusCode::NOT_FOUND, &message),
        TrackingError::Upstream(message) => error_response(StatusCode::BAD_GATEWAY, &message),
    }
}

fn error_response(status: StatusCode, message: &str) -> (StatusCode, Json<Value>) {
    (
        status,
        Json(json!({
            "error": message,
        })),
    )
}

enum ServiceTrayUserEvent {
    Menu(MenuEvent),
    Tray(TrayIconEvent),
}

struct ServiceTrayRuntime {
    _tray_icon: TrayIcon,
    status_item: MenuItem,
    open_settings_item: MenuItem,
    open_desktop_item: MenuItem,
    copy_endpoint_item: MenuItem,
    copy_token_item: MenuItem,
    keep_running_item: CheckMenuItem,
    stop_service_item: MenuItem,
    last_config: Option<ApiServiceConfig>,
}

impl ServiceTrayRuntime {
    fn new() -> Result<Self, String> {
        let status_item = MenuItem::with_id(
            MenuId::new(SERVICE_TRAY_STATUS_ID),
            "Status: API Off",
            false,
            None,
        );
        let open_settings_item = MenuItem::with_id(
            MenuId::new(SERVICE_TRAY_OPEN_SETTINGS_ID),
            "Open ShipFlow Service",
            true,
            None,
        );
        let open_desktop_item = MenuItem::with_id(
            MenuId::new(SERVICE_TRAY_OPEN_DESKTOP_ID),
            "Open ShipFlow Desktop",
            true,
            None,
        );
        let copy_endpoint_item = MenuItem::with_id(
            MenuId::new(SERVICE_TRAY_COPY_ENDPOINT_ID),
            "Copy Endpoint",
            false,
            None,
        );
        let copy_token_item = MenuItem::with_id(
            MenuId::new(SERVICE_TRAY_COPY_TOKEN_ID),
            "Copy Token",
            false,
            None,
        );
        let keep_running_item = CheckMenuItem::with_id(
            MenuId::new(SERVICE_TRAY_KEEP_RUNNING_ID),
            "Keep Running in Tray",
            true,
            false,
            None,
        );
        let stop_service_item = MenuItem::with_id(
            MenuId::new(SERVICE_TRAY_STOP_SERVICE_ID),
            "Stop External API Access",
            false,
            None,
        );
        let quit_item =
            MenuItem::with_id(MenuId::new(SERVICE_TRAY_QUIT_ID), "Quit Tray", true, None);
        let separator_top = PredefinedMenuItem::separator();
        let separator_bottom = PredefinedMenuItem::separator();

        let menu = Menu::new();
        menu.append_items(&[
            &status_item,
            &open_settings_item,
            &open_desktop_item,
            &separator_top,
            &copy_endpoint_item,
            &copy_token_item,
            &keep_running_item,
            &stop_service_item,
            &separator_bottom,
            &quit_item,
        ])
        .map_err(|error| format!("Unable to build service tray menu: {error}"))?;

        let mut tray_builder = TrayIconBuilder::new()
            .with_id(SERVICE_TRAY_ID)
            .with_menu(Box::new(menu))
            .with_tooltip("ShipFlow Service")
            .with_title("ShipFlow Service")
            .with_menu_on_left_click(false);

        if let Some(icon) = load_service_tray_icon()? {
            tray_builder = tray_builder.with_icon(icon);
        }

        #[cfg(target_os = "macos")]
        {
            tray_builder = tray_builder.with_icon_as_template(true);
        }

        let tray_icon = tray_builder
            .build()
            .map_err(|error| format!("Unable to create service tray icon: {error}"))?;

        Ok(Self {
            _tray_icon: tray_icon,
            status_item,
            open_settings_item,
            open_desktop_item,
            copy_endpoint_item,
            copy_token_item,
            keep_running_item,
            stop_service_item,
            last_config: None,
        })
    }

    fn refresh(&mut self) {
        let controller = ApiServiceController::default();
        let saved_config = load_saved_api_service_config().unwrap_or(None);
        let status = controller.status();
        self.last_config = saved_config.clone();

        let status_label = match saved_config.as_ref() {
            Some(config) => format_service_status_label(config, &status),
            None => "API Off".into(),
        };

        self.status_item.set_text(format!("Status: {status_label}"));
        self.open_settings_item.set_enabled(true);
        self.open_desktop_item.set_enabled(true);

        let can_copy_endpoint = saved_config.as_ref().is_some_and(|config| {
            config.enabled && matches!(status.status, ApiServiceStatusKind::Running)
        });
        self.copy_endpoint_item.set_enabled(can_copy_endpoint);
        self.copy_token_item.set_enabled(
            saved_config
                .as_ref()
                .is_some_and(|config| can_copy_endpoint && !config.auth_token.trim().is_empty()),
        );
        self.stop_service_item
            .set_enabled(saved_config.as_ref().is_some_and(|config| config.enabled));
        self.keep_running_item.set_checked(
            saved_config
                .as_ref()
                .is_some_and(|config| config.keep_running_in_tray),
        );
    }

    fn handle_menu_event(&mut self, event: MenuEvent, control_flow: &mut ControlFlow) {
        match event.id().as_ref() {
            SERVICE_TRAY_OPEN_SETTINGS_ID => {
                let _ = launch_shipflow_service_settings();
            }
            SERVICE_TRAY_OPEN_DESKTOP_ID => {
                let _ = launch_shipflow_desktop();
            }
            SERVICE_TRAY_COPY_ENDPOINT_ID => {
                if let Some(config) = self.last_config.as_ref() {
                    let endpoint =
                        build_service_endpoint(config, &ApiServiceController::default().status());
                    let _ = copy_text_to_clipboard(&endpoint);
                }
            }
            SERVICE_TRAY_COPY_TOKEN_ID => {
                if let Some(config) = self.last_config.as_ref() {
                    if !config.auth_token.trim().is_empty() {
                        let _ = copy_text_to_clipboard(config.auth_token.trim());
                    }
                }
            }
            SERVICE_TRAY_KEEP_RUNNING_ID => {
                if let Some(mut config) = self.last_config.clone() {
                    config.keep_running_in_tray = !config.keep_running_in_tray;
                    let _ = configure_service_blocking(config.clone());
                    if !config.keep_running_in_tray {
                        *control_flow = ControlFlow::Exit;
                        return;
                    }
                }
            }
            SERVICE_TRAY_STOP_SERVICE_ID => {
                if let Some(mut config) = self.last_config.clone() {
                    config.enabled = false;
                    let _ = configure_service_blocking(config.clone());
                    *control_flow = ControlFlow::Exit;
                    return;
                }
            }
            SERVICE_TRAY_QUIT_ID => {
                *control_flow = ControlFlow::Exit;
                return;
            }
            _ => {}
        }

        self.refresh();
    }

    fn handle_tray_event(&self, event: TrayIconEvent) {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } = event
        {
            let _ = launch_shipflow_service_settings();
        }
    }
}

fn run_service_tray_app() -> Result<bool, String> {
    let event_loop = EventLoopBuilder::<ServiceTrayUserEvent>::with_user_event().build();
    let menu_proxy = event_loop.create_proxy();
    MenuEvent::set_event_handler(Some(move |event| {
        let _ = menu_proxy.send_event(ServiceTrayUserEvent::Menu(event));
    }));

    let tray_proxy = event_loop.create_proxy();
    TrayIconEvent::set_event_handler(Some(move |event| {
        let _ = tray_proxy.send_event(ServiceTrayUserEvent::Tray(event));
    }));

    let mut tray_runtime: Option<ServiceTrayRuntime> = None;

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::WaitUntil(Instant::now() + SERVICE_TRAY_REFRESH_INTERVAL);

        match event {
            Event::NewEvents(StartCause::Init) => {
                if tray_runtime.is_none() {
                    match ServiceTrayRuntime::new() {
                        Ok(mut runtime) => {
                            runtime.refresh();
                            tray_runtime = Some(runtime);
                        }
                        Err(error) => {
                            eprintln!("[ShipFlowServiceTray] {error}");
                            *control_flow = ControlFlow::Exit;
                        }
                    }
                }
            }
            Event::NewEvents(StartCause::ResumeTimeReached { .. }) => {
                if let Some(runtime) = tray_runtime.as_mut() {
                    runtime.refresh();
                }
            }
            Event::UserEvent(ServiceTrayUserEvent::Menu(event)) => {
                if let Some(runtime) = tray_runtime.as_mut() {
                    runtime.handle_menu_event(event, control_flow);
                }
            }
            Event::UserEvent(ServiceTrayUserEvent::Tray(event)) => {
                if let Some(runtime) = tray_runtime.as_ref() {
                    runtime.handle_tray_event(event);
                }
            }
            Event::LoopDestroyed => {
                clear_recorded_tray_pid();
            }
            _ => {}
        }
    });
}

fn configure_service_blocking(config: ApiServiceConfig) -> Result<ApiServiceStatus, String> {
    let controller = ApiServiceController::default();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("Unable to create tray service runtime: {error}"))?;

    runtime.block_on(controller.configure(config))
}

fn load_service_tray_icon() -> Result<Option<Icon>, String> {
    let decoder = PngDecoder::new(Cursor::new(include_bytes!("../icons/icon.png")));
    let mut reader = decoder
        .read_info()
        .map_err(|error| format!("Unable to decode tray icon metadata: {error}"))?;
    let mut buffer = vec![0; reader.output_buffer_size()];
    let info = reader
        .next_frame(&mut buffer)
        .map_err(|error| format!("Unable to decode tray icon pixels: {error}"))?;

    let rgba_bytes = match info.color_type {
        png::ColorType::Rgba => buffer[..info.buffer_size()].to_vec(),
        png::ColorType::Rgb => buffer[..info.buffer_size()]
            .chunks_exact(3)
            .flat_map(|chunk| [chunk[0], chunk[1], chunk[2], 255])
            .collect(),
        _ => return Ok(None),
    };

    Icon::from_rgba(rgba_bytes, info.width, info.height)
        .map(Some)
        .map_err(|error| format!("Unable to build tray icon: {error}"))
}

fn format_service_status_label(config: &ApiServiceConfig, status: &ApiServiceStatus) -> String {
    if !config.enabled {
        return "API Off".into();
    }

    match status.status {
        ApiServiceStatusKind::Running => {
            let mode = status.mode.clone().unwrap_or_else(|| config.mode.clone());
            let port = status.port.unwrap_or(config.port);
            match mode {
                ApiServiceMode::Local => format!("API Local :{port}"),
                ApiServiceMode::Lan => format!("API LAN :{port}"),
            }
        }
        ApiServiceStatusKind::Error => {
            let port = status.port.unwrap_or(config.port);
            format!("API Error :{port}")
        }
        ApiServiceStatusKind::Stopped => "API Off".into(),
    }
}

fn build_service_endpoint(config: &ApiServiceConfig, status: &ApiServiceStatus) -> String {
    let port = status.port.unwrap_or(config.port);
    let mode = status.mode.clone().unwrap_or_else(|| config.mode.clone());

    match mode {
        ApiServiceMode::Local => format!("http://127.0.0.1:{port}"),
        ApiServiceMode::Lan => format!(
            "http://{}:{port}",
            status.bind_address.as_deref().unwrap_or("0.0.0.0")
        ),
    }
}

fn run_clipboard_command(mut command: Command, text: &str) -> Result<(), String> {
    let mut child = command
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Unable to start clipboard command: {error}"))?;

    if let Some(stdin) = child.stdin.as_mut() {
        use std::io::Write;

        stdin
            .write_all(text.as_bytes())
            .map_err(|error| format!("Unable to write clipboard payload: {error}"))?;
    } else {
        return Err("Clipboard command stdin is unavailable.".into());
    }

    let status = child
        .wait()
        .map_err(|error| format!("Unable to wait for clipboard command: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("Clipboard command exited with status {status}."))
    }
}

fn copy_text_to_clipboard(text: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return run_clipboard_command(Command::new("pbcopy"), text);
    }

    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("cmd");
        command.args(["/C", "clip"]);
        return run_clipboard_command(command, text);
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let candidates = [
            ("wl-copy", Vec::<&str>::new()),
            ("xclip", vec!["-selection", "clipboard"]),
            ("xsel", vec!["--clipboard", "--input"]),
        ];

        let mut last_error = None;
        for (program, args) in candidates {
            let mut command = Command::new(program);
            command.args(args);

            match run_clipboard_command(command, text) {
                Ok(()) => return Ok(()),
                Err(error) => last_error = Some(error),
            }
        }

        return Err(
            last_error.unwrap_or_else(|| "No supported clipboard command is available.".into())
        );
    }

    #[allow(unreachable_code)]
    Err("Clipboard copy is not supported on this platform.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_config() -> ApiServiceConfig {
        ApiServiceConfig {
            version: 1,
            enabled: false,
            mode: ApiServiceMode::Lan,
            port: 19422,
            auth_token: String::new(),
            tracking_source: TrackingSource::ExternalApi,
            external_api_base_url: "https://scrap.example.test".into(),
            external_api_auth_token: "external-token".into(),
            allow_insecure_external_api_http: false,
            keep_running_in_tray: true,
            last_updated_at: "2026-04-19T00:00:00.000Z".into(),
        }
    }

    #[test]
    fn rejects_missing_authorization_header() {
        let result = authorize_request(&HeaderMap::new(), "secret-token");

        assert!(matches!(result, Err((StatusCode::UNAUTHORIZED, _))));
    }

    #[test]
    fn accepts_valid_bearer_token() {
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, "Bearer secret-token".parse().unwrap());

        let result = authorize_request(&headers, "secret-token");

        assert!(result.is_ok());
    }

    #[test]
    fn desktop_runtime_forces_local_service_when_public_api_is_disabled() {
        let runtime = build_tracking_runtime_config(Some(sample_config()), None);

        assert!(runtime.enabled);
        assert!(matches!(runtime.mode, ApiServiceMode::Local));
        assert!(runtime.keep_running_in_tray == false);
        assert!(matches!(
            runtime.tracking_source,
            TrackingSource::ExternalApi
        ));
        assert_eq!(runtime.external_api_base_url, "https://scrap.example.test");
        assert_eq!(runtime.external_api_auth_token, "external-token");
        assert!(!runtime.auth_token.trim().is_empty());
    }

    #[test]
    fn desktop_runtime_reuses_current_internal_token_when_saved_config_has_none() {
        let current_runtime = ApiServiceConfig {
            auth_token: "sf_internal_existing".into(),
            ..sample_config()
        };

        let runtime = build_tracking_runtime_config(Some(sample_config()), Some(&current_runtime));

        assert_eq!(runtime.auth_token, "sf_internal_existing");
    }
}
