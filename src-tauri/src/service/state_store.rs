use std::{env, fs, io::ErrorKind, path::PathBuf};

use super::{
    ApiServiceConfig, DesktopActivationRequest, DESKTOP_PID_FILE_NAME, DESKTOP_REQUEST_FILE_NAME,
    SERVICE_CONFIG_FILE_NAME, SERVICE_PID_FILE_NAME, SERVICE_RUNTIME_CONFIG_FILE_NAME,
    SERVICE_SETTINGS_PID_FILE_NAME, SERVICE_SETTINGS_REQUEST_FILE_NAME, SERVICE_STATE_DIR_NAME,
    SERVICE_TRAY_PID_FILE_NAME,
};

fn service_state_dir() -> PathBuf {
    #[cfg(test)]
    if let Some(path) = env::var_os("SHIPFLOW_SERVICE_STATE_DIR_OVERRIDE") {
        return PathBuf::from(path);
    }

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

pub(crate) fn persist_saved_config(config: &ApiServiceConfig) -> Result<(), String> {
    ensure_service_state_dir()?;
    let serialized = serde_json::to_vec_pretty(config)
        .map_err(|error| format!("Unable to serialize API service configuration: {error}"))?;
    fs::write(service_config_path(), serialized)
        .map_err(|error| format!("Unable to persist API service configuration: {error}"))
}

pub(crate) fn persist_runtime_config(config: &ApiServiceConfig) -> Result<(), String> {
    ensure_service_state_dir()?;
    let serialized = serde_json::to_vec_pretty(config)
        .map_err(|error| format!("Unable to serialize runtime service configuration: {error}"))?;
    fs::write(service_runtime_config_path(), serialized)
        .map_err(|error| format!("Unable to persist runtime service configuration: {error}"))
}

pub(crate) fn load_saved_config() -> Result<Option<ApiServiceConfig>, String> {
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

pub(crate) fn load_runtime_config() -> Result<Option<ApiServiceConfig>, String> {
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

fn persist_pid_file(path: PathBuf, pid: u32, label: &str) -> Result<(), String> {
    ensure_service_state_dir()?;
    fs::write(path, pid.to_string()).map_err(|error| format!("Unable to persist {label}: {error}"))
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
    let raw_value = fs::read_to_string(path).ok()?;
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
    let _ = fs::remove_file(path);
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
    ensure_service_state_dir()?;
    let payload = serde_json::to_vec(request).map_err(|error| {
        format!("Unable to serialize service settings activation request: {error}")
    })?;
    fs::write(service_settings_request_path(), payload)
        .map_err(|error| format!("Unable to persist service settings activation request: {error}"))
}

pub(crate) fn persist_desktop_activation_request(
    request: &DesktopActivationRequest,
) -> Result<(), String> {
    ensure_service_state_dir()?;
    let payload = serde_json::to_vec(request)
        .map_err(|error| format!("Unable to serialize desktop activation request: {error}"))?;
    fs::write(desktop_request_path(), payload)
        .map_err(|error| format!("Unable to persist desktop activation request: {error}"))
}

fn take_pending_activation_request(
    path: PathBuf,
    label: &str,
) -> Result<Option<DesktopActivationRequest>, String> {
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Unable to read pending {label}: {error}")),
    };

    let _ = fs::remove_file(&path);
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
        sync::{Mutex, OnceLock},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::{
        load_runtime_config, load_saved_config, persist_desktop_activation_request,
        persist_runtime_config, persist_saved_config, persist_service_settings_activation_request,
        take_pending_desktop_activation_request, take_pending_service_settings_activation_request,
        ApiServiceConfig, DesktopActivationRequest,
    };
    use crate::service::ApiServiceMode;
    use crate::tracking::model::TrackingSource;

    fn state_dir_test_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn unique_temp_dir(prefix: &str) -> std::path::PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}-{timestamp}-{}", std::process::id()))
    }

    fn with_state_dir<T>(prefix: &str, run: impl FnOnce() -> T) -> T {
        let _guard = state_dir_test_lock()
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
