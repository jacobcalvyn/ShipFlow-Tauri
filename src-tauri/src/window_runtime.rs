use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, Window};

use crate::workspace_document::{
    get_workspace_document_name_from_path, normalize_workspace_document_path,
    to_display_document_path,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceWindowRequest {
    pub(crate) document_path: Option<String>,
    pub(crate) start_fresh: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceDocumentClaimResult {
    pub(crate) status: String,
    pub(crate) path: Option<String>,
    pub(crate) owner_label: Option<String>,
}

#[derive(Clone, Default)]
pub(crate) struct WorkspaceWindowLaunchState {
    inner: Arc<Mutex<HashMap<String, WorkspaceWindowRequest>>>,
}

impl WorkspaceWindowLaunchState {
    pub(crate) fn insert(&self, label: String, request: WorkspaceWindowRequest) {
        self.inner
            .lock()
            .expect("workspace window launch state lock poisoned")
            .insert(label, request);
    }

    pub(crate) fn take(&self, label: &str) -> Option<WorkspaceWindowRequest> {
        self.inner
            .lock()
            .expect("workspace window launch state lock poisoned")
            .remove(label)
    }
}

#[derive(Clone, Default)]
pub(crate) struct WorkspaceDocumentRegistryState {
    path_by_label: Arc<Mutex<HashMap<String, String>>>,
}

impl WorkspaceDocumentRegistryState {
    pub(crate) fn claim_for_window<R: Runtime>(
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

    pub(crate) fn release_window(&self, window_label: &str) {
        self.path_by_label
            .lock()
            .expect("workspace document registry lock poisoned")
            .remove(window_label);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowDocumentStateSnapshot {
    pub(crate) is_dirty: bool,
    pub(crate) document_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowCloseRequestPayload {
    pub(crate) document_name: String,
}

#[derive(Clone, Default)]
pub(crate) struct WindowDocumentState {
    by_label: Arc<Mutex<HashMap<String, WindowDocumentStateSnapshot>>>,
}

impl WindowDocumentState {
    pub(crate) fn set_for_window(&self, label: &str, snapshot: WindowDocumentStateSnapshot) {
        self.by_label
            .lock()
            .expect("window document state lock poisoned")
            .insert(label.to_string(), snapshot);
    }

    pub(crate) fn get_for_window(&self, label: &str) -> WindowDocumentStateSnapshot {
        self.by_label
            .lock()
            .expect("window document state lock poisoned")
            .get(label)
            .cloned()
            .unwrap_or_default()
    }

    pub(crate) fn remove_window(&self, label: &str) {
        self.by_label
            .lock()
            .expect("window document state lock poisoned")
            .remove(label);
    }
}

#[derive(Clone, Default)]
pub(crate) struct WindowCloseGuardState {
    allowed_labels: Arc<Mutex<HashSet<String>>>,
}

impl WindowCloseGuardState {
    pub(crate) fn allow_next_close(&self, label: &str) {
        self.allowed_labels
            .lock()
            .expect("window close guard lock poisoned")
            .insert(label.to_string());
    }

    pub(crate) fn take_allowance(&self, label: &str) -> bool {
        self.allowed_labels
            .lock()
            .expect("window close guard lock poisoned")
            .remove(label)
    }

    pub(crate) fn clear_window(&self, label: &str) {
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

pub(crate) fn set_current_window_title_runtime(
    window: Window,
    title: String,
) -> Result<(), String> {
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

pub(crate) fn get_current_window_label_runtime(window: Window) -> String {
    window.label().to_string()
}

pub(crate) fn set_current_window_document_state_runtime(
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

pub(crate) fn claim_current_workspace_document_runtime<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    registry: &WorkspaceDocumentRegistryState,
    path: Option<String>,
) -> Result<WorkspaceDocumentClaimResult, String> {
    registry.claim_for_window(&app, window.label(), path)
}

pub(crate) fn resolve_window_close_request_runtime(
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

pub(crate) fn create_workspace_window_runtime<R: Runtime>(
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

    if let Err(error) =
        tauri::WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
            .title(&title)
            .inner_size(1280.0, 860.0)
            .resizable(true)
            .build()
    {
        let _ = launch_state.take(&label);
        registry.release_window(&label);
        return Err(format!("Unable to create workspace window: {error}"));
    }

    Ok(WorkspaceDocumentClaimResult {
        status: "claimed".into(),
        path: display_path,
        owner_label: Some(label),
    })
}

pub(crate) fn take_pending_workspace_window_request_runtime(
    window: Window,
    launch_state: &WorkspaceWindowLaunchState,
) -> Option<WorkspaceWindowRequest> {
    launch_state.take(window.label())
}
