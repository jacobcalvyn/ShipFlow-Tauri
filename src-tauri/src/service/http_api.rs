use axum::{
    extract::{Path, State},
    http::{header::AUTHORIZATION, HeaderMap, StatusCode},
    routing::get,
    Json, Router,
};
use reqwest::Client;
use serde_json::{json, Value};

use super::{runtime_config::validate_service_config, ApiServiceConfig, ApiServiceMode};
use crate::tracking::{
    model::{BagResponse, ManifestResponse, TrackResponse, TrackingError},
    upstream::{resolve_bag_request, resolve_manifest_request, resolve_tracking_request},
};

#[derive(Clone)]
pub(crate) struct HttpApiState {
    pub(crate) client: Client,
    pub(crate) auth_token: String,
    pub(crate) mode: ApiServiceMode,
    pub(crate) bind_address: String,
    pub(crate) port: u16,
    pub(crate) tracking_source: crate::tracking::model::TrackingSourceConfig,
}

pub(crate) async fn run_service_process(config: ApiServiceConfig) -> Result<(), String> {
    let bind_address = config.mode.bind_address_label().to_string();
    validate_service_config(&config, &bind_address)?;

    let tracking_source = config.tracking_source_config();
    let socket_addr = std::net::SocketAddr::new(config.mode.bind_address(), config.port);
    let listener = tokio::net::TcpListener::bind(socket_addr)
        .await
        .map_err(|error| {
            format!(
                "Unable to start API service on {}:{}: {error}",
                bind_address, config.port
            )
        })?;

    let app_state = HttpApiState {
        client: Client::new(),
        auth_token: config.auth_token.clone(),
        mode: config.mode,
        bind_address,
        port: config.port,
        tracking_source,
    };
    let router = build_router(app_state);

    axum::serve(listener, router)
        .await
        .map_err(|error| format!("API service stopped unexpectedly: {error}"))
}

fn build_router(app_state: HttpApiState) -> Router {
    Router::new()
        .route("/health", get(health_handler))
        .route("/status", get(status_handler))
        .route("/track/:shipment_id", get(track_handler))
        .route("/bag/:bag_id", get(bag_handler))
        .route("/manifest/:manifest_id", get(manifest_handler))
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

    resolve_tracking_request(&state.client, &state.tracking_source, shipment_id.trim())
        .await
        .map(Json)
        .map_err(map_tracking_error)
}

async fn bag_handler(
    State(state): State<HttpApiState>,
    headers: HeaderMap,
    Path(bag_id): Path<String>,
) -> Result<Json<BagResponse>, (StatusCode, Json<Value>)> {
    authorize_request(&headers, &state.auth_token)?;

    resolve_bag_request(&state.client, bag_id.trim())
        .await
        .map(Json)
        .map_err(map_tracking_error)
}

async fn manifest_handler(
    State(state): State<HttpApiState>,
    headers: HeaderMap,
    Path(manifest_id): Path<String>,
) -> Result<Json<ManifestResponse>, (StatusCode, Json<Value>)> {
    authorize_request(&headers, &state.auth_token)?;

    resolve_manifest_request(&state.client, manifest_id.trim())
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
    use axum::http::{header::AUTHORIZATION, HeaderMap, StatusCode};

    use super::authorize_request;

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
