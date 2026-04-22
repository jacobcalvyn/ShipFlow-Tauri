use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::webview::PageLoadEvent;
use tauri::{App, Emitter, Manager, Runtime, WebviewUrl, Window, WindowEvent};

use crate::lookup_runtime::LookupCacheState;
use crate::runtime_log::log_runtime_event;
use crate::service;
use crate::service::{ApiServiceConfig, ApiServiceController};
use crate::service_runtime::{default_tray_service_config, sync_service_tray, TrayState};
use crate::tracking::model::{TrackingClientState, TrackingSourceConfig};
use crate::window_runtime::{
    WindowCloseGuardState, WindowCloseRequestPayload, WindowDocumentState,
    WorkspaceDocumentRegistryState,
};

#[derive(Clone, Default)]
struct MainWebviewNavigationGuard {
    initial_load_finished_for_labels: Arc<Mutex<HashSet<String>>>,
}

impl MainWebviewNavigationGuard {
    fn observe_navigation(&self, label: &str, url: &str) {
        if label != "main" {
            return;
        }

        let state = self
            .initial_load_finished_for_labels
            .lock()
            .expect("main webview navigation guard lock poisoned");

        if state.contains(label) {
            log_runtime_event(
                "INFO",
                format!(
                    "[ShipFlowTauri] observed top-level navigation for webview '{label}' to {url}"
                ),
            );
        }
    }

    fn mark_initial_load_finished(&self, label: &str, url: &str) {
        if label != "main" {
            return;
        }

        let mut state = self
            .initial_load_finished_for_labels
            .lock()
            .expect("main webview navigation guard lock poisoned");

        if state.insert(label.to_string()) {
            log_runtime_event(
                "INFO",
                format!(
                "[ShipFlowTauri] recorded initial page load finish for webview '{label}' at {url}"
                ),
            );
        }
    }
}

fn initialize_tracking_source_state<R: Runtime>(
    app: &App<R>,
    load_error_label: &str,
    sync_error_label: &str,
) -> Option<ApiServiceConfig> {
    let service_controller = app.state::<ApiServiceController>();
    let tray_state = app.state::<TrayState>();
    let saved_config = service_controller
        .load_saved_config()
        .unwrap_or_else(|error| {
            log_runtime_event("ERROR", format!("{load_error_label} {error}"));
            None
        });

    let initial_tracking_source_config = saved_config
        .as_ref()
        .map(ApiServiceConfig::tracking_source_config)
        .unwrap_or_else(TrackingSourceConfig::default);
    sync_tracking_source_state(
        app,
        initial_tracking_source_config,
        "startup_saved_config_load",
    );

    let status = service_controller.status();
    let tray_config = saved_config
        .clone()
        .unwrap_or_else(default_tray_service_config);
    tray_state.update_service(&tray_config, &status);
    if let Err(error) = sync_service_tray(&app.handle(), &tray_state) {
        log_runtime_event("ERROR", format!("{sync_error_label} {error}"));
    }

    saved_config
}

fn sync_tracking_source_state<R: Runtime>(
    app: &App<R>,
    next_config: TrackingSourceConfig,
    reason: &str,
) {
    let tracking_client_state = app.state::<TrackingClientState>();
    let lookup_cache = app.state::<LookupCacheState>();

    if tracking_client_state.update_source_config(next_config) {
        lookup_cache.invalidate_all(reason);
        log_runtime_event(
            "INFO",
            format!("[ShipFlowCache] source_config_refresh reason={reason}"),
        );
    }
}

fn ensure_desktop_tracking_runtime<R: Runtime>(
    app: &App<R>,
    saved_config: Option<ApiServiceConfig>,
) {
    let service_controller = app.state::<ApiServiceController>();
    let tray_state = app.state::<TrayState>();

    match service::ensure_tracking_service_runtime(saved_config.clone()) {
        Ok(runtime_config) => {
            sync_tracking_source_state(
                app,
                runtime_config.tracking_source_config(),
                "desktop_runtime_ensure",
            );
            log_runtime_event(
                "INFO",
                format!(
                    "[ShipFlowDesktop] startup service runtime ready on port {} with source {:?}",
                    runtime_config.port, runtime_config.tracking_source
                ),
            );

            let status = service_controller.status();
            let tray_config = saved_config.unwrap_or_else(default_tray_service_config);
            tray_state.update_service(&tray_config, &status);
            if let Err(error) = sync_service_tray(&app.handle(), &tray_state) {
                log_runtime_event(
                    "ERROR",
                    format!(
                        "[ShipFlowTray] failed to sync tray after desktop runtime check: {error}"
                    ),
                );
            }
        }
        Err(error) => {
            log_runtime_event(
                "ERROR",
                format!(
                    "[ShipFlowDesktop] failed to ensure service runtime during startup: {error}"
                ),
            );
        }
    }
}

