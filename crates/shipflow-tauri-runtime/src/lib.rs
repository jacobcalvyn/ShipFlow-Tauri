pub mod app_runtime;
pub mod lookup_runtime;
pub mod os_bridge;
pub mod pod_preview;
pub mod runtime_log;
pub mod service;
pub mod service_client;
pub mod service_runtime;
pub mod service_settings_app;
#[cfg(test)]
pub mod test_support;
pub mod tracking;
pub mod updater_runtime;
pub mod window_runtime;
pub mod workspace_document;

pub use app_runtime::{
    build_main_webview_navigation_guard_plugin, build_tracking_client, desktop_setup,
    focus_desktop_main_window_runtime, handle_desktop_window_event,
    handle_service_settings_window_event, load_service_window_icon,
    open_service_settings_window_runtime, service_settings_setup,
};
pub use runtime_log::{install_runtime_logging, log_runtime_event};
pub use service::{
    maybe_delegate_desktop_launch_to_existing_process,
    maybe_delegate_service_settings_launch_to_existing_process,
    maybe_run_service_autostart_from_current_args, maybe_run_service_process_from_current_args,
    maybe_run_service_tray_from_current_args,
};
pub use service_settings_app::run_service_settings_with_context;
