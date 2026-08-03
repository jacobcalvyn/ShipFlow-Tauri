use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Path, State},
    http::{header::AUTHORIZATION, HeaderMap, HeaderValue, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
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
        BagResponse, BagRoute, ManifestResponse, TrackResponse, TrackingError,
        TrackingHtmlResponse, TrackingSource, TrackingSourceConfig,
    },
    upstream::{parse_external_api_base_url, resolve_tracking_html_request, scrape_pos_bag_route},
};
use std::{
    collections::{HashSet, VecDeque},
    future::Future,
    net::{IpAddr, SocketAddr},
    time::{Duration, Instant},
};
use tokio::{
    sync::watch,
    task::JoinSet,
    time::{timeout, MissedTickBehavior},
};

use crate::api_contract::{
    envelope, error_response_v1, generate_request_id, REQUEST_ID_HEADER_NAME,
};
use crate::bag_route_cache::{BagRouteCacheSnapshot, BagRouteCacheState, BagRouteFetchAction};
use crate::contact_cache::{ContactCacheSnapshot, ContactCacheState};
use crate::diagnostics::process_rss_bytes;
use crate::lookup_cache::{
    resolve_bag_request_cached, resolve_manifest_request_cached, resolve_tracking_request_cached,
    LookupCacheSnapshot, LookupCacheState, LookupRequestOptions, TrackingPermitProviders,
};
use crate::model::{
    validate_service_runtime_config, ServiceRuntimeConfig, ServiceRuntimeMode,
    SERVICE_STATUS_PRODUCT,
};
use crate::openapi::service_openapi_document;
use crate::persistent_store::PersistentLookupStore;
use crate::upstream_backpressure::{
    UpstreamBackpressure, UpstreamBackpressureError, UpstreamBackpressureSnapshot,
};
use crate::FORCE_REFRESH_HEADER_NAME;

const STATUS_SCHEMA_VERSION: &str = "shipflow.service.status.v1";
const AUTH_CHECK_SCHEMA_VERSION: &str = "shipflow.service.auth_check.v1";
const CAPABILITIES_SCHEMA_VERSION: &str = "shipflow.service.capabilities.v1";
const TRACK_SCHEMA_VERSION: &str = "shipflow.tracking.detail.v1";
const TRACK_HTML_SCHEMA_VERSION: &str = "shipflow.tracking.html.v1";
const BAG_SCHEMA_VERSION: &str = "shipflow.tracking.bag.v1";
const MANIFEST_SCHEMA_VERSION: &str = "shipflow.tracking.manifest.v1";
const SERVICE_UPSTREAM_CONNECT_TIMEOUT_SECS: u64 = 10;
const SERVICE_UPSTREAM_READ_TIMEOUT_SECS: u64 = 60;
const SERVICE_UPSTREAM_REQUEST_TIMEOUT_SECS: u64 = 90;
pub const SERVICE_LOOKUP_DEADLINE_SECS: u64 = 120;
const SERVICE_MAINTENANCE_INTERVAL_SECS: u64 = 60;
const SERVICE_MEMORY_WARNING_BYTES: u64 = 512 * 1024 * 1024;
const SERVICE_HTTP_BODY_LIMIT_BYTES: usize = 64 * 1024;
const DIAGNOSTICS_SCHEMA_VERSION: &str = "shipflow.service.diagnostics.v1";
const MAX_REQUEST_ID_BYTES: usize = 128;
const BAG_ROUTE_LOOKUP_TIMEOUT_SECS: u64 = 20;
const BAG_ROUTE_ENRICHMENT_BUDGET_SECS: u64 = 20;
const MAX_CONCURRENT_BAG_ROUTE_ENRICHMENTS_PER_TRACK: usize = 4;
const SERVICE_HTTP_HANDLER_DEADLINE_SECS: u64 =
    SERVICE_LOOKUP_DEADLINE_SECS + BAG_ROUTE_ENRICHMENT_BUDGET_SECS + 10;

#[derive(Clone)]
pub struct HttpApiState {
    pub client: Client,
    pub auth_token: String,
    pub internal_auth_token: String,
    pub mode: ServiceRuntimeMode,
    pub bind_address: String,
    pub port: u16,
    pub tracking_source: shipflow_core::model::TrackingSourceConfig,
    pub lookup_cache: LookupCacheState,
    pub contact_cache: ContactCacheState,
    pub bag_route_cache: BagRouteCacheState,
    pub public_upstream_backpressure: UpstreamBackpressure,
    pub upstream_backpressure: UpstreamBackpressure,
    pub contact_backpressure: UpstreamBackpressure,
    pub http_ingress_backpressure: UpstreamBackpressure,
    pub shutdown_signal: ShutdownSignal,
    pub started_at: Instant,
}

#[derive(Clone, Debug)]
pub struct ShutdownSignal {
    sender: watch::Sender<bool>,
}

impl Default for ShutdownSignal {
    fn default() -> Self {
        Self::new()
    }
}

impl ShutdownSignal {
    pub fn new() -> Self {
        let (sender, _) = watch::channel(false);
        Self { sender }
    }

    pub fn cancel(&self) {
        self.sender.send_replace(true);
    }

