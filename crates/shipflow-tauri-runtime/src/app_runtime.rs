use std::collections::HashSet;
use std::env;
use std::io::Cursor;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use png::Decoder as PngDecoder;
use tauri::image::Image;
#[cfg(target_os = "macos")]
use tauri::menu::{AboutMetadata, Submenu};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
#[cfg(target_os = "windows")]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::PageLoadEvent;
use tauri::{
    App, AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindow, Window, WindowEvent,
};

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

const DESKTOP_MAIN_WINDOW_STATE_KEY: &str = "desktop.main";
const DESKTOP_WORKSPACE_WINDOW_STATE_KEY: &str = "desktop.workspace";
const SERVICE_SETTINGS_WINDOW_STATE_KEY: &str = "service.settings";
const MIN_RESTORED_WINDOW_WIDTH: u32 = 640;
const MIN_RESTORED_WINDOW_HEIGHT: u32 = 480;
#[cfg(target_os = "windows")]
const DESKTOP_TRAY_ID: &str = "shipflow-desktop-tray";
#[cfg(target_os = "windows")]
const DESKTOP_TRAY_OPEN_ID: &str = "desktop-tray-open";
#[cfg(target_os = "windows")]
const DESKTOP_TRAY_QUIT_ID: &str = "desktop-tray-quit";
#[cfg(target_os = "macos")]
const SERVICE_MENU_OPEN_PREFERENCES_ID: &str = "service-menu-open-preferences";
#[cfg(target_os = "macos")]
const SERVICE_MENU_QUIT_ID: &str = "service-menu-quit";

#[derive(Clone, Default)]
struct MainWebviewNavigationGuard {
    initial_load_finished_for_labels: Arc<Mutex<HashSet<String>>>,
}

#[derive(Clone, Default)]
pub struct DesktopTrayAvailabilityState {
    is_available: Arc<Mutex<bool>>,
}

impl DesktopTrayAvailabilityState {
    pub fn mark_available(&self) {
        *self
            .is_available
            .lock()
            .expect("desktop tray availability lock poisoned") = true;
    }

    pub fn mark_unavailable(&self) {
        *self
            .is_available
            .lock()
            .expect("desktop tray availability lock poisoned") = false;
    }

