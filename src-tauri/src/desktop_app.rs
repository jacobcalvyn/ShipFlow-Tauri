use std::sync::{Arc, Mutex};

#[cfg(target_os = "macos")]
use shipflow_tauri_runtime::app_runtime::focus_desktop_main_window_runtime;
use shipflow_tauri_runtime::app_runtime::{
    build_desktop_single_instance_plugin, build_main_webview_navigation_guard_plugin,
    build_tracking_client, desktop_setup, handle_desktop_window_event,
    maybe_install_signed_updater_plugin, DesktopTrayAvailabilityState,
};
use shipflow_tauri_runtime::lookup_runtime::LookupCacheState;
use shipflow_tauri_runtime::runtime_log::log_runtime_event;
use shipflow_tauri_runtime::service::{self, ApiServiceController};
use shipflow_tauri_runtime::service_runtime::TrayState;
use shipflow_tauri_runtime::tracking::model::{TrackingClientState, TrackingSourceConfig};
use shipflow_tauri_runtime::window_runtime::{
    WindowCloseGuardState, WindowCloseRequestPayload, WindowDocumentState,
    WorkspaceDocumentRegistryState, WorkspaceWindowLaunchState,
};
use tauri::{Emitter, Manager};

use crate::app_menu_runtime::{build_desktop_menu, handle_desktop_menu_event};
use crate::commands;

pub fn run() {
    shipflow_tauri_runtime::install_runtime_logging();
    let tracking_client = build_tracking_client("ShipFlow Desktop/0.1");
    let context = tauri::generate_context!();

    let builder = tauri::Builder::default()
        .plugin(build_desktop_single_instance_plugin())
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
        .manage(DesktopTrayAvailabilityState::default())
        .manage(WorkspaceWindowLaunchState::default())
        .manage(WorkspaceDocumentRegistryState::default())
        .manage(WindowDocumentState::default())
        .manage(WindowCloseGuardState::default())
        .manage(commands::workspace_engine::WorkspaceEngineState::default())
        .setup(desktop_setup)
        .on_menu_event(|app, event| handle_desktop_menu_event(app, event.id().as_ref()))
        .on_window_event(handle_desktop_window_event)
        .plugin(build_main_webview_navigation_guard_plugin());

    let app = maybe_install_signed_updater_plugin(builder, context.config())
        .invoke_handler(tauri::generate_handler![
            commands::tracking::resolve_pod_image,
            commands::system::open_external_url,
            commands::system::copy_to_clipboard,
            commands::system::read_from_clipboard,
            commands::system::get_release_health,
            commands::system::check_app_update,
            commands::system::install_app_update,
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
            commands::workspace_engine::workspace_engine_command,
            commands::workspace_engine::workspace_engine_run_import_job_with_progress,
            commands::workspace_engine::workspace_engine_retry_import_job_failed_with_progress,
            commands::workspace_engine::workspace_engine_refresh_sheet_rows_tracking_with_progress,
            commands::system::log_frontend_runtime_event,
            commands::service::configure_api_service,
            commands::service::load_saved_api_service_config,
            commands::service::get_api_service_status,
            commands::service::test_api_service_connection,
            commands::service::test_external_tracking_source,
            commands::service::validate_tracking_source_config
        ])
        .build(context)
        .expect("error while building tauri application");

    app.run(handle_desktop_run_event);
}

fn handle_desktop_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    match event {
        tauri::RunEvent::ExitRequested { api, .. } => prepare_desktop_native_quit(app, &api),
        tauri::RunEvent::Exit => service::clear_current_desktop_process(),
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => focus_desktop_main_window_runtime(app),
        _ => {}
    }
}

fn prepare_desktop_native_quit(app: &tauri::AppHandle, api: &tauri::ExitRequestApi) {
    let windows = app.webview_windows();
    let window_labels = windows.keys().cloned().collect::<Vec<_>>();
    let close_guard = app.state::<WindowCloseGuardState>();
    let document_state = app.state::<WindowDocumentState>();
    let labels_requiring_confirmation = window_labels
        .iter()
        .filter(|label| !close_guard.has_allowance(label.as_str()))
        .map(String::as_str);
    if let Some((label, snapshot)) =
        document_state.first_dirty_window(labels_requiring_confirmation)
    {
        api.prevent_exit();
        if let Some(window) = windows.get(&label) {
            if let Err(error) = window.unminimize() {
                log_runtime_event(
                    "ERROR",
                    format!("[ShipFlowDesktop] failed to unminimize dirty window: {error}"),
                );
            }
            if let Err(error) = window.show() {
                log_runtime_event(
                    "ERROR",
                    format!("[ShipFlowDesktop] failed to show dirty window: {error}"),
                );
            }
            if let Err(error) = window.set_focus() {
                log_runtime_event(
                    "ERROR",
                    format!("[ShipFlowDesktop] failed to focus dirty window: {error}"),
                );
            }
            let _ = app.emit_to(
                &label,
                "shipflow://window-close-requested",
                WindowCloseRequestPayload {
                    document_name: if snapshot.document_name.trim().is_empty() {
                        "Untitled.shipflow".into()
                    } else {
                        snapshot.document_name
                    },
                },
            );
        }
        return;
    }

    for label in window_labels {
        close_guard.allow_next_close(&label);
    }
    log_runtime_event("INFO", "[ShipFlowDesktopMenu] native quit requested");
    service::clear_current_desktop_process();
}