fn spawn_desktop_activation_listener(app_handle: tauri::AppHandle<tauri::Wry>) {
    std::thread::spawn(move || loop {
        match service::take_pending_desktop_activation_request() {
            Ok(Some(request)) if request.focus_main_window => {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            Ok(None) => {}
            Err(error) => {
                log_runtime_event(
                    "ERROR",
                    format!(
                        "[ShipFlowDesktop] failed to consume desktop activation request: {error}"
                    ),
                );
            }
            _ => {}
        }

        std::thread::sleep(Duration::from_millis(500));
    });
}

fn spawn_service_settings_activation_listener(app_handle: tauri::AppHandle<tauri::Wry>) {
    std::thread::spawn(move || loop {
        match service::take_pending_service_settings_activation_request() {
            Ok(Some(request)) if request.focus_main_window => {
                if let Some(window) = app_handle.get_webview_window("service-settings") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            Ok(None) => {}
            Err(error) => {
                log_runtime_event(
                    "ERROR",
                    format!(
                        "[ShipFlowService] failed to consume service settings activation request: {error}"
                    ),
                );
            }
            _ => {}
        }

        std::thread::sleep(Duration::from_millis(500));
    });
}

pub(crate) fn build_tracking_client(user_agent: &str) -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(6))
        .read_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(25))
        .user_agent(user_agent)
        .build()
        .expect("failed to create tracking client")
}

pub(crate) fn build_main_webview_navigation_guard_plugin() -> TauriPlugin<tauri::Wry> {
    let navigation_guard = MainWebviewNavigationGuard::default();
    let navigation_guard_plugin = navigation_guard.clone();
    let page_load_guard_plugin = navigation_guard;

    PluginBuilder::<tauri::Wry>::new("main-webview-navigation-guard")
        .on_navigation(move |webview, url| {
            let label = webview.label().to_string();
            navigation_guard_plugin.observe_navigation(&label, url.as_str());
            true
        })
        .on_page_load(move |webview, payload| {
            let label = webview.label().to_string();
            let url = payload.url().to_string();

            match payload.event() {
                PageLoadEvent::Started => {
                    log_runtime_event(
                        "INFO",
                        format!("[ShipFlowTauri] page load started for webview '{label}' at {url}"),
                    );
                }
                PageLoadEvent::Finished => {
                    page_load_guard_plugin.mark_initial_load_finished(&label, &url);
                }
            }
        })
        .build()
}

pub(crate) fn desktop_setup(app: &mut App<tauri::Wry>) -> Result<(), Box<dyn std::error::Error>> {
    if let Err(error) = service::register_current_desktop_process() {
        log_runtime_event(
            "ERROR",
            format!("[ShipFlowDesktop] failed to register desktop process: {error}"),
        );
    }

    let saved_config = initialize_tracking_source_state(
        app,
        "[ShipFlowService] failed to load persisted config:",
        "[ShipFlowTray] failed to initialize tray:",
    );
    ensure_desktop_tracking_runtime(app, saved_config);

    spawn_desktop_activation_listener(app.handle().clone());
    Ok(())
}

pub(crate) fn service_settings_setup(
    app: &mut App<tauri::Wry>,
) -> Result<(), Box<dyn std::error::Error>> {
    if let Err(error) = service::register_current_service_settings_process() {
        log_runtime_event(
            "ERROR",
            format!("[ShipFlowService] failed to register service settings process: {error}"),
        );
    }

    let _ = initialize_tracking_source_state(
        app,
        "[ShipFlowService] failed to load persisted config:",
        "[ShipFlowService] failed to sync tray companion:",
    );

    tauri::WebviewWindowBuilder::new(
        app,
        "service-settings",
        WebviewUrl::App("index.html?windowKind=service-settings".into()),
    )
    .title("ShipFlow Service")
    .inner_size(980.0, 820.0)
    .resizable(true)
    .initialization_script("window.__SHIPFLOW_WINDOW_KIND__ = 'service-settings';")
    .build()
    .map_err(|error| {
        std::io::Error::other(format!("Unable to create ShipFlow Service window: {error}"))
    })?;

    spawn_service_settings_activation_listener(app.handle().clone());
    Ok(())
}

pub(crate) fn handle_desktop_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    let registry = window.state::<WorkspaceDocumentRegistryState>();
    let document_state = window.state::<WindowDocumentState>();
    let close_guard = window.state::<WindowCloseGuardState>();

    match event {
        WindowEvent::CloseRequested { api, .. } => {
            if close_guard.take_allowance(window.label()) {
                return;
            }

            let snapshot = document_state.get_for_window(window.label());
            if snapshot.is_dirty {
                api.prevent_close();
                let _ = window.emit(
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
        }
        WindowEvent::Destroyed => {
            if window.label() == "main" {
                service::clear_current_desktop_process();
            }
            registry.release_window(window.label());
            document_state.remove_window(window.label());
            close_guard.clear_window(window.label());
        }
        _ => {}
    }
}

pub(crate) fn handle_service_settings_window_event<R: Runtime>(
    window: &Window<R>,
    event: &WindowEvent,
) {
    if let WindowEvent::Destroyed = event {
        if window.label() == "service-settings" {
            service::clear_current_service_settings_process();
        }
    }
}