    pub fn is_available(&self) -> bool {
        *self
            .is_available
            .lock()
            .expect("desktop tray availability lock poisoned")
    }
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
    if let Err(error) = sync_service_tray(app.handle(), &tray_state) {
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
            if runtime_config.uses_custom_desktop_service_connection() {
                log_runtime_event(
                    "INFO",
                    format!(
                        "[ShipFlowDesktop] startup using custom service connection at {}",
                        runtime_config.service_client_base_url()
                    ),
                );
            } else {
                log_runtime_event(
                    "INFO",
                    format!(
                        "[ShipFlowDesktop] startup service runtime ready on port {} with source {:?}",
                        runtime_config.port, runtime_config.tracking_source
                    ),
                );
            }

            let status = service_controller.status();
            let tray_config = saved_config.unwrap_or_else(default_tray_service_config);
            tray_state.update_service(&tray_config, &status);
            if let Err(error) = sync_service_tray(app.handle(), &tray_state) {
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
                focus_desktop_main_window_runtime(&app_handle);
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

pub fn focus_desktop_main_window_runtime<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        log_runtime_event(
            "ERROR",
            "[ShipFlowDesktop] cannot focus main window because it is not registered",
        );
        return;
    };

    if let Err(error) = window.unminimize() {
        log_runtime_event(
            "ERROR",
            format!("[ShipFlowDesktop] failed to unminimize main window: {error}"),
        );
    }
    if let Err(error) = window.show() {
        log_runtime_event(
            "ERROR",
            format!("[ShipFlowDesktop] failed to show main window: {error}"),
        );
    }
    if let Err(error) = window.set_focus() {
        log_runtime_event(
            "ERROR",
            format!("[ShipFlowDesktop] failed to focus main window: {error}"),
        );
    }
    request_native_window_attention(&window, "desktop main window");
}

fn request_native_window_attention<R: Runtime>(window: &WebviewWindow<R>, label: &str) {
    if let Err(error) = window.request_user_attention(Some(tauri::UserAttentionType::Informational))
    {
        log_runtime_event(
            "ERROR",
            format!("[ShipFlowWindow] failed to request native attention for {label}: {error}"),
        );
    }
}

fn focus_service_settings_window_runtime<R: Runtime>(
    _app: &AppHandle<R>,
    window: &WebviewWindow<R>,
) {
    #[cfg(target_os = "macos")]
    if let Err(error) = _app.set_activation_policy(tauri::ActivationPolicy::Regular) {
        log_runtime_event(
            "ERROR",
            format!("[ShipFlowService] failed to activate regular app policy: {error}"),
        );
    }

    if let Err(error) = window.unminimize() {
        log_runtime_event(
            "ERROR",
            format!("[ShipFlowService] failed to unminimize service settings window: {error}"),
        );
    }
    if let Err(error) = window.show() {
        log_runtime_event(
            "ERROR",
            format!("[ShipFlowService] failed to show service settings window: {error}"),
        );
    }
    if let Err(error) = window.set_focus() {
        log_runtime_event(
            "ERROR",
            format!("[ShipFlowService] failed to focus service settings window: {error}"),
        );
    }
    request_native_window_attention(window, "service settings window");
}

fn spawn_service_settings_activation_listener(app_handle: tauri::AppHandle<tauri::Wry>) {
    std::thread::spawn(move || loop {
        match service::take_pending_service_settings_activation_request() {
            Ok(Some(request)) if request.focus_main_window => {
                if let Some(window) = app_handle.get_webview_window("service-settings") {
                    focus_service_settings_window_runtime(&app_handle, &window);
                } else if let Err(error) = open_service_settings_window_runtime(&app_handle) {
                    log_runtime_event(
                        "ERROR",
                        format!(
                            "[ShipFlowService] failed to reopen service settings window: {error}"
                        ),
                    );
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

fn service_settings_webview_url() -> WebviewUrl {
    if cfg!(debug_assertions) {
        if let Ok(raw_url) = env::var("SHIPFLOW_SERVICE_SETTINGS_URL") {
            match tauri::Url::parse(&raw_url) {
                Ok(mut url) => {
                    if !url
                        .query_pairs()
                        .any(|(key, value)| key == "windowKind" && value == "service-settings")
                    {
                        url.query_pairs_mut()
                            .append_pair("windowKind", "service-settings");
                    }
                    return WebviewUrl::External(url);
                }
                Err(error) => {
                    log_runtime_event(
                        "ERROR",
                        format!(
                            "[ShipFlowService] invalid SHIPFLOW_SERVICE_SETTINGS_URL '{raw_url}': {error}"
                        ),
                    );
                }
            }
        }
    }

    WebviewUrl::App("index.html?windowKind=service-settings".into())
}

pub fn load_service_window_icon() -> Result<Image<'static>, String> {
    let decoder = PngDecoder::new(Cursor::new(include_bytes!(
        "../../../src-tauri/icons/service-icon.png"
    )));
    let mut reader = decoder
        .read_info()
        .map_err(|error| format!("Unable to decode service window icon metadata: {error}"))?;
    let mut buffer = vec![0; reader.output_buffer_size()];
    let info = reader
        .next_frame(&mut buffer)
        .map_err(|error| format!("Unable to decode service window icon pixels: {error}"))?;

    let rgba_bytes = match info.color_type {
        png::ColorType::Rgba => buffer[..info.buffer_size()].to_vec(),
        png::ColorType::Rgb => buffer[..info.buffer_size()]
            .chunks_exact(3)
            .flat_map(|chunk| [chunk[0], chunk[1], chunk[2], 255])
            .collect(),
        _ => return Err("Service window icon must be RGB or RGBA PNG.".to_string()),
    };

    Ok(Image::new_owned(rgba_bytes, info.width, info.height))
}

fn with_service_window_icon<'a, R: Runtime, M: Manager<R>>(
    builder: tauri::WebviewWindowBuilder<'a, R, M>,
) -> Result<tauri::WebviewWindowBuilder<'a, R, M>, String> {
    builder
        .icon(load_service_window_icon()?)
        .map_err(|error| format!("Unable to set service window icon: {error}"))
}

fn restore_window_state<R: Runtime>(window: &WebviewWindow<R>, window_state_key: &str) {
    let state = match service::load_window_state(window_state_key) {
        Ok(Some(state)) => state,
        Ok(None) => return,
        Err(error) => {
            log_runtime_event(
                "ERROR",
                format!(
                    "[ShipFlowWindow] failed to load window state '{window_state_key}': {error}"
                ),
            );
            return;
        }
    };

    if state.width < MIN_RESTORED_WINDOW_WIDTH || state.height < MIN_RESTORED_WINDOW_HEIGHT {
        log_runtime_event(
            "ERROR",
            format!(
                "[ShipFlowWindow] ignored invalid window state '{window_state_key}' size={}x{}",
                state.width, state.height
            ),
        );
        return;
    }

    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
        width: state.width,
        height: state.height,
    }));
    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
        x: state.x,
        y: state.y,
    }));

    if state.maximized {
        let _ = window.maximize();
    }
}

