mod service;
mod tracking;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use reqwest::{
    header::{CONTENT_TYPE, LOCATION},
    redirect::Policy,
    Url,
};
use scraper::{Html as ScraperHtml, Selector};
use serde::{Deserialize, Serialize};
use service::{
    ensure_tracking_service_runtime, ApiServiceConfig, ApiServiceController, ApiServiceMode,
    ApiServiceStatus,
};
use tauri::plugin::Builder as PluginBuilder;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WindowEvent};
use tracking::model::{TrackingClientState, TrackingSource, TrackingSourceConfig};
use tracking::upstream::{
    probe_external_api_status, resolve_pos_href,
    validate_tracking_source_config as validate_tracking_source_settings,
};

const SERVICE_TRAY_ID: &str = "service-runtime";
const MAX_POD_IMAGE_BYTES: usize = 5 * 1024 * 1024;
const WORKSPACE_DOCUMENT_EXTENSION: &str = "shipflow";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceDocumentFile {
    version: u8,
    app: String,
    saved_at: String,
    workspace: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceDocumentReadResult {
    path: String,
    document: WorkspaceDocumentFile,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceDocumentWriteResult {
    path: String,
    saved_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceWindowRequest {
    document_path: Option<String>,
    start_fresh: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceDocumentClaimResult {
    status: String,
    path: Option<String>,
    owner_label: Option<String>,
}

#[derive(Clone)]
struct TrayServiceSnapshot {
    service_config: ApiServiceConfig,
    service_status: ApiServiceStatus,
}

impl Default for TrayServiceSnapshot {
    fn default() -> Self {
        Self {
            service_config: ApiServiceConfig {
                version: 1,
                enabled: false,
                mode: ApiServiceMode::Local,
                port: 18422,
                auth_token: String::new(),
                tracking_source: TrackingSource::Default,
                external_api_base_url: String::new(),
                external_api_auth_token: String::new(),
                allow_insecure_external_api_http: false,
                keep_running_in_tray: true,
                last_updated_at: String::new(),
            },
            service_status: ApiServiceStatus::default(),
        }
    }
}

#[derive(Clone, Default)]
struct TrayState {
    inner: Arc<Mutex<TrayServiceSnapshot>>,
}

#[derive(Clone, Default)]
struct WorkspaceWindowLaunchState {
    inner: Arc<Mutex<HashMap<String, WorkspaceWindowRequest>>>,
}

#[derive(Clone, Default)]
struct WorkspaceDocumentRegistryState {
    path_by_label: Arc<Mutex<HashMap<String, String>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct WindowDocumentStateSnapshot {
    is_dirty: bool,
    document_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowCloseRequestPayload {
    document_name: String,
}

#[derive(Clone, Default)]
struct WindowDocumentState {
    by_label: Arc<Mutex<HashMap<String, WindowDocumentStateSnapshot>>>,
}

#[derive(Clone, Default)]
struct WindowCloseGuardState {
    allowed_labels: Arc<Mutex<HashSet<String>>>,
}

impl WorkspaceWindowLaunchState {
    fn insert(&self, label: String, request: WorkspaceWindowRequest) {
        self.inner
            .lock()
            .expect("workspace window launch state lock poisoned")
            .insert(label, request);
    }

    fn take(&self, label: &str) -> Option<WorkspaceWindowRequest> {
        self.inner
            .lock()
            .expect("workspace window launch state lock poisoned")
            .remove(label)
    }
}

impl WorkspaceDocumentRegistryState {
    fn claim_for_window<R: Runtime>(
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

    fn release_window(&self, window_label: &str) {
        self.path_by_label
            .lock()
            .expect("workspace document registry lock poisoned")
            .remove(window_label);
    }
}

impl WindowDocumentState {
    fn set_for_window(&self, label: &str, snapshot: WindowDocumentStateSnapshot) {
        self.by_label
            .lock()
            .expect("window document state lock poisoned")
            .insert(label.to_string(), snapshot);
    }

    fn get_for_window(&self, label: &str) -> WindowDocumentStateSnapshot {
        self.by_label
            .lock()
            .expect("window document state lock poisoned")
            .get(label)
            .cloned()
            .unwrap_or_default()
    }

    fn remove_window(&self, label: &str) {
        self.by_label
            .lock()
            .expect("window document state lock poisoned")
            .remove(label);
    }
}

impl WindowCloseGuardState {
    fn allow_next_close(&self, label: &str) {
        self.allowed_labels
            .lock()
            .expect("window close guard lock poisoned")
            .insert(label.to_string());
    }

    fn take_allowance(&self, label: &str) -> bool {
        self.allowed_labels
            .lock()
            .expect("window close guard lock poisoned")
            .remove(label)
    }

    fn clear_window(&self, label: &str) {
        self.allowed_labels
            .lock()
            .expect("window close guard lock poisoned")
            .remove(label);
    }
}

impl TrayState {
    fn snapshot(&self) -> TrayServiceSnapshot {
        self.inner.lock().expect("tray state lock poisoned").clone()
    }

    fn update_service(&self, config: &ApiServiceConfig, status: &ApiServiceStatus) {
        let mut snapshot = self.inner.lock().expect("tray state lock poisoned");
        snapshot.service_config = config.clone();
        snapshot.service_status = status.clone();
    }
}

fn run_clipboard_command(mut command: Command, text: &str) -> Result<(), String> {
    let mut child = command
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Unable to start clipboard command: {error}"))?;

    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(text.as_bytes())
            .map_err(|error| format!("Unable to write clipboard payload: {error}"))?;
    } else {
        return Err("Clipboard command stdin is unavailable.".into());
    }

    let status = child
        .wait()
        .map_err(|error| format!("Unable to wait for clipboard command: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("Clipboard command exited with status {status}."))
    }
}

fn copy_text_to_clipboard(text: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return run_clipboard_command(Command::new("pbcopy"), text);
    }

    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("cmd");
        command.args(["/C", "clip"]);
        return run_clipboard_command(command, text);
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let candidates = [
            ("wl-copy", Vec::<&str>::new()),
            ("xclip", vec!["-selection", "clipboard"]),
            ("xsel", vec!["--clipboard", "--input"]),
        ];

        let mut last_error = None;
        for (program, args) in candidates {
            let mut command = Command::new(program);
            command.args(args);

            match run_clipboard_command(command, text) {
                Ok(()) => return Ok(()),
                Err(error) => last_error = Some(error),
            }
        }

        return Err(
            last_error.unwrap_or_else(|| "No supported clipboard command is available.".into())
        );
    }

    #[allow(unreachable_code)]
    Err("Clipboard copy is not supported on this platform.".into())
}

fn expand_document_path(value: &str) -> PathBuf {
    if let Some(stripped) = value.strip_prefix("~/") {
        if let Some(home_dir) = std::env::var_os("HOME").map(PathBuf::from) {
            return home_dir.join(stripped);
        }
    }

    PathBuf::from(value)
}

fn normalize_workspace_document_path(value: &str) -> Result<PathBuf, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Workspace file path is required.".into());
    }

    let mut path = expand_document_path(trimmed);
    if path.extension().is_none() {
        path.set_extension(WORKSPACE_DOCUMENT_EXTENSION);
    }

    Ok(path)
}

fn to_display_document_path(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}

fn validate_workspace_document(document: &WorkspaceDocumentFile) -> Result<(), String> {
    if document.version != 1 {
        return Err("Unsupported workspace document version.".into());
    }

    if document.app.trim() != "shipflow-desktop" {
        return Err("This file is not a ShipFlow workspace document.".into());
    }

    if !document.workspace.is_object() {
        return Err("Workspace document payload is invalid.".into());
    }

    Ok(())
}

fn write_workspace_document_to_path(
    path: &Path,
    document: &WorkspaceDocumentFile,
) -> Result<(), String> {
    validate_workspace_document(document)?;

    let parent = path
        .parent()
        .ok_or_else(|| "Workspace file must have a parent directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Unable to create workspace directory: {error}"))?;

    let serialized = serde_json::to_vec_pretty(document)
        .map_err(|error| format!("Unable to serialize workspace document: {error}"))?;
    let temp_path = path.with_extension(format!("{WORKSPACE_DOCUMENT_EXTENSION}.tmp"));

    fs::write(&temp_path, serialized)
        .map_err(|error| format!("Unable to write workspace temp file: {error}"))?;

    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("Unable to replace existing workspace file: {error}"))?;
    }

    fs::rename(&temp_path, path)
        .map_err(|error| format!("Unable to finalize workspace file: {error}"))?;

    Ok(())
}

