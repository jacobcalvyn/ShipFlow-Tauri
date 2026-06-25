use axum::{
    extract::{Path, State},
    http::{header::AUTHORIZATION, HeaderMap, StatusCode},
    routing::get,
    Json, Router,
};
use reqwest::Client;
#[cfg(test)]
use reqwest::RequestBuilder;
use serde::Serialize;
use serde_json::Value;
use shipflow_core::{
    model::{
        BagResponse, ManifestResponse, TrackResponse, TrackingError, TrackingHtmlResponse,
        TrackingSource, TrackingSourceConfig,
    },
    upstream::resolve_tracking_html_request,
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::api_contract::{
    envelope, error_response_v1, generate_request_id, REQUEST_ID_HEADER_NAME,
};
use crate::contact_cache::ContactCacheState;
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
const SERVICE_UPSTREAM_CONNECT_TIMEOUT_SECS: u64 = 10;
const SERVICE_UPSTREAM_READ_TIMEOUT_SECS: u64 = 60;
const SERVICE_UPSTREAM_REQUEST_TIMEOUT_SECS: u64 = 90;
const MAX_CONCURRENT_UPSTREAM_LOOKUPS: usize = 15;

#[derive(Clone)]
pub struct HttpApiState {
    pub client: Client,
    pub auth_token: String,
    pub mode: ServiceRuntimeMode,
    pub bind_address: String,
    pub port: u16,
    pub tracking_source: shipflow_core::model::TrackingSourceConfig,
    pub lookup_cache: LookupCacheState,
    pub contact_cache: ContactCacheState,
    pub upstream_lookup_limiter: Arc<Semaphore>,
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
        contact_cache: ContactCacheState::default(),
        upstream_lookup_limiter: Arc::new(Semaphore::new(MAX_CONCURRENT_UPSTREAM_LOOKUPS)),
    };
    let router = build_router(app_state);

    axum::serve(listener, router)
        .await
        .map_err(|error| format!("API service stopped unexpectedly: {error}"))
}

