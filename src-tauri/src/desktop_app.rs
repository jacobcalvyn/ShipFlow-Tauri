use std::sync::{Arc, Mutex};

use shipflow_tauri_runtime::app_runtime::{
    build_main_webview_navigation_guard_plugin, build_tracking_client, desktop_setup,
    handle_desktop_window_event,
};
use shipflow_tauri_runtime::lookup_runtime::LookupCacheState;
use shipflow_tauri_runtime::runtime_log::log_runtime_event;
use shipflow_tauri_runtime::service::ApiServiceController;
use shipflow_tauri_runtime::service_runtime::TrayState;
use shipflow_tauri_runtime::tracking::model::{TrackingClientState, TrackingSourceConfig};
use shipflow_tauri_runtime::window_runtime::{
    WindowCloseGuardState, WindowDocumentState, WorkspaceDocumentRegistryState,
    WorkspaceWindowLaunchState,
};

use crate::app_menu_runtime::{build_desktop_menu, handle_desktop_menu_event};
use crate::commands;

pub fn run() {
    shipflow_tauri_runtime::install_runtime_logging();
    let tracking_client = build_tracking_client("ShipFlow Desktop/0.1");

    tauri::Builder::default()
        .menu(build_desktop_menu)
        .manage(TrackingClientState {
            client: tracking_client,
            source_config: Arc::new(Mutex::new(TrackingSourceConfig::default())),
        })
        .manage(LookupCacheState::with_log_sink(|level, message| {
            log_runtime_event(level, message)
        }))
        .manage(ApiServiceController::default())
        .manage(TrayState::default())
        .manage(WorkspaceWindowLaunchState::default())
        .manage(WorkspaceDocumentRegistryState::default())
        .manage(WindowDocumentState::default())
        .manage(WindowCloseGuardState::default())
        .setup(desktop_setup)
        .on_menu_event(|app, event| handle_desktop_menu_event(app, event.id().as_ref()))
        .on_window_event(handle_desktop_window_event)
        .plugin(build_main_webview_navigation_guard_plugin())
        .invoke_handler(tauri::generate_handler![
            commands::tracking::track_shipment,
            commands::tracking::track_bag,
            commands::tracking::track_manifest,
            commands::tracking::resolve_pod_image,
            commands::system::open_external_url,
            commands::system::copy_to_clipboard,
            commands::system::read_from_clipboard,
            commands::system::get_release_health,
            commands::workspace::pick_workspace_document_path,
            commands::workspace::read_workspace_document,
            commands::workspace::write_workspace_document,
            commands::workspace::export_workspace_csv,
            commands::workspace::list_workspace_recovery,
            commands::workspace::set_current_window_title,
            commands::workspace::get_current_window_label,
            commands::workspace::set_current_window_document_state,
            commands::workspace::claim_current_workspace_document,
            commands::workspace::resolve_window_close_request,
            commands::workspace::create_workspace_window,
            commands::workspace::open_shipflow_service_app,
            commands::workspace::take_pending_workspace_window_request,
            commands::system::log_frontend_runtime_event,
            commands::service::configure_api_service,
            commands::service::load_saved_api_service_config,
            commands::service::get_api_service_status,
            commands::service::test_api_service_connection,
            commands::service::test_external_tracking_source,
            commands::service::validate_tracking_source_config
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
