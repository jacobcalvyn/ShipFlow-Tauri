use axum::{
    extract::{Path, State},
    http::{header::AUTHORIZATION, HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use reqwest::{Client, RequestBuilder, StatusCode as ReqwestStatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use shipflow_core::{
    model::{
        BagResponse, ManifestResponse, TrackResponse, TrackingError, TrackingHtmlResponse,
        TrackingSource, TrackingSourceConfig,
    },
    upstream::{parse_external_api_base_url, resolve_tracking_html_request},
};
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};
use tokio::task::JoinSet;

use crate::api_contract::{
    envelope, error_response_v1, generate_request_id, legacy_error_response, REQUEST_ID_HEADER_NAME,
};
use crate::jobs::{
    BatchJobItemStatus, BatchJobRegistry, BatchJobResultSnapshot, BatchJobStatus,
    BatchTrackJobStart, MAX_BATCH_SHIPMENT_IDS, MAX_BATCH_SHIPMENT_ID_LENGTH,
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
const TRACK_HTML_SCHEMA_VERSION: &str = "shipflow.tracking.html.v1";
const BAG_SCHEMA_VERSION: &str = "shipflow.tracking.bag.v1";
const MANIFEST_SCHEMA_VERSION: &str = "shipflow.tracking.manifest.v1";
const JOB_SCHEMA_VERSION: &str = "shipflow.service.job.v1";
const SERVICE_UPSTREAM_CONNECT_TIMEOUT_SECS: u64 = 10;
const SERVICE_UPSTREAM_READ_TIMEOUT_SECS: u64 = 60;
const SERVICE_UPSTREAM_REQUEST_TIMEOUT_SECS: u64 = 90;
const MAX_CONCURRENT_BATCH_TRACK_LOOKUPS: usize = 10;

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

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchTrackRequest {
    shipment_ids: Vec<String>,
    force_refresh: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteApiEnvelope<T> {
    data: T,
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
        .connect_timeout(Duration::from_secs(SERVICE_UPSTREAM_CONNECT_TIMEOUT_SECS))
        .read_timeout(Duration::from_secs(SERVICE_UPSTREAM_READ_TIMEOUT_SECS))
        .timeout(Duration::from_secs(SERVICE_UPSTREAM_REQUEST_TIMEOUT_SECS))
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
        .route("/v1/track/:shipment_id/html", get(v1_tracking_html_handler))
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
                "GET /v1/track/:shipment_id/html",
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
    let started_at = Instant::now();
    authorize_request(&headers, &state.auth_token)?;
    let request_options = read_lookup_request_options(&headers);
    let normalized_id = shipment_id.trim().to_string();

    let result = resolve_tracking_request_cached(
        &state.lookup_cache,
        &state.client,
        &state.tracking_source,
        &normalized_id,
        request_options,
    )
    .await;
    log_service_tracking_timing(
        "legacy",
        &normalized_id,
        started_at,
        &state.tracking_source,
        request_options.force_refresh,
        result.is_ok(),
    );

    result.map(Json).map_err(map_tracking_error)
}

async fn v1_track_handler(
    State(state): State<HttpApiState>,
    headers: HeaderMap,
    Path(shipment_id): Path<String>,
) -> Result<
    Json<crate::api_contract::ApiEnvelope<TrackResponse>>,
    (StatusCode, Json<crate::api_contract::ApiErrorEnvelope>),
> {
    let started_at = Instant::now();
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
    let normalized_id = shipment_id.trim().to_string();

    let result = resolve_tracking_request_cached(
        &state.lookup_cache,
        &state.client,
        &state.tracking_source,
        &normalized_id,
        request_options,
    )
    .await;
    log_service_tracking_timing(
        "v1",
        &normalized_id,
        started_at,
        &state.tracking_source,
        request_options.force_refresh,
        result.is_ok(),
    );

    result
        .map(|payload| envelope(TRACK_SCHEMA_VERSION, response_request_id, payload))
        .map_err(|error| map_tracking_error_v1(error, TRACK_SCHEMA_VERSION, request_id))
}

async fn v1_tracking_html_handler(
    State(state): State<HttpApiState>,
    headers: HeaderMap,
    Path(shipment_id): Path<String>,
) -> Result<
    Json<crate::api_contract::ApiEnvelope<TrackingHtmlResponse>>,
    (StatusCode, Json<crate::api_contract::ApiErrorEnvelope>),
> {
    let started_at = Instant::now();
    let request_id = authorize_request_id(&headers);
    authorize_request_message(&headers, &state.auth_token).map_err(|message| {
        error_response_v1(
            StatusCode::UNAUTHORIZED,
            TRACK_HTML_SCHEMA_VERSION,
            request_id.clone(),
            &message,
        )
    })?;
    let response_request_id = request_id.clone();
    let normalized_id = shipment_id.trim().to_string();

    let result =
        resolve_tracking_html_request(&state.client, &state.tracking_source, &normalized_id).await;
    log_service_tracking_timing(
        "v1_html",
        &normalized_id,
        started_at,
        &state.tracking_source,
        false,
        result.is_ok(),
    );

    result
        .map(|payload| envelope(TRACK_HTML_SCHEMA_VERSION, response_request_id, payload))
        .map_err(|error| map_tracking_error_v1(error, TRACK_HTML_SCHEMA_VERSION, request_id))
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
        &state.tracking_source,
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
        &state.tracking_source,
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
        &state.tracking_source,
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
        &state.tracking_source,
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

    if try_run_external_api_batch_job(&state, &job_id, &shipment_ids, force_refresh).await {
        return;
    }

    let mut queue = VecDeque::from(shipment_ids);
    let mut tasks = JoinSet::new();

    loop {
        while tasks.len() < MAX_CONCURRENT_BATCH_TRACK_LOOKUPS && !queue.is_empty() {
            if state.job_registry.is_cancel_requested(&job_id) {
                break;
            }

            let Some(shipment_id) = queue.pop_front() else {
                break;
            };
            let state_for_lookup = state.clone();
            tasks.spawn(async move {
                let result = resolve_tracking_request_cached(
                    &state_for_lookup.lookup_cache,
                    &state_for_lookup.client,
                    &state_for_lookup.tracking_source,
                    shipment_id.trim(),
                    LookupRequestOptions { force_refresh },
                )
                .await;
                (shipment_id, result)
            });
        }

        if state.job_registry.is_cancel_requested(&job_id) {
            while let Some(shipment_id) = queue.pop_front() {
                state.job_registry.push_cancelled(&job_id, shipment_id);
            }
        }

        if tasks.is_empty() {
            break;
        }

        match tasks.join_next().await {
            Some(Ok((shipment_id, Ok(payload)))) => {
                state
                    .job_registry
                    .push_success(&job_id, shipment_id, payload);
            }
            Some(Ok((shipment_id, Err(error)))) => {
                state
                    .job_registry
                    .push_error(&job_id, shipment_id, tracking_error_message(error));
            }
            Some(Err(error)) => {
                tasks.abort_all();
                state
                    .job_registry
                    .fail(&job_id, format!("Batch worker failed: {error}"));
                return;
            }
            None => break,
        }
    }

    state.job_registry.finish(&job_id);
}

async fn try_run_external_api_batch_job(
    state: &HttpApiState,
    job_id: &str,
    shipment_ids: &[String],
    force_refresh: bool,
) -> bool {
    if state.tracking_source.tracking_source != TrackingSource::ExternalApi {
        return false;
    }

    match run_external_api_batch_job(state, job_id, shipment_ids, force_refresh).await {
        Ok(ExternalBatchOutcome::Completed) => true,
        Ok(ExternalBatchOutcome::Unsupported) => false,
        Err(error) => {
            state.job_registry.fail(job_id, error);
            true
        }
    }
}

enum ExternalBatchOutcome {
    Completed,
    Unsupported,
}

async fn run_external_api_batch_job(
    state: &HttpApiState,
    job_id: &str,
    shipment_ids: &[String],
    force_refresh: bool,
) -> Result<ExternalBatchOutcome, String> {
    let source_config = &state.tracking_source;
    let Some(auth_token) = external_api_auth_token(source_config) else {
        return Err("External API token is required.".into());
    };
    let base_url = parse_external_api_base_url(
        &source_config.external_api_base_url,
        source_config.allow_insecure_external_api_http,
    )
    .map_err(tracking_error_message)?;

    let start_endpoint = base_url
        .join("v1/jobs/track-batch")
        .map_err(|error| format!("External API batch endpoint is invalid: {error}"))?;
    let start_response = external_api_request(state.client.post(start_endpoint), auth_token)
        .header("content-type", "application/json")
        .body(
            serde_json::to_string(&BatchTrackRequest {
                shipment_ids: shipment_ids.to_vec(),
                force_refresh: Some(force_refresh),
            })
            .map_err(|error| format!("Unable to serialize External API batch request: {error}"))?,
        )
        .send()
        .await
        .map_err(|error| format!("External API batch request failed: {error}"))?;

    if start_response.status() == ReqwestStatusCode::NOT_FOUND {
        return Ok(ExternalBatchOutcome::Unsupported);
    }

    if !start_response.status().is_success() {
        return Err(format!(
            "External API batch request returned HTTP {}: {}",
            start_response.status(),
            start_response.text().await.unwrap_or_default()
        ));
    }

    let start_body = start_response
        .text()
        .await
        .map_err(|error| format!("External API batch start response could not be read: {error}"))?;
    let start = serde_json::from_str::<RemoteApiEnvelope<BatchTrackJobStart>>(&start_body)
        .map_err(|error| format!("External API batch start response is invalid: {error}"))?
        .data;
    let status_url = external_api_relative_url(&base_url, &start.status_endpoint)?;
    let result_url = external_api_relative_url(&base_url, &start.result_endpoint)?;
    let mut poll_count = 0_u16;

    loop {
        if state.job_registry.is_cancel_requested(job_id) {
            let cancel_url =
                external_api_relative_url(&base_url, &format!("/v1/jobs/{}/cancel", start.job_id))?;
            let _ = external_api_request(state.client.post(cancel_url), auth_token)
                .send()
                .await;
        }

        let status_response =
            external_api_request(state.client.get(status_url.clone()), auth_token)
                .send()
                .await
                .map_err(|error| format!("External API batch status request failed: {error}"))?;

        if !status_response.status().is_success() {
            return Err(format!(
                "External API batch status returned HTTP {}: {}",
                status_response.status(),
                status_response.text().await.unwrap_or_default()
            ));
        }

        let status_body = status_response.text().await.map_err(|error| {
            format!("External API batch status response could not be read: {error}")
        })?;
        let status =
            serde_json::from_str::<RemoteApiEnvelope<crate::jobs::BatchJobSnapshot>>(&status_body)
                .map_err(|error| format!("External API batch status response is invalid: {error}"))?
                .data;

        if matches!(
            status.status,
            BatchJobStatus::Completed | BatchJobStatus::Cancelled | BatchJobStatus::Failed
        ) {
            let result_response = external_api_request(state.client.get(result_url), auth_token)
                .send()
                .await
                .map_err(|error| format!("External API batch result request failed: {error}"))?;

            if !result_response.status().is_success() {
                return Err(format!(
                    "External API batch result returned HTTP {}: {}",
                    result_response.status(),
                    result_response.text().await.unwrap_or_default()
                ));
            }

            let result_body = result_response.text().await.map_err(|error| {
                format!("External API batch result response could not be read: {error}")
            })?;
            let result =
                serde_json::from_str::<RemoteApiEnvelope<BatchJobResultSnapshot>>(&result_body)
                    .map_err(|error| {
                        format!("External API batch result response is invalid: {error}")
                    })?
                    .data;

            mirror_external_batch_results(state, job_id, shipment_ids, result);
            return Ok(ExternalBatchOutcome::Completed);
        }

        poll_count = poll_count.saturating_add(1);
        if poll_count >= 600 {
            return Err("External API batch job timed out.".into());
        }

        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn mirror_external_batch_results(
    state: &HttpApiState,
    job_id: &str,
    requested_ids: &[String],
    result: BatchJobResultSnapshot,
) {
    let mut completed_ids = Vec::with_capacity(result.results.len());
    for item in result.results {
        completed_ids.push(item.id.clone());
        match item.status {
            BatchJobItemStatus::Success => {
                if let Some(data) = item.data {
                    state.job_registry.push_success(job_id, item.id, data);
                } else {
                    state.job_registry.push_error(
                        job_id,
                        item.id,
                        "External API returned an empty result.".into(),
                    );
                }
            }
            BatchJobItemStatus::Error => {
                state.job_registry.push_error(
                    job_id,
                    item.id,
                    item.error
                        .unwrap_or_else(|| "External API batch item failed.".into()),
                );
            }
            BatchJobItemStatus::Cancelled => {
                state.job_registry.push_cancelled(job_id, item.id);
            }
        }
    }

    for shipment_id in requested_ids {
        if !completed_ids
            .iter()
            .any(|completed_id| completed_id == shipment_id)
        {
            state.job_registry.push_error(
                job_id,
                shipment_id.clone(),
                "External API did not return this ID.".into(),
            );
        }
    }

    state.job_registry.finish(job_id);
}

fn external_api_auth_token(source_config: &TrackingSourceConfig) -> Option<&str> {
    let token = source_config.external_api_auth_token.trim();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

fn external_api_request(request: RequestBuilder, api_token: &str) -> RequestBuilder {
    request
        .bearer_auth(api_token)
        .header("x-api-token", api_token)
}

fn external_api_relative_url(base_url: &Url, endpoint: &str) -> Result<Url, String> {
    base_url
        .join(endpoint.trim_start_matches('/'))
        .map_err(|error| format!("External API batch URL is invalid: {error}"))
}

fn log_service_tracking_timing(
    route: &str,
    shipment_id: &str,
    started_at: Instant,
    tracking_source: &TrackingSourceConfig,
    force_refresh: bool,
    is_success: bool,
) {
    eprintln!(
        "[ShipFlowPerf] service_tracking route={} id={} source={} forceRefresh={} durationMs={} result={}",
        route,
        shipment_id,
        tracking_source_label(tracking_source),
        force_refresh,
        started_at.elapsed().as_millis(),
        if is_success { "ok" } else { "error" }
    );
}

fn tracking_source_label(tracking_source: &TrackingSourceConfig) -> &'static str {
    match tracking_source.tracking_source {
        TrackingSource::Default => "internal",
        TrackingSource::ExternalApi => "external_api",
    }
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
    use shipflow_core::model::{TrackingSource, TrackingSourceConfig};
    use tower::ServiceExt;

    use super::{
        authorize_request, build_router, external_api_request, read_lookup_request_options,
        HttpApiState,
    };
    use crate::{
        jobs::BatchJobRegistry, lookup_cache::LookupCacheState, model::ServiceRuntimeMode,
        FORCE_REFRESH_HEADER_NAME,
    };

    #[test]
    fn external_api_batch_requests_include_bearer_and_x_api_token_headers() {
        let request = external_api_request(
            reqwest::Client::new().get("https://shipflow.example.test/v1/status"),
            "sf_external_token",
        )
        .build()
        .expect("request should build");

        assert_eq!(
            request
                .headers()
                .get(AUTHORIZATION)
                .and_then(|value| value.to_str().ok()),
            Some("Bearer sf_external_token")
        );
        assert_eq!(
            request
                .headers()
                .get("x-api-token")
                .and_then(|value| value.to_str().ok()),
            Some("sf_external_token")
        );
    }

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

    #[tokio::test]
    async fn capabilities_include_tracking_html_route() {
        let router = build_router(test_state());
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/v1/capabilities")
                    .header(AUTHORIZATION, "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let routes = payload["data"]["routes"]
            .as_array()
            .expect("capability routes should be an array");

        assert!(routes
            .iter()
            .any(|route| route == "GET /v1/track/:shipment_id/html"));
    }

    #[tokio::test]
    async fn tracking_html_route_rejects_external_api_source() {
        let router = build_router(external_api_test_state());
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/v1/track/P2603310114291/html")
                    .header(AUTHORIZATION, "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();

        assert_eq!(
            payload["meta"]["schemaVersion"],
            "shipflow.tracking.html.v1"
        );
        assert!(payload["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("default POS scraper")));
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

    fn external_api_test_state() -> HttpApiState {
        HttpApiState {
            tracking_source: TrackingSourceConfig {
                tracking_source: TrackingSource::ExternalApi,
                external_api_base_url: "https://scrappid3.example.test".into(),
                external_api_auth_token: "sf_token".into(),
                allow_insecure_external_api_http: false,
            },
            ..test_state()
        }
    }
}