    pub async fn cancelled(&self) {
        let mut receiver = self.sender.subscribe();
        if *receiver.borrow() {
            return;
        }
        while receiver.changed().await.is_ok() {
            if *receiver.borrow() {
                return;
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LookupTrafficClass {
    Public,
    Internal,
}

struct LookupPermitSet {
    _public: Option<tokio::sync::OwnedSemaphorePermit>,
    _global: tokio::sync::OwnedSemaphorePermit,
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
struct AuthCheckResponse {
    product: &'static str,
    auth: &'static str,
    status: &'static str,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsResponse {
    product: &'static str,
    uptime_seconds: u64,
    restart_count: u32,
    rss_bytes: Option<u64>,
    lookup_deadline_seconds: u64,
    lookup_cache: CacheDiagnostics,
    contact_cache: ContactCacheDiagnostics,
    bag_route_cache: BagRouteCacheDiagnostics,
    backpressure: BackpressureDiagnostics,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheDiagnostics {
    ready: usize,
    loading: usize,
    capacity: usize,
    bytes: usize,
    byte_capacity: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContactCacheDiagnostics {
    entries: usize,
    in_flight: usize,
    capacity: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BagRouteCacheDiagnostics {
    entries: usize,
    in_flight: usize,
    capacity: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackpressureDiagnostics {
    ingress: BackpressureLaneDiagnostics,
    public: BackpressureLaneDiagnostics,
    global: BackpressureLaneDiagnostics,
    contact: BackpressureLaneDiagnostics,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackpressureLaneDiagnostics {
    active: usize,
    available: usize,
    queued: usize,
    max_concurrent: usize,
    max_queued: usize,
}

fn is_forbidden_external_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let [first, second, ..] = address.octets();
            first == 0 || first == 127 || (first == 169 && second == 254) || first >= 224
        }
        IpAddr::V6(address) => {
            if let Some(mapped) = address.to_ipv4_mapped() {
                return is_forbidden_external_address(IpAddr::V4(mapped));
            }
            address.is_unspecified()
                || address.is_loopback()
                || address.is_unicast_link_local()
                || address.is_multicast()
        }
    }
}

fn is_private_external_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let [first, second, ..] = address.octets();
            first == 10
                || (first == 100 && (64..=127).contains(&second))
                || (first == 172 && (16..=31).contains(&second))
                || (first == 192 && second == 168)
                || (first == 198 && (second == 18 || second == 19))
        }
        IpAddr::V6(address) => {
            if let Some(mapped) = address.to_ipv4_mapped() {
                return is_private_external_address(IpAddr::V4(mapped));
            }
            let first_segment = address.segments()[0];
            first_segment & 0xfe00 == 0xfc00
        }
    }
}

async fn resolve_external_api_addresses(
    tracking_source: &TrackingSourceConfig,
) -> Result<Option<(String, Vec<SocketAddr>)>, String> {
    if tracking_source.tracking_source != TrackingSource::ExternalApi {
        return Ok(None);
    }

    let parsed = parse_external_api_base_url(
        &tracking_source.external_api_base_url,
        tracking_source.allow_insecure_external_api_http,
    )
    .map_err(|error| {
        let message = match error {
            TrackingError::BadRequest(message)
            | TrackingError::NotFound(message)
            | TrackingError::RateLimited(message)
            | TrackingError::ServiceUnavailable(message)
            | TrackingError::Upstream(message) => message,
        };
        format!("External API configuration is invalid: {message}")
    })?;
    let hostname = parsed
        .host_str()
        .ok_or_else(|| "External API URL must include a hostname.".to_string())?
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if hostname == "localhost"
        || hostname.ends_with(".localhost")
        || hostname == "metadata.google.internal"
        || hostname == "metadata.google"
    {
        return Err("External API destination is reserved and cannot be used.".into());
    }

    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "External API URL must include a valid port.".to_string())?;
    let resolved = if let Ok(address) = hostname.parse::<IpAddr>() {
        vec![SocketAddr::new(address, port)]
    } else {
        tokio::net::lookup_host((hostname.as_str(), port))
            .await
            .map_err(|error| format!("Unable to resolve External API hostname: {error}"))?
            .collect::<Vec<_>>()
    };
    let mut unique = HashSet::new();
    let addresses = resolved
        .into_iter()
        .filter(|address| unique.insert(*address))
        .collect::<Vec<_>>();
    if addresses.is_empty() {
        return Err("External API hostname did not resolve to an address.".into());
    }
    if addresses
        .iter()
        .any(|address| is_forbidden_external_address(address.ip()))
    {
        return Err("External API destination is reserved and cannot be used.".into());
    }
    if !tracking_source.allow_insecure_external_api_http
        && addresses
            .iter()
            .any(|address| is_private_external_address(address.ip()))
    {
        return Err(
            "External API resolves to a private address. Enable trusted LAN access only for an intentional private deployment."
                .into(),
        );
    }

    Ok(Some((hostname, addresses)))
}

async fn build_service_http_client(
    tracking_source: &TrackingSourceConfig,
) -> Result<Client, String> {
    let builder = Client::builder()
        .connect_timeout(Duration::from_secs(SERVICE_UPSTREAM_CONNECT_TIMEOUT_SECS))
        .read_timeout(Duration::from_secs(SERVICE_UPSTREAM_READ_TIMEOUT_SECS))
        .timeout(Duration::from_secs(SERVICE_UPSTREAM_REQUEST_TIMEOUT_SECS))
        .user_agent("ShipFlow Service/0.1");
    let mut builder = apply_tracking_source_redirect_policy(builder, tracking_source);
    if let Some((hostname, addresses)) = resolve_external_api_addresses(tracking_source).await? {
        builder = builder.resolve_to_addrs(&hostname, &addresses);
    }
    builder
        .build()
        .map_err(|error| format!("Unable to create service HTTP client: {error}"))
}

fn apply_tracking_source_redirect_policy(
    builder: reqwest::ClientBuilder,
    tracking_source: &TrackingSourceConfig,
) -> reqwest::ClientBuilder {
    if !tracking_source_redirects_allowed(tracking_source) {
        builder.redirect(reqwest::redirect::Policy::none())
    } else {
        builder
    }
}

fn tracking_source_redirects_allowed(tracking_source: &TrackingSourceConfig) -> bool {
    tracking_source.tracking_source != TrackingSource::ExternalApi
}

pub async fn run_service_process(config: ServiceRuntimeConfig) -> Result<(), String> {
    let bind_address = config.mode.bind_address_label().to_string();
    validate_service_runtime_config(&config)?;

    let tracking_source = config.tracking_source.clone();
    let client = build_service_http_client(&tracking_source).await?;
    let socket_addr = std::net::SocketAddr::new(config.mode.bind_address(), config.port);
    let listener = tokio::net::TcpListener::bind(socket_addr)
        .await
        .map_err(|error| {
            format!(
                "Unable to start API service on {}:{}: {error}",
                bind_address, config.port
            )
        })?;

    let shutdown_signal = ShutdownSignal::new();
    let lookup_cache = match PersistentLookupStore::try_open_default() {
        Ok(store) => LookupCacheState::default().with_persistent_store(store),
        Err(error) => {
            shipflow_core::shipflow_log!(
                "[ShipFlowLifecycle] persistent_lookup_disabled error={error}"
            );
            LookupCacheState::default()
        }
    };
    let app_state = HttpApiState {
        client,
        auth_token: config.auth_token.clone(),
        internal_auth_token: config.internal_auth_token.clone(),
        mode: config.mode,
        bind_address,
        port: config.port,
        tracking_source,
        lookup_cache,
        contact_cache: ContactCacheState::default(),
        bag_route_cache: BagRouteCacheState::default(),
        public_upstream_backpressure: UpstreamBackpressure::public_default(),
        upstream_backpressure: UpstreamBackpressure::default(),
        contact_backpressure: UpstreamBackpressure::contact_default(),
        http_ingress_backpressure: UpstreamBackpressure::http_ingress_default(),
        shutdown_signal: shutdown_signal.clone(),
        started_at: Instant::now(),
    };
    shipflow_core::shipflow_log!(
        "[ShipFlowLifecycle] service_ready pid={} platform={} arch={} mode={:?} port={} trackingSource={} internalIpc={}",
        std::process::id(),
        std::env::consts::OS,
        std::env::consts::ARCH,
        app_state.mode,
        app_state.port,
        tracking_source_label(&app_state.tracking_source),
        config.internal_ipc_endpoint.is_some(),
    );
    let shutdown_lookup_cache = app_state.lookup_cache.clone();
    let router = build_router(app_state.clone());
    let maintenance_handle = tokio::spawn(run_service_maintenance(app_state.clone()));
    let http_shutdown_signal = shutdown_signal.clone();
    let os_shutdown_signal = shutdown_signal.clone();
    let os_signal_handle = tokio::spawn(async move {
        wait_for_os_shutdown_signal().await;
        shipflow_core::shipflow_log!("[ShipFlowLifecycle] operating_system_shutdown_received");
        os_shutdown_signal.cancel();
    });
    let http_server = async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                http_shutdown_signal.cancelled().await;
            })
            .await
            .map_err(|error| format!("API service stopped unexpectedly: {error}"))
    };

