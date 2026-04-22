use std::{io::Cursor, time::Instant};

use png::Decoder as PngDecoder;
use tao::{
    event::{Event, StartCause},
    event_loop::{ControlFlow, EventLoopBuilder},
};
use tray_icon::{
    menu::{CheckMenuItem, Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem},
    Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent,
};

use super::{
    process_runtime::{
        build_service_endpoint, format_service_status_label, launch_shipflow_desktop_companion,
        launch_shipflow_service_settings_companion,
    },
    ApiServiceConfig, ApiServiceController, ApiServiceStatus, ApiServiceStatusKind,
    SERVICE_TRAY_COPY_ENDPOINT_ID, SERVICE_TRAY_COPY_TOKEN_ID, SERVICE_TRAY_ID,
    SERVICE_TRAY_KEEP_RUNNING_ID, SERVICE_TRAY_OPEN_DESKTOP_ID, SERVICE_TRAY_OPEN_SETTINGS_ID,
    SERVICE_TRAY_QUIT_ID, SERVICE_TRAY_REFRESH_INTERVAL, SERVICE_TRAY_STATUS_ID,
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
    keep_running_item: CheckMenuItem,
    stop_service_item: MenuItem,
    last_config: Option<ApiServiceConfig>,
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
        let keep_running_item = CheckMenuItem::with_id(
            MenuId::new(SERVICE_TRAY_KEEP_RUNNING_ID),
            "Keep Running in Tray",
            true,
            false,
            None,
        );
        let stop_service_item = MenuItem::with_id(
            MenuId::new(SERVICE_TRAY_STOP_SERVICE_ID),
            "Stop External API Access",
            false,
            None,
        );
        let quit_item =
            MenuItem::with_id(MenuId::new(SERVICE_TRAY_QUIT_ID), "Quit Tray", true, None);
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
            &keep_running_item,
            &stop_service_item,
            &separator_bottom,
            &quit_item,
        ])
        .map_err(|error| format!("Unable to build service tray menu: {error}"))?;

        let mut tray_builder = TrayIconBuilder::new()
            .with_id(SERVICE_TRAY_ID)
            .with_menu(Box::new(menu))
            .with_tooltip("ShipFlow Service")
            .with_title("ShipFlow Service")
            .with_menu_on_left_click(false);

        if let Some(icon) = load_service_tray_icon()? {
            tray_builder = tray_builder.with_icon(icon);
        }

        #[cfg(target_os = "macos")]
        {
            tray_builder = tray_builder.with_icon_as_template(true);
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
            keep_running_item,
            stop_service_item,
            last_config: None,
        })
    }

    fn refresh(&mut self) {
        let controller = ApiServiceController::default();
        let saved_config = super::load_saved_api_service_config().unwrap_or(None);
        let status = controller.status();
        self.last_config = saved_config.clone();

        let status_label = match saved_config.as_ref() {
            Some(config) => format_service_status_label(config, &status),
            None => "API Off".into(),
        };

        self.status_item.set_text(format!("Status: {status_label}"));
        self.open_settings_item.set_enabled(true);
        self.open_desktop_item.set_enabled(true);

        let can_copy_endpoint = saved_config.as_ref().is_some_and(|config| {
            config.enabled && matches!(status.status, ApiServiceStatusKind::Running)
        });
        self.copy_endpoint_item.set_enabled(can_copy_endpoint);
        self.copy_token_item.set_enabled(
            saved_config
                .as_ref()
                .is_some_and(|config| can_copy_endpoint && !config.auth_token.trim().is_empty()),
        );
        self.stop_service_item
            .set_enabled(saved_config.as_ref().is_some_and(|config| config.enabled));
        self.keep_running_item.set_checked(
            saved_config
                .as_ref()
                .is_some_and(|config| config.keep_running_in_tray),
        );
    }

    fn handle_menu_event(&mut self, event: MenuEvent, control_flow: &mut ControlFlow) {
        match event.id().as_ref() {
            SERVICE_TRAY_OPEN_SETTINGS_ID => {
                let _ = launch_shipflow_service_settings_companion();
            }
            SERVICE_TRAY_OPEN_DESKTOP_ID => {
                let _ = launch_shipflow_desktop_companion();
            }
            SERVICE_TRAY_COPY_ENDPOINT_ID => {
                if let Some(config) = self.last_config.as_ref() {
                    let endpoint =
                        build_service_endpoint(config, &ApiServiceController::default().status());
                    let _ = copy_text_to_clipboard(&endpoint);
                }
            }
            SERVICE_TRAY_COPY_TOKEN_ID => {
                if let Some(config) = self.last_config.as_ref() {
                    if !config.auth_token.trim().is_empty() {
                        let _ = copy_text_to_clipboard(config.auth_token.trim());
                    }
                }
            }
            SERVICE_TRAY_KEEP_RUNNING_ID => {
                if let Some(mut config) = self.last_config.clone() {
                    config.keep_running_in_tray = !config.keep_running_in_tray;
                    let _ = configure_service_blocking(config.clone());
                    if !config.keep_running_in_tray {
                        *control_flow = ControlFlow::Exit;
                        return;
                    }
                }
            }
            SERVICE_TRAY_STOP_SERVICE_ID => {
                if let Some(mut config) = self.last_config.clone() {
                    config.enabled = false;
                    let _ = configure_service_blocking(config.clone());
                    *control_flow = ControlFlow::Exit;
                    return;
                }
            }
            SERVICE_TRAY_QUIT_ID => {
                *control_flow = ControlFlow::Exit;
                return;
            }
            _ => {}
        }

        self.refresh();
    }

    fn handle_tray_event(&self, event: TrayIconEvent) {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } = event
        {
            let _ = launch_shipflow_service_settings_companion();
        }
    }
}

pub(crate) fn run_service_tray_app() -> Result<bool, String> {
    let event_loop = EventLoopBuilder::<ServiceTrayUserEvent>::with_user_event().build();
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
            Event::NewEvents(StartCause::Init) => {
                if tray_runtime.is_none() {
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
            }
            Event::NewEvents(StartCause::ResumeTimeReached { .. }) => {
                if let Some(runtime) = tray_runtime.as_mut() {
                    runtime.refresh();
                }
            }
            Event::UserEvent(ServiceTrayUserEvent::Menu(event)) => {
                if let Some(runtime) = tray_runtime.as_mut() {
                    runtime.handle_menu_event(event, control_flow);
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
    let decoder = PngDecoder::new(Cursor::new(include_bytes!("../../icons/icon.png")));
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
