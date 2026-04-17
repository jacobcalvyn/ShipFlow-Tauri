use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::{Arc, Mutex},
};

use axum::{
    extract::{Path, State},
    http::{header::AUTHORIZATION, HeaderMap, StatusCode},
    routing::get,
    Json, Router,
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::async_runtime::JoinHandle;
use tokio::net::TcpListener;

use crate::tracking::{
    model::{TrackResponse, TrackingError},
    upstream::scrape_pos_tracking,
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ApiServiceMode {
    Local,
    Lan,
}

impl ApiServiceMode {
    fn bind_address(&self) -> IpAddr {
        match self {
            Self::Local => IpAddr::V4(Ipv4Addr::LOCALHOST),
            Self::Lan => IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        }
    }

    fn bind_address_label(&self) -> &'static str {
        match self {
            Self::Local => "127.0.0.1",
            Self::Lan => "0.0.0.0",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiServiceConfig {
    pub version: u8,
    pub enabled: bool,
    pub mode: ApiServiceMode,
    pub port: u16,
    pub auth_token: String,
    pub last_updated_at: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApiServiceStatusKind {
    Stopped,
    Running,
    Error,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiServiceStatus {
    pub status: ApiServiceStatusKind,
    pub enabled: bool,
    pub mode: Option<ApiServiceMode>,
    pub bind_address: Option<String>,
    pub port: Option<u16>,
    pub error_message: Option<String>,
}

impl Default for ApiServiceStatus {
    fn default() -> Self {
        Self {
            status: ApiServiceStatusKind::Stopped,
            enabled: false,
            mode: None,
            bind_address: None,
            port: None,
            error_message: None,
        }
    }
}

#[derive(Clone)]
struct HttpApiState {
    client: Client,
    auth_token: String,
    mode: ApiServiceMode,
    bind_address: String,
    port: u16,
}

struct ApiServiceRuntime {
    status: ApiServiceStatus,
    generation: u64,
    server_task: Option<JoinHandle<()>>,
}

impl Default for ApiServiceRuntime {
    fn default() -> Self {
        Self {
            status: ApiServiceStatus::default(),
            generation: 0,
            server_task: None,
        }
    }
}

#[derive(Clone, Default)]
pub struct ApiServiceController {
    inner: Arc<Mutex<ApiServiceRuntime>>,
}

impl ApiServiceController {
    pub async fn configure(
        &self,
        config: ApiServiceConfig,
        client: Client,
    ) -> Result<ApiServiceStatus, String> {
        let bind_address = config.mode.bind_address_label().to_string();
        let previous_handle = {
            let mut runtime = self.inner.lock().expect("service runtime lock poisoned");
            let previous_handle = runtime.server_task.take();

            runtime.generation += 1;

            if !config.enabled {
                runtime.status = ApiServiceStatus {
                    status: ApiServiceStatusKind::Stopped,
                    enabled: false,
                    mode: Some(config.mode.clone()),
                    bind_address: Some(bind_address.clone()),
                    port: Some(config.port),
                    error_message: None,
                };
            }

            previous_handle
        };

        if let Some(handle) = previous_handle {
            handle.abort();
            let _ = handle.await;
        }

        if !config.enabled {
            return Ok(self.status());
        }

        if config.auth_token.trim().is_empty() {
            let status = ApiServiceStatus {
                status: ApiServiceStatusKind::Error,
                enabled: true,
                mode: Some(config.mode.clone()),
                bind_address: Some(bind_address),
                port: Some(config.port),
                error_message: Some("Auth token is required before enabling API service.".into()),
            };

            let mut runtime = self.inner.lock().expect("service runtime lock poisoned");
            runtime.status = status.clone();
            return Err(
                status
                    .error_message
                    .clone()
                    .unwrap_or_else(|| "API service configuration failed.".into()),
            );
        }

        let socket_addr = SocketAddr::new(config.mode.bind_address(), config.port);
        let listener = TcpListener::bind(socket_addr)
            .await
            .map_err(|error| {
                let message = format!(
                    "Unable to start API service on {}:{}: {error}",
                    bind_address, config.port
                );

                let mut runtime = self.inner.lock().expect("service runtime lock poisoned");
                runtime.status = ApiServiceStatus {
                    status: ApiServiceStatusKind::Error,
                    enabled: true,
                    mode: Some(config.mode.clone()),
                    bind_address: Some(bind_address.clone()),
                    port: Some(config.port),
                    error_message: Some(message.clone()),
                };

                message
            })?;

        let app_state = HttpApiState {
            client,
            auth_token: config.auth_token.clone(),
            mode: config.mode.clone(),
            bind_address: bind_address.clone(),
            port: config.port,
        };
        let router = build_router(app_state.clone());
        let controller = self.inner.clone();
        let generation = {
            let runtime = controller.lock().expect("service runtime lock poisoned");
            runtime.generation
        };

        let handle = tauri::async_runtime::spawn(async move {
            if let Err(error) = axum::serve(listener, router).await {
                let mut runtime = controller.lock().expect("service runtime lock poisoned");
                if runtime.generation == generation {
                    runtime.server_task = None;
                    runtime.status = ApiServiceStatus {
                        status: ApiServiceStatusKind::Error,
                        enabled: true,
                        mode: Some(app_state.mode.clone()),
                        bind_address: Some(app_state.bind_address.clone()),
                        port: Some(app_state.port),
                        error_message: Some(format!("API service stopped unexpectedly: {error}")),
                    };
                }
            }
        });

        let mut runtime = self.inner.lock().expect("service runtime lock poisoned");
        runtime.server_task = Some(handle);
        runtime.status = ApiServiceStatus {
            status: ApiServiceStatusKind::Running,
            enabled: true,
            mode: Some(config.mode),
            bind_address: Some(bind_address),
            port: Some(config.port),
            error_message: None,
        };

        Ok(runtime.status.clone())
    }

    pub fn status(&self) -> ApiServiceStatus {
        self.inner
            .lock()
            .expect("service runtime lock poisoned")
            .status
            .clone()
    }
}

fn build_router(app_state: HttpApiState) -> Router {
    Router::new()
        .route("/health", get(health_handler))
        .route("/status", get(status_handler))
        .route("/track/:shipment_id", get(track_handler))
        .with_state(app_state)
}

async fn health_handler() -> Json<Value> {
    Json(json!({ "ok": true }))
}

async fn status_handler(
    State(state): State<HttpApiState>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    authorize_request(&headers, &state.auth_token)?;

    Ok(Json(json!({
        "service": "running",
        "mode": state.mode,
        "bindAddress": state.bind_address,
        "port": state.port,
    })))
}

async fn track_handler(
    State(state): State<HttpApiState>,
    headers: HeaderMap,
    Path(shipment_id): Path<String>,
) -> Result<Json<TrackResponse>, (StatusCode, Json<Value>)> {
    authorize_request(&headers, &state.auth_token)?;

    scrape_pos_tracking(&state.client, shipment_id.trim())
        .await
        .map(Json)
        .map_err(map_tracking_error)
}

fn authorize_request(
    headers: &HeaderMap,
    expected_token: &str,
) -> Result<(), (StatusCode, Json<Value>)> {
    let Some(raw_header) = headers.get(AUTHORIZATION) else {
        return Err(error_response(
            StatusCode::UNAUTHORIZED,
            "Authorization header is required.",
        ));
    };

    let Ok(header_value) = raw_header.to_str() else {
        return Err(error_response(
            StatusCode::UNAUTHORIZED,
            "Authorization header is invalid.",
        ));
    };

    let Some(token) = header_value.strip_prefix("Bearer ") else {
        return Err(error_response(
            StatusCode::UNAUTHORIZED,
            "Authorization header must use Bearer token.",
        ));
    };

    if token != expected_token {
        return Err(error_response(
            StatusCode::UNAUTHORIZED,
            "Bearer token is invalid.",
        ));
    }

    Ok(())
}

fn map_tracking_error(error: TrackingError) -> (StatusCode, Json<Value>) {
    match error {
        TrackingError::BadRequest(message) => error_response(StatusCode::BAD_REQUEST, &message),
        TrackingError::NotFound(message) => error_response(StatusCode::NOT_FOUND, &message),
        TrackingError::Upstream(message) => error_response(StatusCode::BAD_GATEWAY, &message),
    }
}

fn error_response(status: StatusCode, message: &str) -> (StatusCode, Json<Value>) {
    (
        status,
        Json(json!({
            "error": message,
        })),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_missing_authorization_header() {
        let result = authorize_request(&HeaderMap::new(), "secret-token");

        assert!(matches!(result, Err((StatusCode::UNAUTHORIZED, _))));
    }

    #[test]
    fn accepts_valid_bearer_token() {
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, "Bearer secret-token".parse().unwrap());

        let result = authorize_request(&headers, "secret-token");

        assert!(result.is_ok());
    }
}
