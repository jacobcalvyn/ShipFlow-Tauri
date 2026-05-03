use std::{env, fs, path::PathBuf};

use super::set_user_only_permissions;
use crate::service::{
    DESKTOP_PID_FILE_NAME, DESKTOP_REQUEST_FILE_NAME, DESKTOP_SERVICE_CONFIG_FILE_NAME,
    SERVICE_CONFIG_FILE_NAME, SERVICE_PID_FILE_NAME, SERVICE_RUNTIME_CONFIG_FILE_NAME,
    SERVICE_SETTINGS_PID_FILE_NAME, SERVICE_SETTINGS_REQUEST_FILE_NAME, SERVICE_STATE_DIR_NAME,
    SERVICE_TRAY_PID_FILE_NAME,
};

#[cfg(test)]
pub(super) fn state_dir_override() -> Option<PathBuf> {
    env::var_os("SHIPFLOW_SERVICE_STATE_DIR_OVERRIDE").map(PathBuf::from)
}

#[cfg(not(test))]
pub(super) fn state_dir_override() -> Option<PathBuf> {
    None
}

pub(super) fn legacy_service_state_dir() -> PathBuf {
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

pub(super) fn service_state_dir() -> PathBuf {
    if let Some(path) = state_dir_override() {
        return path;
    }

    app_data_service_state_dir().unwrap_or_else(legacy_service_state_dir)
}

pub(super) fn service_config_path() -> PathBuf {
    service_state_dir().join(SERVICE_CONFIG_FILE_NAME)
}

pub(super) fn desktop_service_config_path() -> PathBuf {
    service_state_dir().join(DESKTOP_SERVICE_CONFIG_FILE_NAME)
}

pub(super) fn service_runtime_config_path() -> PathBuf {
    service_state_dir().join(SERVICE_RUNTIME_CONFIG_FILE_NAME)
}

pub(super) fn service_pid_path() -> PathBuf {
    service_state_dir().join(SERVICE_PID_FILE_NAME)
}

pub(super) fn service_tray_pid_path() -> PathBuf {
    service_state_dir().join(SERVICE_TRAY_PID_FILE_NAME)
}

pub(super) fn service_settings_pid_path() -> PathBuf {
    service_state_dir().join(SERVICE_SETTINGS_PID_FILE_NAME)
}

pub(super) fn desktop_pid_path() -> PathBuf {
    service_state_dir().join(DESKTOP_PID_FILE_NAME)
}

pub(super) fn service_settings_request_path() -> PathBuf {
    service_state_dir().join(SERVICE_SETTINGS_REQUEST_FILE_NAME)
}

pub(super) fn desktop_request_path() -> PathBuf {
    service_state_dir().join(DESKTOP_REQUEST_FILE_NAME)
}

pub(super) fn ensure_service_state_dir() -> Result<(), String> {
    let state_dir = service_state_dir();
    fs::create_dir_all(&state_dir)
        .map_err(|error| format!("Unable to prepare service state directory: {error}"))?;
    set_user_only_permissions(&state_dir, 0o700);
    Ok(())
}
