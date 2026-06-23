use shipflow_tauri_runtime::os_bridge::{
    copy_text_to_clipboard, open_external_url_runtime, read_text_from_clipboard,
};
use shipflow_tauri_runtime::runtime_log::log_runtime_event;
use shipflow_tauri_runtime::updater_runtime::{
    app_release_health, check_app_update_runtime, install_app_update_runtime, AppReleaseHealth,
    AppUpdateStatus,
};

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
pub fn get_release_health(app_handle: tauri::AppHandle) -> AppReleaseHealth {
    app_release_health(&app_handle)
}

#[tauri::command]
pub async fn check_app_update(app_handle: tauri::AppHandle) -> Result<AppUpdateStatus, String> {
    check_app_update_runtime(app_handle).await
}

#[tauri::command]
pub async fn install_app_update(app_handle: tauri::AppHandle) -> Result<AppUpdateStatus, String> {
    install_app_update_runtime(app_handle).await
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
