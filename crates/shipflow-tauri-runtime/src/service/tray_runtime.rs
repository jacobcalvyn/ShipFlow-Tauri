use std::{io::Cursor, time::Instant};

use png::Decoder as PngDecoder;
#[cfg(target_os = "macos")]
use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
use tao::{
    event::{Event, StartCause},
    event_loop::{ControlFlow, EventLoopBuilder},
};
use tray_icon::{
    menu::{Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem},
    Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent,
};

use super::{
    process_runtime::{
        build_service_endpoint, format_service_status_label, launch_shipflow_desktop_companion,
        launch_shipflow_service_settings_companion, stop_service_process,
        stop_service_settings_process,
    },
    ApiServiceConfig, ApiServiceController, ApiServiceStatus, ApiServiceStatusKind,
    SERVICE_TRAY_COPY_ENDPOINT_ID, SERVICE_TRAY_COPY_TOKEN_ID, SERVICE_TRAY_ID,
    SERVICE_TRAY_OPEN_DESKTOP_ID, SERVICE_TRAY_OPEN_SETTINGS_ID, SERVICE_TRAY_QUIT_ID,
    SERVICE_TRAY_REFRESH_INTERVAL, SERVICE_TRAY_RESTART_SERVICE_ID, SERVICE_TRAY_STATUS_ID,
    SERVICE_TRAY_STOP_SERVICE_ID,
};
use crate::os_bridge::copy_text_to_clipboard;
use crate::runtime_log::log_runtime_event;
use crate::service::state_store::clear_recorded_tray_pid;

enum ServiceTrayUserEvent {
    Menu(MenuEvent),
    Tray(TrayIconEvent),
}

struct ServiceTrayRuntime {
    _tray_icon: TrayIcon,
    status_item: MenuItem,
    open_settings_item: MenuItem,
    open_desktop_item: MenuItem,
    copy_endpoint_item: MenuItem,
    copy_token_item: MenuItem,
    restart_service_item: MenuItem,
    stop_service_item: MenuItem,
    quit_item: MenuItem,
    last_config: Option<ApiServiceConfig>,
    last_auto_start_attempt_key: Option<String>,
}

fn log_tray_action_result<T>(action: &str, result: Result<T, String>) {
    match result {
        Ok(_) => log_runtime_event("INFO", format!("[ShipFlowServiceTray] {action} succeeded")),
        Err(error) => log_runtime_event(
            "ERROR",
            format!("[ShipFlowServiceTray] {action} failed: {error}"),
        ),
    }
}

fn can_copy_service_endpoint(config: Option<&ApiServiceConfig>) -> bool {
    config.is_some_and(|config| !config.uses_custom_desktop_service_connection())
}

fn can_copy_service_token(config: Option<&ApiServiceConfig>) -> bool {
    config.is_some_and(|config| {
        can_copy_service_endpoint(Some(config)) && !config.auth_token.trim().is_empty()
    })
}

fn can_restart_api_service(config: Option<&ApiServiceConfig>) -> bool {
    config.is_some_and(|config| !config.uses_custom_desktop_service_connection())
}

fn can_stop_api_service(config: Option<&ApiServiceConfig>) -> bool {
    config.is_some_and(|config| config.enabled && !config.uses_custom_desktop_service_connection())
}