    let result = if let Some(endpoint) = config.internal_ipc_endpoint {
        match shipflow_ipc::LocalIpcListener::bind(&endpoint) {
            Ok(ipc_listener) => {
                let ipc_server =
                    crate::internal_ipc::run_internal_ipc_server(ipc_listener, app_state);
                tokio::try_join!(http_server, ipc_server).map(|_| ())
            }
            Err(error) => Err(format!("Unable to start internal IPC service: {error}")),
        }
    } else {
        http_server.await
    };
    shipflow_core::shipflow_log!(
        "[ShipFlowLifecycle] service_stopping pid={} result={}",
        std::process::id(),
        if result.is_ok() { "ok" } else { "error" },
    );
    maintenance_handle.abort();
    os_signal_handle.abort();
    tokio::task::spawn_blocking(move || shutdown_lookup_cache.flush_persistent_store())
        .await
        .map_err(|error| format!("Unable to flush persistent lookup cache: {error}"))?;
    shipflow_core::shipflow_log!(
        "[ShipFlowLifecycle] service_stopped pid={} result={}",
        std::process::id(),
        if result.is_ok() { "ok" } else { "error" },
    );
    result
}

async fn wait_for_os_shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};

        match signal(SignalKind::terminate()) {
            Ok(mut terminate) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = terminate.recv() => {}
                }
            }
            Err(error) => {
                shipflow_core::shipflow_log!(
                    "[ShipFlowLifecycle] sigterm_handler_unavailable error={error}"
                );
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }

    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

fn build_router(app_state: HttpApiState) -> Router {
    Router::new()
        .route("/v1/status", get(v1_status_handler))
        .route("/v1/auth/check", get(v1_auth_check_handler))
        .route("/v1/openapi.json", get(v1_openapi_handler))
        .route("/v1/capabilities", get(v1_capabilities_handler))
        .route("/v1/diagnostics", get(v1_diagnostics_handler))
        .route("/v1/track/:shipment_id/html", get(v1_tracking_html_handler))
        .route("/v1/track/:shipment_id", get(v1_track_handler))
        .route("/v1/bag/:bag_id", get(v1_bag_handler))
        .route("/v1/manifest/:manifest_id", get(v1_manifest_handler))
        .layer(DefaultBodyLimit::max(SERVICE_HTTP_BODY_LIMIT_BYTES))
        .layer(middleware::from_fn_with_state(
            app_state.clone(),
            http_ingress_guard,
        ))
        .with_state(app_state)
}

async fn http_ingress_guard(
    State(state): State<HttpApiState>,
    mut request: Request<Body>,
    next: Next,
) -> Response {
    let started_at = Instant::now();
    let method = request.method().as_str().to_string();
    let route = normalize_http_audit_route(request.uri().path());
    let request_id = authorize_request_id(request.headers());
    request.headers_mut().insert(
        REQUEST_ID_HEADER_NAME,
        HeaderValue::from_str(&request_id).expect("normalized request id must be a header value"),
    );
    shipflow_core::shipflow_log!(
        "[ShipFlowHttp] request_started requestId={} method={} route={}",
        request_id,
        method,
        route,
    );
    let permit = match state
        .http_ingress_backpressure
        .acquire(route, "http", &request_id)
        .await
    {
        Ok(permit) => permit,
        Err(error) => {
            let mut response = map_tracking_error_v1(
                tracking_error_from_upstream_backpressure(error),
                STATUS_SCHEMA_VERSION,
                request_id.clone(),
            )
            .into_response();
            attach_request_id_header(&mut response, &request_id);
            shipflow_core::shipflow_log!(
                "[ShipFlowHttp] request_completed requestId={} method={} route={} status={} durationMs={}",
                request_id,
                method,
                route,
                response.status().as_u16(),
                started_at.elapsed().as_millis(),
            );
            return response;
        }
    };

    let mut response = match timeout(
        Duration::from_secs(SERVICE_HTTP_HANDLER_DEADLINE_SECS),
        next.run(request),
    )
    .await
    {
        Ok(response) => response,
        Err(_) => error_response_v1(
            StatusCode::GATEWAY_TIMEOUT,
            STATUS_SCHEMA_VERSION,
            request_id.clone(),
            "The ShipFlow Service request exceeded its execution deadline.",
        )
        .into_response(),
    };
    attach_request_id_header(&mut response, &request_id);
    drop(permit);
    shipflow_core::shipflow_log!(
        "[ShipFlowHttp] request_completed requestId={} method={} route={} status={} durationMs={}",
        request_id,
        method,
        route,
        response.status().as_u16(),
        started_at.elapsed().as_millis(),
    );
    response
}

fn normalize_http_audit_route(path: &str) -> &'static str {
    if path.starts_with("/v1/track/") && path.ends_with("/html") {
        "/v1/track/:shipment_id/html"
    } else if path.starts_with("/v1/track/") {
        "/v1/track/:shipment_id"
    } else if path.starts_with("/v1/bag/") {
        "/v1/bag/:bag_id"
    } else if path.starts_with("/v1/manifest/") {
        "/v1/manifest/:manifest_id"
    } else {
        match path {
            "/v1/status" => "/v1/status",
            "/v1/auth/check" => "/v1/auth/check",
            "/v1/openapi.json" => "/v1/openapi.json",
            "/v1/capabilities" => "/v1/capabilities",
            "/v1/diagnostics" => "/v1/diagnostics",
            _ => "unmatched",
        }
    }
}

fn attach_request_id_header(response: &mut Response, request_id: &str) {
    response.headers_mut().insert(
        REQUEST_ID_HEADER_NAME,
        HeaderValue::from_str(request_id).expect("normalized request id must be a header value"),
    );
}

async fn run_service_maintenance(state: HttpApiState) {
    let mut interval =
        tokio::time::interval(Duration::from_secs(SERVICE_MAINTENANCE_INTERVAL_SECS));
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    interval.tick().await;
    loop {
        tokio::select! {
            _ = state.shutdown_signal.cancelled() => return,
            _ = interval.tick() => {
                let lookup_cache = state.lookup_cache.prune_expired_and_over_capacity();
                let contact_cache = state.contact_cache.snapshot_async().await;
                let bag_route_cache = state.bag_route_cache.snapshot_async().await;
                let public = state.public_upstream_backpressure.snapshot();
                let global = state.upstream_backpressure.snapshot();
                let contact = state.contact_backpressure.snapshot();
                let ingress = state.http_ingress_backpressure.snapshot();
                let rss_bytes = process_rss_bytes();
                shipflow_core::shipflow_log!(
                    "[ShipFlowDiagnostics] uptimeSec={} rssBytes={} cacheReady={} cacheLoading={} cacheBytes={} cacheByteCapacity={} contactEntries={} contactInFlight={} bagRouteEntries={} bagRouteInFlight={} ingressActive={} ingressQueued={} publicActive={} publicQueued={} globalActive={} globalQueued={} contactActive={} contactQueued={}",
                    state.started_at.elapsed().as_secs(),
                    rss_bytes.map_or_else(|| "unavailable".to_string(), |value| value.to_string()),
                    lookup_cache.ready,
                    lookup_cache.loading,
                    lookup_cache.bytes,
                    lookup_cache.byte_capacity,
                    contact_cache.entries,
                    contact_cache.in_flight,
                    bag_route_cache.entries,
                    bag_route_cache.in_flight,
                    ingress.active,
                    ingress.queued,
                    public.active,
                    public.queued,
                    global.active,
                    global.queued,
                    contact.active,
                    contact.queued,
                );
                if rss_bytes.is_some_and(|value| value >= SERVICE_MEMORY_WARNING_BYTES) {
                    shipflow_core::shipflow_log!(
                        "[ShipFlowDiagnostics] memory_warning rssBytes={} thresholdBytes={SERVICE_MEMORY_WARNING_BYTES}",
                        rss_bytes.unwrap_or_default()
                    );
                }
            }
        }
    }
}

