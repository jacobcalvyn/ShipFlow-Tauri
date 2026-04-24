use std::{
    env, fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use super::{
    ApiServiceConfig, DesktopActivationRequest, DESKTOP_PID_FILE_NAME, DESKTOP_REQUEST_FILE_NAME,
    SERVICE_CONFIG_FILE_NAME, SERVICE_PID_FILE_NAME, SERVICE_RUNTIME_CONFIG_FILE_NAME,
    SERVICE_SETTINGS_PID_FILE_NAME, SERVICE_SETTINGS_REQUEST_FILE_NAME, SERVICE_STATE_DIR_NAME,
    SERVICE_TRAY_PID_FILE_NAME,
};

static STATE_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
fn state_dir_override() -> Option<PathBuf> {
    env::var_os("SHIPFLOW_SERVICE_STATE_DIR_OVERRIDE").map(PathBuf::from)
}

#[cfg(not(test))]
fn state_dir_override() -> Option<PathBuf> {
    None
}

fn legacy_service_state_dir() -> PathBuf {
    env::temp_dir().join(SERVICE_STATE_DIR_NAME)
}

fn app_data_service_state_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        return env::var_os("HOME").map(PathBuf::from).map(|home| {
            home.join("Library")
                .join("Application Support")
                .join("ShipFlow Desktop")
                .join(SERVICE_STATE_DIR_NAME)
        });
    }

    #[cfg(target_os = "windows")]
    {
        return env::var_os("APPDATA").map(PathBuf::from).map(|app_data| {
            app_data
                .join("ShipFlow Desktop")
                .join(SERVICE_STATE_DIR_NAME)
        });
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(xdg_data_home) = env::var_os("XDG_DATA_HOME").map(PathBuf::from) {
            return Some(
                xdg_data_home
                    .join("shipflow-desktop")
                    .join(SERVICE_STATE_DIR_NAME),
            );
        }

        return env::var_os("HOME").map(PathBuf::from).map(|home| {
            home.join(".local")
                .join("share")
                .join("shipflow-desktop")
                .join(SERVICE_STATE_DIR_NAME)
        });
    }

    #[allow(unreachable_code)]
    None
}

fn service_state_dir() -> PathBuf {
    if let Some(path) = state_dir_override() {
        return path;
    }

    app_data_service_state_dir().unwrap_or_else(legacy_service_state_dir)
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
    let state_dir = service_state_dir();
    fs::create_dir_all(&state_dir)
        .map_err(|error| format!("Unable to prepare service state directory: {error}"))?;
    set_user_only_permissions(&state_dir, 0o700);
    Ok(())
}

fn set_user_only_permissions(path: &Path, mode: u32) {
    #[cfg(unix)]
    {
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
    }
}

fn state_file_candidates(primary_path: &Path) -> Vec<PathBuf> {
    let mut candidates = vec![primary_path.to_path_buf()];

    if state_dir_override().is_none() {
        if let Some(file_name) = primary_path.file_name() {
            let legacy_path = legacy_service_state_dir().join(file_name);
            if legacy_path != primary_path {
                candidates.push(legacy_path);
            }
        }
    }

    candidates
}

fn read_first_state_file(
    primary_path: PathBuf,
    label: &str,
) -> Result<Option<(PathBuf, Vec<u8>)>, String> {
    for path in state_file_candidates(&primary_path) {
        match fs::read(&path) {
            Ok(bytes) => return Ok(Some((path, bytes))),
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Unable to read {label} from {}: {error}",
                    path.to_string_lossy()
                ))
            }
        }
    }

    Ok(None)
}

fn write_state_file(path: PathBuf, payload: Vec<u8>, label: &str) -> Result<(), String> {
    ensure_service_state_dir()?;
    let file_name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "state".into());
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let counter = STATE_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp_path = path.with_file_name(format!(
        "{file_name}.{}.{}.{}.tmp",
        std::process::id(),
        timestamp,
        counter
    ));

    fs::write(&temp_path, payload)
        .map_err(|error| format!("Unable to write temporary {label}: {error}"))?;
    set_user_only_permissions(&temp_path, 0o600);

    #[cfg(target_os = "windows")]
    {
        if path.exists() {
            let backup_counter = STATE_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
            let backup_path = path.with_file_name(format!(
                "{file_name}.{}.{}.{}.bak",
                std::process::id(),
                timestamp,
                backup_counter
            ));
            fs::rename(&path, &backup_path)
                .map_err(|error| format!("Unable to prepare {label} replacement: {error}"))?;

            return match fs::rename(&temp_path, &path) {
                Ok(()) => {
                    let _ = fs::remove_file(&backup_path);
                    Ok(())
                }
                Err(error) => {
                    let _ = fs::rename(&backup_path, &path);
                    let _ = fs::remove_file(&temp_path);
                    Err(format!("Unable to finalize {label}: {error}"))
                }
            };
        }
    }

    fs::rename(&temp_path, &path).map_err(|error| {
        let _ = fs::remove_file(&temp_path);
        format!("Unable to finalize {label}: {error}")
    })
}