fn persist_window_state_from_window<R: Runtime>(window: &Window<R>, window_state_key: &str) {
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.inner_size() else {
        return;
    };

    if size.width < MIN_RESTORED_WINDOW_WIDTH || size.height < MIN_RESTORED_WINDOW_HEIGHT {
        return;
    }

    let state = service::SavedWindowState {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: window.is_maximized().unwrap_or(false),
    };

    if let Err(error) = service::persist_window_state(window_state_key, &state) {
        log_runtime_event(
            "ERROR",
            format!(
                "[ShipFlowWindow] failed to persist window state '{window_state_key}': {error}"
            ),
        );
    }
}

fn persist_window_state_for_event<R: Runtime>(
    window: &Window<R>,
    event: &WindowEvent,
    window_state_key: &str,
) {
    match event {
        WindowEvent::Moved(_)
        | WindowEvent::Resized(_)
        | WindowEvent::CloseRequested { .. }
        | WindowEvent::Destroyed => persist_window_state_from_window(window, window_state_key),
        _ => {}
    }
}

fn should_hide_service_settings_window_on_close(config: Option<ApiServiceConfig>) -> bool {
    config.is_none_or(|config| config.keep_running_in_tray)
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn should_hide_desktop_window_on_windows_close(is_tray_available: bool) -> bool {
    is_tray_available
}

fn desktop_window_state_key(label: &str) -> Option<&'static str> {
    if label == "main" {
        return Some(DESKTOP_MAIN_WINDOW_STATE_KEY);
    }

    if label.starts_with("workspace-") {
        return Some(DESKTOP_WORKSPACE_WINDOW_STATE_KEY);
    }

    None
}

fn should_start_service_tray_companion_on_settings_start(
    config: Option<&ApiServiceConfig>,
) -> bool {
    config.is_none_or(|config| {
        config.keep_running_in_tray && !config.uses_custom_desktop_service_connection()
    })
}

pub fn build_tracking_client(user_agent: &str) -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(90))
        .timeout(Duration::from_secs(120))
        .user_agent(user_agent)
        .build()
        .expect("failed to create tracking client")
}