fn get_workspace_document_name_from_path(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "Untitled.shipflow".into())
}

fn uuid_like_label() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{now:x}")
}

#[cfg(target_os = "macos")]
fn pick_workspace_document_path_macos(
    mode: &str,
    suggested_name: Option<&str>,
) -> Result<Option<String>, String> {
    let script = match mode {
        "open" => {
            r#"set chosenFile to choose file with prompt "Buka workspace ShipFlow" of type {"shipflow"}
POSIX path of chosenFile"#
                .to_string()
        }
        "save" => {
            let default_name = suggested_name.unwrap_or("Untitled.shipflow");
            format!(
                r#"set chosenFile to choose file name with prompt "Simpan workspace ShipFlow" default name "{}"
POSIX path of chosenFile"#,
                default_name.replace('"', "\\\"")
            )
        }
        _ => return Err("Unsupported workspace picker mode.".into()),
    };

    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|error| format!("Unable to open native file picker: {error}"))?;

    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() {
            Ok(None)
        } else {
            Ok(Some(path))
        }
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
        if stderr.contains("user canceled") || stderr.contains("cancelled") {
            Ok(None)
        } else {
            Err(format!(
                "Native file picker failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        }
    }
}

#[cfg(target_os = "windows")]
fn pick_workspace_document_path_windows(
    mode: &str,
    suggested_name: Option<&str>,
) -> Result<Option<String>, String> {
    let dialog_type = if mode == "open" {
        "OpenFileDialog"
    } else {
        "SaveFileDialog"
    };
    let file_name_line = suggested_name
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!("$dialog.FileName = '{}';", value.replace('\'', "''")))
        .unwrap_or_default();
    let powershell = format!(
        "Add-Type -AssemblyName System.Windows.Forms; \
         $dialog = New-Object System.Windows.Forms.{dialog_type}; \
         $dialog.Filter = 'ShipFlow Workspace (*.shipflow)|*.shipflow|All files (*.*)|*.*'; \
         {file_name_line} \
         if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{ Write-Output $dialog.FileName }}"
    );

    let output = Command::new("powershell")
        .args(["-NoProfile", "-Command", &powershell])
        .output()
        .map_err(|error| format!("Unable to open native file picker: {error}"))?;

    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() {
            Ok(None)
        } else {
            Ok(Some(path))
        }
    } else {
        Err(format!(
            "Native file picker failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn pick_workspace_document_path_linux(
    mode: &str,
    suggested_name: Option<&str>,
) -> Result<Option<String>, String> {
    let mut command = Command::new("zenity");
    command.arg("--file-selection");

    if mode == "save" {
        command.arg("--save");
        command.arg("--confirm-overwrite");
        if let Some(name) = suggested_name.filter(|value| !value.trim().is_empty()) {
            command.arg(format!("--filename={name}"));
        }
    }

    let output = command
        .output()
        .map_err(|error| format!("Unable to open native file picker: {error}"))?;

    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() {
            Ok(None)
        } else {
            Ok(Some(path))
        }
    } else {
        Ok(None)
    }
}

fn pick_workspace_document_path_native(
    mode: &str,
    suggested_name: Option<&str>,
) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        return pick_workspace_document_path_macos(mode, suggested_name);
    }

    #[cfg(target_os = "windows")]
    {
        return pick_workspace_document_path_windows(mode, suggested_name);
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        return pick_workspace_document_path_linux(mode, suggested_name);
    }

    #[allow(unreachable_code)]
    Err("Native file picker is not supported on this platform.".into())
}

fn sync_service_tray<R: Runtime>(app: &AppHandle<R>, tray_state: &TrayState) -> tauri::Result<()> {
    let snapshot = tray_state.snapshot();
    if let Some(tray) = app.tray_by_id(SERVICE_TRAY_ID) {
        let _ = tray.set_visible(false);
    }

    if let Err(error) = service::sync_service_tray_companion(&snapshot.service_config) {
        eprintln!("[ShipFlowTray] failed to sync service tray companion: {error}");
    }
    Ok(())
}