pub(crate) fn persist_saved_config(config: &ApiServiceConfig) -> Result<(), String> {
    let serialized = serde_json::to_vec_pretty(config)
        .map_err(|error| format!("Unable to serialize API service configuration: {error}"))?;
    write_state_file(
        service_config_path(),
        serialized,
        "API service configuration",
    )
}

pub(crate) fn persist_runtime_config(config: &ApiServiceConfig) -> Result<(), String> {
    let serialized = serde_json::to_vec_pretty(config)
        .map_err(|error| format!("Unable to serialize runtime service configuration: {error}"))?;
    write_state_file(
        service_runtime_config_path(),
        serialized,
        "runtime service configuration",
    )
}

pub(crate) fn load_saved_config() -> Result<Option<ApiServiceConfig>, String> {
    let primary_path = service_config_path();
    let Some((source_path, bytes)) =
        read_first_state_file(primary_path.clone(), "persisted API service configuration")?
    else {
        return Ok(None);
    };

    let config = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Unable to parse persisted API service configuration: {error}"))?;

    if source_path != primary_path {
        let _ = persist_saved_config(&config);
    }

    Ok(Some(config))
}

pub(crate) fn load_runtime_config() -> Result<Option<ApiServiceConfig>, String> {
    let primary_path = service_runtime_config_path();
    let Some((source_path, bytes)) =
        read_first_state_file(primary_path.clone(), "runtime service configuration")?
    else {
        return Ok(None);
    };

    let config = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Unable to parse runtime service configuration: {error}"))?;

    if source_path != primary_path {
        let _ = persist_runtime_config(&config);
    }

    Ok(Some(config))
}

fn persist_pid_file(path: PathBuf, pid: u32, label: &str) -> Result<(), String> {
    write_state_file(path, pid.to_string().into_bytes(), label)
}

pub(crate) fn persist_service_pid(pid: u32) -> Result<(), String> {
    persist_pid_file(service_pid_path(), pid, "API service process id")
}

pub(crate) fn persist_service_tray_pid(pid: u32) -> Result<(), String> {
    persist_pid_file(service_tray_pid_path(), pid, "API service tray process id")
}

pub fn register_current_desktop_process() -> Result<(), String> {
    persist_pid_file(desktop_pid_path(), std::process::id(), "desktop process id")
}

pub fn register_current_service_settings_process() -> Result<(), String> {
    persist_pid_file(
        service_settings_pid_path(),
        std::process::id(),
        "service settings process id",
    )
}

fn read_pid_file(path: PathBuf) -> Option<u32> {
    let (_, bytes) = read_first_state_file(path, "process id").ok()??;
    let raw_value = String::from_utf8(bytes).ok()?;
    raw_value.trim().parse::<u32>().ok()
}

pub(crate) fn read_recorded_pid() -> Option<u32> {
    read_pid_file(service_pid_path())
}

pub(crate) fn read_recorded_tray_pid() -> Option<u32> {
    read_pid_file(service_tray_pid_path())
}

pub(crate) fn read_recorded_service_settings_pid() -> Option<u32> {
    read_pid_file(service_settings_pid_path())
}

pub(crate) fn read_recorded_desktop_pid() -> Option<u32> {
    read_pid_file(desktop_pid_path())
}

fn clear_path(path: PathBuf) {
    for candidate in state_file_candidates(&path) {
        let _ = fs::remove_file(candidate);
    }
}

pub(crate) fn clear_recorded_pid() {
    clear_path(service_pid_path());
}

pub(crate) fn clear_runtime_config() {
    clear_path(service_runtime_config_path());
}

pub(crate) fn clear_recorded_tray_pid() {
    clear_path(service_tray_pid_path());
}

pub(crate) fn clear_recorded_service_settings_pid() {
    clear_path(service_settings_pid_path());
}

pub(crate) fn clear_recorded_desktop_pid() {
    clear_path(desktop_pid_path());
}

pub fn clear_current_desktop_process() {
    clear_recorded_desktop_pid();
}

pub fn clear_current_service_settings_process() {
    clear_recorded_service_settings_pid();
}

pub(crate) fn persist_service_settings_activation_request(
    request: &DesktopActivationRequest,
) -> Result<(), String> {
    let payload = serde_json::to_vec(request).map_err(|error| {
        format!("Unable to serialize service settings activation request: {error}")
    })?;
    write_state_file(
        service_settings_request_path(),
        payload,
        "service settings activation request",
    )
}