impl ServiceTrayRuntime {
    fn new() -> Result<Self, String> {
        let status_item = MenuItem::with_id(
            MenuId::new(SERVICE_TRAY_STATUS_ID),
            "Status: API Off",
            false,
            None,
        );
        let open_settings_item = MenuItem::with_id(
            MenuId::new(SERVICE_TRAY_OPEN_SETTINGS_ID),
            "Open ShipFlow Service",
            true,
            None,
        );
        let open_desktop_item = MenuItem::with_id(
            MenuId::new(SERVICE_TRAY_OPEN_DESKTOP_ID),
            "Open ShipFlow Desktop",
            true,
            None,
        );
        let copy_endpoint_item = MenuItem::with_id(
            MenuId::new(SERVICE_TRAY_COPY_ENDPOINT_ID),
            "Copy Endpoint",
            false,
            None,
        );
        let copy_token_item = MenuItem::with_id(
            MenuId::new(SERVICE_TRAY_COPY_TOKEN_ID),
            "Copy Token",
            false,
            None,
        );
        let restart_service_item = MenuItem::with_id(
            MenuId::new(SERVICE_TRAY_RESTART_SERVICE_ID),
            "Restart API",
            false,
            None,
        );
        let stop_service_item = MenuItem::with_id(
            MenuId::new(SERVICE_TRAY_STOP_SERVICE_ID),
            "Stop API",
            false,
            None,
        );
        let quit_item = MenuItem::with_id(
            MenuId::new(SERVICE_TRAY_QUIT_ID),
            "Quit ShipFlow Service",
            true,
            None,
        );
        let separator_top = PredefinedMenuItem::separator();
        let separator_bottom = PredefinedMenuItem::separator();

        let menu = Menu::new();
        menu.append_items(&[
            &status_item,
            &open_settings_item,
            &open_desktop_item,
            &separator_top,
            &copy_endpoint_item,
            &copy_token_item,
            &restart_service_item,
            &stop_service_item,
            &separator_bottom,
            &quit_item,
        ])
        .map_err(|error| format!("Unable to build service tray menu: {error}"))?;

        let mut tray_builder = TrayIconBuilder::new()
            .with_id(SERVICE_TRAY_ID)
            .with_menu(Box::new(menu))
            .with_tooltip("ShipFlow Service")
            .with_menu_on_left_click(false);

        if let Some(icon) = load_service_tray_icon()? {
            tray_builder = tray_builder.with_icon(icon);
        }

        #[cfg(target_os = "macos")]
        {
            tray_builder = tray_builder.with_icon_as_template(true).with_title("SF");
        }

        let tray_icon = tray_builder
            .build()
            .map_err(|error| format!("Unable to create service tray icon: {error}"))?;

        Ok(Self {
            _tray_icon: tray_icon,
            status_item,
            open_settings_item,
            open_desktop_item,
            copy_endpoint_item,
            copy_token_item,
            restart_service_item,
            stop_service_item,
            quit_item,
            last_config: None,
            last_auto_start_attempt_key: None,
        })
    }

    fn refresh(&mut self) {
        let controller = ApiServiceController::default();
        let saved_config = super::load_saved_api_service_config().unwrap_or(None);
        let mut status = controller.status();

        if let Some(config) = saved_config.as_ref() {
            if let Some(attempt_key) = should_auto_start_enabled_api_runtime(
                config,
                &status,
                self.last_auto_start_attempt_key.as_deref(),
            ) {
                self.last_auto_start_attempt_key = Some(attempt_key);
                match configure_service_blocking(config.clone()) {
                    Ok(next_status) => {
                        log_runtime_event(
                            "INFO",
                            "[ShipFlowServiceTray] auto-started enabled API runtime",
                        );
                        status = next_status;
                    }
                    Err(error) => {
                        log_runtime_event(
                            "ERROR",
                            format!(
                                "[ShipFlowServiceTray] failed to auto-start enabled API runtime: {error}"
                            ),
                        );
                        status = controller.status();
                    }
                }
            }
        }

        self.last_config = saved_config.clone();

        let status_label = match saved_config.as_ref() {
            Some(config) => format_service_status_label(config, &status),
            None => "API Off".into(),
        };

        self.status_item.set_text(format!("Status: {status_label}"));
        self.open_settings_item.set_enabled(true);
        self.open_desktop_item.set_enabled(true);

        let can_copy_endpoint = can_copy_service_endpoint(saved_config.as_ref());
        self.copy_endpoint_item.set_enabled(can_copy_endpoint);
        self.copy_token_item
            .set_enabled(can_copy_service_token(saved_config.as_ref()));
        self.restart_service_item
            .set_enabled(can_restart_api_service(saved_config.as_ref()));
        self.stop_service_item
            .set_enabled(can_stop_api_service(saved_config.as_ref()));
        self.quit_item.set_enabled(true);
    }

    fn handle_menu_event(&mut self, event: MenuEvent) -> bool {
        match event.id().as_ref() {
            SERVICE_TRAY_OPEN_SETTINGS_ID => {
                log_tray_action_result(
                    "open service settings",
                    launch_shipflow_service_settings_companion(),
                );
            }
            SERVICE_TRAY_OPEN_DESKTOP_ID => {
                log_tray_action_result("open desktop", launch_shipflow_desktop_companion());
            }
            SERVICE_TRAY_COPY_ENDPOINT_ID => {
                if let Some(config) = self.last_config.as_ref() {
                    let endpoint =
                        build_service_endpoint(config, &ApiServiceController::default().status());
                    log_tray_action_result("copy endpoint", copy_text_to_clipboard(&endpoint));
                }
            }
            SERVICE_TRAY_COPY_TOKEN_ID => {
                if let Some(config) = self.last_config.as_ref() {
                    if !config.auth_token.trim().is_empty() {
                        log_tray_action_result(
                            "copy token",
                            copy_text_to_clipboard(config.auth_token.trim()),
                        );
                    }
                }
            }
            SERVICE_TRAY_RESTART_SERVICE_ID => {
                if let Some(mut config) = self.last_config.clone() {
                    if can_restart_api_service(Some(&config)) {
                        config.enabled = true;
                        stop_service_process();
                        log_tray_action_result("restart API", configure_service_blocking(config));
                    }
                }
            }
            SERVICE_TRAY_STOP_SERVICE_ID => {
                if let Some(mut config) = self.last_config.clone() {
                    if can_stop_api_service(Some(&config)) {
                        config.enabled = false;
                        log_tray_action_result("stop API", configure_service_blocking(config));
                    }
                }
            }
            SERVICE_TRAY_QUIT_ID => {
                log_runtime_event("INFO", "[ShipFlowServiceTray] quit requested");
                stop_service_process();
                stop_service_settings_process();
                clear_recorded_tray_pid();
                return true;
            }
            _ => {}
        }

        self.refresh();
        false
    }

