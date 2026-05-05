use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use shipflow_tauri_runtime::pod_preview::resolve_pod_image_source;
use shipflow_tauri_runtime::runtime_log::log_runtime_event;
use shipflow_tauri_runtime::service::{
    ensure_tracking_service_runtime, load_desktop_tracking_service_config,
};
use shipflow_tauri_runtime::service_client::{
    track_bag_via_service, track_manifest_via_service, track_shipment_via_service,
    track_shipments_batch_via_service,
};
use shipflow_tauri_runtime::tracking::model::{
    BagResponse, ManifestResponse, TrackResponse, TrackingClientState, TrackingError,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchTrackingRequestEntry {
    pub row_key: String,
    pub shipment_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchTrackingRowResult {
    pub row_key: String,
    pub shipment_id: String,
    pub shipment: Option<TrackResponse>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn track_shipment(
    shipment_id: String,
    force_refresh: Option<bool>,
    sheet_id: Option<String>,
    row_key: Option<String>,
    client_state: tauri::State<'_, TrackingClientState>,
) -> Result<TrackResponse, String> {
    let context = format!(
        "[sheetId={}, rowKey={}, shipmentId={}]",
        sheet_id.as_deref().unwrap_or("-"),
        row_key.as_deref().unwrap_or("-"),
        shipment_id.trim()
    );

    let saved_service_config = load_desktop_tracking_service_config().unwrap_or(None);
    let runtime_config =
        ensure_tracking_service_runtime(saved_service_config).map_err(|message| {
            log_runtime_event("ERROR", format!("[ShipFlowBackend] {context} {message}"));
            format!("{context} {message}")
        })?;

    track_shipment_via_service(
        &client_state.client,
        &runtime_config,
        shipment_id.trim(),
        force_refresh.unwrap_or(false),
    )
    .await
    .map_err(|error| format_tracking_error(&context, error))
}

#[tauri::command]
pub async fn track_shipments_batch(
    entries: Vec<BatchTrackingRequestEntry>,
    force_refresh: Option<bool>,
    sheet_id: Option<String>,
    client_state: tauri::State<'_, TrackingClientState>,
) -> Result<Vec<BatchTrackingRowResult>, String> {
    let context = format!(
        "[sheetId={}, batchSize={}]",
        sheet_id.as_deref().unwrap_or("-"),
        entries.len()
    );
    let saved_service_config = load_desktop_tracking_service_config().unwrap_or(None);
    let runtime_config =
        ensure_tracking_service_runtime(saved_service_config).map_err(|message| {
            log_runtime_event("ERROR", format!("[ShipFlowBackend] {context} {message}"));
            format!("{context} {message}")
        })?;
    let shipment_ids = entries
        .iter()
        .map(|entry| entry.shipment_id.trim().to_string())
        .collect::<Vec<_>>();
    let results = track_shipments_batch_via_service(
        &client_state.client,
        &runtime_config,
        shipment_ids,
        force_refresh.unwrap_or(false),
    )
    .await
    .map_err(|error| format_tracking_error(&context, error))?;
    let results_by_id = results
        .into_iter()
        .map(|result| (result.id.clone(), result))
        .collect::<HashMap<_, _>>();

    Ok(entries
        .into_iter()
        .map(|entry| {
            let shipment_id = entry.shipment_id.trim().to_string();
            match results_by_id.get(&shipment_id) {
                Some(result) if result.data.is_some() => BatchTrackingRowResult {
                    row_key: entry.row_key,
                    shipment_id,
                    shipment: result.data.clone(),
                    error: result.error.clone(),
                },
                Some(result) => BatchTrackingRowResult {
                    row_key: entry.row_key,
                    shipment_id,
                    shipment: None,
                    error: result
                        .error
                        .clone()
                        .or_else(|| Some("Tracking request failed.".into())),
                },
                None => BatchTrackingRowResult {
                    row_key: entry.row_key,
                    shipment_id,
                    shipment: None,
                    error: Some("ShipFlow Service did not return this tracking result.".into()),
                },
            }
        })
        .collect())
}

#[tauri::command]
pub async fn track_bag(
    bag_id: String,
    force_refresh: Option<bool>,
    sheet_id: Option<String>,
    row_key: Option<String>,
    client_state: tauri::State<'_, TrackingClientState>,
) -> Result<BagResponse, String> {
    let context = format!(
        "[sheetId={}, rowKey={}, bagId={}]",
        sheet_id.as_deref().unwrap_or("-"),
        row_key.as_deref().unwrap_or("-"),
        bag_id.trim()
    );

    let saved_service_config = load_desktop_tracking_service_config().unwrap_or(None);
    let runtime_config =
        ensure_tracking_service_runtime(saved_service_config).map_err(|message| {
            log_runtime_event("ERROR", format!("[ShipFlowBackend] {context} {message}"));
            format!("{context} {message}")
        })?;

    track_bag_via_service(
        &client_state.client,
        &runtime_config,
        bag_id.trim(),
        force_refresh.unwrap_or(false),
    )
    .await
    .map_err(|error| format_tracking_error(&context, error))
}

#[tauri::command]
pub async fn track_manifest(
    manifest_id: String,
    force_refresh: Option<bool>,
    sheet_id: Option<String>,
    row_key: Option<String>,
    client_state: tauri::State<'_, TrackingClientState>,
) -> Result<ManifestResponse, String> {
    let context = format!(
        "[sheetId={}, rowKey={}, manifestId={}]",
        sheet_id.as_deref().unwrap_or("-"),
        row_key.as_deref().unwrap_or("-"),
        manifest_id.trim()
    );

    let saved_service_config = load_desktop_tracking_service_config().unwrap_or(None);
    let runtime_config =
        ensure_tracking_service_runtime(saved_service_config).map_err(|message| {
            log_runtime_event("ERROR", format!("[ShipFlowBackend] {context} {message}"));
            format!("{context} {message}")
        })?;

    track_manifest_via_service(
        &client_state.client,
        &runtime_config,
        manifest_id.trim(),
        force_refresh.unwrap_or(false),
    )
    .await
    .map_err(|error| format_tracking_error(&context, error))
}

#[tauri::command]
pub async fn resolve_pod_image(image_source: String) -> Result<String, String> {
    resolve_pod_image_source(image_source.trim(), 0).await
}

fn format_tracking_error(context: &str, error: TrackingError) -> String {
    match error {
        TrackingError::BadRequest(message)
        | TrackingError::NotFound(message)
        | TrackingError::Upstream(message) => {
            log_runtime_event("ERROR", format!("[ShipFlowBackend] {context} {message}"));
            format!("{context} {message}")
        }
    }
}