pub(crate) fn persist_desktop_activation_request(
    request: &DesktopActivationRequest,
) -> Result<(), String> {
    let payload = serde_json::to_vec(request)
        .map_err(|error| format!("Unable to serialize desktop activation request: {error}"))?;
    write_state_file(
        desktop_request_path(),
        payload,
        "desktop activation request",
    )
}

fn take_pending_activation_request(
    path: PathBuf,
    label: &str,
) -> Result<Option<DesktopActivationRequest>, String> {
    let Some((source_path, bytes)) = read_first_state_file(path, &format!("pending {label}"))?
    else {
        return Ok(None);
    };

    let _ = fs::remove_file(&source_path);
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| format!("Unable to parse pending {label}: {error}"))
}

pub fn take_pending_desktop_activation_request() -> Result<Option<DesktopActivationRequest>, String>
{
    take_pending_activation_request(desktop_request_path(), "desktop activation request")
}

pub fn take_pending_service_settings_activation_request(
) -> Result<Option<DesktopActivationRequest>, String> {
    take_pending_activation_request(
        service_settings_request_path(),
        "service settings activation request",
    )
}

pub fn load_saved_api_service_config() -> Result<Option<ApiServiceConfig>, String> {
    load_saved_config()
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        panic::{self, AssertUnwindSafe},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::{
        load_runtime_config, load_saved_config, persist_desktop_activation_request,
        persist_runtime_config, persist_saved_config, persist_service_settings_activation_request,
        take_pending_desktop_activation_request, take_pending_service_settings_activation_request,
        ApiServiceConfig, DesktopActivationRequest,
    };
    use crate::service::{ApiServiceMode, DesktopServiceConnectionMode};
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

    fn sample_config() -> ApiServiceConfig {
        ApiServiceConfig {
            version: 1,
            desktop_connection_mode: DesktopServiceConnectionMode::ManagedLocal,
            desktop_service_url: "http://127.0.0.1:18422".into(),
            desktop_service_auth_token: String::new(),
            enabled: true,
            mode: ApiServiceMode::Lan,
            port: 18422,
            auth_token: "sf_state_store_token".into(),
            tracking_source: TrackingSource::ExternalApi,
            external_api_base_url: "https://scrap.example.test".into(),
            external_api_auth_token: "external-token".into(),
            allow_insecure_external_api_http: false,
            keep_running_in_tray: true,
            last_updated_at: "2026-04-21T00:00:00.000Z".into(),
        }
    }

    #[test]
    fn saved_config_roundtrip_uses_overridden_state_dir() {
        with_state_dir("shipflow-service-saved-config-test", || {
            let config = sample_config();

            persist_saved_config(&config).expect("saved config should persist");
            let loaded = load_saved_config()
                .expect("saved config should load")
                .expect("saved config should exist");

            assert_eq!(loaded, config);
        });
    }

    #[test]
    fn runtime_config_roundtrip_uses_overridden_state_dir() {
        with_state_dir("shipflow-service-runtime-config-test", || {
            let config = ApiServiceConfig {
                enabled: false,
                mode: ApiServiceMode::Local,
                keep_running_in_tray: false,
                ..sample_config()
            };

            persist_runtime_config(&config).expect("runtime config should persist");
            let loaded = load_runtime_config()
                .expect("runtime config should load")
                .expect("runtime config should exist");

            assert_eq!(loaded, config);
        });
    }

    #[test]
    fn desktop_activation_request_is_consumed_once() {
        with_state_dir("shipflow-service-desktop-request-test", || {
            let request = DesktopActivationRequest {
                focus_main_window: true,
            };

            persist_desktop_activation_request(&request)
                .expect("desktop activation request should persist");

            let first_take = take_pending_desktop_activation_request()
                .expect("desktop activation request should load");
            let second_take = take_pending_desktop_activation_request()
                .expect("desktop activation request should be removed after first read");

            assert_eq!(first_take, Some(request));
            assert_eq!(second_take, None);
        });
    }

    #[test]
    fn service_settings_activation_request_is_consumed_once() {
        with_state_dir("shipflow-service-settings-request-test", || {
            let request = DesktopActivationRequest {
                focus_main_window: false,
            };

            persist_service_settings_activation_request(&request)
                .expect("service settings activation request should persist");

            let first_take = take_pending_service_settings_activation_request()
                .expect("service settings activation request should load");
            let second_take = take_pending_service_settings_activation_request()
                .expect("service settings activation request should be removed after first read");

            assert_eq!(first_take, Some(request));
            assert_eq!(second_take, None);
        });
    }
}
