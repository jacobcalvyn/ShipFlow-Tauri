use axum::{
    extract::{Path, State},
    http::{header::AUTHORIZATION, HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use shipflow_core::model::{BagResponse, ManifestResponse, TrackResponse, TrackingError};
use std::time::Duration;

use crate::api_contract::{
    envelope, error_response_v1, generate_request_id, legacy_error_response, REQUEST_ID_HEADER_NAME,
};
use crate::jobs::{
    BatchJobRegistry, BatchTrackJobStart, MAX_BATCH_SHIPMENT_IDS, MAX_BATCH_SHIPMENT_ID_LENGTH,
};
use crate::lookup_cache::{
    resolve_bag_request_cached, resolve_manifest_request_cached, resolve_tracking_request_cached,
    LookupCacheState, LookupRequestOptions,
};
use crate::model::{
    validate_service_runtime_config, ServiceRuntimeConfig, ServiceRuntimeMode,
    SERVICE_STATUS_PRODUCT,
};
use crate::openapi::service_openapi_document;
use crate::persistent_store::PersistentLookupStore;
use crate::FORCE_REFRESH_HEADER_NAME;

const STATUS_SCHEMA_VERSION: &str = "shipflow.service.status.v1";
const CAPABILITIES_SCHEMA_VERSION: &str = "shipflow.service.capabilities.v1";
const TRACK_SCHEMA_VERSION: &str = "shipflow.tracking.detail.v1";
const BAG_SCHEMA_VERSION: &str = "shipflow.tracking.bag.v1";
const MANIFEST_SCHEMA_VERSION: &str = "shipflow.tracking.manifest.v1";
const JOB_SCHEMA_VERSION: &str = "shipflow.service.job.v1";

#[derive(Clone)]
pub struct HttpApiState {
    pub client: Client,
    pub auth_token: String,
    pub mode: ServiceRuntimeMode,
    pub bind_address: String,
    pub port: u16,
    pub tracking_source: shipflow_core::model::TrackingSourceConfig,
    pub lookup_cache: LookupCacheState,
    pub job_registry: BatchJobRegistry,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusResponse {
    service: &'static str,
    product: &'static str,
    mode: ServiceRuntimeMode,
    bind_address: String,
    port: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CapabilitiesResponse {
    product: &'static str,
    api_version: &'static str,
    auth: &'static str,
    force_refresh_header: &'static str,
    routes: Vec<&'static str>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchTrackRequest {
    shipment_ids: Vec<String>,
    force_refresh: Option<bool>,
}

pub async fn run_service_process(config: ServiceRuntimeConfig) -> Result<(), String> {
    let bind_address = config.mode.bind_address_label().to_string();
    validate_service_runtime_config(&config)?;

    let tracking_source = config.tracking_source.clone();
    let socket_addr = std::net::SocketAddr::new(config.mode.bind_address(), config.port);
    let listener = tokio::net::TcpListener::bind(socket_addr)
        .await
        .map_err(|error| {
            format!(
                "Unable to start API service on {}:{}: {error}",
                bind_address, config.port
            )
        })?;

    let client = Client::builder()
        .connect_timeout(Duration::from_secs(6))
        .read_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(25))
        .user_agent("ShipFlow Service/0.1")
        .build()
        .map_err(|error| format!("Unable to create service HTTP client: {error}"))?;

    let app_state = HttpApiState {
        client,
        auth_token: config.auth_token.clone(),
        mode: config.mode,
        bind_address,
        port: config.port,
        tracking_source,
        lookup_cache: LookupCacheState::default()
            .with_persistent_store(PersistentLookupStore::open_default()),
        job_registry: BatchJobRegistry::default(),
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
        .route("/v1/status", get(v1_status_handler))
        .route("/v1/openapi.json", get(v1_openapi_handler))
        .route("/v1/capabilities", get(v1_capabilities_handler))
        .route("/v1/track/:shipment_id", get(v1_track_handler))
        .route("/v1/bag/:bag_id", get(v1_bag_handler))
        .route("/v1/manifest/:manifest_id", get(v1_manifest_handler))
        .route("/v1/jobs/track-batch", post(v1_start_track_batch_job))
        .route("/v1/jobs/:job_id", get(v1_get_job_status))
        .route("/v1/jobs/:job_id/result", get(v1_get_job_result))
        .route("/v1/jobs/:job_id/cancel", post(v1_cancel_job))
        .with_state(app_state)
}

async fn health_handler(
    State(state): State<HttpApiState>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    authorize_request(&headers, &state.auth_token)?;
    Ok(Json(json!({ "ok": true })))
}

async fn status_handler(
    State(state): State<HttpApiState>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    authorize_request(&headers, &state.auth_token)?;

    Ok(Json(json!({
        "service": "running",
        "product": SERVICE_STATUS_PRODUCT,
        "mode": state.mode,
        "bindAddress": state.bind_address,
        "port": state.port,
    })))
}

async fn v1_status_handler(
    State(state): State<HttpApiState>,
    headers: HeaderMap,
) -> Result<
    Json<crate::api_contract::ApiEnvelope<StatusResponse>>,
    (StatusCode, Json<crate::api_contract::ApiErrorEnvelope>),
> {
    let request_id = authorize_request_id(&headers);
    authorize_request_message(&headers, &state.auth_token).map_err(|message| {
        error_response_v1(
            StatusCode::UNAUTHORIZED,
            STATUS_SCHEMA_VERSION,
            request_id.clone(),
            &message,
        )
    })?;

    Ok(envelope(
        STATUS_SCHEMA_VERSION,
        request_id,
        status_response(&state),
    ))
}

async fn v1_capabilities_handler(
    State(state): State<HttpApiState>,
    headers: HeaderMap,
) -> Result<
    Json<crate::api_contract::ApiEnvelope<CapabilitiesResponse>>,
    (StatusCode, Json<crate::api_contract::ApiErrorEnvelope>),
> {
    let request_id = authorize_request_id(&headers);
    authorize_request_message(&headers, &state.auth_token).map_err(|message| {
        error_response_v1(
            StatusCode::UNAUTHORIZED,
            CAPABILITIES_SCHEMA_VERSION,
            request_id.clone(),
            &message,
        )
    })?;

    Ok(envelope(
        CAPABILITIES_SCHEMA_VERSION,
        request_id,
        CapabilitiesResponse {
            product: SERVICE_STATUS_PRODUCT,
            api_version: "v1",
            auth: "bearer",
            force_refresh_header: FORCE_REFRESH_HEADER_NAME,
            routes: vec![
                "GET /v1/openapi.json",
                "GET /v1/status",
                "GET /v1/capabilities",
                "GET /v1/track/:shipment_id",
                "GET /v1/bag/:bag_id",
                "GET /v1/manifest/:manifest_id",
                "POST /v1/jobs/track-batch",
                "GET /v1/jobs/:job_id",
                "GET /v1/jobs/:job_id/result",
                "POST /v1/jobs/:job_id/cancel",
            ],
        },
    ))
}

async fn v1_openapi_handler(
    State(state): State<HttpApiState>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<crate::api_contract::ApiErrorEnvelope>)> {
    let request_id = authorize_request_id(&headers);
    authorize_request_message(&headers, &state.auth_token).map_err(|message| {
        error_response_v1(
            StatusCode::UNAUTHORIZED,
            crate::openapi::OPENAPI_SCHEMA_VERSION,
            request_id,
            &message,
        )
    })?;

    Ok(Json(service_openapi_document(
        state.port,
        state.mode == ServiceRuntimeMode::Lan,
    )))
}

async fn track_handler(
    State(state): State<HttpApiState>,
    headers: HeaderMap,
    Path(shipment_id): Path<String>,
) -> Result<Json<TrackResponse>, (StatusCode, Json<Value>)> {
    authorize_request(&headers, &state.auth_token)?;
    let request_options = read_lookup_request_options(&headers);

    resolve_tracking_request_cached(
        &state.lookup_cache,
        &state.client,
        &state.tracking_source,
        shipment_id.trim(),
        request_options,
    )
    .await
    .map(Json)
    .map_err(map_tracking_error)
}

async fn v1_track_handler(
    State(state): State<HttpApiState>,
    headers: HeaderMap,
    Path(shipment_id): Path<String>,
) -> Result<
    Json<crate::api_contract::ApiEnvelope<TrackResponse>>,
    (StatusCode, Json<crate::api_contract::ApiErrorEnvelope>),
> {
    let request_id = authorize_request_id(&headers);
    authorize_request_message(&headers, &state.auth_token).map_err(|message| {
        error_response_v1(
            StatusCode::UNAUTHORIZED,
            TRACK_SCHEMA_VERSION,
            request_id.clone(),
            &message,
        )
    })?;
    let response_request_id = request_id.clone();
    let request_options = read_lookup_request_options(&headers);

    resolve_tracking_request_cached(
        &state.lookup_cache,
        &state.client,
        &state.tracking_source,
        shipment_id.trim(),
        request_options,
    )
    .await
    .map(|payload| envelope(TRACK_SCHEMA_VERSION, response_request_id, payload))
    .map_err(|error| map_tracking_error_v1(error, TRACK_SCHEMA_VERSION, request_id))
}

async fn bag_handler(
    State(state): State<HttpApiState>,
    headers: HeaderMap,
    Path(bag_id): Path<String>,
) -> Result<Json<BagResponse>, (StatusCode, Json<Value>)> {
    authorize_request(&headers, &state.auth_token)?;
    let request_options = read_lookup_request_options(&headers);

    resolve_bag_request_cached(
        &state.lookup_cache,
        &state.client,
        bag_id.trim(),
        request_options,
    )
    .await
    .map(Json)
    .map_err(map_tracking_error)
}

async fn v1_bag_handler(
    State(state): State<HttpApiState>,
    headers: HeaderMap,
    Path(bag_id): Path<String>,
) -> Result<
    Json<crate::api_contract::ApiEnvelope<BagResponse>>,
    (StatusCode, Json<crate::api_contract::ApiErrorEnvelope>),
> {
    let request_id = authorize_request_id(&headers);
    authorize_request_message(&headers, &state.auth_token).map_err(|message| {
        error_response_v1(
            StatusCode::UNAUTHORIZED,
            BAG_SCHEMA_VERSION,
            request_id.clone(),
            &message,
        )
    })?;
    let response_request_id = request_id.clone();
    let request_options = read_lookup_request_options(&headers);

    resolve_bag_request_cached(
        &state.lookup_cache,
        &state.client,
        bag_id.trim(),
        request_options,
    )
    .await
    .map(|payload| envelope(BAG_SCHEMA_VERSION, response_request_id, payload))
    .map_err(|error| map_tracking_error_v1(error, BAG_SCHEMA_VERSION, request_id))
}

async fn manifest_handler(
    State(state): State<HttpApiState>,
    headers: HeaderMap,
    Path(manifest_id): Path<String>,
) -> Result<Json<ManifestResponse>, (StatusCode, Json<Value>)> {
    authorize_request(&headers, &state.auth_token)?;
    let request_options = read_lookup_request_options(&headers);

    resolve_manifest_request_cached(
        &state.lookup_cache,
        &state.client,
        manifest_id.trim(),
        request_options,
    )
    .await
    .map(Json)
    .map_err(map_tracking_error)
}

async fn v1_manifest_handler(
    State(state): State<HttpApiState>,
    headers: HeaderMap,
    Path(manifest_id): Path<String>,
) -> Result<
    Json<crate::api_contract::ApiEnvelope<ManifestResponse>>,
    (StatusCode, Json<crate::api_contract::ApiErrorEnvelope>),
> {
    let request_id = authorize_request_id(&headers);
    authorize_request_message(&headers, &state.auth_token).map_err(|message| {
        error_response_v1(
            StatusCode::UNAUTHORIZED,
            MANIFEST_SCHEMA_VERSION,
            request_id.clone(),
            &message,
        )
    })?;
    let response_request_id = request_id.clone();
    let request_options = read_lookup_request_options(&headers);

    resolve_manifest_request_cached(
        &state.lookup_cache,
        &state.client,
        manifest_id.trim(),
        request_options,
    )
    .await
    .map(|payload| envelope(MANIFEST_SCHEMA_VERSION, response_request_id, payload))
    .map_err(|error| map_tracking_error_v1(error, MANIFEST_SCHEMA_VERSION, request_id))
}

async fn v1_start_track_batch_job(
    State(state): State<HttpApiState>,
    headers: HeaderMap,
    Json(payload): Json<BatchTrackRequest>,
) -> Result<
    Json<crate::api_contract::ApiEnvelope<BatchTrackJobStart>>,
    (StatusCode, Json<crate::api_contract::ApiErrorEnvelope>),
> {
    let request_id = authorize_request_id(&headers);
    authorize_request_message(&headers, &state.auth_token).map_err(|message| {
        error_response_v1(
            StatusCode::UNAUTHORIZED,
            JOB_SCHEMA_VERSION,
            request_id.clone(),
            &message,
        )
    })?;
    let shipment_ids = payload
        .shipment_ids
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect::<Vec<_>>();

    if shipment_ids.is_empty() {
        return Err(error_response_v1(
            StatusCode::BAD_REQUEST,
            JOB_SCHEMA_VERSION,
            request_id,
            "At least one shipment ID is required.",
        ));
    }
    if shipment_ids.len() > MAX_BATCH_SHIPMENT_IDS {
        return Err(error_response_v1(
            StatusCode::PAYLOAD_TOO_LARGE,
            JOB_SCHEMA_VERSION,
            request_id,
            &format!("At most {MAX_BATCH_SHIPMENT_IDS} shipment IDs are allowed per batch job."),
        ));
    }
    if shipment_ids
        .iter()
        .any(|shipment_id| shipment_id.len() > MAX_BATCH_SHIPMENT_ID_LENGTH)
    {
        return Err(error_response_v1(
            StatusCode::BAD_REQUEST,
            JOB_SCHEMA_VERSION,
            request_id,
            &format!("Shipment IDs must be {MAX_BATCH_SHIPMENT_ID_LENGTH} characters or fewer."),
        ));
    }

    let mut deduped_shipment_ids = Vec::with_capacity(shipment_ids.len());
    for shipment_id in shipment_ids {
        if !deduped_shipment_ids.contains(&shipment_id) {
            deduped_shipment_ids.push(shipment_id);
        }
    }

    let job = state
        .job_registry
        .create_track_job(deduped_shipment_ids.len())
        .map_err(|message| {
            error_response_v1(
                StatusCode::TOO_MANY_REQUESTS,
                JOB_SCHEMA_VERSION,
                request_id.clone(),
                &message,
            )
        })?;
    let job_id = job.job_id.clone();
    let state_for_job = state.clone();
    let force_refresh = payload.force_refresh.unwrap_or(false);

    tokio::spawn(async move {
        run_track_batch_job(state_for_job, job_id, deduped_shipment_ids, force_refresh).await;
    });

    Ok(envelope(JOB_SCHEMA_VERSION, request_id, job))
}

async fn v1_get_job_status(
    State(state): State<HttpApiState>,
    headers: HeaderMap,
    Path(job_id): Path<String>,
) -> Result<
    Json<crate::api_contract::ApiEnvelope<crate::jobs::BatchJobSnapshot>>,
    (StatusCode, Json<crate::api_contract::ApiErrorEnvelope>),
> {
    let request_id = authorize_request_id(&headers);
    authorize_request_message(&headers, &state.auth_token).map_err(|message| {
        error_response_v1(
            StatusCode::UNAUTHORIZED,
            JOB_SCHEMA_VERSION,
            request_id.clone(),
            &message,
        )
    })?;

    state
        .job_registry
        .status(job_id.trim())
        .map(|status| envelope(JOB_SCHEMA_VERSION, request_id.clone(), status))
        .ok_or_else(|| {
            error_response_v1(
                StatusCode::NOT_FOUND,
                JOB_SCHEMA_VERSION,
                request_id,
                "Job was not found.",
            )
        })
}

async fn v1_get_job_result(
    State(state): State<HttpApiState>,
    headers: HeaderMap,
    Path(job_id): Path<String>,
) -> Result<
    Json<crate::api_contract::ApiEnvelope<crate::jobs::BatchJobResultSnapshot>>,
    (StatusCode, Json<crate::api_contract::ApiErrorEnvelope>),
> {
    let request_id = authorize_request_id(&headers);
    authorize_request_message(&headers, &state.auth_token).map_err(|message| {
        error_response_v1(
            StatusCode::UNAUTHORIZED,
            JOB_SCHEMA_VERSION,
            request_id.clone(),
            &message,
        )
    })?;

    state
        .job_registry
        .result(job_id.trim())
        .map(|result| envelope(JOB_SCHEMA_VERSION, request_id.clone(), result))
        .ok_or_else(|| {
            error_response_v1(
                StatusCode::NOT_FOUND,
                JOB_SCHEMA_VERSION,
                request_id,
                "Job was not found.",
            )
        })
}

async fn v1_cancel_job(
    State(state): State<HttpApiState>,
    headers: HeaderMap,
    Path(job_id): Path<String>,
) -> Result<
    Json<crate::api_contract::ApiEnvelope<crate::jobs::BatchJobSnapshot>>,
    (StatusCode, Json<crate::api_contract::ApiErrorEnvelope>),
> {
    let request_id = authorize_request_id(&headers);
    authorize_request_message(&headers, &state.auth_token).map_err(|message| {
        error_response_v1(
            StatusCode::UNAUTHORIZED,
            JOB_SCHEMA_VERSION,
            request_id.clone(),
            &message,
        )
    })?;

    state
        .job_registry
        .request_cancel(job_id.trim())
        .map(|status| envelope(JOB_SCHEMA_VERSION, request_id.clone(), status))
        .ok_or_else(|| {
            error_response_v1(
                StatusCode::NOT_FOUND,
                JOB_SCHEMA_VERSION,
                request_id,
                "Job was not found.",
            )
        })
}

async fn run_track_batch_job(
    state: HttpApiState,
    job_id: String,
    shipment_ids: Vec<String>,
    force_refresh: bool,
) {
    state.job_registry.mark_running(&job_id);

    for shipment_id in shipment_ids {
        if state.job_registry.is_cancel_requested(&job_id) {
            state
                .job_registry
                .push_cancelled(&job_id, shipment_id.to_string());
            continue;
        }

        let result = resolve_tracking_request_cached(
            &state.lookup_cache,
            &state.client,
            &state.tracking_source,
            shipment_id.trim(),
            LookupRequestOptions { force_refresh },
        )
        .await;

        match result {
            Ok(payload) => {
                state
                    .job_registry
                    .push_success(&job_id, shipment_id, payload);
            }
            Err(error) => {
                state
                    .job_registry
                    .push_error(&job_id, shipment_id, tracking_error_message(error));
            }
        }
    }

    state.job_registry.finish(&job_id);
}

fn authorize_request(
    headers: &HeaderMap,
    expected_token: &str,
) -> Result<(), (StatusCode, Json<Value>)> {
    authorize_request_message(headers, expected_token)
        .map_err(|message| legacy_error_response(StatusCode::UNAUTHORIZED, &message))
}

fn authorize_request_message(headers: &HeaderMap, expected_token: &str) -> Result<(), String> {
    let Some(raw_header) = headers.get(AUTHORIZATION) else {
        return Err("Authorization header is required.".into());
    };

    let Ok(header_value) = raw_header.to_str() else {
        return Err("Authorization header is invalid.".into());
    };

    let Some(token) = header_value.strip_prefix("Bearer ") else {
        return Err("Authorization header must use Bearer token.".into());
    };

    if token != expected_token {
        return Err("Bearer token is invalid.".into());
    }

    Ok(())
}

fn map_tracking_error(error: TrackingError) -> (StatusCode, Json<Value>) {
    match error {
        TrackingError::BadRequest(message) => {
            legacy_error_response(StatusCode::BAD_REQUEST, &message)
        }
        TrackingError::NotFound(message) => legacy_error_response(StatusCode::NOT_FOUND, &message),
        TrackingError::Upstream(message) => {
            legacy_error_response(StatusCode::BAD_GATEWAY, &message)
        }
    }
}

fn map_tracking_error_v1(
    error: TrackingError,
    schema_version: &'static str,
    request_id: String,
) -> (StatusCode, Json<crate::api_contract::ApiErrorEnvelope>) {
    match error {
        TrackingError::BadRequest(message) => error_response_v1(
            StatusCode::BAD_REQUEST,
            schema_version,
            request_id,
            &message,
        ),
        TrackingError::NotFound(message) => {
            error_response_v1(StatusCode::NOT_FOUND, schema_version, request_id, &message)
        }
        TrackingError::Upstream(message) => error_response_v1(
            StatusCode::BAD_GATEWAY,
            schema_version,
            request_id,
            &message,
        ),
    }
}

fn read_lookup_request_options(headers: &HeaderMap) -> LookupRequestOptions {
    let force_refresh = headers
        .get(FORCE_REFRESH_HEADER_NAME)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("true"));

    LookupRequestOptions { force_refresh }
}

fn authorize_request_id(headers: &HeaderMap) -> String {
    headers
        .get(REQUEST_ID_HEADER_NAME)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(generate_request_id)
}

fn status_response(state: &HttpApiState) -> StatusResponse {
    StatusResponse {
        service: "running",
        product: SERVICE_STATUS_PRODUCT,
        mode: state.mode.clone(),
        bind_address: state.bind_address.clone(),
        port: state.port,
    }
}

fn tracking_error_message(error: TrackingError) -> String {
    match error {
        TrackingError::BadRequest(message)
        | TrackingError::NotFound(message)
        | TrackingError::Upstream(message) => message,
    }
}

#[cfg(test)]
mod tests {
    use axum::{
        body::{to_bytes, Body},
        http::{header::AUTHORIZATION, HeaderMap, Request, StatusCode},
    };
    use shipflow_core::model::TrackingSourceConfig;
    use tower::ServiceExt;

    use super::{authorize_request, build_router, read_lookup_request_options, HttpApiState};
    use crate::{
        jobs::BatchJobRegistry, lookup_cache::LookupCacheState, model::ServiceRuntimeMode,
        FORCE_REFRESH_HEADER_NAME,
    };

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

    #[test]
    fn rejects_wrong_bearer_token() {
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, "Bearer other-token".parse().unwrap());

        let result = authorize_request(&headers, "secret-token");

        assert!(matches!(result, Err((StatusCode::UNAUTHORIZED, _))));
    }

    #[test]
    fn reads_force_refresh_lookup_option_from_header() {
        let mut headers = HeaderMap::new();
        headers.insert(FORCE_REFRESH_HEADER_NAME, "true".parse().unwrap());

        let options = read_lookup_request_options(&headers);

        assert!(options.force_refresh);
    }

    #[tokio::test]
    async fn serves_authenticated_openapi_document() {
        let router = build_router(test_state());
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/v1/openapi.json")
                    .header(AUTHORIZATION, "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["openapi"], "3.1.0");
        assert!(payload["paths"]["/v1/openapi.json"]["get"].is_object());
    }

    #[tokio::test]
    async fn rejects_unauthenticated_openapi_document() {
        let router = build_router(test_state());
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/v1/openapi.json")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    fn test_state() -> HttpApiState {
        HttpApiState {
            client: reqwest::Client::new(),
            auth_token: "secret-token".into(),
            mode: ServiceRuntimeMode::Local,
            bind_address: "127.0.0.1".into(),
            port: 18422,
            tracking_source: TrackingSourceConfig::default(),
            lookup_cache: LookupCacheState::default(),
            job_registry: BatchJobRegistry::default(),
        }
    }
}