pub fn build_main_webview_navigation_guard_plugin() -> TauriPlugin<tauri::Wry> {
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

pub fn build_signed_updater_plugin() -> TauriPlugin<tauri::Wry, tauri_plugin_updater::Config> {
    tauri_plugin_updater::Builder::new().build()
}

pub fn is_signed_updater_configured(config: &tauri::Config) -> bool {
    config
        .plugins
        .0
        .get("updater")
        .is_some_and(serde_json::Value::is_object)
}

pub fn maybe_install_signed_updater_plugin(
    builder: tauri::Builder<tauri::Wry>,
    config: &tauri::Config,
) -> tauri::Builder<tauri::Wry> {
    if is_signed_updater_configured(config) {
        return builder.plugin(build_signed_updater_plugin());
    }

    log_runtime_event(
        "WARN",
        "[ShipFlowUpdater] updater plugin skipped because plugins.updater is not configured",
    );
    builder
}

pub fn build_desktop_single_instance_plugin() -> TauriPlugin<tauri::Wry> {
    tauri_plugin_single_instance::init(|app, _args, _cwd| {
        log_runtime_event(
            "INFO",
            "[ShipFlowDesktop] secondary launch delegated to existing desktop instance",
        );

        focus_desktop_main_window_runtime(app);
    })
}

#[cfg(target_os = "windows")]
fn build_desktop_windows_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open_item = MenuItem::with_id(
        app,
        DESKTOP_TRAY_OPEN_ID,
        "Open ShipFlow Desktop",
        true,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(
        app,
        DESKTOP_TRAY_QUIT_ID,
        "Quit ShipFlow Desktop",
        true,
        None::<&str>,
    )?;
    let menu = Menu::with_items(
        app,
        &[&open_item, &PredefinedMenuItem::separator(app)?, &quit_item],
    )?;

    let mut tray_builder = TrayIconBuilder::with_id(DESKTOP_TRAY_ID)
        .menu(&menu)
        .tooltip("ShipFlow Desktop")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            handle_desktop_windows_tray_menu_event(app, event.id().as_ref());
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => {
                log_runtime_event("INFO", "[ShipFlowDesktopTray] open desktop requested");
                focus_desktop_main_window_runtime(tray.app_handle());
            }
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } => {
                log_runtime_event("INFO", "[ShipFlowDesktopTray] open desktop requested");
                focus_desktop_main_window_runtime(tray.app_handle());
            }
            _ => {}
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        tray_builder = tray_builder.icon(icon);
    }

    tray_builder.build(app)?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn handle_desktop_windows_tray_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        DESKTOP_TRAY_OPEN_ID => {
            log_runtime_event("INFO", "[ShipFlowDesktopTray] open desktop requested");
            focus_desktop_main_window_runtime(app);
        }
        DESKTOP_TRAY_QUIT_ID => {
            log_runtime_event("INFO", "[ShipFlowDesktopTray] quitting ShipFlow Desktop");
            let close_guard = app.state::<WindowCloseGuardState>();
            for label in app.webview_windows().keys() {
                close_guard.allow_next_close(label);
            }
            service::clear_current_desktop_process();
            app.exit(0);
        }
        _ => {}
    }
}

pub fn build_service_settings_single_instance_plugin() -> TauriPlugin<tauri::Wry> {
    tauri_plugin_single_instance::init(|app, args, _cwd| {
        log_runtime_event(
            "INFO",
            "[ShipFlowService] secondary launch delegated to existing service settings instance",
        );

        if !service::should_show_service_settings_window_for_args(args.iter().map(String::as_str)) {
            log_runtime_event(
                "INFO",
                "[ShipFlowService] secondary background launch kept service settings hidden",
            );
            return;
        }

        if let Err(error) = open_service_settings_window_runtime(app) {
            log_runtime_event(
                "ERROR",
                format!(
                    "[ShipFlowService] failed to focus service settings from secondary launch: {error}"
                ),
            );
        }
    })
}

#[cfg(target_os = "macos")]
pub fn build_service_settings_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let pkg_info = app.package_info();
    let config = app.config();
    let about_metadata = AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config
            .bundle
            .publisher
            .clone()
            .map(|publisher| vec![publisher]),
        ..Default::default()
    };

    let preferences_item = MenuItem::with_id(
        app,
        SERVICE_MENU_OPEN_PREFERENCES_ID,
        "Preferences...",
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let quit_item = MenuItem::with_id(
        app,
        SERVICE_MENU_QUIT_ID,
        "Quit ShipFlow Service",
        true,
        Some("CmdOrCtrl+Q"),
    )?;
    let app_menu = Submenu::with_items(
        app,
        pkg_info.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about_metadata))?,
            &PredefinedMenuItem::separator(app)?,
            &preferences_item,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
        ],
    )?;

    Menu::with_items(app, &[&app_menu, &window_menu])
}