async fn track_shipment_via_service(
    client: &reqwest::Client,
    config: &ApiServiceConfig,
    shipment_id: &str,
) -> Result<tracking::model::TrackResponse, tracking::model::TrackingError> {
    let endpoint = format!(
        "http://127.0.0.1:{}/track/{}",
        config.port,
        shipment_id.trim()
    );
    let response = client
        .get(endpoint)
        .bearer_auth(config.auth_token.trim())
        .send()
        .await
        .map_err(|error| {
            tracking::model::TrackingError::Upstream(format!(
                "Unable to reach ShipFlow Service: {error}"
            ))
        })?;

    if response.status().is_success() {
        let raw_body = response.text().await.map_err(|error| {
            tracking::model::TrackingError::Upstream(format!(
                "Unable to read ShipFlow Service tracking response: {error}"
            ))
        })?;

        return serde_json::from_str::<tracking::model::TrackResponse>(&raw_body).map_err(
            |error| {
                tracking::model::TrackingError::Upstream(format!(
                    "ShipFlow Service returned an invalid tracking response: {error}"
                ))
            },
        );
    }

    let status = response.status();
    let raw_body = response.text().await.ok();
    let payload = raw_body
        .as_deref()
        .and_then(|body| serde_json::from_str::<serde_json::Value>(body).ok());
    let message = payload
        .as_ref()
        .and_then(|value| value.get("error"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("ShipFlow Service tracking request failed.");

    match status.as_u16() {
        400 => Err(tracking::model::TrackingError::BadRequest(message.into())),
        404 => Err(tracking::model::TrackingError::NotFound(message.into())),
        _ => Err(tracking::model::TrackingError::Upstream(message.into())),
    }
}

#[tauri::command]
async fn track_shipment(
    shipment_id: String,
    sheet_id: Option<String>,
    row_key: Option<String>,
    client_state: tauri::State<'_, TrackingClientState>,
    service_controller: tauri::State<'_, ApiServiceController>,
) -> Result<tracking::model::TrackResponse, String> {
    let context = format!(
        "[sheetId={}, rowKey={}, shipmentId={}]",
        sheet_id.as_deref().unwrap_or("-"),
        row_key.as_deref().unwrap_or("-"),
        shipment_id.trim()
    );

    let saved_service_config = service_controller.load_saved_config().unwrap_or(None);
    let runtime_config =
        ensure_tracking_service_runtime(saved_service_config).map_err(|message| {
            eprintln!("[ShipFlowBackend] {context} {message}");
            format!("{context} {message}")
        })?;

    let track_result =
        track_shipment_via_service(&client_state.client, &runtime_config, shipment_id.trim()).await;

    track_result.map_err(|error| match error {
        tracking::model::TrackingError::BadRequest(message)
        | tracking::model::TrackingError::NotFound(message)
        | tracking::model::TrackingError::Upstream(message) => {
            eprintln!("[ShipFlowBackend] {context} {message}");
            format!("{context} {message}")
        }
    })
}

#[tauri::command]
async fn resolve_pod_image(image_source: String) -> Result<String, String> {
    resolve_pod_image_source(image_source.trim(), 0).await
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("External URL is required.".into());
    }

    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Err("Only HTTP(S) URLs can be opened.".into());
    }

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(trimmed);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", "", trimmed]);
        command
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(trimmed);
        command
    };

    command
        .spawn()
        .map_err(|error| format!("Unable to open external URL: {error}"))?;

    Ok(())
}

#[tauri::command]
fn copy_to_clipboard(text: String) -> Result<(), String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("Clipboard text is required.".into());
    }

    copy_text_to_clipboard(trimmed)
}

#[tauri::command]
fn pick_workspace_document_path(
    mode: String,
    suggested_name: Option<String>,
) -> Result<Option<String>, String> {
    let normalized_mode = mode.trim().to_lowercase();
    let suggested_name = suggested_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    match normalized_mode.as_str() {
        "open" => pick_workspace_document_path_native("open", suggested_name),
        "save" | "saveas" => pick_workspace_document_path_native("save", suggested_name),
        _ => Err("Unsupported workspace picker mode.".into()),
    }
}

#[tauri::command]
fn read_workspace_document(path: String) -> Result<WorkspaceDocumentReadResult, String> {
    let normalized_path = normalize_workspace_document_path(&path)?;
    let raw = fs::read_to_string(&normalized_path)
        .map_err(|error| format!("Unable to read workspace file: {error}"))?;
    let document: WorkspaceDocumentFile = serde_json::from_str(&raw)
        .map_err(|error| format!("Unable to parse workspace file: {error}"))?;
    validate_workspace_document(&document)?;

    Ok(WorkspaceDocumentReadResult {
        path: to_display_document_path(&normalized_path),
        document,
    })
}

#[tauri::command]
fn write_workspace_document(
    path: String,
    document: WorkspaceDocumentFile,
) -> Result<WorkspaceDocumentWriteResult, String> {
    let normalized_path = normalize_workspace_document_path(&path)?;
    write_workspace_document_to_path(&normalized_path, &document)?;

    Ok(WorkspaceDocumentWriteResult {
        path: to_display_document_path(&normalized_path),
        saved_at: document.saved_at,
    })
}

