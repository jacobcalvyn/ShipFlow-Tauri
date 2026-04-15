use std::fs::File;
use std::io::Read;
use std::sync::mpsc;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::header::{HeaderName, HeaderValue};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::routing::get;
use axum::{Json, Router};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use reqwest::Client;
use tower_http::cors::{AllowOrigin, CorsLayer};

use super::model::{
    ErrorResponse, HealthResponse, TrackResponse, TrackingError, TrackingServerInfo,
    TrackingServerState,
};
use super::upstream::scrape_pos_tracking;

const TRACKING_TOKEN_HEADER: &str = "x-shipflow-token";

#[tauri::command]
pub fn get_tracking_server_config(server: tauri::State<'_, TrackingServerInfo>) -> TrackingServerInfo {
    server.inner().clone()
}

pub async fn healthcheck() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

pub async fn track_handler(
    Path(shipment_id): Path<String>,
    State(state): State<TrackingServerState>,
    headers: HeaderMap,
) -> Result<Json<TrackResponse>, (StatusCode, Json<ErrorResponse>)> {
    let provided_token = headers
        .get(TRACKING_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .unwrap_or_default();

    if provided_token != state.access_token {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: "Unauthorized tracking request.".into(),
            }),
        ));
    }

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
    let access_token = generate_access_token();
    let client = Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("ShipFlow Desktop/0.1")
        .build()
        .map_err(|error| format!("failed to create tracking client: {error}"))?;

    let allowed_origins = AllowOrigin::list([
        HeaderValue::from_static("http://localhost:1420"),
        HeaderValue::from_static("http://127.0.0.1:1420"),
        HeaderValue::from_static("http://tauri.localhost"),
        HeaderValue::from_static("tauri://localhost"),
    ]);

    let router = Router::new()
        .route("/health", get(healthcheck))
        .route("/track/:shipment_id", get(track_handler))
        .layer(
            CorsLayer::new()
                .allow_origin(allowed_origins)
                .allow_methods([Method::GET])
                .allow_headers([HeaderName::from_static(TRACKING_TOKEN_HEADER)]),
        )
        .with_state(TrackingServerState {
            client,
            access_token: access_token.clone(),
        });

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

    Ok(TrackingServerInfo {
        base_url,
        access_token,
    })
}

fn generate_access_token() -> String {
    let mut bytes = [0_u8; 24];

    if File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .is_err()
    {
        let fallback = format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default()
        );
        return URL_SAFE_NO_PAD.encode(fallback);
    }

    URL_SAFE_NO_PAD.encode(bytes)
}
