use std::sync::mpsc;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::{Method, StatusCode};
use axum::routing::get;
use axum::{Json, Router};
use reqwest::Client;
use tower_http::cors::{Any, CorsLayer};

use super::model::{
    ErrorResponse, HealthResponse, TrackResponse, TrackingError, TrackingServerInfo,
    TrackingServerState,
};
use super::upstream::scrape_pos_tracking;

#[tauri::command]
pub fn get_tracking_server_url(server: tauri::State<'_, TrackingServerInfo>) -> String {
    server.base_url.clone()
}

pub async fn healthcheck() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

pub async fn track_handler(
    Path(shipment_id): Path<String>,
    State(state): State<TrackingServerState>,
) -> Result<Json<TrackResponse>, (StatusCode, Json<ErrorResponse>)> {
    let normalized = shipment_id.trim().to_uppercase();

    if normalized.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Shipment ID is required.".into(),
            }),
        ));
    }

    scrape_pos_tracking(&state.client, &normalized)
        .await
        .map(Json)
        .map_err(map_tracking_error)
}

pub fn map_tracking_error(error: TrackingError) -> (StatusCode, Json<ErrorResponse>) {
    match error {
        TrackingError::BadRequest(message) => (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse { error: message }),
        ),
        TrackingError::NotFound(message) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse { error: message }),
        ),
        TrackingError::Upstream(message) => (
            StatusCode::BAD_GATEWAY,
            Json(ErrorResponse { error: message }),
        ),
    }
}

pub fn start_tracking_server() -> Result<TrackingServerInfo, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("ShipFlow Desktop/0.1")
        .build()
        .map_err(|error| format!("failed to create tracking client: {error}"))?;

    let router = Router::new()
        .route("/health", get(healthcheck))
        .route("/track/:shipment_id", get(track_handler))
        .layer(CorsLayer::new().allow_origin(Any).allow_methods([Method::GET]))
        .with_state(TrackingServerState { client });

    let (sender, receiver) = mpsc::channel::<Result<String, String>>();

    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
            Ok(listener) => listener,
            Err(error) => {
                let _ = sender.send(Err(format!("failed to bind tracking server: {error}")));
                return;
            }
        };

        let address = match listener.local_addr() {
            Ok(address) => address,
            Err(error) => {
                let _ = sender.send(Err(format!(
                    "failed to read tracking server address: {error}"
                )));
                return;
            }
        };

        let _ = sender.send(Ok(format!("http://{address}")));

        if let Err(error) = axum::serve(listener, router).await {
            eprintln!("tracking server failed: {error}");
        }
    });

    let base_url = receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|error| format!("failed to receive tracking server address: {error}"))??;

    Ok(TrackingServerInfo { base_url })
}