#[tauri::command]
fn set_current_window_title(window: tauri::Window, title: String) -> Result<(), String> {
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

#[tauri::command]
fn get_current_window_label(window: tauri::Window) -> String {
    window.label().to_string()
}

#[tauri::command]
fn set_current_window_document_state(
    window: tauri::Window,
    state: tauri::State<'_, WindowDocumentState>,
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

#[tauri::command]
fn claim_current_workspace_document(
    app: tauri::AppHandle,
    window: tauri::Window,
    registry: tauri::State<'_, WorkspaceDocumentRegistryState>,
    path: Option<String>,
) -> Result<WorkspaceDocumentClaimResult, String> {
    registry.claim_for_window(&app, window.label(), path)
}

#[tauri::command]
fn resolve_window_close_request(
    window: tauri::Window,
    close_guard: tauri::State<'_, WindowCloseGuardState>,
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

#[tauri::command]
fn create_workspace_window(
    app: tauri::AppHandle,
    launch_state: tauri::State<'_, WorkspaceWindowLaunchState>,
    registry: tauri::State<'_, WorkspaceDocumentRegistryState>,
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

#[tauri::command]
fn open_shipflow_service_app() -> Result<(), String> {
    service::launch_shipflow_service_app()
}

#[tauri::command]
fn take_pending_workspace_window_request(
    window: tauri::Window,
    launch_state: tauri::State<'_, WorkspaceWindowLaunchState>,
) -> Option<WorkspaceWindowRequest> {
    launch_state.take(window.label())
}

#[tauri::command]
async fn configure_api_service(
    app_handle: tauri::AppHandle,
    config: ApiServiceConfig,
    client_state: tauri::State<'_, TrackingClientState>,
    service_controller: tauri::State<'_, ApiServiceController>,
    tray_state: tauri::State<'_, TrayState>,
) -> Result<ApiServiceStatus, String> {
    let tracking_source_config = config.tracking_source_config();
    validate_tracking_source_settings(&tracking_source_config).map_err(|error| match error {
        tracking::model::TrackingError::BadRequest(message)
        | tracking::model::TrackingError::NotFound(message)
        | tracking::model::TrackingError::Upstream(message) => message,
    })?;

    let result = service_controller.configure(config.clone()).await;
    let status = match &result {
        Ok(status) => status.clone(),
        Err(_) => service_controller.status(),
    };

    tray_state.update_service(&config, &status);
    if let Err(error) = sync_service_tray(&app_handle, &tray_state) {
        eprintln!("[ShipFlowTray] failed to sync tray after configure: {error}");
    }

    if result.is_ok() {
        client_state.update_source_config(tracking_source_config);
    }

    result
}

#[tauri::command]
fn load_saved_api_service_config(
    service_controller: tauri::State<'_, ApiServiceController>,
    client_state: tauri::State<'_, TrackingClientState>,
    app_handle: tauri::AppHandle,
    tray_state: tauri::State<'_, TrayState>,
) -> Result<Option<ApiServiceConfig>, String> {
    let saved_config = service_controller.load_saved_config()?;

    if let Some(config) = saved_config.as_ref() {
        client_state.update_source_config(config.tracking_source_config());
    }

    let status = service_controller.status();
    let tray_config = saved_config
        .clone()
        .unwrap_or_else(|| TrayServiceSnapshot::default().service_config);

    tray_state.update_service(&tray_config, &status);
    if let Err(error) = sync_service_tray(&app_handle, &tray_state) {
        eprintln!("[ShipFlowTray] failed to sync tray after loading config: {error}");
    }

    Ok(saved_config)
}

#[tauri::command]
fn get_api_service_status(
    service_controller: tauri::State<'_, ApiServiceController>,
    app_handle: tauri::AppHandle,
    tray_state: tauri::State<'_, TrayState>,
) -> ApiServiceStatus {
    let status = service_controller.status();
    let config = tray_state.snapshot().service_config;
    tray_state.update_service(&config, &status);
    if let Err(error) = sync_service_tray(&app_handle, &tray_state) {
        eprintln!("[ShipFlowTray] failed to sync tray after status refresh: {error}");
    }
    status
}

#[tauri::command]
async fn test_external_tracking_source(
    config: ApiServiceConfig,
    client_state: tauri::State<'_, TrackingClientState>,
) -> Result<String, String> {
    probe_external_api_status(&client_state.client, &config.tracking_source_config())
        .await
        .map_err(|error| match error {
            tracking::model::TrackingError::BadRequest(message)
            | tracking::model::TrackingError::NotFound(message)
            | tracking::model::TrackingError::Upstream(message) => message,
        })
}

#[tauri::command]
fn validate_tracking_source_config(config: ApiServiceConfig) -> Result<(), String> {
    validate_tracking_source_settings(&config.tracking_source_config()).map_err(|error| match error
    {
        tracking::model::TrackingError::BadRequest(message)
        | tracking::model::TrackingError::NotFound(message)
        | tracking::model::TrackingError::Upstream(message) => message,
    })
}

#[tauri::command]
fn log_frontend_runtime_event(level: String, message: String) {
    let normalized_level = level.trim().to_lowercase();
    let trimmed_message = message.trim();

    if trimmed_message.is_empty() {
        return;
    }

    eprintln!(
        "[ShipFlowFrontend][{}] {}",
        if normalized_level.is_empty() {
            "info"
        } else {
            &normalized_level
        },
        trimmed_message
    );
}

fn build_pod_preview_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .read_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(15))
        .redirect(Policy::none())
        .user_agent("ShipFlow Desktop POD Preview/0.1")
        .build()
        .map_err(|error| format!("Unable to create restricted POD client: {error}"))
}

fn is_forbidden_remote_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ipv4) => {
            ipv4.is_private()
                || ipv4.is_loopback()
                || ipv4.is_link_local()
                || ipv4.is_multicast()
                || ipv4.is_unspecified()
        }
        IpAddr::V6(ipv6) => {
            ipv6.is_loopback()
                || ipv6.is_multicast()
                || ipv6.is_unspecified()
                || ipv6.is_unique_local()
                || ipv6.is_unicast_link_local()
        }
    }
}

async fn validate_remote_pod_url(url: &Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("POD image source must use HTTP(S).".into());
    }

    let Some(host) = url.host_str() else {
        return Err("POD image source host is missing.".into());
    };

    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".local") {
        return Err("POD image source host is not allowed.".into());
    }

    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_forbidden_remote_ip(ip) {
            return Err("POD image source host is not allowed.".into());
        }
        return Ok(());
    }

    let port = url.port_or_known_default().unwrap_or(443);
    let mut resolved_any = false;
    let resolved_hosts = tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| format!("Unable to resolve POD image host: {error}"))?;

    for socket_addr in resolved_hosts {
        resolved_any = true;
        if is_forbidden_remote_ip(socket_addr.ip()) {
            return Err("POD image source host is not allowed.".into());
        }
    }

    if !resolved_any {
        return Err("POD image source host did not resolve.".into());
    }

    Ok(())
}

fn normalize_remote_pod_url(image_source: &str) -> Result<Url, String> {
    let normalized = if image_source.starts_with("http://") || image_source.starts_with("https://")
    {
        image_source.to_string()
    } else {
        resolve_pos_href(image_source)
    };

    Url::parse(&normalized).map_err(|error| format!("POD image source is invalid: {error}"))
}

async fn fetch_remote_pod_payload(
    client: &reqwest::Client,
    url: &Url,
    depth: u8,
) -> Result<(Option<String>, Vec<u8>), String> {
    if depth > 3 {
        return Err("POD image source redirected too many times.".into());
    }

    validate_remote_pod_url(url).await?;

    let response = client
        .get(url.clone())
        .send()
        .await
        .map_err(|error| format!("Unable to fetch POD image source: {error}"))?;

    if response.status().is_redirection() {
        let location = response
            .headers()
            .get(LOCATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| "POD image redirect is missing location header.".to_string())?;
        let next_url = url
            .join(location)
            .map_err(|error| format!("POD image redirect URL is invalid: {error}"))?;

        return Box::pin(fetch_remote_pod_payload(client, &next_url, depth + 1)).await;
    }

    if !response.status().is_success() {
        return Err(format!(
            "POD image source returned HTTP {}.",
            response.status()
        ));
    }

    if let Some(content_length) = response.content_length() {
        if content_length > MAX_POD_IMAGE_BYTES as u64 {
            return Err("POD image source is too large to preview safely.".into());
        }
    }

    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    let mut bytes = Vec::new();
    let mut response = response;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Unable to read POD image source response: {error}"))?
    {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > MAX_POD_IMAGE_BYTES {
            return Err("POD image source is too large to preview safely.".into());
        }
    }

    Ok((content_type, bytes))
}