async fn v1_status_handler(
    State(state): State<HttpApiState>,
    headers: HeaderMap,
) -> Result<
    Json<crate::api_contract::ApiEnvelope<StatusResponse>>,
    (StatusCode, Json<crate::api_contract::ApiErrorEnvelope>),
> {
    let request_id = authorize_request_id(&headers);
    Ok(envelope(
        STATUS_SCHEMA_VERSION,
        request_id,
        status_response(&state),
    ))
}

async fn v1_auth_check_handler(
    State(state): State<HttpApiState>,
    headers: HeaderMap,
) -> Result<
    Json<crate::api_contract::ApiEnvelope<AuthCheckResponse>>,
    (StatusCode, Json<crate::api_contract::ApiErrorEnvelope>),
> {
    let request_id = authorize_request_id(&headers);
    authorize_state_request(&headers, &state).map_err(|message| {
        error_response_v1(
            StatusCode::UNAUTHORIZED,
            AUTH_CHECK_SCHEMA_VERSION,
            request_id.clone(),
            &message,
        )
    })?;

    Ok(envelope(
        AUTH_CHECK_SCHEMA_VERSION,
        request_id,
        AuthCheckResponse {
            product: SERVICE_STATUS_PRODUCT,
            auth: "bearer",
            status: "ok",
        },
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
    authorize_state_request(&headers, &state).map_err(|message| {
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
                "GET /v1/auth/check",
                "GET /v1/capabilities",
                "GET /v1/diagnostics",
                "GET /v1/track/:shipment_id",
                "GET /v1/track/:shipment_id/html",
                "GET /v1/bag/:bag_id",
                "GET /v1/manifest/:manifest_id",
            ],
        },
    ))
}

async fn v1_diagnostics_handler(
    State(state): State<HttpApiState>,
    headers: HeaderMap,
) -> Result<
    Json<crate::api_contract::ApiEnvelope<DiagnosticsResponse>>,
    (StatusCode, Json<crate::api_contract::ApiErrorEnvelope>),
> {
    let request_id = authorize_request_id(&headers);
    authorize_state_request(&headers, &state).map_err(|message| {
        error_response_v1(
            StatusCode::UNAUTHORIZED,
            DIAGNOSTICS_SCHEMA_VERSION,
            request_id.clone(),
            &message,
        )
    })?;
    let lookup_cache = state.lookup_cache.snapshot();
    let contact_cache = state.contact_cache.snapshot_async().await;
    let bag_route_cache = state.bag_route_cache.snapshot_async().await;
    let public = state.public_upstream_backpressure.snapshot();
    let global = state.upstream_backpressure.snapshot();
    let contact = state.contact_backpressure.snapshot();
    let ingress = state.http_ingress_backpressure.snapshot();

    Ok(envelope(
        DIAGNOSTICS_SCHEMA_VERSION,
        request_id,
        DiagnosticsResponse {
            product: SERVICE_STATUS_PRODUCT,
            uptime_seconds: state.started_at.elapsed().as_secs(),
            restart_count: service_restart_count(),
            rss_bytes: process_rss_bytes(),
            lookup_deadline_seconds: SERVICE_LOOKUP_DEADLINE_SECS,
            lookup_cache: cache_diagnostics(lookup_cache),
            contact_cache: contact_cache_diagnostics(contact_cache),
            bag_route_cache: bag_route_cache_diagnostics(bag_route_cache),
            backpressure: BackpressureDiagnostics {
                ingress: backpressure_diagnostics(ingress),
                public: backpressure_diagnostics(public),
                global: backpressure_diagnostics(global),
                contact: backpressure_diagnostics(contact),
            },
        },
    ))
}