#[cfg(target_os = "macos")]
pub fn handle_service_settings_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        SERVICE_MENU_OPEN_PREFERENCES_ID => {
            if let Err(error) = open_service_settings_window_runtime(app) {
                log_runtime_event(
                    "ERROR",
                    format!("[ShipFlowServiceMenu] failed to open service preferences: {error}"),
                );
            } else {
                log_runtime_event("INFO", "[ShipFlowServiceMenu] open preferences succeeded");
            }
        }
        SERVICE_MENU_QUIT_ID => {
            log_runtime_event("INFO", "[ShipFlowServiceMenu] quitting ShipFlow Service");
            service::stop_service_process();
            service::stop_service_tray_companion();
            service::clear_current_service_settings_process();
            app.exit(0);
        }
        _ => {}
    }
}

pub fn desktop_setup(app: &mut App<tauri::Wry>) -> Result<(), Box<dyn std::error::Error>> {
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
    let desktop_tracking_config =
        service::load_desktop_tracking_service_config().unwrap_or_else(|error| {
            log_runtime_event(
                "ERROR",
                format!("[ShipFlowDesktop] failed to load desktop service config: {error}"),
            );
            saved_config
        });
    ensure_desktop_tracking_runtime(app, desktop_tracking_config);

    if let Some(window) = app.get_webview_window("main") {
        restore_window_state(&window, DESKTOP_MAIN_WINDOW_STATE_KEY);
    }

    #[cfg(target_os = "windows")]
    {
        let desktop_tray_availability = app.state::<DesktopTrayAvailabilityState>();
        match build_desktop_windows_tray(app.handle()) {
            Ok(()) => {
                desktop_tray_availability.mark_available();
                log_runtime_event("INFO", "[ShipFlowDesktopTray] Windows tray ready");
            }
            Err(error) => {
                desktop_tray_availability.mark_unavailable();
                log_runtime_event(
                    "ERROR",
                    format!("[ShipFlowDesktopTray] failed to initialize Windows tray: {error}"),
                );
            }
        }
    }

    spawn_desktop_activation_listener(app.handle().clone());
    Ok(())
}

pub fn service_settings_setup(app: &mut App<tauri::Wry>) -> Result<(), Box<dyn std::error::Error>> {
    if let Err(error) = service::register_current_service_settings_process() {
        log_runtime_event(
            "ERROR",
            format!("[ShipFlowService] failed to register service settings process: {error}"),
        );
    }

    let saved_config = initialize_tracking_source_state(
        app,
        "[ShipFlowService] failed to load persisted config:",
        "[ShipFlowService] failed to sync tray companion:",
    );
    let should_keep_tray_companion =
        should_start_service_tray_companion_on_settings_start(saved_config.as_ref());
    let is_tray_available = if should_keep_tray_companion {
        match service::ensure_service_tray_companion_running() {
            Ok(()) => true,
            Err(error) => {
                log_runtime_event(
                    "ERROR",
                    format!("[ShipFlowService] failed to start tray companion: {error}"),
                );
                false
            }
        }
    } else {
        false
    };

    let should_show_window = service::should_show_service_settings_window_from_current_args();
    let should_show_window = should_show_window || !is_tray_available;

    #[cfg(target_os = "macos")]
    {
        let activation_policy = if should_show_window {
            tauri::ActivationPolicy::Regular
        } else {
            tauri::ActivationPolicy::Accessory
        };
        if let Err(error) = app.handle().set_activation_policy(activation_policy) {
            log_runtime_event(
                "ERROR",
                format!("[ShipFlowService] failed to set initial macOS app policy: {error}"),
            );
        }
    }

    let service_window_builder =
        tauri::WebviewWindowBuilder::new(app, "service-settings", service_settings_webview_url())
            .title("ShipFlow Service")
            .inner_size(980.0, 820.0)
            .resizable(true)
            .visible(should_show_window)
            .initialization_script("window.__SHIPFLOW_WINDOW_KIND__ = 'service-settings';");

    let service_window = with_service_window_icon(service_window_builder)
        .map_err(std::io::Error::other)?
        .build()
        .map_err(|error| {
            std::io::Error::other(format!("Unable to create ShipFlow Service window: {error}"))
        })?;
    restore_window_state(&service_window, SERVICE_SETTINGS_WINDOW_STATE_KEY);
    if should_show_window {
        focus_service_settings_window_runtime(app.handle(), &service_window);
    }

    spawn_service_settings_activation_listener(app.handle().clone());
    Ok(())
}