async fn resolve_pod_image_source(image_source: &str, depth: u8) -> Result<String, String> {
    if depth > 3 {
        return Err("POD image source redirected too many times.".into());
    }

    let trimmed = image_source.trim();
    if trimmed.is_empty() {
        return Err("Image source is required.".into());
    }

    if trimmed.starts_with("data:image/") {
        return Ok(trimmed.to_string());
    }

    if let Some(normalized) = normalize_base64_image(trimmed) {
        return Ok(base64_to_data_url(&normalized));
    }

    let url = normalize_remote_pod_url(trimmed)?;
    let client = build_pod_preview_client()?;
    let (content_type, bytes) = fetch_remote_pod_payload(&client, &url, depth).await?;

    if let Some(content_type) = content_type {
        if content_type.starts_with("image/") {
            return Ok(format!(
                "data:{content_type};base64,{}",
                STANDARD.encode(&bytes)
            ));
        }
    }

    let body_text = String::from_utf8_lossy(&bytes).trim().to_string();
    if body_text.starts_with("data:image/") {
        return Ok(body_text);
    }

    if let Some(data_image) = extract_data_image_from_text(&body_text) {
        return Ok(data_image);
    }

    if let Some(normalized) = normalize_base64_image(&body_text) {
        return Ok(base64_to_data_url(&normalized));
    }

    if let Some(next_source) = extract_image_source_from_html(&body_text) {
        let resolved_source = if next_source.starts_with("http://")
            || next_source.starts_with("https://")
            || next_source.starts_with("data:image/")
        {
            next_source
        } else {
            resolve_pos_href(&next_source)
        };

        return Box::pin(resolve_pod_image_source(&resolved_source, depth + 1)).await;
    }

    Err("POD image source did not resolve to a valid image payload.".into())
}

fn extract_image_source_from_html(html: &str) -> Option<String> {
    let document = ScraperHtml::parse_document(html);
    let img_selector = Selector::parse("img").expect("valid selector");

    document.select(&img_selector).find_map(|img| {
        img.value()
            .attr("src")
            .or_else(|| img.value().attr("data-src"))
            .or_else(|| img.value().attr("data-original"))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn extract_data_image_from_text(value: &str) -> Option<String> {
    let start = value.find("data:image/")?;
    let remainder = &value[start..];
    let end = remainder
        .find(|ch: char| ch == '"' || ch == '\'' || ch.is_whitespace())
        .unwrap_or(remainder.len());
    let candidate = remainder[..end].trim().trim_end_matches(',').to_string();
    if candidate.starts_with("data:image/") {
        Some(candidate)
    } else {
        None
    }
}

fn normalize_base64_image(value: &str) -> Option<String> {
    let mut normalized = value.trim().to_string();

    if normalized.len() > 3 && normalized.starts_with("b\"") && normalized.ends_with('"') {
        normalized = normalized[2..normalized.len() - 1].to_string();
    } else if normalized.len() > 3 && normalized.starts_with("b'") && normalized.ends_with('\'') {
        normalized = normalized[2..normalized.len() - 1].to_string();
    }

    normalized = normalized
        .replace(['\r', '\n', '\t', ' '], "")
        .replace("base64,", "");

    if let Some((_, rest)) = normalized.split_once("data:image/") {
        if let Some((_, payload)) = rest.split_once(',') {
            normalized = payload.to_string();
        }
    }

    normalized = normalized.replace('-', "+").replace('_', "/");
    normalized = normalized.trim_matches('"').trim_matches('\'').to_string();

    if normalized.is_empty() {
        return None;
    }

    if !normalized
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '/' | '='))
    {
        return None;
    }

    let padding_length = normalized.len() % 4;
    if padding_length != 0 {
        normalized.push_str(&"=".repeat(4 - padding_length));
    }

    Some(normalized)
}

fn base64_to_data_url(normalized: &str) -> String {
    let mime_type = if normalized.starts_with("iVBOR") {
        "image/png"
    } else if normalized.starts_with("R0lGOD") {
        "image/gif"
    } else if normalized.starts_with("UklGR") {
        "image/webp"
    } else if normalized.starts_with("PHN2Zy") {
        "image/svg+xml"
    } else {
        "image/jpeg"
    };

    format!("data:{mime_type};base64,{normalized}")
}

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
            eprintln!(
                "[ShipFlowTauri] observed top-level navigation for webview '{label}' to {url}"
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
            eprintln!(
                "[ShipFlowTauri] recorded initial page load finish for webview '{label}' at {url}"
            );
        }
    }
}

pub fn maybe_run_service_process_from_current_args() -> Result<bool, String> {
    service::maybe_run_service_process_from_current_args()
}

pub fn maybe_run_service_tray_from_current_args() -> Result<bool, String> {
    service::maybe_run_service_tray_from_current_args()
}

pub fn maybe_delegate_to_existing_desktop_process() -> Result<bool, String> {
    service::maybe_delegate_desktop_launch_to_existing_process()
}

pub fn maybe_delegate_to_existing_service_settings_process() -> Result<bool, String> {
    service::maybe_delegate_service_settings_launch_to_existing_process()
}

fn build_base_context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

fn build_tracking_client(user_agent: &str) -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(6))
        .read_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(25))
        .user_agent(user_agent)
        .build()
        .expect("failed to create tracking client")
}

pub fn run() {
    let tracking_client = build_tracking_client("ShipFlow Desktop/0.1");
    let context = build_base_context();
    let navigation_guard = MainWebviewNavigationGuard::default();
    let navigation_guard_plugin = navigation_guard.clone();
    let page_load_guard_plugin = navigation_guard.clone();

    tauri::Builder::default()
        .manage(TrackingClientState {
            client: tracking_client,
            source_config: Arc::new(Mutex::new(TrackingSourceConfig::default())),
        })
        .manage(ApiServiceController::default())
        .manage(TrayState::default())
        .manage(WorkspaceWindowLaunchState::default())
        .manage(WorkspaceDocumentRegistryState::default())
        .manage(WindowDocumentState::default())
        .manage(WindowCloseGuardState::default())
        .setup(|app| {
            if let Err(error) = service::register_current_desktop_process() {
                eprintln!("[ShipFlowDesktop] failed to register desktop process: {error}");
            }

            let service_controller = app.state::<ApiServiceController>();
            let tracking_client_state = app.state::<TrackingClientState>();
            let tray_state = app.state::<TrayState>();
            let saved_config = service_controller
                .load_saved_config()
                .unwrap_or_else(|error| {
                    eprintln!("[ShipFlowService] failed to load persisted config: {error}");
                    None
                });

            if let Some(config) = saved_config.as_ref() {
                tracking_client_state.update_source_config(config.tracking_source_config());
            }

            let status = service_controller.status();
            let tray_config =
                saved_config.unwrap_or_else(|| TrayServiceSnapshot::default().service_config);
            tray_state.update_service(&tray_config, &status);
            if let Err(error) = sync_service_tray(&app.handle(), &tray_state) {
                eprintln!("[ShipFlowTray] failed to initialize tray: {error}");
            }

            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                loop {
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
                            eprintln!(
                                "[ShipFlowDesktop] failed to consume desktop activation request: {error}"
                            );
                        }
                        _ => {}
                    }

                    std::thread::sleep(Duration::from_millis(500));
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
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
        })
        .plugin(
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
                            eprintln!(
                                "[ShipFlowTauri] page load started for webview '{label}' at {url}"
                            );
                        }
                        PageLoadEvent::Finished => {
                            page_load_guard_plugin.mark_initial_load_finished(&label, &url);
                        }
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            track_shipment,
            resolve_pod_image,
            open_external_url,
            copy_to_clipboard,
            pick_workspace_document_path,
            read_workspace_document,
            write_workspace_document,
            set_current_window_title,
            get_current_window_label,
            set_current_window_document_state,
            claim_current_workspace_document,
            resolve_window_close_request,
            create_workspace_window,
            open_shipflow_service_app,
            take_pending_workspace_window_request,
            log_frontend_runtime_event,
            configure_api_service,
            load_saved_api_service_config,
            get_api_service_status,
            test_external_tracking_source,
            validate_tracking_source_config
        ])
        .run(context)
        .expect("error while running tauri application");
}

