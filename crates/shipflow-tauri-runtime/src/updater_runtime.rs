use serde::Serialize;
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::runtime_log::log_runtime_event;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppReleaseHealth {
    pub app_version: String,
    pub target_os: String,
    pub target_arch: String,
    pub package_name: String,
    pub product_name: String,
    pub app_identifier: String,
    pub debug_build: bool,
    pub updater_plugin_ready: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateStatus {
    pub available: bool,
    pub current_version: String,
    pub version: Option<String>,
    pub body: Option<String>,
    pub download_url: Option<String>,
}

fn update_status_from_update(update: &Update) -> AppUpdateStatus {
    AppUpdateStatus {
        available: true,
        current_version: update.current_version.clone(),
        version: Some(update.version.clone()),
        body: update.body.clone(),
        download_url: Some(update.download_url.to_string()),
    }
}

fn no_update_status(app_handle: &tauri::AppHandle) -> AppUpdateStatus {
    AppUpdateStatus {
        available: false,
        current_version: app_handle.package_info().version.to_string(),
        version: None,
        body: None,
        download_url: None,
    }
}

fn updater_error_context(error: impl std::fmt::Display) -> String {
    format!("ShipFlow updater is not ready: {error}")
}

pub fn app_release_health(app_handle: &tauri::AppHandle) -> AppReleaseHealth {
    let package_info = app_handle.package_info();
    let config = app_handle.config();
    AppReleaseHealth {
        app_version: package_info.version.to_string(),
        target_os: std::env::consts::OS.to_string(),
        target_arch: std::env::consts::ARCH.to_string(),
        package_name: package_info.name.clone(),
        product_name: config
            .product_name
            .clone()
            .unwrap_or_else(|| package_info.name.clone()),
        app_identifier: config.identifier.clone(),
        debug_build: cfg!(debug_assertions),
        updater_plugin_ready: app_handle.updater().is_ok(),
    }
}

pub async fn check_app_update_runtime(
    app_handle: tauri::AppHandle,
) -> Result<AppUpdateStatus, String> {
    let updater = app_handle.updater().map_err(updater_error_context)?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("Failed to check for ShipFlow update: {error}"))?;

    let status = match update {
        Some(update) => update_status_from_update(&update),
        None => no_update_status(&app_handle),
    };

    log_runtime_event(
        "INFO",
        format!(
            "[ShipFlowUpdater] check complete available={} current={} latest={}",
            status.available,
            status.current_version,
            status.version.as_deref().unwrap_or("-")
        ),
    );

    Ok(status)
}

pub async fn install_app_update_runtime(
    app_handle: tauri::AppHandle,
) -> Result<AppUpdateStatus, String> {
    let updater = app_handle.updater().map_err(updater_error_context)?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("Failed to check for ShipFlow update: {error}"))?;
    let Some(update) = update else {
        let status = no_update_status(&app_handle);
        log_runtime_event(
            "INFO",
            format!(
                "[ShipFlowUpdater] install skipped because no update is available current={}",
                status.current_version
            ),
        );
        return Ok(status);
    };

    let status = update_status_from_update(&update);
    log_runtime_event(
        "INFO",
        format!(
            "[ShipFlowUpdater] installing update current={} latest={}",
            status.current_version,
            status.version.as_deref().unwrap_or("-")
        ),
    );

    let mut downloaded_bytes: usize = 0;
    update
        .download_and_install(
            |chunk_length, content_length| {
                downloaded_bytes = downloaded_bytes.saturating_add(chunk_length);
                if let Some(content_length) = content_length {
                    if downloaded_bytes >= content_length as usize {
                        log_runtime_event(
                            "INFO",
                            format!(
                                "[ShipFlowUpdater] downloaded {} of {} bytes",
                                downloaded_bytes, content_length
                            ),
                        );
                    }
                }
            },
            || {
                log_runtime_event("INFO", "[ShipFlowUpdater] download finished");
            },
        )
        .await
        .map_err(|error| format!("Failed to install ShipFlow update: {error}"))?;

    Ok(status)
}