pub fn open_service_settings_window_runtime<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if let Err(error) = app.set_activation_policy(tauri::ActivationPolicy::Regular) {
        log_runtime_event(
            "ERROR",
            format!("[ShipFlowService] failed to activate regular app policy: {error}"),
        );
    }

    if let Some(window) = app.get_webview_window("service-settings") {
        focus_service_settings_window_runtime(app, &window);
        return Ok(());
    }

    let service_window_builder =
        tauri::WebviewWindowBuilder::new(app, "service-settings", service_settings_webview_url())
            .title("ShipFlow Service")
            .inner_size(980.0, 820.0)
            .resizable(true)
            .initialization_script("window.__SHIPFLOW_WINDOW_KIND__ = 'service-settings';");

    let service_window = with_service_window_icon(service_window_builder)
        .map_err(|error| format!("Unable to create ShipFlow Service window: {error}"))?
        .build()
        .map_err(|error| format!("Unable to create ShipFlow Service window: {error}"))?;
    restore_window_state(&service_window, SERVICE_SETTINGS_WINDOW_STATE_KEY);
    focus_service_settings_window_runtime(app, &service_window);
    Ok(())
}

pub fn handle_desktop_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if let Some(window_state_key) = desktop_window_state_key(window.label()) {
        persist_window_state_for_event(window, event, window_state_key);
    }

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

                #[cfg(target_os = "windows")]
                return;
            }

            #[cfg(target_os = "windows")]
            if window.label() == "main" {
                let desktop_tray_available = window
                    .state::<DesktopTrayAvailabilityState>()
                    .is_available();
                if should_hide_desktop_window_on_windows_close(desktop_tray_available) {
                    api.prevent_close();
                    if let Err(error) = window.hide() {
                        log_runtime_event(
                            "ERROR",
                            format!("[ShipFlowDesktopTray] failed to hide main window: {error}"),
                        );
                    } else {
                        log_runtime_event(
                            "INFO",
                            "[ShipFlowDesktopTray] main window hidden to tray",
                        );
                    }
                } else {
                    log_runtime_event(
                        "WARN",
                        "[ShipFlowDesktopTray] Windows tray unavailable; allowing main window close",
                    );
                }
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

pub fn handle_service_settings_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if window.label() != "service-settings" {
        return;
    }

    persist_window_state_for_event(window, event, SERVICE_SETTINGS_WINDOW_STATE_KEY);

    match event {
        WindowEvent::CloseRequested { api, .. } => {
            let saved_config = service::load_saved_api_service_config().ok().flatten();
            if !should_hide_service_settings_window_on_close(saved_config) {
                return;
            }

            api.prevent_close();
            if let Err(error) = service::register_current_service_settings_process() {
                log_runtime_event(
                    "ERROR",
                    format!("[ShipFlowService] failed to refresh service settings pid: {error}"),
                );
            }
            if let Err(error) = service::ensure_service_tray_companion_running() {
                log_runtime_event(
                    "ERROR",
                    format!("[ShipFlowService] failed to keep tray companion alive: {error}"),
                );
            }
            if let Err(error) = window.hide() {
                log_runtime_event(
                    "ERROR",
                    format!("[ShipFlowService] failed to hide service window: {error}"),
                );
            }
            #[cfg(target_os = "macos")]
            if let Err(error) = window
                .app_handle()
                .set_activation_policy(tauri::ActivationPolicy::Accessory)
            {
                log_runtime_event(
                    "ERROR",
                    format!("[ShipFlowService] failed to restore accessory app policy: {error}"),
                );
            }
        }
        WindowEvent::Destroyed => {
            service::clear_current_service_settings_process();
            #[cfg(target_os = "macos")]
            if let Err(error) = window
                .app_handle()
                .set_activation_policy(tauri::ActivationPolicy::Accessory)
            {
                log_runtime_event(
                    "ERROR",
                    format!("[ShipFlowService] failed to restore accessory app policy: {error}"),
                );
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::{
        desktop_window_state_key, should_hide_desktop_window_on_windows_close,
        should_hide_service_settings_window_on_close,
        should_start_service_tray_companion_on_settings_start,
    };
    use crate::service::{ApiServiceConfig, ApiServiceMode, DesktopServiceConnectionMode};
    use crate::tracking::model::TrackingSource;

    fn service_config(keep_running_in_tray: bool) -> ApiServiceConfig {
        ApiServiceConfig {
            version: 1,
            desktop_connection_mode: DesktopServiceConnectionMode::ManagedLocal,
            desktop_service_url: "http://127.0.0.1:18422".into(),
            desktop_service_auth_token: String::new(),
            enabled: true,
            mode: ApiServiceMode::Local,
            port: 18422,
            auth_token: "sf_service_token".into(),
            tracking_source: TrackingSource::Default,
            external_api_base_url: String::new(),
            external_api_auth_token: String::new(),
            allow_insecure_external_api_http: false,
            keep_running_in_tray,
            start_at_login: true,
            last_updated_at: "2026-04-21T00:00:00.000Z".into(),
        }
    }

    #[test]
    fn service_settings_close_hides_when_tray_mode_is_enabled() {
        assert!(should_hide_service_settings_window_on_close(Some(
            service_config(true),
        )));
    }

    #[test]
    fn service_settings_close_exits_when_tray_mode_is_disabled() {
        assert!(!should_hide_service_settings_window_on_close(Some(
            service_config(false),
        )));
    }

    #[test]
    fn service_settings_close_defaults_to_tray_mode_before_config_exists() {
        assert!(should_hide_service_settings_window_on_close(None));
    }

    #[test]
    fn desktop_close_to_tray_requires_available_windows_tray() {
        assert!(should_hide_desktop_window_on_windows_close(true));
        assert!(!should_hide_desktop_window_on_windows_close(false));
    }

    #[test]
    fn desktop_window_state_key_covers_main_and_workspace_windows() {
        assert_eq!(desktop_window_state_key("main"), Some("desktop.main"));
        assert_eq!(
            desktop_window_state_key("workspace-abc123"),
            Some("desktop.workspace")
        );
        assert_eq!(desktop_window_state_key("service-settings"), None);
    }

    #[test]
    fn service_settings_start_uses_tray_companion_only_when_tray_mode_is_enabled() {
        let disabled_tray_config = service_config(false);
        let starts_with_disabled_tray =
            should_start_service_tray_companion_on_settings_start(Some(&disabled_tray_config));

        assert!(should_start_service_tray_companion_on_settings_start(Some(
            &service_config(true),
        )));
        assert!(!starts_with_disabled_tray);
        assert!(should_start_service_tray_companion_on_settings_start(None));
    }

    #[test]
    fn service_settings_start_does_not_spawn_tray_for_custom_desktop_connection() {
        let mut config = service_config(true);
        config.desktop_connection_mode = DesktopServiceConnectionMode::Custom;
        let starts_with_custom_connection =
            should_start_service_tray_companion_on_settings_start(Some(&config));

        assert!(!starts_with_custom_connection);
    }
}