fn build_router(app_state: HttpApiState) -> Router {
    Router::new()
        .route("/v1/status", get(v1_status_handler))
        .route("/v1/openapi.json", get(v1_openapi_handler))
        .route("/v1/capabilities", get(v1_capabilities_handler))
        .route("/v1/track/:shipment_id/html", get(v1_tracking_html_handler))
        .route("/v1/track/:shipment_id", get(v1_track_handler))
        .route("/v1/bag/:bag_id", get(v1_bag_handler))
        .route("/v1/manifest/:manifest_id", get(v1_manifest_handler))
        .with_state(app_state)
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
    let _upstream_lookup_permit = acquire_upstream_lookup_permit(
        &state,
        TRACK_SCHEMA_VERSION,
        &request_id,
        "v1",
        &normalized_id,
    )
    .await?;

    let result = resolve_tracking_request_cached(
        &state.lookup_cache,
        &state.contact_cache,
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
    let _upstream_lookup_permit = acquire_upstream_lookup_permit(
        &state,
        TRACK_HTML_SCHEMA_VERSION,
        &request_id,
        "v1_html",
        &normalized_id,
    )
    .await?;

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
    let normalized_id = bag_id.trim().to_string();
    let _upstream_lookup_permit = acquire_upstream_lookup_permit(
        &state,
        BAG_SCHEMA_VERSION,
        &request_id,
        "v1_bag",
        &normalized_id,
    )
    .await?;

    resolve_bag_request_cached(
        &state.lookup_cache,
        &state.client,
        &state.tracking_source,
        &normalized_id,
        request_options,
    )
    .await
    .map(|payload| envelope(BAG_SCHEMA_VERSION, response_request_id, payload))
    .map_err(|error| map_tracking_error_v1(error, BAG_SCHEMA_VERSION, request_id))
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
    let normalized_id = manifest_id.trim().to_string();
    let _upstream_lookup_permit = acquire_upstream_lookup_permit(
        &state,
        MANIFEST_SCHEMA_VERSION,
        &request_id,
        "v1_manifest",
        &normalized_id,
    )
    .await?;

    resolve_manifest_request_cached(
        &state.lookup_cache,
        &state.client,
        &state.tracking_source,
        &normalized_id,
        request_options,
    )
    .await
    .map(|payload| envelope(MANIFEST_SCHEMA_VERSION, response_request_id, payload))
    .map_err(|error| map_tracking_error_v1(error, MANIFEST_SCHEMA_VERSION, request_id))
}

#[cfg(test)]
fn external_api_request(request: RequestBuilder, api_token: &str) -> RequestBuilder {
    request
        .bearer_auth(api_token)
        .header("x-api-token", api_token)
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

async fn acquire_upstream_lookup_permit(
    state: &HttpApiState,
    schema_version: &'static str,
    request_id: &str,
    route: &str,
    lookup_id: &str,
) -> Result<OwnedSemaphorePermit, (StatusCode, Json<crate::api_contract::ApiErrorEnvelope>)> {
    let queued_for_permit = state.upstream_lookup_limiter.available_permits() == 0;
    let permit_started_at = Instant::now();
    let permit = state
        .upstream_lookup_limiter
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| {
            error_response_v1(
                StatusCode::SERVICE_UNAVAILABLE,
                schema_version,
                request_id.to_owned(),
                "Upstream lookup limiter is unavailable.",
            )
        })?;
    let permit_wait_ms = permit_started_at.elapsed().as_millis();
    if queued_for_permit || permit_wait_ms > 0 {
        eprintln!(
            "[ShipFlowBackpressure] service_upstream_lookup_permit route={} id={} requestId={} queued={} waitMs={} limit={}",
            route,
            lookup_id,
            request_id,
            queued_for_permit,
            permit_wait_ms,
            MAX_CONCURRENT_UPSTREAM_LOOKUPS
        );
    }

    Ok(permit)
}

fn tracking_source_label(tracking_source: &TrackingSourceConfig) -> &'static str {
    match tracking_source.tracking_source {
        TrackingSource::Default => "internal",
        TrackingSource::ExternalApi => "external_api",
    }
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

#[cfg(test)]
mod tests {
    use axum::{
        body::{to_bytes, Body},
        http::{header::AUTHORIZATION, HeaderMap, Request, StatusCode},
    };
    use shipflow_core::model::{TrackingSource, TrackingSourceConfig};
    use tower::ServiceExt;

    use super::{
        authorize_request_message, build_router, external_api_request, read_lookup_request_options,
        HttpApiState, MAX_CONCURRENT_UPSTREAM_LOOKUPS,
    };
    use std::sync::Arc;
    use tokio::sync::Semaphore;
    use tokio::time::{timeout, Duration};

    use crate::{
        contact_cache::ContactCacheState, lookup_cache::LookupCacheState,
        model::ServiceRuntimeMode, FORCE_REFRESH_HEADER_NAME,
    };

    #[test]
    fn external_api_requests_include_bearer_and_x_api_token_headers() {
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
        let result = authorize_request_message(&HeaderMap::new(), "secret-token");

        assert!(result.is_err());
    }

    #[test]
    fn accepts_valid_bearer_token() {
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, "Bearer secret-token".parse().unwrap());

        let result = authorize_request_message(&headers, "secret-token");

        assert!(result.is_ok());
    }

    #[test]
    fn rejects_wrong_bearer_token() {
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, "Bearer other-token".parse().unwrap());

        let result = authorize_request_message(&headers, "secret-token");

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn unsupported_routes_are_not_served() {
        let router = build_router(test_state());

        for uri in [
            "/health",
            "/status",
            "/track/P2603310114291",
            "/bag/PID1",
            "/manifest/MAN1",
            "/v1/jobs/track-batch",
            "/v1/jobs/job_123",
            "/v1/jobs/job_123/result",
            "/v1/jobs/job_123/cancel",
        ] {
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(uri)
                        .header(AUTHORIZATION, "Bearer secret-token")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();

            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{uri}");
        }
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
        assert!(!routes.iter().any(|route| route
            .as_str()
            .is_some_and(|route| route.contains("/v1/jobs"))));
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

    #[tokio::test]
    async fn upstream_lookup_routes_wait_for_shared_limiter() {
        for uri in [
            "/v1/track/P2603310114291/html",
            "/v1/bag/PID1",
            "/v1/manifest/MAN1",
        ] {
            let limiter = Arc::new(Semaphore::new(1));
            let held_permit = limiter
                .clone()
                .acquire_owned()
                .await
                .expect("test permit should acquire");
            let router = build_router(external_api_test_state_with_limiter(limiter, "not-a-url"));

            let response = timeout(
                Duration::from_millis(50),
                router.oneshot(
                    Request::builder()
                        .uri(uri)
                        .header(AUTHORIZATION, "Bearer secret-token")
                        .body(Body::empty())
                        .unwrap(),
                ),
            )
            .await;

            assert!(
                response.is_err(),
                "{uri} should wait for upstream lookup permit"
            );
            drop(held_permit);
        }
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
            contact_cache: ContactCacheState::default(),
            upstream_lookup_limiter: Arc::new(Semaphore::new(MAX_CONCURRENT_UPSTREAM_LOOKUPS)),
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

    fn external_api_test_state_with_limiter(
        limiter: Arc<Semaphore>,
        external_api_base_url: &str,
    ) -> HttpApiState {
        HttpApiState {
            tracking_source: TrackingSourceConfig {
                tracking_source: TrackingSource::ExternalApi,
                external_api_base_url: external_api_base_url.into(),
                external_api_auth_token: "sf_token".into(),
                allow_insecure_external_api_http: true,
            },
            upstream_lookup_limiter: limiter,
            ..test_state()
        }
    }
}