pub fn run_service_settings() {
    let tracking_client = build_tracking_client("ShipFlow Service/0.1");
    let mut context = build_base_context();
    context.config_mut().app.windows.clear();

    tauri::Builder::default()
        .manage(TrackingClientState {
            client: tracking_client,
            source_config: Arc::new(Mutex::new(TrackingSourceConfig::default())),
        })
        .manage(ApiServiceController::default())
        .manage(TrayState::default())
        .setup(|app| {
            if let Err(error) = service::register_current_service_settings_process() {
                eprintln!("[ShipFlowService] failed to register service settings process: {error}");
            }

            let service_controller = app.state::<ApiServiceController>();
            let tracking_client_state = app.state::<TrackingClientState>();
            let tray_state = app.state::<TrayState>();
            let saved_config = service_controller
                .load_saved_config()
                .unwrap_or_else(|error| {
                    eprintln!("[ShipFlowService] failed to load persisted config: {error}");
                    None
                });

            if let Some(config) = saved_config.as_ref() {
                tracking_client_state.update_source_config(config.tracking_source_config());
            }

            let status = service_controller.status();
            let tray_config =
                saved_config.unwrap_or_else(|| TrayServiceSnapshot::default().service_config);
            tray_state.update_service(&tray_config, &status);
            if let Err(error) = sync_service_tray(&app.handle(), &tray_state) {
                eprintln!("[ShipFlowService] failed to sync tray companion: {error}");
            }

            tauri::WebviewWindowBuilder::new(
                app,
                "service-settings",
                WebviewUrl::App("index.html?windowKind=service-settings".into()),
            )
            .title("ShipFlow Service")
            .inner_size(780.0, 860.0)
            .resizable(true)
            .initialization_script("window.__SHIPFLOW_WINDOW_KIND__ = 'service-settings';")
            .build()
            .map_err(|error| format!("Unable to create ShipFlow Service window: {error}"))?;

            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                loop {
                    match service::take_pending_service_settings_activation_request() {
                        Ok(Some(request)) if request.focus_main_window => {
                            if let Some(window) = app_handle.get_webview_window("service-settings")
                            {
                                let _ = window.unminimize();
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        Ok(None) => {}
                        Err(error) => {
                            eprintln!(
                                "[ShipFlowService] failed to consume service settings activation request: {error}"
                            );
                        }
                        _ => {}
                    }

                    std::thread::sleep(Duration::from_millis(500));
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                if window.label() == "service-settings" {
                    service::clear_current_service_settings_process();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            open_external_url,
            copy_to_clipboard,
            log_frontend_runtime_event,
            configure_api_service,
            load_saved_api_service_config,
            get_api_service_status,
            test_external_tracking_source,
            validate_tracking_source_config
        ])
        .run(context)
        .expect("error while running ShipFlow Service");
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::json;

    use super::tracking::model::{TrackingError, TrackingSource, TrackingSourceConfig};
    use super::tracking::parser::parse_tracking_html;
    use super::tracking::upstream::{
        build_tracking_url, normalize_and_validate_shipment_id, validate_tracking_source_config,
        POS_TRACKING_ENDPOINT,
    };
    use super::{
        base64_to_data_url, normalize_base64_image, normalize_workspace_document_path,
        read_workspace_document, validate_remote_pod_url, write_workspace_document, Url,
        WorkspaceDocumentFile,
    };

    const SAMPLE_HTML: &str = include_str!("fixtures/pos_tracking_sample.html");
    const NULLABLE_NUMERIC_HTML: &str = include_str!("fixtures/pos_tracking_nullable_numeric.html");
    const REORDERED_TABLES_HTML: &str = include_str!("fixtures/pos_tracking_reordered_tables.html");
    const RUNSHEET_FAILEDTODELIVERED_HTML: &str =
        include_str!("fixtures/pos_tracking_runsheet_failedtoddelivered.html");

    #[test]
    fn build_tracking_url_percent_encodes_base64_payload() {
        let url = build_tracking_url(POS_TRACKING_ENDPOINT, "P2603310114291");

        assert_eq!(
            url,
            "https://pid.posindonesia.co.id/lacak/admin/detail_lacak_banyak.php?id=UDI2MDMzMTAxMTQyOTE%3D"
        );
    }

    #[test]
    fn parse_tracking_html_matches_track_response_shape() {
        let response = parse_tracking_html(
            "https://pid.posindonesia.co.id/lacak/admin/detail_lacak_banyak.php?id=UDI2MDMzMTAxMTQyOTE%3D",
            SAMPLE_HTML,
        )
        .expect("sample should parse");

        assert_eq!(
            response.detail.header.nomor_kiriman.as_deref(),
            Some("P2603310114291")
        );
        assert_eq!(
            response.detail.package.jenis_layanan.as_deref(),
            Some("PKH")
        );
        assert_eq!(response.status_akhir.status.as_deref(), Some("INVEHICLE"));
        assert_eq!(
            response.pod.photo1_url.as_deref(),
            Some("https://apistorage.mile.app/v2-public/prod/pos/2026/04/13/sample-photo.jpg")
        );
        assert_eq!(
            response.pod.coordinate_map_url.as_deref(),
            Some(
                "https://pid.posindonesia.co.id/lacak/admin/mapnya.php?id=LTIuNTQyNTU2NiwxNDAuNzA3MDQwNQ%3D%3D"
            )
        );
        assert_eq!(response.history.len(), 2);
        assert_eq!(response.history[0].tanggal_update, "2026-04-13 11:01:13");
        assert_eq!(response.history_summary.delivery_runsheet.len(), 1);
        assert_eq!(
            response.history_summary.delivery_runsheet[0].updates.len(),
            1
        );
    }

    #[test]
    fn parse_tracking_html_returns_not_found_when_shipment_header_missing() {
        let html = r#"
            <html>
              <body>
                <div>Data tidak ditemukan untuk kiriman ini.</div>
              </body>
            </html>
        "#;

        let error = parse_tracking_html("https://example.test", html)
            .expect_err("missing details should fail");

        assert!(matches!(error, TrackingError::NotFound(_)));
    }

    #[test]
    fn parse_tracking_html_returns_upstream_error_for_invalid_numeric_fields() {
        let html = r#"
            <table>
              <tr><td>Nomor Kiriman</td><td>P2603310114291</td></tr>
              <tr><td>Bea Dasar</td><td>Rp not-a-number</td></tr>
            </table>
        "#;

        let error = parse_tracking_html("https://example.test", html)
            .expect_err("invalid numeric values should fail loudly");

        assert!(matches!(error, TrackingError::Upstream(_)));
    }

    #[test]
    fn parse_tracking_html_keeps_nullable_numeric_fields_as_none() {
        let response = parse_tracking_html("https://example.test", NULLABLE_NUMERIC_HTML)
            .expect("nullable numeric sample should parse");

        assert_eq!(response.detail.package.berat_actual, None);
        assert_eq!(response.detail.package.berat_volumetric, None);
        assert_eq!(response.detail.billing.bea_dasar, None);
        assert_eq!(response.detail.billing.nilai_barang, None);
        assert_eq!(response.detail.billing.htnb, None);
        assert_eq!(response.detail.billing.cod.total_cod, None);
    }

    #[test]
    fn parse_tracking_html_survives_reordered_tables() {
        let response = parse_tracking_html("https://example.test", REORDERED_TABLES_HTML)
            .expect("reordered tables sample should parse");

        assert_eq!(
            response.detail.header.nomor_kiriman.as_deref(),
            Some("P2603310116000")
        );
        assert_eq!(response.history.len(), 2);
        assert_eq!(
            response.pod.photo1_url.as_deref(),
            Some("https://apistorage.mile.app/v2-public/prod/pos/2026/04/14/sample-photo.jpg")
        );
    }

    #[test]
    fn parse_tracking_html_selected_fields_match_snapshot() {
        let response =
            parse_tracking_html("https://example.test", SAMPLE_HTML).expect("sample should parse");

        let snapshot = json!({
            "nomor_kiriman": response.detail.header.nomor_kiriman,
            "jenis_layanan": response.detail.package.jenis_layanan,
            "status_akhir": response.status_akhir.status,
            "history_count": response.history.len(),
            "delivery_runsheet_count": response.history_summary.delivery_runsheet.len(),
        });

        assert_eq!(
            snapshot,
            json!({
                "nomor_kiriman": "P2603310114291",
                "jenis_layanan": "PKH",
                "status_akhir": "INVEHICLE",
                "history_count": 2,
                "delivery_runsheet_count": 1
            })
        );
    }

    #[test]
    fn parse_tracking_html_distinguishes_partial_upstream_from_not_found() {
        let html = r#"
            <html>
              <body>
                <div>Halaman tracking POS aktif tetapi struktur detail berubah total.</div>
              </body>
            </html>
        "#;

        let error = parse_tracking_html("https://example.test", html)
            .expect_err("partial upstream html should not be treated as not found");

        assert!(matches!(error, TrackingError::Upstream(_)));
    }

    #[test]
    fn parse_tracking_html_maps_failedtoddelivered_as_single_runsheet_update() {
        let response = parse_tracking_html("https://example.test", RUNSHEET_FAILEDTODELIVERED_HTML)
            .expect("failedtoddelivered runsheet sample should parse");

        let runsheet = &response.history_summary.delivery_runsheet[0];
        assert_eq!(runsheet.updates.len(), 1);
        assert_eq!(
            runsheet.updates[0].status.as_deref(),
            Some("FAILEDTODELIVERED")
        );
        assert_eq!(
            runsheet.updates[0].keterangan_status.as_deref(),
            Some("YANG BERSANGKUTAN TIDAK DITEMPAT")
        );
    }

    #[test]
    fn parse_tracking_html_keeps_synthetic_delivered_for_exact_delivered_status() {
        let html = r#"
            <table>
              <tr><td>Nomor Kiriman</td><td>P2603310999999</td></tr>
              <tr><td>Status Akhir</td><td>DELIVERED di DC JAYAPURA 9910A [Kurir/9910bkurir] [2026-04-15 11:51:34]</td></tr>
            </table>
            <table>
              <tr><td>TANGGAL UPDATE</td><td>DETAIL HISTORY</td></tr>
              <tr>
                <td>2026-04-15 11:40:47</td>
                <td>Barang P2603310999999 anda telah melewati proses DeliveryRunsheet oleh Akbar di DC JAYAPURA 9910A diterima oleh Kurir</td>
              </tr>
            </table>
        "#;

        let response = parse_tracking_html("https://example.test", html)
            .expect("synthetic delivered sample should parse");

        let runsheet = &response.history_summary.delivery_runsheet[0];
        assert_eq!(runsheet.updates.len(), 1);
        assert_eq!(runsheet.updates[0].status.as_deref(), Some("DELIVERED"));
        assert_eq!(runsheet.updates[0].keterangan_status, None);
    }

    #[test]
    fn parse_tracking_html_keeps_only_latest_effective_update_per_runsheet() {
        let html = r#"
            <table>
              <tr><td>Nomor Kiriman</td><td>P2603310888888</td></tr>
              <tr><td>Status Akhir</td><td>FAILEDTODELIVERED di DC JAYAPURA 9910A [Kurir/9910bkurir] [2026-04-15 14:50:02]</td></tr>
            </table>
            <table>
              <tr><td>TANGGAL UPDATE</td><td>DETAIL HISTORY</td></tr>
              <tr>
                <td>2026-04-15 11:40:47</td>
                <td>Barang P2603310888888 anda telah melewati proses DeliveryRunsheet oleh Akbar di DC JAYAPURA 9910A diterima oleh Kurir</td>
              </tr>
              <tr>
                <td>2026-04-15 14:00:00</td>
                <td>Barang P2603310888888 anda telah melewati proses antaran oleh Gabriel Erick Taurui dengan keterangan (ALAMAT TIDAK DITEMUKAN)</td>
              </tr>
              <tr>
                <td>2026-04-15 14:50:02</td>
                <td>Barang P2603310888888 anda telah melewati proses antaran oleh Gabriel Erick Taurui dengan keterangan (YANG BERSANGKUTAN TIDAK DITEMPAT)</td>
              </tr>
            </table>
        "#;

        let response = parse_tracking_html("https://example.test", html)
            .expect("multi-update runsheet sample should parse");

        let runsheet = &response.history_summary.delivery_runsheet[0];
        assert_eq!(runsheet.updates.len(), 1);
        assert_eq!(
            runsheet.updates[0].status.as_deref(),
            Some("FAILEDTODELIVERED")
        );
        assert_eq!(
            runsheet.updates[0].keterangan_status.as_deref(),
            Some("YANG BERSANGKUTAN TIDAK DITEMPAT")
        );
    }

    #[test]
    fn normalize_and_validate_shipment_id_matches_frontend_constraints() {
        assert_eq!(
            normalize_and_validate_shipment_id(" p2603310114291 ")
                .expect("valid shipment id should normalize"),
            "P2603310114291"
        );
        assert!(matches!(
            normalize_and_validate_shipment_id("   "),
            Err(TrackingError::BadRequest(_))
        ));
        assert!(matches!(
            normalize_and_validate_shipment_id(&format!("P{}", "1".repeat(80))),
            Err(TrackingError::BadRequest(_))
        ));
    }

    #[test]
    fn parse_tracking_html_keeps_data_image_pod_src_as_is() {
        let html = r#"
            <table>
              <tr><td>Nomor Kiriman</td><td>P2603310114291</td></tr>
              <tr><td>Status Akhir</td><td>DELIVERED - DC JAYAPURA [Kurir/9910bkurir] [2026-04-15 11:51:34]</td></tr>
            </table>
            <table>
              <tr>
                <th>POD</th>
                <th>Photo</th>
                <th>Photo2</th>
                <th>signature</th>
                <th>coordinate</th>
              </tr>
              <tr>
                <td></td>
                <td><img src="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD" /></td>
                <td><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" /></td>
                <td></td>
                <td>-2.5,140.7</td>
              </tr>
            </table>
        "#;

        let response = parse_tracking_html("https://example.test", html)
            .expect("data image pod sample should parse");

        assert_eq!(
            response.pod.photo1_url.as_deref(),
            Some("data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD")
        );
        assert_eq!(
            response.pod.photo2_url.as_deref(),
            Some("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB")
        );
    }

    #[test]
    fn resolve_pod_base64_into_data_url() {
        let base64_png =
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z1xQAAAAASUVORK5CYII=";

        assert_eq!(
            base64_to_data_url(base64_png),
            format!("data:image/png;base64,{base64_png}")
        );
        assert_eq!(
            normalize_base64_image(base64_png),
            Some(base64_png.to_string())
        );
    }

    #[test]
    fn rejects_insecure_external_api_base_url_without_opt_in() {
        let error = validate_tracking_source_config(&TrackingSourceConfig {
            tracking_source: TrackingSource::ExternalApi,
            external_api_base_url: "http://shipflow.internal".into(),
            external_api_auth_token: "sf_token".into(),
            allow_insecure_external_api_http: false,
        })
        .expect_err("http external API should be rejected by default");

        assert!(matches!(error, TrackingError::BadRequest(message) if message.contains("HTTPS")));
    }

    #[test]
    fn allows_insecure_external_api_base_url_only_with_explicit_opt_in() {
        validate_tracking_source_config(&TrackingSourceConfig {
            tracking_source: TrackingSource::ExternalApi,
            external_api_base_url: "http://shipflow.internal".into(),
            external_api_auth_token: "sf_token".into(),
            allow_insecure_external_api_http: true,
        })
        .expect("http external API should be allowed only with explicit opt-in");
    }

    #[tokio::test]
    async fn rejects_private_loopback_pod_url() {
        let error = validate_remote_pod_url(
            &Url::parse("http://127.0.0.1/internal-preview.jpg").expect("url should parse"),
        )
        .await
        .expect_err("private loopback POD URL should be rejected");

        assert!(error.contains("not allowed"));
    }

    #[test]
    fn workspace_document_roundtrip_preserves_workspace_payload() {
        let temp_dir =
            std::env::temp_dir().join(format!("shipflow-doc-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&temp_dir);
        let target_path = temp_dir.join("workspace");
        let target_path_string = target_path.to_string_lossy().to_string();

        let document = WorkspaceDocumentFile {
            version: 1,
            app: "shipflow-desktop".into(),
            saved_at: "2026-04-18T16:00:00.000Z".into(),
            workspace: json!({
                "version": 1,
                "activeSheetId": "sheet-1",
                "sheetOrder": ["sheet-1"],
                "sheetMetaById": {
                    "sheet-1": {
                        "name": "Sheet 1",
                        "color": "slate",
                        "icon": "sheet"
                    }
                },
                "sheetsById": {
                    "sheet-1": {
                        "rows": [],
                        "filters": {},
                        "valueFilters": {},
                        "sortState": {
                            "path": null,
                            "direction": "asc"
                        },
                        "selectedRowKeys": [],
                        "selectionFollowsVisibleRows": false,
                        "columnWidths": {},
                        "hiddenColumnPaths": [],
                        "pinnedColumnPaths": [],
                        "openColumnMenuPath": null,
                        "highlightedColumnPath": null,
                        "deleteAllArmed": false
                    }
                }
            }),
        };

        let write_result = write_workspace_document(target_path_string.clone(), document.clone())
            .expect("workspace document should write");
        assert!(write_result.path.ends_with(".shipflow"));

        let read_result =
            read_workspace_document(target_path_string).expect("workspace document should read");
        assert_eq!(read_result.document.workspace, document.workspace);

        let _ = fs::remove_file(
            normalize_workspace_document_path(
                temp_dir.join("workspace").to_string_lossy().as_ref(),
            )
            .expect("document path should normalize"),
        );
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn workspace_document_requires_shipflow_signature() {
        let temp_dir =
            std::env::temp_dir().join(format!("shipflow-doc-invalid-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&temp_dir);
        let target_path = temp_dir.join("invalid.shipflow");

        fs::write(
            &target_path,
            serde_json::to_vec_pretty(&json!({
                "version": 1,
                "app": "not-shipflow",
                "savedAt": "2026-04-18T16:00:00.000Z",
                "workspace": {}
            }))
            .expect("invalid document json should serialize"),
        )
        .expect("invalid document should write");

        let error = read_workspace_document(target_path.to_string_lossy().to_string())
            .expect_err("invalid app signature should fail");
        assert!(error.contains("not a ShipFlow workspace"));

        let _ = fs::remove_file(&target_path);
        let _ = fs::remove_dir_all(&temp_dir);
    }
}