    fn handle_tray_event(&self, event: TrayIconEvent) {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } = event
        {
            log_tray_action_result(
                "open service settings from tray click",
                launch_shipflow_service_settings_companion(),
            );
        }
    }
}

fn service_runtime_auto_start_attempt_key(config: &ApiServiceConfig) -> String {
    format!(
        "v{}:{}:{}:{:?}:{}",
        config.version,
        config.mode.bind_address_label(),
        config.port,
        config.tracking_source_config().tracking_source,
        config.last_updated_at
    )
}

fn should_auto_start_enabled_api_runtime(
    config: &ApiServiceConfig,
    status: &ApiServiceStatus,
    last_attempt_key: Option<&str>,
) -> Option<String> {
    if !config.enabled || config.uses_custom_desktop_service_connection() {
        return None;
    }

    if matches!(status.status, ApiServiceStatusKind::Running) {
        return None;
    }

    let attempt_key = service_runtime_auto_start_attempt_key(config);
    if last_attempt_key == Some(attempt_key.as_str()) {
        return None;
    }

    Some(attempt_key)
}

pub fn run_service_tray_app() -> Result<bool, String> {
    let mut event_loop = EventLoopBuilder::<ServiceTrayUserEvent>::with_user_event().build();
    #[cfg(target_os = "macos")]
    {
        event_loop.set_activation_policy(ActivationPolicy::Accessory);
        event_loop.set_dock_visibility(false);
        event_loop.set_activate_ignoring_other_apps(false);
    }

    let menu_proxy = event_loop.create_proxy();
    MenuEvent::set_event_handler(Some(move |event| {
        let _ = menu_proxy.send_event(ServiceTrayUserEvent::Menu(event));
    }));

    let tray_proxy = event_loop.create_proxy();
    TrayIconEvent::set_event_handler(Some(move |event| {
        let _ = tray_proxy.send_event(ServiceTrayUserEvent::Tray(event));
    }));

    let mut tray_runtime: Option<ServiceTrayRuntime> = None;

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::WaitUntil(Instant::now() + SERVICE_TRAY_REFRESH_INTERVAL);

        match event {
            Event::NewEvents(StartCause::Init) if tray_runtime.is_none() => {
                match ServiceTrayRuntime::new() {
                    Ok(mut runtime) => {
                        runtime.refresh();
                        tray_runtime = Some(runtime);
                    }
                    Err(error) => {
                        log_runtime_event("ERROR", format!("[ShipFlowServiceTray] {error}"));
                        *control_flow = ControlFlow::Exit;
                    }
                }
            }
            Event::NewEvents(StartCause::ResumeTimeReached { .. }) => {
                if let Some(runtime) = tray_runtime.as_mut() {
                    runtime.refresh();
                }
            }
            Event::UserEvent(ServiceTrayUserEvent::Menu(event)) => {
                if let Some(runtime) = tray_runtime.as_mut() {
                    if runtime.handle_menu_event(event) {
                        *control_flow = ControlFlow::Exit;
                    }
                }
            }
            Event::UserEvent(ServiceTrayUserEvent::Tray(event)) => {
                if let Some(runtime) = tray_runtime.as_ref() {
                    runtime.handle_tray_event(event);
                }
            }
            Event::LoopDestroyed => {
                clear_recorded_tray_pid();
            }
            _ => {}
        }
    });
}

fn configure_service_blocking(config: ApiServiceConfig) -> Result<ApiServiceStatus, String> {
    let controller = ApiServiceController::default();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("Unable to create tray service runtime: {error}"))?;

    runtime.block_on(controller.configure(config))
}

