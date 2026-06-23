use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, Window};

use crate::runtime_log::log_runtime_event;
use crate::service;
use crate::workspace_document::{
    get_workspace_document_name_from_path, normalize_workspace_document_path,
    to_display_document_path,
};

const DESKTOP_WORKSPACE_WINDOW_STATE_KEY: &str = "desktop.workspace";
const MIN_RESTORED_WORKSPACE_WINDOW_WIDTH: u32 = 640;
const MIN_RESTORED_WORKSPACE_WINDOW_HEIGHT: u32 = 480;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWindowRequest {
    pub document_path: Option<String>,
    pub start_fresh: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDocumentClaimResult {
    pub status: String,
    pub path: Option<String>,
    pub owner_label: Option<String>,
}

#[derive(Clone, Default)]
pub struct WorkspaceWindowLaunchState {
    inner: Arc<Mutex<HashMap<String, WorkspaceWindowRequest>>>,
}

impl WorkspaceWindowLaunchState {
    pub fn insert(&self, label: String, request: WorkspaceWindowRequest) {
        self.inner
            .lock()
            .expect("workspace window launch state lock poisoned")
            .insert(label, request);
    }

    pub fn take(&self, label: &str) -> Option<WorkspaceWindowRequest> {
        self.inner
            .lock()
            .expect("workspace window launch state lock poisoned")
            .remove(label)
    }
}

#[derive(Clone, Default)]
pub struct WorkspaceDocumentRegistryState {
    path_by_label: Arc<Mutex<HashMap<String, String>>>,
}

impl WorkspaceDocumentRegistryState {
    pub fn claim_for_window<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        window_label: &str,
        path: Option<String>,
    ) -> Result<WorkspaceDocumentClaimResult, String> {
        let mut path_by_label = self
            .path_by_label
            .lock()
            .expect("workspace document registry lock poisoned");

        let normalized_path = path
            .as_deref()
            .map(normalize_workspace_document_path)
            .transpose()?
            .map(|value| to_display_document_path(&value));

        if let Some(path) = normalized_path.as_ref() {
            if let Some((owner_label, _)) = path_by_label
                .iter()
                .find(|(label, owned_path)| label.as_str() != window_label && *owned_path == path)
            {
                if let Some(window) = app.get_webview_window(owner_label) {
                    let _ = window.show();
                    let _ = window.set_focus();
                }

                return Ok(WorkspaceDocumentClaimResult {
                    status: "alreadyOpen".into(),
                    path: Some(path.clone()),
                    owner_label: Some(owner_label.clone()),
                });
            }
        }

        path_by_label.remove(window_label);
        if let Some(path) = normalized_path.clone() {
            path_by_label.insert(window_label.to_string(), path.clone());
        }

        Ok(WorkspaceDocumentClaimResult {
            status: "claimed".into(),
            path: normalized_path,
            owner_label: None,
        })
    }

    pub fn release_window(&self, window_label: &str) {
        self.path_by_label
            .lock()
            .expect("workspace document registry lock poisoned")
            .remove(window_label);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WindowDocumentStateSnapshot {
    pub is_dirty: bool,
    pub document_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowCloseRequestPayload {
    pub document_name: String,
}

#[derive(Clone, Default)]
pub struct WindowDocumentState {
    by_label: Arc<Mutex<HashMap<String, WindowDocumentStateSnapshot>>>,
}

impl WindowDocumentState {
    pub fn set_for_window(&self, label: &str, snapshot: WindowDocumentStateSnapshot) {
        self.by_label
            .lock()
            .expect("window document state lock poisoned")
            .insert(label.to_string(), snapshot);
    }

    pub fn get_for_window(&self, label: &str) -> WindowDocumentStateSnapshot {
        self.by_label
            .lock()
            .expect("window document state lock poisoned")
            .get(label)
            .cloned()
            .unwrap_or_default()
    }

    pub fn remove_window(&self, label: &str) {
        self.by_label
            .lock()
            .expect("window document state lock poisoned")
            .remove(label);
    }

    pub fn first_dirty_window<I, S>(
        &self,
        labels: I,
    ) -> Option<(String, WindowDocumentStateSnapshot)>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let by_label = self
            .by_label
            .lock()
            .expect("window document state lock poisoned");

        labels.into_iter().find_map(|label| {
            let label = label.as_ref();
            by_label
                .get(label)
                .filter(|snapshot| snapshot.is_dirty)
                .map(|snapshot| (label.to_string(), snapshot.clone()))
        })
    }
}

#[derive(Clone, Default)]
pub struct WindowCloseGuardState {
    allowed_labels: Arc<Mutex<HashSet<String>>>,
}

impl WindowCloseGuardState {
    pub fn allow_next_close(&self, label: &str) {
        self.allowed_labels
            .lock()
            .expect("window close guard lock poisoned")
            .insert(label.to_string());
    }

    pub fn take_allowance(&self, label: &str) -> bool {
        self.allowed_labels
            .lock()
            .expect("window close guard lock poisoned")
            .remove(label)
    }

    pub fn has_allowance(&self, label: &str) -> bool {
        self.allowed_labels
            .lock()
            .expect("window close guard lock poisoned")
            .contains(label)
    }

    pub fn clear_window(&self, label: &str) {
        self.allowed_labels
            .lock()
            .expect("window close guard lock poisoned")
            .remove(label);
    }
}

fn uuid_like_label() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{now:x}")
}

fn restore_workspace_window_state<R: Runtime>(window: &WebviewWindow<R>) {
    let state = match service::load_window_state(DESKTOP_WORKSPACE_WINDOW_STATE_KEY) {
        Ok(Some(state)) => state,
        Ok(None) => return,
        Err(error) => {
            log_runtime_event(
                "ERROR",
                format!(
                    "[ShipFlowWindow] failed to load workspace window state '{}': {error}",
                    DESKTOP_WORKSPACE_WINDOW_STATE_KEY
                ),
            );
            return;
        }
    };

    if state.width < MIN_RESTORED_WORKSPACE_WINDOW_WIDTH
        || state.height < MIN_RESTORED_WORKSPACE_WINDOW_HEIGHT
    {
        log_runtime_event(
            "ERROR",
            format!(
                "[ShipFlowWindow] ignored invalid workspace window state '{}' size={}x{}",
                DESKTOP_WORKSPACE_WINDOW_STATE_KEY, state.width, state.height
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

pub fn set_current_window_title_runtime(window: Window, title: String) -> Result<(), String> {
    let trimmed = title.trim();
    let next_title = if trimmed.is_empty() {
        "ShipFlow Desktop"
    } else {
        trimmed
    };

    window
        .set_title(next_title)
        .map_err(|error| format!("Unable to update window title: {error}"))
}

pub fn get_current_window_label_runtime(window: Window) -> String {
    window.label().to_string()
}

pub fn set_current_window_document_state_runtime(
    window: Window,
    state: &WindowDocumentState,
    is_dirty: bool,
    document_name: String,
) {
    state.set_for_window(
        window.label(),
        WindowDocumentStateSnapshot {
            is_dirty,
            document_name,
        },
    );
}

pub fn claim_current_workspace_document_runtime<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    registry: &WorkspaceDocumentRegistryState,
    path: Option<String>,
) -> Result<WorkspaceDocumentClaimResult, String> {
    registry.claim_for_window(&app, window.label(), path)
}

pub fn resolve_window_close_request_runtime(
    window: Window,
    close_guard: &WindowCloseGuardState,
    action: String,
) -> Result<(), String> {
    match action.trim().to_lowercase().as_str() {
        "cancel" => Ok(()),
        "discard" | "proceed" => {
            close_guard.allow_next_close(window.label());
            window
                .close()
                .map_err(|error| format!("Unable to close window: {error}"))
        }
        _ => Err("Unsupported close request action.".into()),
    }
}

pub fn create_workspace_window_runtime<R: Runtime>(
    app: AppHandle<R>,
    launch_state: &WorkspaceWindowLaunchState,
    registry: &WorkspaceDocumentRegistryState,
    document_path: Option<String>,
) -> Result<WorkspaceDocumentClaimResult, String> {
    let normalized_path = document_path
        .as_deref()
        .map(normalize_workspace_document_path)
        .transpose()?;
    let label = format!("workspace-{}", uuid_like_label());
    let display_path = normalized_path
        .as_ref()
        .map(|path| to_display_document_path(path));

    if let Some(path) = display_path.clone() {
        let claim_result = registry.claim_for_window(&app, &label, Some(path))?;
        if claim_result.status == "alreadyOpen" {
            return Ok(claim_result);
        }
    }

    let title = format!(
        "{} - ShipFlow Desktop",
        display_path
            .as_ref()
            .map(|path| get_workspace_document_name_from_path(path))
            .unwrap_or_else(|| "Untitled.shipflow".into())
    );

    launch_state.insert(
        label.clone(),
        WorkspaceWindowRequest {
            document_path: display_path.clone(),
            start_fresh: normalized_path.is_none(),
        },
    );

    let window =
        tauri::WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
            .title(&title)
            .inner_size(1280.0, 860.0)
            .resizable(true)
            .build()
            .map_err(|error| {
                let _ = launch_state.take(&label);
                registry.release_window(&label);
                format!("Unable to create workspace window: {error}")
            })?;
    restore_workspace_window_state(&window);

    Ok(WorkspaceDocumentClaimResult {
        status: "claimed".into(),
        path: display_path,
        owner_label: Some(label),
    })
}

pub fn take_pending_workspace_window_request_runtime(
    window: Window,
    launch_state: &WorkspaceWindowLaunchState,
) -> Option<WorkspaceWindowRequest> {
    launch_state.take(window.label())
}

#[cfg(test)]
mod tests {
    use super::{WindowDocumentState, WindowDocumentStateSnapshot};

    #[test]
    fn first_dirty_window_returns_none_when_registered_windows_are_clean() {
        let state = WindowDocumentState::default();
        state.set_for_window(
            "main",
            WindowDocumentStateSnapshot {
                is_dirty: false,
                document_name: "Main.shipflow".into(),
            },
        );

        assert!(state.first_dirty_window(["main"]).is_none());
    }

    #[test]
    fn first_dirty_window_returns_first_dirty_registered_window() {
        let state = WindowDocumentState::default();
        state.set_for_window(
            "main",
            WindowDocumentStateSnapshot {
                is_dirty: false,
                document_name: "Main.shipflow".into(),
            },
        );
        state.set_for_window(
            "workspace-2",
            WindowDocumentStateSnapshot {
                is_dirty: true,
                document_name: "Unsaved.shipflow".into(),
            },
        );

        let dirty_window = state
            .first_dirty_window(["main", "workspace-2"])
            .expect("dirty window should be detected");

        assert_eq!(dirty_window.0, "workspace-2");
        assert_eq!(dirty_window.1.document_name, "Unsaved.shipflow");
    }

    #[test]
    fn close_guard_can_check_allowance_without_consuming_it() {
        let guard = super::WindowCloseGuardState::default();

        guard.allow_next_close("main");

        assert!(guard.has_allowance("main"));
        assert!(guard.has_allowance("main"));
        assert!(guard.take_allowance("main"));
        assert!(!guard.has_allowance("main"));
    }
}
