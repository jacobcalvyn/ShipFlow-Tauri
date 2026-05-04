use serde::Serialize;
use shipflow_tauri_runtime::os_bridge::{
    copy_text_to_clipboard, open_external_url_runtime, read_text_from_clipboard,
};
use shipflow_tauri_runtime::runtime_log::log_runtime_event;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseHealth {
    pub app_version: String,
    pub target_os: String,
    pub target_arch: String,
    pub package_name: String,
    pub debug_build: bool,
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    open_external_url_runtime(&url)
}

#[tauri::command]
pub fn copy_to_clipboard(text: String) -> Result<(), String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("Clipboard text is required.".into());
    }

    copy_text_to_clipboard(trimmed)
}

#[tauri::command]
pub fn read_from_clipboard() -> Result<String, String> {
    read_text_from_clipboard()
}

#[tauri::command]
pub fn get_release_health() -> ReleaseHealth {
    ReleaseHealth {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        target_os: std::env::consts::OS.to_string(),
        target_arch: std::env::consts::ARCH.to_string(),
        package_name: env!("CARGO_PKG_NAME").to_string(),
        debug_build: cfg!(debug_assertions),
    }
}

#[tauri::command]
pub fn log_frontend_runtime_event(level: String, message: String) {
    let normalized_level = level.trim().to_lowercase();
    let trimmed_message = message.trim();

    if trimmed_message.is_empty() {
        return;
    }

    let level = if normalized_level.is_empty() {
        "info"
    } else {
        &normalized_level
    };
    log_runtime_event(
        level,
        format!("[ShipFlowFrontend][{level}] {trimmed_message}"),
    );
}
