use serde::Serialize;
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use shipflow_tauri_runtime::runtime_log::log_runtime_event;

const APP_MENU_EVENT: &str = "shipflow://app-menu-command";
const APP_MENU_NEW_DOCUMENT_ID: &str = "app-menu-new-document";
const APP_MENU_OPEN_DOCUMENT_ID: &str = "app-menu-open-document";
const APP_MENU_SAVE_DOCUMENT_ID: &str = "app-menu-save-document";
const APP_MENU_SAVE_DOCUMENT_AS_ID: &str = "app-menu-save-document-as";
const APP_MENU_NEW_WINDOW_ID: &str = "app-menu-new-window";
const APP_MENU_OPEN_DOCUMENT_IN_NEW_WINDOW_ID: &str = "app-menu-open-document-in-new-window";
const APP_MENU_SHOW_SETTINGS_ID: &str = "app-menu-show-settings";
const APP_MENU_CHECK_FOR_UPDATES_ID: &str = "app-menu-check-for-updates";
const APP_MENU_INSTALL_APP_UPDATE_ID: &str = "app-menu-install-app-update";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppMenuCommandPayload {
    command: String,
}

pub(crate) fn build_desktop_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
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

    let new_document_item = MenuItem::with_id(
        app,
        APP_MENU_NEW_DOCUMENT_ID,
        "New Workspace",
        true,
        Some("CmdOrCtrl+N"),
    )?;
    let open_document_item = MenuItem::with_id(
        app,
        APP_MENU_OPEN_DOCUMENT_ID,
        "Open Workspace...",
        true,
        Some("CmdOrCtrl+O"),
    )?;
    let save_document_item = MenuItem::with_id(
        app,
        APP_MENU_SAVE_DOCUMENT_ID,
        "Save",
        true,
        Some("CmdOrCtrl+S"),
    )?;
    let save_document_as_item = MenuItem::with_id(
        app,
        APP_MENU_SAVE_DOCUMENT_AS_ID,
        "Save As...",
        true,
        Some("CmdOrCtrl+Shift+S"),
    )?;
    let new_window_item = MenuItem::with_id(
        app,
        APP_MENU_NEW_WINDOW_ID,
        "New Window",
        true,
        Some("CmdOrCtrl+Shift+N"),
    )?;
    let open_document_in_new_window_item = MenuItem::with_id(
        app,
        APP_MENU_OPEN_DOCUMENT_IN_NEW_WINDOW_ID,
        "Open Workspace in New Window...",
        true,
        None::<&str>,
    )?;
    #[cfg(target_os = "macos")]
    let settings_label = "Preferences...";
    #[cfg(not(target_os = "macos"))]
    let settings_label = "Settings...";
    let settings_item = MenuItem::with_id(
        app,
        APP_MENU_SHOW_SETTINGS_ID,
        settings_label,
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let check_for_updates_item = MenuItem::with_id(
        app,
        APP_MENU_CHECK_FOR_UPDATES_ID,
        "Check for Updates...",
        true,
        None::<&str>,
    )?;
    let install_app_update_item = MenuItem::with_id(
        app,
        APP_MENU_INSTALL_APP_UPDATE_ID,
        "Install Available Update...",
        true,
        None::<&str>,
    )?;
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new_document_item,
            &open_document_item,
            &PredefinedMenuItem::separator(app)?,
            &save_document_item,
            &save_document_as_item,
            &PredefinedMenuItem::separator(app)?,
            &new_window_item,
            &open_document_in_new_window_item,
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::separator(app)?,
            #[cfg(not(target_os = "macos"))]
            &settings_item,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::separator(app)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::fullscreen(app, None)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::show_all(app, None)?,
        ],
    )?;

    #[cfg(target_os = "macos")]
    let app_menu = Submenu::with_items(
        app,
        pkg_info.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about_metadata.clone()))?,
            &PredefinedMenuItem::separator(app)?,
            &settings_item,
            &PredefinedMenuItem::separator(app)?,
            &check_for_updates_item,
            &install_app_update_item,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    #[cfg(not(target_os = "macos"))]
    let help_menu = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            &check_for_updates_item,
            &install_app_update_item,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::about(app, None, Some(about_metadata))?,
        ],
    )?;

    Menu::with_items(
        app,
        &[
            #[cfg(target_os = "macos")]
            &app_menu,
            &file_menu,
            &edit_menu,
            &window_menu,
            #[cfg(not(target_os = "macos"))]
            &help_menu,
        ],
    )
}

fn emit_workspace_menu_command<R: Runtime>(app: &AppHandle<R>, command: &str) {
    let target_label = app
        .webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
        .map(|window| window.label().to_string())
        .or_else(|| {
            app.get_webview_window("main")
                .map(|window| window.label().to_string())
        });

    if let Some(label) = target_label {
        log_runtime_event(
            "INFO",
            format!("[ShipFlowDesktopMenu] command {command} emitted to {label}"),
        );
        let _ = app.emit_to(
            label,
            APP_MENU_EVENT,
            AppMenuCommandPayload {
                command: command.to_string(),
            },
        );
    }
}

pub(crate) fn handle_desktop_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        APP_MENU_NEW_DOCUMENT_ID => emit_workspace_menu_command(app, "new-document"),
        APP_MENU_OPEN_DOCUMENT_ID => emit_workspace_menu_command(app, "open-document"),
        APP_MENU_SAVE_DOCUMENT_ID => emit_workspace_menu_command(app, "save-document"),
        APP_MENU_SAVE_DOCUMENT_AS_ID => emit_workspace_menu_command(app, "save-document-as"),
        APP_MENU_NEW_WINDOW_ID => emit_workspace_menu_command(app, "new-window"),
        APP_MENU_OPEN_DOCUMENT_IN_NEW_WINDOW_ID => {
            emit_workspace_menu_command(app, "open-document-in-new-window")
        }
        APP_MENU_SHOW_SETTINGS_ID => emit_workspace_menu_command(app, "show-settings"),
        APP_MENU_CHECK_FOR_UPDATES_ID => emit_workspace_menu_command(app, "check-for-updates"),
        APP_MENU_INSTALL_APP_UPDATE_ID => emit_workspace_menu_command(app, "install-app-update"),
        _ => {}
    }
}