async fn v1_openapi_handler(
    State(state): State<HttpApiState>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<crate::api_contract::ApiErrorEnvelope>)> {
    let request_id = authorize_request_id(&headers);
    authorize_state_request(&headers, &state).map_err(|message| {
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
    let request_id = authorize_request_id(&headers);
    authorize_state_request(&headers, &state).map_err(|message| {
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
    let result = resolve_tracking_payload(
        &state,
        &normalized_id,
        request_options,
        "v1",
        &request_id,
        LookupTrafficClass::Public,
    )
    .await;

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
    authorize_state_request(&headers, &state).map_err(|message| {
        error_response_v1(
            StatusCode::UNAUTHORIZED,
            TRACK_HTML_SCHEMA_VERSION,
            request_id.clone(),
            &message,
        )
    })?;
    let response_request_id = request_id.clone();
    let normalized_id = shipment_id.trim().to_string();
    let result = with_lookup_deadline("v1_html", &normalized_id, async {
        let _upstream_lookup_permit = acquire_lookup_permits(
            state.public_upstream_backpressure.clone(),
            state.upstream_backpressure.clone(),
            LookupTrafficClass::Public,
            "v1_html",
            &normalized_id,
            &request_id,
        )
        .await?;
        resolve_tracking_html_request(&state.client, &state.tracking_source, &normalized_id).await
    })
    .await;
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
    authorize_state_request(&headers, &state).map_err(|message| {
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
    resolve_bag_payload(
        &state,
        &normalized_id,
        request_options,
        "v1_bag",
        &request_id,
        LookupTrafficClass::Public,
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
    authorize_state_request(&headers, &state).map_err(|message| {
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
    resolve_manifest_payload(
        &state,
        &normalized_id,
        request_options,
        "v1_manifest",
        &request_id,
        LookupTrafficClass::Public,
    )
    .await
    .map(|payload| envelope(MANIFEST_SCHEMA_VERSION, response_request_id, payload))
    .map_err(|error| map_tracking_error_v1(error, MANIFEST_SCHEMA_VERSION, request_id))
}

pub(crate) async fn resolve_tracking_payload(
    state: &HttpApiState,
    shipment_id: &str,
    request_options: LookupRequestOptions,
    route: &'static str,
    request_id: &str,
    traffic_class: LookupTrafficClass,
) -> Result<TrackResponse, TrackingError> {
    let started_at = Instant::now();
    let normalized_id = shipment_id.trim().to_string();
    let public_backpressure = state.public_upstream_backpressure.clone();
    let backpressure = state.upstream_backpressure.clone();
    let contact_backpressure = state.contact_backpressure.clone();
    let permit_request_id = request_id.to_string();
    let permit_lookup_id = normalized_id.clone();
    let contact_request_id = request_id.to_string();
    let contact_lookup_id = normalized_id.clone();
    let result = with_lookup_deadline(
        route,
        &normalized_id,
        resolve_tracking_request_cached(
            &state.lookup_cache,
            &state.contact_cache,
            &state.client,
            &state.tracking_source,
            &normalized_id,
            request_options,
            TrackingPermitProviders {
                primary: move || async move {
                    acquire_lookup_permits(
                        public_backpressure,
                        backpressure,
                        traffic_class,
                        route,
                        &permit_lookup_id,
                        &permit_request_id,
                    )
                    .await
                },
                contact: move || {
                    let backpressure = contact_backpressure.clone();
                    let request_id = contact_request_id.clone();
                    let lookup_id = contact_lookup_id.clone();
                    async move {
                        backpressure
                            .acquire("contact_enrichment", &lookup_id, &request_id)
                            .await
                            .map_err(tracking_error_from_upstream_backpressure)
                    }
                },
            },
        ),
    )
    .await;
    let result = match result {
        Ok(mut response) => {
            if timeout(
                Duration::from_secs(BAG_ROUTE_ENRICHMENT_BUDGET_SECS),
                enrich_tracking_bag_routes(state, &mut response, request_id),
            )
            .await
            .is_err()
            {
                shipflow_core::shipflow_log!(
                    "[ShipFlowBagRouteCache] enrichment_budget_exhausted id={} budgetSec={BAG_ROUTE_ENRICHMENT_BUDGET_SECS}",
                    normalized_id
                );
            }
            Ok(response)
        }
        Err(error) => Err(error),
    };
    log_service_tracking_timing(
        route,
        &normalized_id,
        started_at,
        &state.tracking_source,
        request_options.force_refresh,
        result.is_ok(),
    );
    result
}

async fn enrich_tracking_bag_routes(
    state: &HttpApiState,
    response: &mut TrackResponse,
    request_id: &str,
) {
    if state.tracking_source.tracking_source != TrackingSource::Default {
        return;
    }

    let mut seen = HashSet::new();
    let mut pending: VecDeque<String> = response
        .history_summary
        .bagging_unbagging
        .iter()
        .filter(|summary| summary.bagging.is_some())
        .filter_map(|summary| {
            let bag_id = summary.nomor_kantung.trim().to_ascii_uppercase();
            (!bag_id.is_empty() && seen.insert(bag_id.clone())).then_some(bag_id)
        })
        .collect();
    if pending.is_empty() {
        return;
    }

    let mut tasks = JoinSet::new();
    loop {
        while tasks.len() < MAX_CONCURRENT_BAG_ROUTE_ENRICHMENTS_PER_TRACK {
            let Some(bag_id) = pending.pop_front() else {
                break;
            };
            let task_state = state.clone();
            let task_request_id = request_id.to_string();
            tasks.spawn(async move {
                let route = resolve_cached_bag_route(&task_state, &bag_id, &task_request_id).await;
                (bag_id, route)
            });
        }

        let Some(joined) = tasks.join_next().await else {
            break;
        };
        match joined {
            Ok((_bag_id, Some(route))) => apply_bag_route(response, &route),
            Ok((_bag_id, None)) => {}
            Err(error) => shipflow_core::shipflow_log!(
                "[ShipFlowBagRouteCache] enrichment_task_failed error={error}"
            ),
        }
    }
}

async fn resolve_cached_bag_route(
    state: &HttpApiState,
    bag_id: &str,
    request_id: &str,
) -> Option<BagRoute> {
    loop {
        if let Some(entry) = state.bag_route_cache.get_async(bag_id).await {
            shipflow_core::shipflow_log!(
                "[ShipFlowBagRouteCache] cache_hit id={} status={:?}",
                entry.bag_id,
                entry.status
            );
            return entry.route;
        }

        match state.bag_route_cache.begin_fetch(bag_id) {
            BagRouteFetchAction::Wait(waiter) => waiter.await,
            BagRouteFetchAction::Start(fetch_lease) => {
                let _fetch_lease = fetch_lease;
                let permit = match state
                    .contact_backpressure
                    .acquire("bag_route_enrichment", bag_id, request_id)
                    .await
                {
                    Ok(permit) => permit,
                    Err(error) => {
                        state.bag_route_cache.store_failure_async(bag_id).await;
                        shipflow_core::shipflow_log!(
                            "[ShipFlowBagRouteCache] permit_failed id={} error={error:?}",
                            bag_id
                        );
                        return None;
                    }
                };
                let fetch_result = timeout(
                    Duration::from_secs(BAG_ROUTE_LOOKUP_TIMEOUT_SECS),
                    scrape_pos_bag_route(&state.client, bag_id),
                )
                .await;
                drop(permit);

                match fetch_result {
                    Ok(Ok(route)) => {
                        let entry = state.bag_route_cache.store_async(bag_id, route).await;
                        shipflow_core::shipflow_log!(
                            "[ShipFlowBagRouteCache] fetch_ok id={} status={:?} destinationPresent={}",
                            bag_id,
                            entry.status,
                            entry.route.as_ref().is_some_and(|route| route.tujuan.is_some())
                        );
                        return entry.route;
                    }
                    Ok(Err(error)) => {
                        state.bag_route_cache.store_failure_async(bag_id).await;
                        shipflow_core::shipflow_log!(
                            "[ShipFlowBagRouteCache] fetch_failed id={} error={error:?}",
                            bag_id
                        );
                        return None;
                    }
                    Err(_) => {
                        state.bag_route_cache.store_failure_async(bag_id).await;
                        shipflow_core::shipflow_log!(
                            "[ShipFlowBagRouteCache] fetch_timeout id={} timeoutSec={BAG_ROUTE_LOOKUP_TIMEOUT_SECS}",
                            bag_id
                        );
                        return None;
                    }
                }
            }
        }
    }
}

fn apply_bag_route(response: &mut TrackResponse, route: &BagRoute) {
    for summary in &mut response.history_summary.bagging_unbagging {
        if !summary
            .nomor_kantung
            .eq_ignore_ascii_case(&route.nomor_kantung)
        {
            continue;
        }

        let Some(bagging) = summary.bagging.as_mut() else {
            continue;
        };
        if bagging.lokasi.is_none() {
            bagging.lokasi = route.lokasi_asal.clone();
        }
        bagging.tujuan = route.tujuan.clone();
        summary.unbagging_sesuai_tujuan = match (
            route.tujuan.as_deref(),
            summary
                .unbagging
                .as_ref()
                .and_then(|unbagging| unbagging.lokasi.as_deref()),
        ) {
            (Some(expected), Some(actual)) => Some(locations_match(expected, actual)),
            _ => None,
        };
    }
}

fn locations_match(expected: &str, actual: &str) -> bool {
    let expected = normalized_location_identity(expected);
    let actual = normalized_location_identity(actual);
    !expected.is_empty() && expected == actual
}

fn normalized_location_identity(value: &str) -> String {
    let normalized = value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_uppercase();
    normalized
        .split_whitespace()
        .rev()
        .find(|part| part.chars().any(|character| character.is_ascii_digit()))
        .map(|part| {
            part.chars()
                .filter(|character| character.is_ascii_alphanumeric())
                .collect()
        })
        .unwrap_or(normalized)
}

async fn acquire_lookup_permits(
    public_backpressure: UpstreamBackpressure,
    global_backpressure: UpstreamBackpressure,
    traffic_class: LookupTrafficClass,
    route: &str,
    lookup_id: &str,
    request_id: &str,
) -> Result<LookupPermitSet, TrackingError> {
    let public_permit = if traffic_class == LookupTrafficClass::Public {
        Some(
            public_backpressure
                .acquire(route, lookup_id, request_id)
                .await
                .map_err(tracking_error_from_upstream_backpressure)?,
        )
    } else {
        None
    };
    let global_permit = global_backpressure
        .acquire(route, lookup_id, request_id)
        .await
        .map_err(tracking_error_from_upstream_backpressure)?;
    Ok(LookupPermitSet {
        _public: public_permit,
        _global: global_permit,
    })
}

pub(crate) async fn resolve_bag_payload(
    state: &HttpApiState,
    bag_id: &str,
    request_options: LookupRequestOptions,
    route: &'static str,
    request_id: &str,
    traffic_class: LookupTrafficClass,
) -> Result<BagResponse, TrackingError> {
    let normalized_id = bag_id.trim().to_string();
    let public_backpressure = state.public_upstream_backpressure.clone();
    let backpressure = state.upstream_backpressure.clone();
    let permit_request_id = request_id.to_string();
    let permit_lookup_id = normalized_id.clone();
    with_lookup_deadline(
        route,
        &normalized_id,
        resolve_bag_request_cached(
            &state.lookup_cache,
            &state.client,
            &state.tracking_source,
            &normalized_id,
            request_options,
            move || async move {
                acquire_lookup_permits(
                    public_backpressure,
                    backpressure,
                    traffic_class,
                    route,
                    &permit_lookup_id,
                    &permit_request_id,
                )
                .await
            },
        ),
    )
    .await
}

pub(crate) async fn resolve_manifest_payload(
    state: &HttpApiState,
    manifest_id: &str,
    request_options: LookupRequestOptions,
    route: &'static str,
    request_id: &str,
    traffic_class: LookupTrafficClass,
) -> Result<ManifestResponse, TrackingError> {
    let normalized_id = manifest_id.trim().to_string();
    let public_backpressure = state.public_upstream_backpressure.clone();
    let backpressure = state.upstream_backpressure.clone();
    let permit_request_id = request_id.to_string();
    let permit_lookup_id = normalized_id.clone();
    with_lookup_deadline(
        route,
        &normalized_id,
        resolve_manifest_request_cached(
            &state.lookup_cache,
            &state.client,
            &state.tracking_source,
            &normalized_id,
            request_options,
            move || async move {
                acquire_lookup_permits(
                    public_backpressure,
                    backpressure,
                    traffic_class,
                    route,
                    &permit_lookup_id,
                    &permit_request_id,
                )
                .await
            },
        ),
    )
    .await
}

async fn with_lookup_deadline<T, F>(
    route: &str,
    lookup_id: &str,
    future: F,
) -> Result<T, TrackingError>
where
    F: Future<Output = Result<T, TrackingError>>,
{
    with_lookup_deadline_duration(
        route,
        lookup_id,
        Duration::from_secs(SERVICE_LOOKUP_DEADLINE_SECS),
        future,
    )
    .await
}

async fn with_lookup_deadline_duration<T, F>(
    route: &str,
    lookup_id: &str,
    deadline: Duration,
    future: F,
) -> Result<T, TrackingError>
where
    F: Future<Output = Result<T, TrackingError>>,
{
    match timeout(deadline, future).await {
        Ok(result) => result,
        Err(_) => {
            shipflow_core::shipflow_log!(
                "[ShipFlowDeadline] lookup_timed_out route={route} id={lookup_id} deadlineMs={}",
                deadline.as_millis()
            );
            Err(TrackingError::ServiceUnavailable(format!(
                "Lookup exceeded the {}-second service deadline. Please retry.",
                deadline.as_secs()
            )))
        }
    }
}

fn service_restart_count() -> u32 {
    std::env::var("SHIPFLOW_SERVICE_RESTART_COUNT")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0)
}

fn cache_diagnostics(snapshot: LookupCacheSnapshot) -> CacheDiagnostics {
    CacheDiagnostics {
        ready: snapshot.ready,
        loading: snapshot.loading,
        capacity: snapshot.capacity,
        bytes: snapshot.bytes,
        byte_capacity: snapshot.byte_capacity,
    }
}

fn contact_cache_diagnostics(snapshot: ContactCacheSnapshot) -> ContactCacheDiagnostics {
    ContactCacheDiagnostics {
        entries: snapshot.entries,
        in_flight: snapshot.in_flight,
        capacity: snapshot.capacity,
    }
}

fn bag_route_cache_diagnostics(snapshot: BagRouteCacheSnapshot) -> BagRouteCacheDiagnostics {
    BagRouteCacheDiagnostics {
        entries: snapshot.entries,
        in_flight: snapshot.in_flight,
        capacity: snapshot.capacity,
    }
}

fn backpressure_diagnostics(snapshot: UpstreamBackpressureSnapshot) -> BackpressureLaneDiagnostics {
    BackpressureLaneDiagnostics {
        active: snapshot.active,
        available: snapshot.available,
        queued: snapshot.queued,
        max_concurrent: snapshot.max_concurrent,
        max_queued: snapshot.max_queued,
    }
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
    shipflow_core::shipflow_log!(
        "[ShipFlowPerf] service_tracking route={} id={} source={} forceRefresh={} durationMs={} result={}",
        route,
        shipment_id,
        tracking_source_label(tracking_source),
        force_refresh,
        started_at.elapsed().as_millis(),
        if is_success { "ok" } else { "error" }
    );
}

fn tracking_error_from_upstream_backpressure(error: UpstreamBackpressureError) -> TrackingError {
    match error {
        UpstreamBackpressureError::QueueFull { depth } => TrackingError::RateLimited(format!(
            "Too many upstream lookup requests are already queued ({depth}). Please retry shortly."
        )),
        UpstreamBackpressureError::LimiterUnavailable => {
            TrackingError::ServiceUnavailable("Upstream lookup limiter is unavailable.".into())
        }
        UpstreamBackpressureError::Timeout => TrackingError::ServiceUnavailable(
            "Upstream lookup queue timed out. Please retry shortly.".into(),
        ),
    }
}

fn tracking_source_label(tracking_source: &TrackingSourceConfig) -> &'static str {
    match tracking_source.tracking_source {
        TrackingSource::Default => "internal",
        TrackingSource::ExternalApi => "external_api",
    }
}

fn authorize_state_request(headers: &HeaderMap, state: &HttpApiState) -> Result<(), String> {
    let token = bearer_token(headers)?;
    if !constant_time_token_eq(token, &state.auth_token) {
        return Err("Bearer token is invalid.".into());
    }
    Ok(())
}

fn bearer_token(headers: &HeaderMap) -> Result<&str, String> {
    let Some(raw_header) = headers.get(AUTHORIZATION) else {
        return Err("Authorization header is required.".into());
    };
    let Ok(header_value) = raw_header.to_str() else {
        return Err("Authorization header is invalid.".into());
    };
    let Some(token) = header_value.strip_prefix("Bearer ") else {
        return Err("Authorization header must use Bearer token.".into());
    };
    Ok(token)
}

pub(crate) fn constant_time_token_eq(candidate: &str, expected: &str) -> bool {
    let candidate = candidate.as_bytes();
    let expected = expected.as_bytes();
    let max_len = candidate.len().max(expected.len());
    let mut difference = candidate.len() ^ expected.len();
    for index in 0..max_len {
        let left = candidate.get(index).copied().unwrap_or_default();
        let right = expected.get(index).copied().unwrap_or_default();
        difference |= usize::from(left ^ right);
    }
    difference == 0
}

#[cfg(test)]
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

    if !constant_time_token_eq(token, expected_token) {
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
        TrackingError::RateLimited(message) => error_response_v1(
            StatusCode::TOO_MANY_REQUESTS,
            schema_version,
            request_id,
            &message,
        ),
        TrackingError::ServiceUnavailable(message) => error_response_v1(
            StatusCode::SERVICE_UNAVAILABLE,
            schema_version,
            request_id,
            &message,
        ),
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
        .filter(|value| {
            !value.is_empty()
                && value.len() <= MAX_REQUEST_ID_BYTES
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:".contains(&byte))
        })
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
    use shipflow_core::model::{
        BagRoute, BaggingEvent, BaggingUnbaggingEvent, BaggingUnbaggingSummary, HistorySummary,
        MultiKoliSummary, ShipmentIdentity, TrackDetail, TrackPod, TrackResponse, TrackStatusAkhir,
        TrackingSource, TrackingSourceConfig,
    };
    use tower::ServiceExt;

    use super::{
        acquire_lookup_permits, apply_bag_route, authorize_request_id, authorize_request_message,
        build_router, external_api_request, is_forbidden_external_address,
        is_private_external_address, read_lookup_request_options, resolve_external_api_addresses,
        tracking_source_redirects_allowed, with_lookup_deadline_duration, HttpApiState,
        LookupTrafficClass, ShutdownSignal,
    };
    use std::{net::IpAddr, sync::Arc, time::Instant};
    use tokio::sync::Semaphore;
    use tokio::time::Duration;

    use crate::{
        bag_route_cache::BagRouteCacheState,
        contact_cache::ContactCacheState,
        lookup_cache::LookupCacheState,
        model::ServiceRuntimeMode,
        upstream_backpressure::{UpstreamBackpressure, MAX_CONCURRENT_UPSTREAM_LOOKUPS},
        FORCE_REFRESH_HEADER_NAME,
    };

    #[test]
    fn external_api_network_policy_separates_forbidden_and_trusted_lan_addresses() {
        let loopback: IpAddr = "127.0.0.1".parse().unwrap();
        let metadata: IpAddr = "169.254.169.254".parse().unwrap();
        let private_lan: IpAddr = "192.168.1.20".parse().unwrap();
        let public: IpAddr = "8.8.8.8".parse().unwrap();

        assert!(is_forbidden_external_address(loopback));
        assert!(is_forbidden_external_address(metadata));
        assert!(!is_forbidden_external_address(private_lan));
        assert!(is_private_external_address(private_lan));
        assert!(!is_private_external_address(public));
    }

    #[test]
    fn external_api_client_redirects_are_disabled() {
        let source = TrackingSourceConfig {
            tracking_source: TrackingSource::ExternalApi,
            external_api_base_url: "https://shipflow.example.test".into(),
            external_api_auth_token: "secret".into(),
            allow_insecure_external_api_http: false,
        };

        assert!(!tracking_source_redirects_allowed(&source));
        assert!(tracking_source_redirects_allowed(
            &TrackingSourceConfig::default()
        ));
    }

    #[test]
    fn bag_route_enrichment_keeps_expected_and_actual_locations_separate() {
        let mut response = TrackResponse {
            url: "https://example.test/track/P1".into(),
            detail: TrackDetail::default(),
            status_akhir: TrackStatusAkhir::default(),
            pod: TrackPod::default(),
            history: Vec::new(),
            history_summary: HistorySummary {
                bagging_unbagging: vec![BaggingUnbaggingSummary {
                    nomor_kantung: "PID96722106".into(),
                    bagging: Some(BaggingEvent {
                        petugas: None,
                        lokasi: Some("KCU JAYAPURA 99000".into()),
                        tujuan: None,
                        tanggal: None,
                        waktu: None,
                    }),
                    unbagging: Some(BaggingUnbaggingEvent {
                        petugas: None,
                        lokasi: Some("DC JAYAPURA 9910A".into()),
                        tanggal: None,
                        waktu: None,
                    }),
                    unbagging_sesuai_tujuan: None,
                }],
                ..HistorySummary::default()
            },
            shipment_identity: ShipmentIdentity::default(),
            multi_koli: MultiKoliSummary::default(),
            contact_enrichment: None,
        };

        apply_bag_route(
            &mut response,
            &BagRoute {
                nomor_kantung: "PID96722106".into(),
                lokasi_asal: Some("KCU JAYAPURA 99000".into()),
                tujuan: Some("DC JAYAPURA 9910A".into()),
                url: "https://example.test/print-bag".into(),
            },
        );

        let summary = &response.history_summary.bagging_unbagging[0];
        assert_eq!(
            summary
                .bagging
                .as_ref()
                .and_then(|bagging| bagging.tujuan.as_deref()),
            Some("DC JAYAPURA 9910A")
        );
        assert_eq!(
            summary
                .unbagging
                .as_ref()
                .and_then(|unbagging| unbagging.lokasi.as_deref()),
            Some("DC JAYAPURA 9910A")
        );
        assert_eq!(summary.unbagging_sesuai_tujuan, Some(true));
    }

    #[tokio::test]
    async fn shutdown_signal_is_sticky_for_late_subscribers() {
        let signal = ShutdownSignal::new();
        signal.cancel();

        tokio::time::timeout(Duration::from_millis(50), signal.cancelled())
            .await
            .expect("late subscribers should observe prior shutdown");
    }

    #[tokio::test]
    async fn external_api_runtime_rejects_loopback_even_with_lan_opt_in() {
        let error = resolve_external_api_addresses(&TrackingSourceConfig {
            tracking_source: TrackingSource::ExternalApi,
            external_api_base_url: "http://127.0.0.1:18422".into(),
            external_api_auth_token: "sf_token".into(),
            allow_insecure_external_api_http: true,
        })
        .await
        .expect_err("loopback must remain forbidden");

        assert!(error.contains("reserved"));
    }

    #[tokio::test]
    async fn external_api_runtime_allows_explicit_trusted_lan_address() {
        let destination = resolve_external_api_addresses(&TrackingSourceConfig {
            tracking_source: TrackingSource::ExternalApi,
            external_api_base_url: "http://192.168.1.20:18422/v1".into(),
            external_api_auth_token: "sf_token".into(),
            allow_insecure_external_api_http: true,
        })
        .await
        .expect("trusted LAN address should be accepted")
        .expect("external source should resolve");

        assert_eq!(destination.0, "192.168.1.20");
        assert_eq!(destination.1[0].to_string(), "192.168.1.20:18422");
    }

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

    #[tokio::test]
    async fn lookup_deadline_cancels_slow_work() {
        let result =
            with_lookup_deadline_duration("test", "P1", Duration::from_millis(10), async {
                tokio::time::sleep(Duration::from_secs(1)).await;
                Ok::<_, shipflow_core::model::TrackingError>(())
            })
            .await;

        assert!(matches!(
            result,
            Err(shipflow_core::model::TrackingError::ServiceUnavailable(_))
        ));
    }

    #[tokio::test]
    async fn internal_lookup_can_use_reserved_capacity_when_public_lane_is_full() {
        let public_backpressure = UpstreamBackpressure::with_limits(1, 2, Duration::from_secs(1));
        let global_backpressure = UpstreamBackpressure::with_limits(2, 2, Duration::from_secs(1));
        let first_public = acquire_lookup_permits(
            public_backpressure.clone(),
            global_backpressure.clone(),
            LookupTrafficClass::Public,
            "test_public",
            "P1",
            "request-1",
        )
        .await
        .expect("first public request should acquire");
        let waiting_public = tokio::spawn({
            let public_backpressure = public_backpressure.clone();
            let global_backpressure = global_backpressure.clone();
            async move {
                acquire_lookup_permits(
                    public_backpressure,
                    global_backpressure,
                    LookupTrafficClass::Public,
                    "test_public",
                    "P2",
                    "request-2",
                )
                .await
            }
        });
        tokio::task::yield_now().await;

        assert_eq!(public_backpressure.snapshot().queued, 1);
        let internal = acquire_lookup_permits(
            public_backpressure,
            global_backpressure,
            LookupTrafficClass::Internal,
            "test_internal",
            "P3",
            "request-3",
        )
        .await
        .expect("internal request should use reserved global capacity");

        drop(first_public);
        drop(internal);
        waiting_public
            .await
            .expect("public waiter should join")
            .expect("public waiter should acquire after capacity is released");
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

    #[test]
    fn rejects_unbounded_or_unsafe_request_ids() {
        let mut headers = HeaderMap::new();
        headers.insert(
            super::REQUEST_ID_HEADER_NAME,
            "request id with whitespace".parse().unwrap(),
        );
        let unsafe_id = authorize_request_id(&headers);
        assert_ne!(unsafe_id, "request id with whitespace");

        headers.insert(
            super::REQUEST_ID_HEADER_NAME,
            "x".repeat(super::MAX_REQUEST_ID_BYTES + 1).parse().unwrap(),
        );
        assert_ne!(
            authorize_request_id(&headers),
            "x".repeat(super::MAX_REQUEST_ID_BYTES + 1)
        );
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
    async fn status_identity_is_available_without_bearer_token() {
        let router = build_router(test_state());
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/v1/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let response_request_id = response
            .headers()
            .get(super::REQUEST_ID_HEADER_NAME)
            .expect("response should expose the correlation id")
            .to_str()
            .unwrap()
            .to_string();

        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["data"]["product"], "shipflow-service");
        assert_eq!(payload["data"]["service"], "running");
        assert_eq!(payload["meta"]["requestId"], response_request_id);
    }

    #[tokio::test]
    async fn auth_check_requires_bearer_token() {
        let router = build_router(test_state());
        let unauthenticated = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/auth/check")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);

        let authenticated = router
            .oneshot(
                Request::builder()
                    .uri("/v1/auth/check")
                    .header(AUTHORIZATION, "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(authenticated.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn public_http_rejects_the_internal_ipc_token() {
        let response = build_router(test_state())
            .oneshot(
                Request::builder()
                    .uri("/v1/auth/check")
                    .header(AUTHORIZATION, "Bearer internal-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
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
    async fn diagnostics_require_auth_and_report_bounded_runtime_state() {
        let router = build_router(test_state());
        let unauthenticated = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/diagnostics")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);

        let authenticated = router
            .oneshot(
                Request::builder()
                    .uri("/v1/diagnostics")
                    .header(AUTHORIZATION, "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(authenticated.status(), StatusCode::OK);

        let body = to_bytes(authenticated.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            payload["meta"]["schemaVersion"],
            "shipflow.service.diagnostics.v1"
        );
        assert_eq!(payload["data"]["product"], "shipflow-service");
        assert_eq!(payload["data"]["lookupDeadlineSeconds"], 120);
        assert_eq!(payload["data"]["lookupCache"]["capacity"], 10_000);
        assert!(payload["data"]["lookupCache"]["bytes"].is_number());
        assert!(payload["data"]["lookupCache"]["byteCapacity"].is_number());
        assert!(payload["data"]["backpressure"]["global"]["maxConcurrent"].is_number());
        assert!(payload["data"]["backpressure"]["global"]["maxQueued"].is_number());
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
        assert!(routes.iter().any(|route| route == "GET /v1/diagnostics"));
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
    async fn upstream_lookup_routes_return_backpressure_when_queue_is_full() {
        for uri in [
            "/v1/track/P2603310114291",
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
            let router = build_router(external_api_test_state_with_limiter(
                limiter,
                "not-a-url",
                0,
                Duration::from_millis(50),
            ));

            let response = router
                .oneshot(
                    Request::builder()
                        .uri(uri)
                        .header(AUTHORIZATION, "Bearer secret-token")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await;

            assert_eq!(response.unwrap().status(), StatusCode::TOO_MANY_REQUESTS);
            drop(held_permit);
        }
    }

    #[tokio::test]
    async fn http_ingress_rejects_immediately_when_its_queue_is_full() {
        let limiter = Arc::new(Semaphore::new(1));
        let held_permit = limiter
            .clone()
            .acquire_owned()
            .await
            .expect("test permit should acquire");
        let mut state = test_state();
        state.http_ingress_backpressure =
            UpstreamBackpressure::with_limiter(limiter, 1, 0, Duration::from_millis(50));

        let response = build_router(state)
            .oneshot(
                Request::builder()
                    .uri("/v1/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .expect("router should respond");

        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        drop(held_permit);
    }

    #[tokio::test]
    async fn http_ingress_releases_capacity_across_a_burst() {
        let mut state = test_state();
        state.http_ingress_backpressure =
            UpstreamBackpressure::with_limits(8, 512, Duration::from_secs(1));
        let router = build_router(state);
        let mut requests = tokio::task::JoinSet::new();

        for _ in 0..512 {
            let router = router.clone();
            requests.spawn(async move {
                router
                    .oneshot(
                        Request::builder()
                            .uri("/v1/status")
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await
                    .expect("router should respond")
                    .status()
            });
        }

        while let Some(result) = requests.join_next().await {
            assert_eq!(result.expect("request task should join"), StatusCode::OK);
        }
    }

    fn test_state() -> HttpApiState {
        HttpApiState {
            client: reqwest::Client::new(),
            auth_token: "secret-token".into(),
            internal_auth_token: "internal-token".into(),
            mode: ServiceRuntimeMode::Local,
            bind_address: "127.0.0.1".into(),
            port: 18422,
            tracking_source: TrackingSourceConfig::default(),
            lookup_cache: LookupCacheState::default(),
            contact_cache: ContactCacheState::default(),
            bag_route_cache: BagRouteCacheState::default(),
            public_upstream_backpressure: UpstreamBackpressure::public_default(),
            upstream_backpressure: UpstreamBackpressure::default(),
            contact_backpressure: UpstreamBackpressure::contact_default(),
            http_ingress_backpressure: UpstreamBackpressure::http_ingress_default(),
            shutdown_signal: ShutdownSignal::new(),
            started_at: Instant::now(),
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
        max_queued: usize,
        permit_timeout: Duration,
    ) -> HttpApiState {
        HttpApiState {
            tracking_source: TrackingSourceConfig {
                tracking_source: TrackingSource::ExternalApi,
                external_api_base_url: external_api_base_url.into(),
                external_api_auth_token: "sf_token".into(),
                allow_insecure_external_api_http: true,
            },
            upstream_backpressure: UpstreamBackpressure::with_limiter(
                limiter,
                MAX_CONCURRENT_UPSTREAM_LOOKUPS,
                max_queued,
                permit_timeout,
            ),
            ..test_state()
        }
    }
}