fn load_service_tray_icon() -> Result<Option<Icon>, String> {
    let decoder = PngDecoder::new(Cursor::new(include_bytes!(
        "../../../../src-tauri/icons/service-icon.png"
    )));
    let mut reader = decoder
        .read_info()
        .map_err(|error| format!("Unable to decode tray icon metadata: {error}"))?;
    let mut buffer = vec![0; reader.output_buffer_size()];
    let info = reader
        .next_frame(&mut buffer)
        .map_err(|error| format!("Unable to decode tray icon pixels: {error}"))?;

    let rgba_bytes = match info.color_type {
        png::ColorType::Rgba => buffer[..info.buffer_size()].to_vec(),
        png::ColorType::Rgb => buffer[..info.buffer_size()]
            .chunks_exact(3)
            .flat_map(|chunk| [chunk[0], chunk[1], chunk[2], 255])
            .collect(),
        _ => return Ok(None),
    };

    Icon::from_rgba(rgba_bytes, info.width, info.height)
        .map(Some)
        .map_err(|error| format!("Unable to build tray icon: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{
        can_copy_service_endpoint, can_copy_service_token, can_restart_api_service,
        can_stop_api_service, should_auto_start_enabled_api_runtime,
    };
    use crate::service::{
        ApiServiceConfig, ApiServiceMode, ApiServiceStatus, ApiServiceStatusKind,
        DesktopServiceConnectionMode,
    };
    use crate::tracking::model::TrackingSource;

    fn service_config() -> ApiServiceConfig {
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
            keep_running_in_tray: true,
            start_at_login: true,
            last_updated_at: "2026-04-21T00:00:00.000Z".into(),
        }
    }

    fn status(status: ApiServiceStatusKind) -> ApiServiceStatus {
        ApiServiceStatus {
            status,
            enabled: true,
            mode: Some(ApiServiceMode::Local),
            bind_address: Some("127.0.0.1".into()),
            port: Some(18422),
            error_message: None,
        }
    }

    #[test]
    fn auto_start_runs_for_enabled_local_service_that_is_not_running() {
        assert!(should_auto_start_enabled_api_runtime(
            &service_config(),
            &status(ApiServiceStatusKind::Stopped),
            None,
        )
        .is_some());
    }

    #[test]
    fn auto_start_does_not_run_when_service_is_already_running() {
        assert!(should_auto_start_enabled_api_runtime(
            &service_config(),
            &status(ApiServiceStatusKind::Running),
            None,
        )
        .is_none());
    }

    #[test]
    fn auto_start_does_not_run_for_disabled_or_custom_service() {
        let mut disabled_config = service_config();
        disabled_config.enabled = false;
        assert!(should_auto_start_enabled_api_runtime(
            &disabled_config,
            &status(ApiServiceStatusKind::Stopped),
            None,
        )
        .is_none());

        let mut custom_config = service_config();
        custom_config.desktop_connection_mode = DesktopServiceConnectionMode::Custom;
        assert!(should_auto_start_enabled_api_runtime(
            &custom_config,
            &status(ApiServiceStatusKind::Stopped),
            None,
        )
        .is_none());
    }

    #[test]
    fn auto_start_does_not_repeat_for_same_config_after_failure() {
        let config = service_config();
        let attempt_key = should_auto_start_enabled_api_runtime(
            &config,
            &status(ApiServiceStatusKind::Error),
            None,
        )
        .expect("enabled service should request an auto-start attempt");

        assert!(should_auto_start_enabled_api_runtime(
            &config,
            &status(ApiServiceStatusKind::Error),
            Some(attempt_key.as_str()),
        )
        .is_none());

        let mut changed_config = config;
        changed_config.last_updated_at = "2026-04-22T00:00:00.000Z".into();
        assert!(should_auto_start_enabled_api_runtime(
            &changed_config,
            &status(ApiServiceStatusKind::Error),
            Some(attempt_key.as_str()),
        )
        .is_some());
    }

    #[test]
    fn service_tray_endpoint_and_restart_actions_do_not_require_running_api() {
        let mut stopped_config = service_config();
        stopped_config.enabled = false;

        assert!(can_copy_service_endpoint(Some(&stopped_config)));
        assert!(can_copy_service_token(Some(&stopped_config)));
        assert!(can_restart_api_service(Some(&stopped_config)));
        assert!(!can_stop_api_service(Some(&stopped_config)));
    }

    #[test]
    fn service_tray_api_actions_ignore_custom_desktop_connection() {
        let mut custom_config = service_config();
        custom_config.desktop_connection_mode = DesktopServiceConnectionMode::Custom;

        assert!(!can_copy_service_endpoint(Some(&custom_config)));
        assert!(!can_copy_service_token(Some(&custom_config)));
        assert!(!can_restart_api_service(Some(&custom_config)));
        assert!(!can_stop_api_service(Some(&custom_config)));
    }
}
