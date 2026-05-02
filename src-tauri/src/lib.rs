mod app_menu_runtime;
mod commands;
mod desktop_app;

pub fn maybe_run_service_process_from_current_args() -> Result<bool, String> {
    shipflow_tauri_runtime::maybe_run_service_process_from_current_args()
}

pub fn maybe_run_service_tray_from_current_args() -> Result<bool, String> {
    shipflow_tauri_runtime::maybe_run_service_tray_from_current_args()
}

pub fn maybe_delegate_to_existing_desktop_process() -> Result<bool, String> {
    shipflow_tauri_runtime::maybe_delegate_desktop_launch_to_existing_process()
}

pub fn install_runtime_logging() {
    shipflow_tauri_runtime::install_runtime_logging();
}

pub fn run() {
    desktop_app::run();
}
