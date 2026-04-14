use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{ConnectInfo, Request, State},
    http::{header, HeaderMap, HeaderValue},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use moka::future::Cache;
use reqwest::Client;
use serde_json::json;
use tokio::{net::TcpListener, sync::Semaphore};
use tokio_util::sync::CancellationToken;
use tracing::{error, info};

use crate::{
    app_state::AppState,
    auth::{
        build_token_lookup, required_scope_for_request, ApiTokenRecord, AuthContext, TokenSource,
    },
    canary::{probe_upstream_canary, CanaryRuntimeState},
    config::AppConfig,
    deprecation::{legacy_successor_path, LEGACY_API_SUNSET_HTTP_DATE},
    drift_guard::DriftGuard,
    error::AppError,
    incidents::IncidentStore,
    jobs::JobStore,
    managed_tokens::ManagedTokenStore,
    metrics::Metrics,
    persistent_cache::PersistentCache,
    rate_limit::{RateLimitDecision, RateLimiter},
    request_context::{request_context_middleware, RequestContext},
    routes,
    token_state::TokenStateStore,
};

const HEADER_RATE_LIMIT_LIMIT: &str = "X-RateLimit-Limit";
const HEADER_RATE_LIMIT_REMAINING: &str = "X-RateLimit-Remaining";
const HEADER_RATE_LIMIT_RESET: &str = "X-RateLimit-Reset";
const HEADER_RATE_LIMIT_BURST_LIMIT: &str = "X-RateLimit-Burst-Limit";
const HEADER_RATE_LIMIT_BURST_REMAINING: &str = "X-RateLimit-Burst-Remaining";
const HEADER_RATE_LIMIT_BURST_RESET: &str = "X-RateLimit-Burst-Reset";
const HEADER_DEPRECATION: &str = "deprecation";
const HEADER_SUNSET: &str = "sunset";

/// Menjalankan HTTP server Axum dengan konfigurasi yang diberikan.
/// Server akan berhenti ketika `cancel` di-trigger.
pub async fn run(config: AppConfig, cancel: CancellationToken) {
    let port = config.port;
    let http_max_concurrency = config.http_max_concurrency.max(1);
    let http_timeout_secs = config.http_timeout_secs.max(1);
    let stale_ttl = config.stale_if_error_ttl_secs.max(1);
    let allowed_tokens = build_token_lookup(&config.api_tokens);
    let token_state_store = match build_token_state_store(&config, &allowed_tokens) {
        Ok(store) => store,
        Err(err) => {
            error!("failed to initialize API token state store: {err:#}");
            return;
        }
    };
    let managed_token_store = match build_managed_token_store(&config, &allowed_tokens) {
        Ok(store) => store,
        Err(err) => {
            error!("failed to initialize managed API token store: {err:#}");
            return;
        }
    };

    let client = match Client::builder()
        .user_agent("scrap-pid-v3/0.1.0")
        .timeout(Duration::from_secs(http_timeout_secs))
        .build()
    {
        Ok(client) => client,
        Err(err) => {
            error!("failed to build HTTP client: {}", err);
            return;
        }
    };

    let state = AppState {
        config: config.clone(),
        client,
        upstream_semaphore: Arc::new(Semaphore::new(http_max_concurrency)),
        allowed_tokens: Arc::new(allowed_tokens),
        rate_limiter: Arc::new(RateLimiter::new(
            config.rate_limit_per_minute,
            config.rate_limit_burst_capacity,
            config.rate_limit_burst_window_secs,
        )),
        metrics: Arc::new(Metrics::default()),
        job_store: Arc::new(JobStore::new(
            config.job_result_ttl_secs,
            config.job_store_max_entries,
        )),
        drift_guard: Arc::new(DriftGuard::new(config.parser_guard_max_events)),
        incident_store: Arc::new(IncidentStore::new(config.incident_max_events, 30_000)),
        canary_state: Arc::new(CanaryRuntimeState::new()),
        persistent_cache: build_persistent_cache(&config),
        token_state_store,
        managed_token_store,
        upstream_singleflight: Cache::builder().max_capacity(10_000).build(),
        track_html_cache: Cache::builder()
            .max_capacity(config.cache_max_entries as u64)
            .time_to_live(Duration::from_secs(config.track_cache_ttl_secs))
            .build(),
        bag_html_cache: Cache::builder()
            .max_capacity(config.cache_max_entries as u64)
            .time_to_live(Duration::from_secs(config.bag_cache_ttl_secs))
            .build(),
        manifest_html_cache: Cache::builder()
            .max_capacity(config.cache_max_entries as u64)
            .time_to_live(Duration::from_secs(config.manifest_cache_ttl_secs))
            .build(),
        track_stale_cache: Cache::builder()
            .max_capacity(config.cache_max_entries as u64)
            .time_to_live(Duration::from_secs(stale_ttl))
            .build(),
        bag_stale_cache: Cache::builder()
            .max_capacity(config.cache_max_entries as u64)
            .time_to_live(Duration::from_secs(stale_ttl))
            .build(),
        manifest_stale_cache: Cache::builder()
            .max_capacity(config.cache_max_entries as u64)
            .time_to_live(Duration::from_secs(stale_ttl))
            .build(),
    };

    let app = build_router(state);

    let addr: SocketAddr = ([0, 0, 0, 0], port).into();
    info!("Starting server on http://{}", addr);

    let listener = match TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(err) => {
            error!("failed to bind TCP listener on {}: {}", addr, err);
            return;
        }
    };

    let shutdown = async move {
        cancel.cancelled().await;
    };
    let server = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown);

    if let Err(err) = server.await {
        error!("server error: {}", err);
    }
}

fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/canaryz", get(canaryz))
        .route("/metrics", get(metrics_handler))
        .route("/parserGuard", get(parser_guard_handler))
        .merge(routes::v1::routes())
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        .layer(middleware::from_fn(legacy_deprecation_middleware))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            access_log_middleware,
        ))
        .layer(middleware::from_fn(request_context_middleware))
        .with_state(state)
}

async fn healthz() -> &'static str {
    "ok"
}

async fn readyz(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({
        "status": "ready",
        "upstream_available_permits": state.upstream_semaphore.available_permits(),
    }))
}

async fn canaryz(State(state): State<AppState>) -> impl IntoResponse {
    let (status, payload) = probe_upstream_canary(&state).await;
    (status, Json(payload))
}

async fn metrics_handler(State(state): State<AppState>) -> impl IntoResponse {
    let body = state
        .metrics
        .render_prometheus(state.upstream_semaphore.available_permits());
    ([(header::CONTENT_TYPE, "text/plain; version=0.0.4")], body)
}

async fn parser_guard_handler(
    State(state): State<AppState>,
) -> Json<crate::drift_guard::ParserGuardSnapshot> {
    Json(state.drift_guard.snapshot())
}

async fn legacy_deprecation_middleware(request: Request, next: Next) -> Response {
    let path = request.uri().path().to_string();
    let mut response = next.run(request).await;

    if let Some(successor_path) = legacy_successor_path(&path) {
        response
            .headers_mut()
            .insert(HEADER_DEPRECATION, HeaderValue::from_static("true"));
        response.headers_mut().insert(
            HEADER_SUNSET,
            HeaderValue::from_static(LEGACY_API_SUNSET_HTTP_DATE),
        );
        if let Ok(link) =
            HeaderValue::from_str(&format!("<{successor_path}>; rel=\"successor-version\""))
        {
            response.headers_mut().insert(header::LINK, link);
        }
    }

    response
}

async fn auth_middleware(
    State(state): State<AppState>,
    headers: HeaderMap,
    mut request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path();
    if path == "/healthz" || path == "/readyz" || path == "/canaryz" {
        return next.run(request).await;
    }

    let token = headers
        .get("X-Api-Token")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty());

    let Some(token) = token else {
        state.metrics.inc_http_unauthorized();
        return AppError::unauthorized("missing or invalid X-Api-Token").into_response();
    };

    let Some(token_record) = find_token_record(&state, token) else {
        state.metrics.inc_http_unauthorized();
        return AppError::unauthorized("missing or invalid X-Api-Token").into_response();
    };

    if token_record.is_revoked() {
        state.metrics.inc_http_token_revoked();
        return AppError::token_revoked("API token has been revoked").into_response();
    }

    let now_ms = current_time_ms();
    let client_ip = resolve_client_ip(&request, state.config.trust_proxy_headers_for_ip_allowlist);
    if token_record.is_expired(now_ms) {
        state.metrics.inc_http_unauthorized();
        return AppError::token_expired("API token has expired").into_response();
    }

    if !token_record.allows_ip(client_ip) {
        state.metrics.inc_http_forbidden();
        return AppError::ip_not_allowed("API token is not allowed from the resolved client IP")
            .into_response();
    }

    let resolved_rate_limit = token_record.resolved_rate_limit(
        state.config.default_rate_limit_policy(),
        &state.config.rate_limit_classes,
        &state.config.rate_limit_scope_class_defaults,
    );
    let decision = state
        .rate_limiter
        .check_with_policy(token, resolved_rate_limit.policy);
    if !decision.allowed {
        state.metrics.inc_http_rate_limited();
        let mut response =
            AppError::rate_limited("too many requests for this API token").into_response();
        apply_rate_limit_headers(&mut response, decision);
        return response;
    }

    if let Some(required_scope) = required_scope_for_request(request.method(), path) {
        if !token_record.has_scope(required_scope) {
            state.metrics.inc_http_forbidden();
            let mut response = AppError::forbidden(format!(
                "API token does not have required scope: {required_scope}"
            ))
            .into_response();
            apply_rate_limit_headers(&mut response, decision);
            return response;
        }
    }

    token_record.mark_used(now_ms);
    request.extensions_mut().insert(AuthContext::from_record(
        &token_record,
        client_ip,
        resolved_rate_limit,
    ));

    state.metrics.inc_http_requests();
    let mut response = next.run(request).await;
    apply_rate_limit_headers(&mut response, decision);
    response
}

#[derive(Debug, Clone)]
struct AccessLogIdentity {
    token_present: bool,
    token_id: Option<String>,
    token_source: Option<TokenSource>,
}

async fn access_log_middleware(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    let client_ip = resolve_client_ip(&request, state.config.trust_proxy_headers_for_ip_allowlist)
        .map(|ip| ip.to_string());
    let request_context = request.extensions().get::<RequestContext>().cloned();
    let identity = build_access_log_identity(&state, request.headers());

    let response = next.run(request).await;
    let latency_ms = request_context
        .as_ref()
        .map(RequestContext::elapsed_ms)
        .unwrap_or_default();
    state.metrics.observe_http_request_duration(
        metric_endpoint_label(&path),
        method.as_str(),
        status_class_label(response.status()),
        latency_ms,
    );
    emit_access_log(
        &method,
        &path,
        client_ip.as_deref(),
        request_context.as_ref(),
        &identity,
        &response,
    );
    response
}

fn build_access_log_identity(state: &AppState, headers: &HeaderMap) -> AccessLogIdentity {
    let token = headers
        .get("X-Api-Token")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let Some(token) = token else {
        return AccessLogIdentity {
            token_present: false,
            token_id: None,
            token_source: None,
        };
    };

    let Some(record) = find_token_record(state, token) else {
        return AccessLogIdentity {
            token_present: true,
            token_id: None,
            token_source: None,
        };
    };

    AccessLogIdentity {
        token_present: true,
        token_id: Some(record.token_id.clone()),
        token_source: Some(record.source),
    }
}

enum TokenRecordHandle<'a> {
    Static(&'a ApiTokenRecord),
    Managed(Arc<ApiTokenRecord>),
}

impl std::ops::Deref for TokenRecordHandle<'_> {
    type Target = ApiTokenRecord;

    fn deref(&self) -> &Self::Target {
        match self {
            Self::Static(record) => record,
            Self::Managed(record) => record.as_ref(),
        }
    }
}

fn find_token_record<'a>(state: &'a AppState, token: &str) -> Option<TokenRecordHandle<'a>> {
    if let Some(record) = state.allowed_tokens.get(token) {
        return Some(TokenRecordHandle::Static(record));
    }

    state
        .managed_token_store
        .as_ref()
        .and_then(|store| store.get_by_secret(token))
        .map(TokenRecordHandle::Managed)
}

fn emit_access_log(
    method: &axum::http::Method,
    path: &str,
    client_ip: Option<&str>,
    request_context: Option<&RequestContext>,
    identity: &AccessLogIdentity,
    response: &Response,
) {
    let request_id = request_context
        .map(|context| context.request_id.as_str())
        .unwrap_or("-");
    let latency_ms = request_context
        .map(RequestContext::elapsed_ms)
        .unwrap_or_default();
    let token_id = identity.token_id.as_deref().unwrap_or("-");
    let token_source = identity.token_source.map(token_source_label).unwrap_or("-");
    let client_ip = client_ip.unwrap_or("-");
    let schema_version = response
        .headers()
        .get(crate::api_contract::HEADER_SCHEMA_VERSION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("-");
    let deprecated = response.headers().contains_key(HEADER_DEPRECATION);
    let status = response.status().as_u16();

    if status >= 500 {
        tracing::warn!(
            request_id,
            method = %method,
            path,
            status,
            latency_ms,
            client_ip,
            token_present = identity.token_present,
            token_id,
            token_source,
            schema_version,
            deprecated,
            "request completed",
        );
    } else {
        tracing::info!(
            request_id,
            method = %method,
            path,
            status,
            latency_ms,
            client_ip,
            token_present = identity.token_present,
            token_id,
            token_source,
            schema_version,
            deprecated,
            "request completed",
        );
    }
}

fn metric_endpoint_label(path: &str) -> &'static str {
    match path {
        "/healthz" => "healthz",
        "/readyz" => "readyz",
        "/canaryz" => "canaryz",
        "/metrics" => "metrics",
        "/parserGuard" => "parser_guard",
        "/v1/capabilities" => "v1_capabilities",
        "/v1/changelog" => "v1_changelog",
        "/v1/incidents" => "v1_incidents",
        "/v1/status" => "v1_status",
        "/v1/whoami" => "v1_whoami",
        "/v1/admin/tokens" => "v1_admin_tokens",
        "/v1/admin/tokens/managed/create" => "v1_admin_tokens_managed_create",
        "/v1/admin/tokens/revoke" => "v1_admin_tokens_revoke",
        "/v1/admin/tokens/restore" => "v1_admin_tokens_restore",
        "/v1/admin/tokens/rotate" => "v1_admin_tokens_rotate",
        "/v1/admin/tokens/managed/rotate-secret" => "v1_admin_tokens_managed_rotate_secret",
        "/v1/track/html" => "v1_track_html",
        "/v1/track/detail" => "v1_track_detail",
        "/v1/bag/html" => "v1_bag_html",
        "/v1/bag/detail" => "v1_bag_detail",
        "/v1/manifest/html" => "v1_manifest_html",
        "/v1/manifest/detail" => "v1_manifest_detail",
        "/openapi.json" => "openapi_json",
        _ => "other",
    }
}

fn status_class_label(status: axum::http::StatusCode) -> &'static str {
    match status.as_u16() / 100 {
        1 => "1xx",
        2 => "2xx",
        3 => "3xx",
        4 => "4xx",
        5 => "5xx",
        _ => "other",
    }
}

fn token_source_label(source: TokenSource) -> &'static str {
    match source {
        TokenSource::LegacyFullAccess => "legacy_full_access",
        TokenSource::Explicit => "explicit",
        TokenSource::Managed => "managed",
    }
}

fn build_persistent_cache(config: &AppConfig) -> Option<Arc<PersistentCache>> {
    let root_dir = config.persistent_cache_dir.as_deref()?;

    match PersistentCache::new(
        root_dir,
        config.persistent_cache_max_entries,
        config.persistent_cache_sweep_interval_secs,
    ) {
        Ok(cache) => Some(Arc::new(cache)),
        Err(err) => {
            error!(error = %err, "failed to initialize persistent cache; fallback to memory cache only");
            None
        }
    }
}

fn build_token_state_store(
    config: &AppConfig,
    allowed_tokens: &HashMap<String, ApiTokenRecord>,
) -> anyhow::Result<Option<Arc<TokenStateStore>>> {
    let Some(path) = config.api_token_state_file.as_deref() else {
        return Ok(None);
    };

    let store = Arc::new(TokenStateStore::new(path));
    store.load_into_lookup(allowed_tokens)?;
    Ok(Some(store))
}

fn build_managed_token_store(
    config: &AppConfig,
    allowed_tokens: &HashMap<String, ApiTokenRecord>,
) -> anyhow::Result<Option<Arc<ManagedTokenStore>>> {
    let Some(path) = config.managed_api_token_store_file.as_deref() else {
        return Ok(None);
    };

    let store = Arc::new(ManagedTokenStore::load(path)?);
    store.validate_against_static(allowed_tokens)?;
    Ok(Some(store))
}

fn apply_rate_limit_headers(response: &mut Response, decision: RateLimitDecision) {
    insert_u64_header(
        response.headers_mut(),
        HEADER_RATE_LIMIT_LIMIT,
        decision.limit as u64,
    );
    insert_u64_header(
        response.headers_mut(),
        HEADER_RATE_LIMIT_REMAINING,
        decision.remaining as u64,
    );
    insert_u64_header(
        response.headers_mut(),
        HEADER_RATE_LIMIT_RESET,
        decision.reset_at_epoch_secs,
    );
    insert_u64_header(
        response.headers_mut(),
        HEADER_RATE_LIMIT_BURST_LIMIT,
        decision.burst_limit as u64,
    );
    insert_u64_header(
        response.headers_mut(),
        HEADER_RATE_LIMIT_BURST_REMAINING,
        decision.burst_remaining as u64,
    );
    insert_u64_header(
        response.headers_mut(),
        HEADER_RATE_LIMIT_BURST_RESET,
        decision.burst_reset_at_epoch_secs,
    );

    if let Some(retry_after_secs) = decision.retry_after_secs {
        insert_u64_header(
            response.headers_mut(),
            header::RETRY_AFTER.as_str(),
            retry_after_secs,
        );
    }
}

fn insert_u64_header(headers: &mut HeaderMap, name: &'static str, value: u64) {
    if let Ok(parsed) = HeaderValue::from_str(&value.to_string()) {
        headers.insert(name, parsed);
    }
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn resolve_client_ip(request: &Request, trust_proxy_headers: bool) -> Option<IpAddr> {
    if trust_proxy_headers {
        for header_name in [
            "cf-connecting-ip",
            "x-real-ip",
            "x-forwarded-for",
            "forwarded",
        ] {
            let Some(raw) = request.headers().get(header_name) else {
                continue;
            };
            let Ok(raw) = raw.to_str() else {
                continue;
            };
            let parsed = match header_name {
                "x-forwarded-for" => parse_x_forwarded_for(raw),
                "forwarded" => parse_forwarded_for(raw),
                _ => parse_ip_value(raw),
            };
            if parsed.is_some() {
                return parsed;
            }
        }
    }

    request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|value| value.0.ip())
}

fn parse_x_forwarded_for(raw: &str) -> Option<IpAddr> {
    raw.split(',').find_map(parse_ip_value)
}

fn parse_forwarded_for(raw: &str) -> Option<IpAddr> {
    for section in raw.split(',') {
        for pair in section.split(';') {
            let Some((key, value)) = pair.trim().split_once('=') else {
                continue;
            };
            if key.trim().eq_ignore_ascii_case("for") {
                if let Some(ip) = parse_ip_value(value) {
                    return Some(ip);
                }
            }
        }
    }

    None
}

fn parse_ip_value(raw: &str) -> Option<IpAddr> {
    let trimmed = raw.trim().trim_matches('"');
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("unknown") {
        return None;
    }

    if let Some(rest) = trimmed.strip_prefix('[') {
        let ip = rest.split(']').next()?.trim();
        return ip.parse::<IpAddr>().ok();
    }

    if let Ok(ip) = trimmed.parse::<IpAddr>() {
        return Some(ip);
    }

    let (ip_part, port_part) = trimmed.rsplit_once(':')?;
    if ip_part.contains(':') || !port_part.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }

    ip_part.parse::<IpAddr>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        http::{header, HeaderMap, HeaderValue, Request, StatusCode},
    };
    use std::time::{SystemTime, UNIX_EPOCH};
    use tower::ServiceExt;

    use crate::{
        api_contract::HEADER_SCHEMA_VERSION,
        auth::{
            build_token_lookup, ApiTokenConfig, ApiTokenMetadata, RateLimitScopeClassDefault,
            TokenSource, SCOPE_ADMIN_READ, SCOPE_ADMIN_WRITE, SCOPE_TRACKING_READ,
        },
        managed_tokens::ManagedTokenStore,
        rate_limit::RateLimitPolicy,
        request_context::HEADER_REQUEST_ID,
        token_state::TokenStateStore,
        upstream::CachedBody,
    };

    fn test_state() -> AppState {
        let config = AppConfig {
            port: 3000,
            track_url: "https://example.com/track?id=".to_string(),
            bag_url: "https://example.com/bag?id=".to_string(),
            manifest_url: "https://example.com/manifest?id=".to_string(),
            http_max_concurrency: 4,
            http_timeout_secs: 5,
            cache_max_entries: 100,
            track_cache_ttl_secs: 10,
            bag_cache_ttl_secs: 10,
            manifest_cache_ttl_secs: 10,
            upstream_queue_timeout_secs: 1,
            retry_max_attempts: 2,
            retry_base_delay_ms: 10,
            stale_if_error_ttl_secs: 60,
            rate_limit_per_minute: 60,
            rate_limit_burst_capacity: 10,
            rate_limit_burst_window_secs: 10,
            rate_limit_classes: HashMap::new(),
            rate_limit_scope_class_defaults: Vec::new(),
            batch_concurrency: 4,
            batch_max_items: 100,
            job_result_ttl_secs: 300,
            job_store_max_entries: 100,
            webhook_timeout_secs: 5,
            webhook_max_attempts: 2,
            webhook_base_delay_ms: 100,
            webhook_secret: None,
            webhook_include_legacy_secret_header: false,
            webhook_allowed_hosts: Vec::new(),
            persistent_cache_dir: None,
            persistent_cache_max_entries: 1000,
            persistent_cache_sweep_interval_secs: 60,
            parser_guard_max_events: 100,
            incident_max_events: 100,
            upstream_canary_enabled: false,
            upstream_canary_id: "P0000000000000".to_string(),
            upstream_canary_timeout_secs: 5,
            upstream_canary_min_body_bytes: 200,
            upstream_canary_fail_threshold: 3,
            upstream_canary_grace_secs: 60,
            trust_proxy_headers_for_ip_allowlist: false,
            api_token_state_file: None,
            managed_api_token_store_file: None,
            api_tokens: vec![
                ApiTokenConfig::legacy_full_access("secret-token", "legacy-1"),
                ApiTokenConfig::legacy_full_access("rotated-token", "legacy-2"),
            ],
        };
        let allowed_tokens = build_token_lookup(&config.api_tokens);

        AppState {
            config,
            client: Client::builder()
                .timeout(Duration::from_secs(2))
                .build()
                .expect("test client should build"),
            upstream_semaphore: Arc::new(Semaphore::new(4)),
            allowed_tokens: Arc::new(allowed_tokens),
            rate_limiter: Arc::new(RateLimiter::new(60, 10, 10)),
            metrics: Arc::new(Metrics::default()),
            job_store: Arc::new(JobStore::new(300, 100)),
            drift_guard: Arc::new(DriftGuard::new(100)),
            incident_store: Arc::new(IncidentStore::new(100, 30_000)),
            canary_state: Arc::new(CanaryRuntimeState::new()),
            persistent_cache: None,
            token_state_store: None,
            managed_token_store: None,
            upstream_singleflight: Cache::builder().max_capacity(10).build(),
            track_html_cache: Cache::builder().max_capacity(10).build(),
            bag_html_cache: Cache::builder().max_capacity(10).build(),
            manifest_html_cache: Cache::builder().max_capacity(10).build(),
            track_stale_cache: Cache::builder().max_capacity(10).build(),
            bag_stale_cache: Cache::builder().max_capacity(10).build(),
            manifest_stale_cache: Cache::builder().max_capacity(10).build(),
        }
    }

    fn sample_track_html(id: &str) -> String {
        format!(
            r#"
            <html>
            <body>
                <table>
                    <tr><td>Nomor Kiriman</td><td>{id} [ SLA : 4 hari, Status kiriman OverSLA 1 hari ]</td></tr>
                    <tr><td>COD/Non COD</td><td>#CCOD, Virtual Account : 25176303 Type Rekening : Total COD : 3.783.486 Status COD/CCOD : Belum dilakukan pembayaran</td></tr>
                    <tr><td>Pengirim</td><td>PENGIRIM TEST; 0811111111; JL PENGIRIM 1; 99111</td></tr>
                    <tr><td>Penerima</td><td>PENERIMA TEST; 0822222222; JL PENERIMA 2; 99222</td></tr>
                    <tr><td>Status Akhir</td><td>DELIVERED di DC JAYAPURA 9910A oleh (Kurir Test / 12345) Tanggal : 2026-03-07 10:00:00 -</td></tr>
                </table>
                <table>
                    <tr><th>Tanggal Update</th><th>Detail History</th></tr>
                    <tr><td>2026-03-07 09:00:00</td><td>Connote telah dibuat oleh Petugas Gudang (98765) di lokasi KCU JAYAPURA 99000</td></tr>
                    <tr><td>2026-03-07 10:00:00</td><td>DELIVERED [ YBS ]</td></tr>
                </table>
            </body>
            </html>
            "#
        )
    }

    fn sample_bag_html(id: &str) -> String {
        format!(
            r#"
            <html>
            <body>
                <div>Nomor Kantung : {id}</div>
                <table>
                    <tr>
                        <th>No</th><th>No.Resi</th><th>Kantor Kirim</th><th>Tanggal Kirim</th>
                        <th>Posisi Akhir</th><th>Status</th><th>Tanggal Update</th><th>Jatuh Tempo</th><th>Petugas Update</th>
                    </tr>
                    <tr>
                        <td>1</td><td>P123</td><td>SPP JAYAPURA</td><td>2026-03-06 09:00:00</td>
                        <td>DC JAYAPURA</td><td>PROCESS</td><td>2026-03-07 08:00:00</td><td>2026-03-10</td><td>Kurir A</td>
                    </tr>
                    <tr>
                        <td>2</td><td>P456</td><td>SPP JAYAPURA</td><td>2026-03-06 09:30:00</td>
                        <td>KCU JAYAPURA</td><td>DELIVERED</td><td>2026-03-07 10:15:00</td><td>2026-03-10</td><td>Kurir B</td>
                    </tr>
                </table>
            </body>
            </html>
            "#
        )
    }

    fn sample_manifest_html() -> String {
        r#"
        <html>
        <body>
            <div>Total Berat : 12 Kg</div>
            <table>
                <tr>
                    <th>No</th><th>Nomor Kantung</th><th>Jenis Layanan</th>
                    <th>Berat</th><th>Status</th><th>Lokasi Akhir</th><th>Tanggal</th>
                </tr>
                <tr>
                    <td>1</td><td>PID123</td><td>PKH</td><td>5</td><td>inBag</td><td>DC JAYAPURA 9910A</td><td>2026-03-07 09:00:00</td>
                </tr>
                <tr>
                    <td>2</td><td>PID456</td><td>Express</td><td>7</td><td>closed</td><td>KCU JAYAPURA</td><td>2026-03-07 11:30:00</td>
                </tr>
            </table>
        </body>
        </html>
        "#
        .to_string()
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0)
    }

    fn scoped_test_state() -> AppState {
        let mut state = test_state();
        state.config.api_tokens = vec![
            ApiTokenConfig::explicit(
                "tracking-only-token",
                "partner-tracking",
                Some("Partner Tracking".to_string()),
                [SCOPE_TRACKING_READ],
            ),
            ApiTokenConfig::legacy_full_access("secret-token", "legacy-ops"),
        ];
        state.allowed_tokens = Arc::new(build_token_lookup(&state.config.api_tokens));
        state
    }

    fn managed_key_test_state() -> AppState {
        let mut state = test_state();
        state.config.trust_proxy_headers_for_ip_allowlist = true;
        state
            .config
            .rate_limit_classes
            .insert("partner".to_string(), RateLimitPolicy::new(180, 30, 10));
        state
            .config
            .rate_limit_scope_class_defaults
            .push(RateLimitScopeClassDefault {
                scope: SCOPE_TRACKING_READ.to_string(),
                class_name: "partner".to_string(),
            });
        state.config.api_tokens = vec![ApiTokenConfig::explicit_with_metadata(
            "managed-token",
            "managed-ops",
            Some("Managed Ops".to_string()),
            [SCOPE_TRACKING_READ],
            ApiTokenMetadata {
                created_by: Some("security-team".to_string()),
                created_at_ms: Some(1_700_000_000_000),
                expires_at_ms: Some(4_102_444_800_000),
                allowed_ips: ["203.0.113.0/24".to_string()].into_iter().collect(),
                ..ApiTokenMetadata::default()
            },
        )];
        state.allowed_tokens = Arc::new(build_token_lookup(&state.config.api_tokens));
        state
    }

    fn admin_inventory_test_state() -> AppState {
        let mut state = test_state();
        state
            .config
            .rate_limit_classes
            .insert("admin".to_string(), RateLimitPolicy::new(300, 60, 10));
        state
            .config
            .rate_limit_classes
            .insert("partner".to_string(), RateLimitPolicy::new(180, 30, 10));
        state.config.rate_limit_scope_class_defaults = vec![
            RateLimitScopeClassDefault {
                scope: SCOPE_ADMIN_WRITE.to_string(),
                class_name: "admin".to_string(),
            },
            RateLimitScopeClassDefault {
                scope: SCOPE_TRACKING_READ.to_string(),
                class_name: "partner".to_string(),
            },
        ];
        state.config.api_tokens = vec![
            ApiTokenConfig::explicit_with_metadata(
                "admin-token",
                "admin-ops",
                Some("Admin Ops".to_string()),
                [SCOPE_ADMIN_READ, SCOPE_ADMIN_WRITE],
                ApiTokenMetadata {
                    created_by: Some("security-team".to_string()),
                    created_at_ms: Some(1_700_000_000_000),
                    ..ApiTokenMetadata::default()
                },
            ),
            ApiTokenConfig::explicit_with_metadata(
                "expired-tracking-token",
                "partner-expired",
                Some("Expired Partner".to_string()),
                [SCOPE_TRACKING_READ],
                ApiTokenMetadata {
                    created_by: Some("ops".to_string()),
                    expires_at_ms: Some(1),
                    ..ApiTokenMetadata::default()
                },
            ),
            ApiTokenConfig::legacy_full_access("legacy-token", "legacy-ops"),
        ];
        state.allowed_tokens = Arc::new(build_token_lookup(&state.config.api_tokens));
        state
    }

    fn persistent_admin_inventory_test_state(path: &std::path::Path) -> AppState {
        let mut state = admin_inventory_test_state();
        state.config.api_token_state_file = Some(path.display().to_string());
        let allowed_tokens = build_token_lookup(&state.config.api_tokens);
        let store = Arc::new(TokenStateStore::new(path));
        store
            .load_into_lookup(&allowed_tokens)
            .expect("persisted token state should load in test");
        state.allowed_tokens = Arc::new(allowed_tokens);
        state.token_state_store = Some(store);
        state
    }

    fn managed_admin_inventory_test_state(path: &std::path::Path) -> AppState {
        let mut state = admin_inventory_test_state();
        state.config.managed_api_token_store_file = Some(path.display().to_string());
        state.managed_token_store = Some(Arc::new(
            ManagedTokenStore::load(path).expect("managed token store should load in test"),
        ));
        state
    }

    fn canary_failure_test_state() -> AppState {
        let mut state = test_state();
        state.config.upstream_canary_enabled = true;
        state.config.upstream_canary_timeout_secs = 1;
        state.config.upstream_canary_fail_threshold = 1;
        state.config.upstream_canary_grace_secs = 0;
        state.config.track_url = "http://127.0.0.1:9/track?id=".to_string();
        state
    }

    fn unique_temp_state_file(name: &str) -> std::path::PathBuf {
        let now_ms = now_ms();
        std::env::temp_dir().join(format!("scrap-pid-v3-{name}-{now_ms}.json"))
    }

    #[tokio::test]
    async fn healthz_is_public_without_token() {
        let app = build_router(test_state());

        let req = Request::builder()
            .uri("/healthz")
            .body(Body::empty())
            .expect("request should build");

        let resp = app.oneshot(req).await.expect("response should be returned");
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(resp.headers().contains_key(HEADER_REQUEST_ID));
    }

    #[tokio::test]
    async fn readyz_is_public_without_token() {
        let app = build_router(test_state());

        let req = Request::builder()
            .uri("/readyz")
            .body(Body::empty())
            .expect("request should build");

        let resp = app.oneshot(req).await.expect("response should be returned");
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(resp.headers().contains_key(HEADER_REQUEST_ID));
    }

    #[tokio::test]
    async fn canaryz_is_public_without_token_when_disabled() {
        let app = build_router(test_state());

        let req = Request::builder()
            .uri("/canaryz")
            .body(Body::empty())
            .expect("request should build");

        let resp = app.oneshot(req).await.expect("response should be returned");
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(resp.headers().contains_key(HEADER_REQUEST_ID));
    }

    #[tokio::test]
    async fn missing_token_returns_json_unauthorized() {
        let app = build_router(test_state());

        let req = Request::builder()
            .uri("/v1/track/detail?id=P2511250078195")
            .body(Body::empty())
            .expect("request should build");

        let resp = app.oneshot(req).await.expect("response should be returned");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        let request_id = resp
            .headers()
            .get(HEADER_REQUEST_ID)
            .and_then(|value| value.to_str().ok())
            .map(ToString::to_string)
            .expect("request id header should exist");

        let body = to_bytes(resp.into_body(), 1024 * 16)
            .await
            .expect("body should be readable");
        let json: serde_json::Value =
            serde_json::from_slice(&body).expect("unauthorized response should be JSON");

        assert_eq!(json["error"]["code"], "UNAUTHORIZED");
        assert_eq!(json["error"]["retryable"], false);
        assert_eq!(json["error"]["request_id"], request_id);
    }

    #[tokio::test]
    async fn rotated_token_is_accepted() {
        let app = build_router(test_state());

        let req = Request::builder()
            .uri("/metrics")
            .header("X-Api-Token", "rotated-token")
            .body(Body::empty())
            .expect("request should build");

        let resp = app.oneshot(req).await.expect("response should be returned");
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[test]
    fn access_log_identity_resolves_known_token_metadata() {
        let state = test_state();
        let mut headers = HeaderMap::new();
        headers.insert("X-Api-Token", HeaderValue::from_static("secret-token"));

        let identity = build_access_log_identity(&state, &headers);

        assert!(identity.token_present);
        assert_eq!(identity.token_id.as_deref(), Some("legacy-1"));
        assert_eq!(identity.token_source, Some(TokenSource::LegacyFullAccess));
    }

    #[tokio::test]
    async fn authorized_response_includes_rate_limit_headers() {
        let mut state = test_state();
        state.config.rate_limit_per_minute = 2;
        state.config.rate_limit_burst_capacity = 2;
        state.config.rate_limit_burst_window_secs = 60;
        state.rate_limiter = Arc::new(RateLimiter::new(2, 2, 60));
        let app = build_router(state);

        let req = Request::builder()
            .uri("/metrics")
            .header("X-Api-Token", "secret-token")
            .body(Body::empty())
            .expect("request should build");

        let resp = app.oneshot(req).await.expect("response should be returned");
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers()
                .get(HEADER_RATE_LIMIT_LIMIT)
                .and_then(|value| value.to_str().ok()),
            Some("2")
        );
        assert_eq!(
            resp.headers()
                .get(HEADER_RATE_LIMIT_REMAINING)
                .and_then(|value| value.to_str().ok()),
            Some("1")
        );
        assert_eq!(
            resp.headers()
                .get(HEADER_RATE_LIMIT_BURST_LIMIT)
                .and_then(|value| value.to_str().ok()),
            Some("2")
        );
        assert_eq!(
            resp.headers()
                .get(HEADER_RATE_LIMIT_BURST_REMAINING)
                .and_then(|value| value.to_str().ok()),
            Some("1")
        );
        assert!(resp.headers().contains_key(HEADER_RATE_LIMIT_RESET));
        assert!(resp.headers().contains_key(HEADER_RATE_LIMIT_BURST_RESET));
    }

    #[tokio::test]
    async fn metrics_expose_http_request_duration_histogram() {
        let app = build_router(test_state());

        let status_req = Request::builder()
            .uri("/v1/status")
            .header("X-Api-Token", "secret-token")
            .body(Body::empty())
            .expect("request should build");
        let status_resp = app
            .clone()
            .oneshot(status_req)
            .await
            .expect("status response should be returned");
        assert_eq!(status_resp.status(), StatusCode::OK);

        let metrics_req = Request::builder()
            .uri("/metrics")
            .header("X-Api-Token", "secret-token")
            .body(Body::empty())
            .expect("request should build");
        let metrics_resp = app
            .oneshot(metrics_req)
            .await
            .expect("metrics response should be returned");
        assert_eq!(metrics_resp.status(), StatusCode::OK);

        let body = to_bytes(metrics_resp.into_body(), 1024 * 128)
            .await
            .expect("metrics body should be readable");
        let metrics_text = String::from_utf8(body.to_vec()).expect("metrics should be UTF-8");

        assert!(metrics_text.contains("# TYPE scrap_http_request_duration_ms histogram"));
        assert!(metrics_text.contains(
            "scrap_http_request_duration_ms_count{endpoint=\"v1_status\",method=\"GET\",status_class=\"2xx\"} 1"
        ));
    }

    #[tokio::test]
    async fn rate_limited_response_includes_retry_after_headers() {
        let mut state = test_state();
        state.config.rate_limit_per_minute = 1;
        state.config.rate_limit_burst_capacity = 1;
        state.config.rate_limit_burst_window_secs = 60;
        state.rate_limiter = Arc::new(RateLimiter::new(1, 1, 60));
        let app = build_router(state);

        let first = Request::builder()
            .uri("/metrics")
            .header("X-Api-Token", "secret-token")
            .body(Body::empty())
            .expect("request should build");
        let first_resp = app
            .clone()
            .oneshot(first)
            .await
            .expect("first response should be returned");
        assert_eq!(first_resp.status(), StatusCode::OK);

        let second = Request::builder()
            .uri("/metrics")
            .header("X-Api-Token", "secret-token")
            .body(Body::empty())
            .expect("request should build");
        let second_resp = app
            .oneshot(second)
            .await
            .expect("second response should be returned");
        assert_eq!(second_resp.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            second_resp
                .headers()
                .get(HEADER_RATE_LIMIT_LIMIT)
                .and_then(|value| value.to_str().ok()),
            Some("1")
        );
        assert_eq!(
            second_resp
                .headers()
                .get(HEADER_RATE_LIMIT_REMAINING)
                .and_then(|value| value.to_str().ok()),
            Some("0")
        );
        assert_eq!(
            second_resp
                .headers()
                .get(HEADER_RATE_LIMIT_BURST_LIMIT)
                .and_then(|value| value.to_str().ok()),
            Some("1")
        );
        assert_eq!(
            second_resp
                .headers()
                .get(HEADER_RATE_LIMIT_BURST_REMAINING)
                .and_then(|value| value.to_str().ok()),
            Some("0")
        );
        assert!(second_resp.headers().contains_key(header::RETRY_AFTER));
    }

    #[tokio::test]
    async fn burst_limited_response_returns_429_before_sustained_budget_is_exhausted() {
        let mut state = test_state();
        state.config.rate_limit_per_minute = 120;
        state.config.rate_limit_burst_capacity = 2;
        state.config.rate_limit_burst_window_secs = 60;
        state.rate_limiter = Arc::new(RateLimiter::new(120, 2, 60));
        let app = build_router(state);

        for _ in 0..2 {
            let req = Request::builder()
                .uri("/metrics")
                .header("X-Api-Token", "secret-token")
                .body(Body::empty())
                .expect("request should build");
            let resp = app
                .clone()
                .oneshot(req)
                .await
                .expect("response should be returned");
            assert_eq!(resp.status(), StatusCode::OK);
        }

        let burst_req = Request::builder()
            .uri("/metrics")
            .header("X-Api-Token", "secret-token")
            .body(Body::empty())
            .expect("request should build");
        let burst_resp = app
            .oneshot(burst_req)
            .await
            .expect("response should be returned");

        assert_eq!(burst_resp.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            burst_resp
                .headers()
                .get(HEADER_RATE_LIMIT_LIMIT)
                .and_then(|value| value.to_str().ok()),
            Some("120")
        );
        assert_eq!(
            burst_resp
                .headers()
                .get(HEADER_RATE_LIMIT_REMAINING)
                .and_then(|value| value.to_str().ok()),
            Some("0")
        );
        assert_eq!(
            burst_resp
                .headers()
                .get(HEADER_RATE_LIMIT_BURST_LIMIT)
                .and_then(|value| value.to_str().ok()),
            Some("2")
        );
        assert_eq!(
            burst_resp
                .headers()
                .get(HEADER_RATE_LIMIT_BURST_REMAINING)
                .and_then(|value| value.to_str().ok()),
            Some("0")
        );
        assert!(burst_resp.headers().contains_key(header::RETRY_AFTER));
    }

    #[tokio::test]
    async fn removed_legacy_routes_return_404() {
        let app = build_router(test_state());

        let req = Request::builder()
            .uri("/trackLite?id=P1234567890")
            .header("X-Api-Token", "secret-token")
            .body(Body::empty())
            .expect("request should build");

        let resp = app.oneshot(req).await.expect("response should be returned");
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn v1_track_detail_returns_full_record() {
        let state = test_state();
        state
            .track_html_cache
            .insert(
                "P1234567890".to_string(),
                CachedBody::new_now(Arc::new(sample_track_html("P1234567890"))),
            )
            .await;
        let app = build_router(state);

        let req = Request::builder()
            .uri("/v1/track/detail?id=P1234567890")
            .header("X-Api-Token", "secret-token")
            .body(Body::empty())
            .expect("request should build");

        let resp = app.oneshot(req).await.expect("response should be returned");
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers()
                .get(HEADER_SCHEMA_VERSION)
                .and_then(|value| value.to_str().ok()),
            Some("track-detail.v1")
        );

        let body = to_bytes(resp.into_body(), 1024 * 128)
            .await
            .expect("body should be readable");
        let json: serde_json::Value =
            serde_json::from_slice(&body).expect("detail response should be JSON");

        assert_eq!(json["data"]["id"], "P1234567890");
        assert_eq!(json["data"]["authoritative_entity"], "shipment");
        assert_eq!(
            json["data"]["record"]["detail"]["billing_detail"]["cod_info"]["is_cod"],
            true
        );
        assert_eq!(
            json["data"]["record"]["status_akhir"]["status"],
            "DELIVERED"
        );
        assert_eq!(
            json["data"]["record"]["history"][0]["detail_history"],
            "Connote telah dibuat oleh Petugas Gudang (98765) di lokasi KCU JAYAPURA 99000"
        );
    }

    #[tokio::test]
    async fn v1_status_returns_service_and_deprecation_contract() {
        let app = build_router(test_state());

        let req = Request::builder()
            .uri("/v1/status")
            .header("X-Api-Token", "secret-token")
            .body(Body::empty())
            .expect("request should build");

        let resp = app.oneshot(req).await.expect("response should be returned");
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers()
                .get(HEADER_SCHEMA_VERSION)
                .and_then(|value| value.to_str().ok()),
            Some("service-status.v1")
        );

        let body = to_bytes(resp.into_body(), 1024 * 64)
            .await
            .expect("body should be readable");
        let json: serde_json::Value =
            serde_json::from_slice(&body).expect("service status response should be JSON");

        assert_eq!(json["meta"]["schema_version"], "service-status.v1");
        assert_eq!(json["meta"]["degraded"], false);
        assert_eq!(json["meta"]["warnings"][0], "strict_canary_disabled");
        assert_eq!(json["data"]["service"]["name"], "scrap-pid-v3");
        assert_eq!(json["data"]["service"]["status"], "operational");
        assert_eq!(json["data"]["service"]["strict_canary_enabled"], false);
        assert_eq!(json["data"]["upstream"]["strict_mode"], false);
        assert_eq!(
            json["data"]["deprecation"]["deprecation_headers_enabled"],
            true
        );
        assert_eq!(
            json["data"]["deprecation"]["sunset_at_http"],
            LEGACY_API_SUNSET_HTTP_DATE
        );
        assert_eq!(json["data"]["deprecation"]["successor_api_version"], "v1");
        assert_eq!(
            json["data"]["deprecation"]["migration_reference"],
            "/openapi.json"
        );
        assert_eq!(
            json["data"]["deprecation"]["changelog_path"],
            crate::deprecation::API_CHANGELOG_PATH
        );
        assert_eq!(
            json["data"]["deprecation"]["legacy_endpoints_deprecated"],
            false
        );
        assert!(json["data"]["deprecation"]["affected_endpoints"]
            .as_array()
            .expect("affected_endpoints should be array")
            .is_empty());
    }

    #[tokio::test]
    async fn v1_changelog_returns_entries_and_legacy_migrations() {
        let app = build_router(test_state());

        let req = Request::builder()
            .uri("/v1/changelog")
            .header("X-Api-Token", "secret-token")
            .body(Body::empty())
            .expect("request should build");

        let resp = app.oneshot(req).await.expect("response should be returned");
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers()
                .get(HEADER_SCHEMA_VERSION)
                .and_then(|value| value.to_str().ok()),
            Some("changelog.v1")
        );

        let body = to_bytes(resp.into_body(), 1024 * 64)
            .await
            .expect("body should be readable");
        let json: serde_json::Value =
            serde_json::from_slice(&body).expect("changelog response should be JSON");

        assert_eq!(json["data"]["current_api_version"], "v1");
        assert_eq!(json["data"]["migration_reference"], "/openapi.json");
        assert_eq!(
            json["data"]["deprecation"]["legacy_endpoints_deprecated"],
            false
        );
        assert!(json["data"]["deprecation"]["affected_endpoints"]
            .as_array()
            .expect("affected_endpoints should be array")
            .is_empty());
        let entries = json["data"]["entries"]
            .as_array()
            .expect("entries should be an array");
        assert!(entries
            .iter()
            .any(|entry| entry["id"] == "2026-03-07-admin-token-state-persistence"));
        assert!(entries.iter().any(|entry| {
            entry["id"] == "2026-03-07-webhook-signing-v1"
                && entry["notes"]
                    .as_array()
                    .expect("notes should be an array")
                    .iter()
                    .any(|value| {
                        value
                            .as_str()
                            .is_some_and(|text| text.contains("X-Scrap-Webhook-Signature"))
                    })
        }));
        assert!(entries.iter().any(|entry| {
            entry["id"] == "2026-03-07-observability-histograms"
                && entry["notes"]
                    .as_array()
                    .expect("notes should be an array")
                    .iter()
                    .any(|value| {
                        value
                            .as_str()
                            .is_some_and(|text| text.contains("scrap_http_request_duration_ms"))
                    })
        }));
        assert!(entries.iter().any(|entry| {
            entry["id"] == "2026-03-07-managed-token-store"
                && entry["endpoints_added"]
                    .as_array()
                    .expect("endpoints_added should be an array")
                    .iter()
                    .any(|value| value == "/v1/admin/tokens/managed/create")
        }));
    }

    #[tokio::test]
    async fn v1_incidents_returns_recent_upstream_degraded_event() {
        let app = build_router(canary_failure_test_state());

        let status_req = Request::builder()
            .uri("/v1/status")
            .header("X-Api-Token", "secret-token")
            .body(Body::empty())
            .expect("request should build");
        let status_resp = app
            .clone()
            .oneshot(status_req)
            .await
            .expect("status response should be returned");
        assert_eq!(status_resp.status(), StatusCode::OK);

        let incidents_req = Request::builder()
            .uri("/v1/incidents")
            .header("X-Api-Token", "secret-token")
            .body(Body::empty())
            .expect("request should build");
        let incidents_resp = app
            .oneshot(incidents_req)
            .await
            .expect("incidents response should be returned");
        assert_eq!(incidents_resp.status(), StatusCode::OK);
        assert_eq!(
            incidents_resp
                .headers()
                .get(HEADER_SCHEMA_VERSION)
                .and_then(|value| value.to_str().ok()),
            Some("incidents.v1")
        );
        let incidents_body = to_bytes(incidents_resp.into_body(), 1024 * 64)
            .await
            .expect("incidents body should be readable");
        let incidents_json: serde_json::Value =
            serde_json::from_slice(&incidents_body).expect("incidents response should be JSON");
        assert_eq!(incidents_json["data"]["incidents"]["total_incidents"], 1);
        assert_eq!(
            incidents_json["data"]["incidents"]["recent"][0]["code"],
            "UPSTREAM_DEGRADED"
        );
        assert_eq!(
            incidents_json["data"]["incidents"]["recent"][0]["severity"],
            "critical"
        );
    }

    #[tokio::test]
    async fn v1_bag_detail_returns_full_record() {
        let state = test_state();
        state
            .bag_html_cache
            .insert(
                "BAG123".to_string(),
                CachedBody::new_now(Arc::new(sample_bag_html("BAG123"))),
            )
            .await;
        let app = build_router(state);

        let req = Request::builder()
            .uri("/v1/bag/detail?id=BAG123")
            .header("X-Api-Token", "secret-token")
            .body(Body::empty())
            .expect("request should build");

        let resp = app.oneshot(req).await.expect("response should be returned");
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers()
                .get(HEADER_SCHEMA_VERSION)
                .and_then(|value| value.to_str().ok()),
            Some("bag-detail.v1")
        );

        let body = to_bytes(resp.into_body(), 1024 * 128)
            .await
            .expect("body should be readable");
        let json: serde_json::Value =
            serde_json::from_slice(&body).expect("bag detail should be JSON");

        assert_eq!(json["data"]["id"], "BAG123");
        assert_eq!(json["data"]["authoritative_entity"], "bag");
        assert_eq!(json["data"]["record"]["nomor_kantung"], "BAG123");
        assert_eq!(json["data"]["record"]["items"][0]["no_resi"], "P123");
        assert_eq!(json["data"]["record"]["items"][1]["status"], "DELIVERED");
    }

    #[tokio::test]
    async fn v1_manifest_detail_returns_full_record() {
        let state = test_state();
        state
            .manifest_html_cache
            .insert(
                "MANIFEST123".to_string(),
                CachedBody::new_now(Arc::new(sample_manifest_html())),
            )
            .await;
        let app = build_router(state);

        let req = Request::builder()
            .uri("/v1/manifest/detail?id=MANIFEST123")
            .header("X-Api-Token", "secret-token")
            .body(Body::empty())
            .expect("request should build");

        let resp = app.oneshot(req).await.expect("response should be returned");
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers()
                .get(HEADER_SCHEMA_VERSION)
                .and_then(|value| value.to_str().ok()),
            Some("manifest-detail.v1")
        );

        let body = to_bytes(resp.into_body(), 1024 * 128)
            .await
            .expect("body should be readable");
        let json: serde_json::Value =
            serde_json::from_slice(&body).expect("manifest detail should be JSON");

        assert_eq!(json["data"]["id"], "MANIFEST123");
        assert_eq!(json["data"]["authoritative_entity"], "manifest");
        assert_eq!(json["data"]["record"]["total_berat"], "12 Kg");
        assert_eq!(
            json["data"]["record"]["items"][0]["nomor_kantung"],
            "PID123"
        );
        assert_eq!(json["data"]["record"]["items"][1]["status"], "closed");
    }

    #[tokio::test]
    async fn v1_capabilities_exposes_limits_and_features() {
        let mut state = test_state();
        state
            .config
            .rate_limit_classes
            .insert("partner".to_string(), RateLimitPolicy::new(180, 30, 10));
        state
            .config
            .rate_limit_scope_class_defaults
            .push(RateLimitScopeClassDefault {
                scope: SCOPE_TRACKING_READ.to_string(),
                class_name: "partner".to_string(),
            });
        let app = build_router(state);

        let req = Request::builder()
            .uri("/v1/capabilities")
            .header("X-Api-Token", "secret-token")
            .body(Body::empty())
            .expect("request should build");

        let resp = app.oneshot(req).await.expect("response should be returned");
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers()
                .get(HEADER_SCHEMA_VERSION)
                .and_then(|value| value.to_str().ok()),
            Some("capabilities.v1")
        );

        let body = to_bytes(resp.into_body(), 1024 * 64)
            .await
            .expect("body should be readable");
        let json: serde_json::Value =
            serde_json::from_slice(&body).expect("capabilities response should be JSON");

        assert_eq!(json["meta"]["api_version"], "v1");
        assert_eq!(json["data"]["auth"]["required_header"], "X-Api-Token");
        assert_eq!(
            json["data"]["auth"]["token_introspection_endpoint"],
            "/v1/whoami"
        );
        assert_eq!(json["data"]["auth"]["supports_scopes"], true);
        assert_eq!(json["data"]["auth"]["supports_token_expiry"], true);
        assert_eq!(json["data"]["auth"]["supports_ip_allowlist"], true);
        assert_eq!(json["data"]["auth"]["tracks_last_used_at"], true);
        assert_eq!(json["data"]["auth"]["supports_managed_tokens"], false);
        assert_eq!(
            json["data"]["auth"]["trust_proxy_headers_for_ip_allowlist"],
            false
        );
        assert_eq!(json["data"]["schemas"]["admin_tokens"], "admin-tokens.v1");
        assert_eq!(
            json["data"]["schemas"]["admin_token_mutation"],
            "admin-token-mutation.v1"
        );
        assert_eq!(
            json["data"]["schemas"]["admin_token_rotation"],
            "admin-token-rotation.v1"
        );
        assert_eq!(
            json["data"]["schemas"]["admin_token_secret"],
            "admin-token-secret.v1"
        );
        assert_eq!(json["data"]["schemas"]["bag_detail"], "bag-detail.v1");
        assert_eq!(json["data"]["limits"]["batch_max_items"], 100);
        assert_eq!(json["data"]["limits"]["id_max_length"], 50);
        assert_eq!(json["data"]["limits"]["rate_limit_per_minute"], 60);
        assert_eq!(json["data"]["limits"]["rate_limit_burst_capacity"], 10);
        assert_eq!(json["data"]["limits"]["rate_limit_burst_window_secs"], 10);
        assert_eq!(
            json["data"]["limits"]["rate_limit_class_names"][0],
            "default"
        );
        assert_eq!(
            json["data"]["limits"]["rate_limit_class_names"][1],
            "partner"
        );
        assert_eq!(
            json["data"]["schemas"]["manifest_detail"],
            "manifest-detail.v1"
        );
        assert_eq!(json["data"]["schemas"]["track_detail"], "track-detail.v1");
        assert_eq!(json["data"]["schemas"]["changelog"], "changelog.v1");
        assert_eq!(json["data"]["schemas"]["incidents"], "incidents.v1");
        assert_eq!(
            json["data"]["schemas"]["service_status"],
            "service-status.v1"
        );
        assert_eq!(json["data"]["features"]["admin_token_inventory"], true);
        assert_eq!(json["data"]["features"]["admin_managed_tokens"], false);
        assert_eq!(
            json["data"]["features"]["admin_token_persistent_state"],
            false
        );
        assert_eq!(
            json["data"]["features"]["admin_token_runtime_restore"],
            true
        );
        assert_eq!(json["data"]["features"]["admin_token_runtime_revoke"], true);
        assert_eq!(json["data"]["features"]["admin_token_runtime_rotate"], true);
        assert_eq!(
            json["data"]["features"]["admin_token_secret_rotation"],
            false
        );
        assert_eq!(json["data"]["features"]["api_changelog"], true);
        assert_eq!(json["data"]["features"]["incident_feed"], true);
        assert_eq!(json["data"]["features"]["bag_detail"], true);
        assert_eq!(
            json["data"]["features"]["deprecation_headers_enabled"],
            true
        );
        assert_eq!(json["data"]["features"]["manifest_detail"], true);
        assert_eq!(json["data"]["features"]["service_status"], true);
        assert_eq!(json["data"]["features"]["track_detail"], true);
        assert_eq!(json["data"]["features"]["rate_limit_burst_policy"], true);
        assert_eq!(json["data"]["features"]["rate_limit_scope_defaults"], true);
        assert_eq!(json["data"]["features"]["rate_limit_token_classes"], true);
        assert_eq!(
            json["data"]["features"]["async_track_lite_batch_job"],
            false
        );
        assert_eq!(json["data"]["features"]["openapi_available"], true);
        assert_eq!(json["data"]["features"]["rate_limit_headers"], true);
        assert_eq!(json["data"]["features"]["webhook_signed_delivery"], true);
        assert!(json["data"]["endpoints"]["protected"]
            .as_array()
            .expect("protected endpoints should be an array")
            .iter()
            .any(|value| value == "/v1/admin/tokens/revoke"));
        assert!(json["data"]["endpoints"]["protected"]
            .as_array()
            .expect("protected endpoints should be an array")
            .iter()
            .any(|value| value == "/v1/admin/tokens/managed/create"));
        assert!(json["data"]["endpoints"]["protected"]
            .as_array()
            .expect("protected endpoints should be an array")
            .iter()
            .any(|value| value == "/v1/admin/tokens/rotate"));
        assert!(json["data"]["endpoints"]["protected"]
            .as_array()
            .expect("protected endpoints should be an array")
            .iter()
            .any(|value| value == "/v1/admin/tokens/managed/rotate-secret"));
        assert!(json["data"]["endpoints"]["protected"]
            .as_array()
            .expect("protected endpoints should be an array")
            .iter()
            .any(|value| value == "/v1/track/html"));
        assert!(json["data"]["endpoints"]["protected"]
            .as_array()
            .expect("protected endpoints should be an array")
            .iter()
            .any(|value| value == "/v1/bag/html"));
        assert!(json["data"]["endpoints"]["protected"]
            .as_array()
            .expect("protected endpoints should be an array")
            .iter()
            .any(|value| value == "/v1/manifest/html"));
        assert!(json["data"]["endpoints"]["protected"]
            .as_array()
            .expect("protected endpoints should be an array")
            .iter()
            .any(|value| value == "/v1/changelog"));
        assert!(json["data"]["endpoints"]["protected"]
            .as_array()
            .expect("protected endpoints should be an array")
            .iter()
            .any(|value| value == "/v1/incidents"));
        assert!(!json["data"]["endpoints"]["protected"]
            .as_array()
            .expect("protected endpoints should be an array")
            .iter()
            .any(|value| value == "/track"));
    }

    #[tokio::test]
    async fn v1_admin_tokens_returns_inventory_without_token_secrets() {
        let app = build_router(admin_inventory_test_state());

        let req = Request::builder()
            .uri("/v1/admin/tokens")
            .header("X-Api-Token", "admin-token")
            .body(Body::empty())
            .expect("request should build");

        let resp = app.oneshot(req).await.expect("response should be returned");
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers()
                .get(HEADER_SCHEMA_VERSION)
                .and_then(|value| value.to_str().ok()),
            Some("admin-tokens.v1")
        );

        let body = to_bytes(resp.into_body(), 1024 * 128)
            .await
            .expect("body should be readable");
        let body_text = String::from_utf8(body.to_vec()).expect("body should be utf8");
        assert!(!body_text.contains("\"admin-token\""));
        assert!(!body_text.contains("\"expired-tracking-token\""));
        assert!(!body_text.contains("\"legacy-token\""));

        let json: serde_json::Value =
            serde_json::from_str(&body_text).expect("admin tokens response should be JSON");

        assert_eq!(json["data"]["summary"]["total"], 3);
        assert_eq!(json["data"]["summary"]["active"], 2);
        assert_eq!(json["data"]["summary"]["expired"], 1);
        assert_eq!(json["data"]["summary"]["revoked"], 0);
        assert_eq!(json["data"]["summary"]["explicit"], 2);
        assert_eq!(json["data"]["summary"]["legacy_full_access"], 1);

        let tokens = json["data"]["tokens"]
            .as_array()
            .expect("tokens should be an array");
        assert_eq!(tokens[0]["token_id"], "admin-ops");
        assert_eq!(tokens[1]["token_id"], "legacy-ops");
        assert_eq!(tokens[2]["token_id"], "partner-expired");
        assert_eq!(tokens[2]["status"], "expired");
        assert_eq!(tokens[0]["revoked"], false);
        assert_eq!(tokens[0]["rate_limit_class"], "admin");
        assert_eq!(tokens[0]["rate_limit_per_minute"], 300);
        assert_eq!(tokens[0]["rate_limit_burst_capacity"], 60);
        assert_eq!(tokens[1]["rate_limit_class"], "default");
        assert_eq!(tokens[1]["rate_limit_per_minute"], 60);
        assert_eq!(tokens[2]["rate_limit_class"], "partner");
        assert_eq!(tokens[2]["rate_limit_per_minute"], 180);
        assert!(tokens[0]["last_used_at_ms"].as_u64().is_some());
    }

    #[tokio::test]
    async fn scoped_token_is_forbidden_from_admin_inventory_without_scope() {
        let app = build_router(scoped_test_state());

        let req = Request::builder()
            .uri("/v1/admin/tokens")
            .header("X-Api-Token", "tracking-only-token")
            .body(Body::empty())
            .expect("request should build");

        let resp = app.oneshot(req).await.expect("response should be returned");
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        let body = to_bytes(resp.into_body(), 1024 * 64)
            .await
            .expect("body should be readable");
        let json: serde_json::Value =
            serde_json::from_slice(&body).expect("forbidden response should be JSON");

        assert_eq!(json["error"]["code"], "FORBIDDEN");
        assert_eq!(
            json["error"]["message"],
            "API token does not have required scope: admin:read"
        );
    }

    #[tokio::test]
    async fn admin_can_revoke_and_restore_token_runtime() {
        let app = build_router(admin_inventory_test_state());

        let revoke_req = Request::builder()
            .method("POST")
            .uri("/v1/admin/tokens/revoke")
            .header("X-Api-Token", "admin-token")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                r#"{"token_id":"legacy-ops","reason":"suspected leak","successor_token_id":"admin-ops"}"#
                    .to_string(),
            ))
            .expect("request should build");

        let revoke_resp = app
            .clone()
            .oneshot(revoke_req)
            .await
            .expect("revoke response should be returned");
        assert_eq!(revoke_resp.status(), StatusCode::OK);
        assert_eq!(
            revoke_resp
                .headers()
                .get(HEADER_SCHEMA_VERSION)
                .and_then(|value| value.to_str().ok()),
            Some("admin-token-mutation.v1")
        );

        let revoke_body = to_bytes(revoke_resp.into_body(), 1024 * 64)
            .await
            .expect("revoke body should be readable");
        let revoke_json: serde_json::Value =
            serde_json::from_slice(&revoke_body).expect("revoke response should be JSON");

        assert_eq!(revoke_json["data"]["token"]["token_id"], "legacy-ops");
        assert_eq!(revoke_json["data"]["token"]["revoked"], true);
        assert_eq!(
            revoke_json["data"]["token"]["revoked_by_token_id"],
            "admin-ops"
        );
        assert_eq!(
            revoke_json["data"]["token"]["revoke_reason"],
            "suspected leak"
        );
        assert_eq!(
            revoke_json["data"]["token"]["successor_token_id"],
            "admin-ops"
        );
        assert_eq!(revoke_json["data"]["operation"]["action"], "revoked");
        assert_eq!(revoke_json["data"]["operation"]["runtime_only"], true);
        assert_eq!(revoke_json["data"]["operation"]["persisted"], false);
        assert_eq!(revoke_json["meta"]["warnings"][0], "runtime_only_change");

        let blocked_req = Request::builder()
            .uri("/v1/status")
            .header("X-Api-Token", "legacy-token")
            .body(Body::empty())
            .expect("request should build");
        let blocked_resp = app
            .clone()
            .oneshot(blocked_req)
            .await
            .expect("blocked response should be returned");
        assert_eq!(blocked_resp.status(), StatusCode::UNAUTHORIZED);

        let blocked_body = to_bytes(blocked_resp.into_body(), 1024 * 16)
            .await
            .expect("blocked body should be readable");
        let blocked_json: serde_json::Value =
            serde_json::from_slice(&blocked_body).expect("blocked response should be JSON");
        assert_eq!(blocked_json["error"]["code"], "TOKEN_REVOKED");

        let restore_req = Request::builder()
            .method("POST")
            .uri("/v1/admin/tokens/restore")
            .header("X-Api-Token", "admin-token")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"token_id":"legacy-ops"}"#.to_string()))
            .expect("request should build");

        let restore_resp = app
            .clone()
            .oneshot(restore_req)
            .await
            .expect("restore response should be returned");
        assert_eq!(restore_resp.status(), StatusCode::OK);

        let restore_body = to_bytes(restore_resp.into_body(), 1024 * 64)
            .await
            .expect("restore body should be readable");
        let restore_json: serde_json::Value =
            serde_json::from_slice(&restore_body).expect("restore response should be JSON");
        assert_eq!(restore_json["data"]["token"]["revoked"], false);
        assert_eq!(restore_json["data"]["operation"]["action"], "restored");
        assert_eq!(restore_json["data"]["operation"]["runtime_only"], true);
        assert_eq!(restore_json["data"]["operation"]["persisted"], false);
        assert_eq!(restore_json["meta"]["warnings"][0], "runtime_only_change");

        let ok_req = Request::builder()
            .uri("/v1/status")
            .header("X-Api-Token", "legacy-token")
            .body(Body::empty())
            .expect("request should build");
        let ok_resp = app
            .oneshot(ok_req)
            .await
            .expect("ok response should be returned");
        assert_eq!(ok_resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn admin_can_rotate_token_runtime() {
        let app = build_router(admin_inventory_test_state());

        let rotate_req = Request::builder()
            .method("POST")
            .uri("/v1/admin/tokens/rotate")
            .header("X-Api-Token", "admin-token")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                r#"{"from_token_id":"legacy-ops","to_token_id":"admin-ops","reason":"planned cutover"}"#
                    .to_string(),
            ))
            .expect("request should build");

        let rotate_resp = app
            .clone()
            .oneshot(rotate_req)
            .await
            .expect("rotate response should be returned");
        assert_eq!(rotate_resp.status(), StatusCode::OK);
        assert_eq!(
            rotate_resp
                .headers()
                .get(HEADER_SCHEMA_VERSION)
                .and_then(|value| value.to_str().ok()),
            Some("admin-token-rotation.v1")
        );

        let rotate_body = to_bytes(rotate_resp.into_body(), 1024 * 64)
            .await
            .expect("rotate body should be readable");
        let rotate_json: serde_json::Value =
            serde_json::from_slice(&rotate_body).expect("rotate response should be JSON");

        assert_eq!(
            rotate_json["data"]["source_token"]["token_id"],
            "legacy-ops"
        );
        assert_eq!(rotate_json["data"]["source_token"]["revoked"], true);
        assert_eq!(
            rotate_json["data"]["source_token"]["revoke_reason"],
            "planned cutover"
        );
        assert_eq!(
            rotate_json["data"]["source_token"]["successor_token_id"],
            "admin-ops"
        );
        assert_eq!(
            rotate_json["data"]["successor_token"]["token_id"],
            "admin-ops"
        );
        assert_eq!(rotate_json["data"]["successor_token"]["revoked"], false);
        assert_eq!(rotate_json["data"]["operation"]["action"], "rotated");
        assert_eq!(rotate_json["data"]["operation"]["runtime_only"], true);
        assert_eq!(rotate_json["data"]["operation"]["persisted"], false);
        assert_eq!(
            rotate_json["data"]["operation"]["performed_by_token_id"],
            "admin-ops"
        );
        assert_eq!(
            rotate_json["data"]["operation"]["restored_successor"],
            false
        );
        assert_eq!(rotate_json["meta"]["warnings"][0], "runtime_only_change");

        let blocked_req = Request::builder()
            .uri("/v1/status")
            .header("X-Api-Token", "legacy-token")
            .body(Body::empty())
            .expect("request should build");
        let blocked_resp = app
            .oneshot(blocked_req)
            .await
            .expect("blocked response should be returned");
        assert_eq!(blocked_resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn admin_token_revoke_persists_across_state_reload_when_store_is_configured() {
        let path = unique_temp_state_file("admin-token-state");
        let app = build_router(persistent_admin_inventory_test_state(&path));

        let capabilities_req = Request::builder()
            .uri("/v1/capabilities")
            .header("X-Api-Token", "admin-token")
            .body(Body::empty())
            .expect("request should build");
        let capabilities_resp = app
            .clone()
            .oneshot(capabilities_req)
            .await
            .expect("capabilities response should be returned");
        let capabilities_body = to_bytes(capabilities_resp.into_body(), 1024 * 64)
            .await
            .expect("capabilities body should be readable");
        let capabilities_json: serde_json::Value =
            serde_json::from_slice(&capabilities_body).expect("capabilities should be JSON");
        assert_eq!(
            capabilities_json["data"]["features"]["admin_token_persistent_state"],
            true
        );

        let revoke_req = Request::builder()
            .method("POST")
            .uri("/v1/admin/tokens/revoke")
            .header("X-Api-Token", "admin-token")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                r#"{"token_id":"legacy-ops","reason":"persist me"}"#.to_string(),
            ))
            .expect("request should build");

        let revoke_resp = app
            .clone()
            .oneshot(revoke_req)
            .await
            .expect("revoke response should be returned");
        assert_eq!(revoke_resp.status(), StatusCode::OK);
        let revoke_body = to_bytes(revoke_resp.into_body(), 1024 * 64)
            .await
            .expect("revoke body should be readable");
        let revoke_json: serde_json::Value =
            serde_json::from_slice(&revoke_body).expect("revoke response should be JSON");
        assert_eq!(revoke_json["data"]["operation"]["runtime_only"], false);
        assert_eq!(revoke_json["data"]["operation"]["persisted"], true);
        assert!(revoke_json["meta"]["warnings"]
            .as_array()
            .expect("warnings should be an array")
            .is_empty());

        let reloaded_app = build_router(persistent_admin_inventory_test_state(&path));
        let blocked_req = Request::builder()
            .uri("/v1/status")
            .header("X-Api-Token", "legacy-token")
            .body(Body::empty())
            .expect("request should build");
        let blocked_resp = reloaded_app
            .clone()
            .oneshot(blocked_req)
            .await
            .expect("blocked response should be returned");
        assert_eq!(blocked_resp.status(), StatusCode::UNAUTHORIZED);

        let inventory_req = Request::builder()
            .uri("/v1/admin/tokens")
            .header("X-Api-Token", "admin-token")
            .body(Body::empty())
            .expect("request should build");
        let inventory_resp = reloaded_app
            .oneshot(inventory_req)
            .await
            .expect("inventory response should be returned");
        assert_eq!(inventory_resp.status(), StatusCode::OK);
        let inventory_body = to_bytes(inventory_resp.into_body(), 1024 * 64)
            .await
            .expect("inventory body should be readable");
        let inventory_json: serde_json::Value =
            serde_json::from_slice(&inventory_body).expect("inventory response should be JSON");
        assert_eq!(inventory_json["data"]["summary"]["revoked"], 1);
        assert_eq!(
            inventory_json["data"]["tokens"][1]["token_id"],
            "legacy-ops"
        );
        assert_eq!(inventory_json["data"]["tokens"][1]["revoked"], true);
        assert_eq!(
            inventory_json["data"]["tokens"][1]["revoke_reason"],
            "persist me"
        );

        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn admin_can_create_managed_token_and_use_it_immediately() {
        let path = unique_temp_state_file("managed-token-store");
        let app = build_router(managed_admin_inventory_test_state(&path));

        let create_req = Request::builder()
            .method("POST")
            .uri("/v1/admin/tokens/managed/create")
            .header("X-Api-Token", "admin-token")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                r#"{"token_id":"managed-partner","label":"Managed Partner","scopes":["tracking:read"]}"#
                    .to_string(),
            ))
            .expect("request should build");
        let create_resp = app
            .clone()
            .oneshot(create_req)
            .await
            .expect("create response should be returned");
        assert_eq!(create_resp.status(), StatusCode::CREATED);
        assert_eq!(
            create_resp
                .headers()
                .get(HEADER_SCHEMA_VERSION)
                .and_then(|value| value.to_str().ok()),
            Some("admin-token-secret.v1")
        );
        let create_body = to_bytes(create_resp.into_body(), 1024 * 64)
            .await
            .expect("create body should be readable");
        let create_json: serde_json::Value =
            serde_json::from_slice(&create_body).expect("create response should be JSON");
        let managed_token = create_json["data"]["token"]
            .as_str()
            .expect("managed token should be returned")
            .to_string();
        assert!(managed_token.starts_with("mt_"));
        assert_eq!(create_json["data"]["token_info"]["token_source"], "managed");
        assert_eq!(create_json["data"]["operation"]["action"], "created");

        let whoami_req = Request::builder()
            .uri("/v1/whoami")
            .header("X-Api-Token", managed_token.as_str())
            .body(Body::empty())
            .expect("whoami request should build");
        let whoami_resp = app
            .clone()
            .oneshot(whoami_req)
            .await
            .expect("whoami response should be returned");
        assert_eq!(whoami_resp.status(), StatusCode::OK);
        let whoami_body = to_bytes(whoami_resp.into_body(), 1024 * 64)
            .await
            .expect("whoami body should be readable");
        let whoami_json: serde_json::Value =
            serde_json::from_slice(&whoami_body).expect("whoami response should be JSON");
        assert_eq!(whoami_json["data"]["token_id"], "managed-partner");
        assert_eq!(whoami_json["data"]["token_source"], "managed");

        let inventory_req = Request::builder()
            .uri("/v1/admin/tokens")
            .header("X-Api-Token", "admin-token")
            .body(Body::empty())
            .expect("inventory request should build");
        let inventory_resp = app
            .oneshot(inventory_req)
            .await
            .expect("inventory response should be returned");
        assert_eq!(inventory_resp.status(), StatusCode::OK);
        let inventory_body = to_bytes(inventory_resp.into_body(), 1024 * 64)
            .await
            .expect("inventory body should be readable");
        let inventory_json: serde_json::Value =
            serde_json::from_slice(&inventory_body).expect("inventory response should be JSON");
        assert_eq!(inventory_json["data"]["summary"]["managed"], 1);

        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn admin_can_rotate_managed_token_secret_and_reload_it() {
        let path = unique_temp_state_file("managed-token-rotate-store");
        let app = build_router(managed_admin_inventory_test_state(&path));

        let create_req = Request::builder()
            .method("POST")
            .uri("/v1/admin/tokens/managed/create")
            .header("X-Api-Token", "admin-token")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                r#"{"token_id":"managed-ops","scopes":["tracking:read"]}"#.to_string(),
            ))
            .expect("create request should build");
        let create_resp = app
            .clone()
            .oneshot(create_req)
            .await
            .expect("create response should be returned");
        let create_body = to_bytes(create_resp.into_body(), 1024 * 64)
            .await
            .expect("create body should be readable");
        let create_json: serde_json::Value =
            serde_json::from_slice(&create_body).expect("create response should be JSON");
        let old_token = create_json["data"]["token"]
            .as_str()
            .expect("old token should exist")
            .to_string();

        let rotate_req = Request::builder()
            .method("POST")
            .uri("/v1/admin/tokens/managed/rotate-secret")
            .header("X-Api-Token", "admin-token")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"token_id":"managed-ops"}"#.to_string()))
            .expect("rotate request should build");
        let rotate_resp = app
            .clone()
            .oneshot(rotate_req)
            .await
            .expect("rotate response should be returned");
        assert_eq!(rotate_resp.status(), StatusCode::OK);
        let rotate_body = to_bytes(rotate_resp.into_body(), 1024 * 64)
            .await
            .expect("rotate body should be readable");
        let rotate_json: serde_json::Value =
            serde_json::from_slice(&rotate_body).expect("rotate response should be JSON");
        let new_token = rotate_json["data"]["token"]
            .as_str()
            .expect("new token should exist")
            .to_string();
        assert_ne!(old_token, new_token);
        assert_eq!(rotate_json["data"]["operation"]["action"], "rotated_secret");
        assert_eq!(
            rotate_json["data"]["operation"]["invalidated_previous_secret"],
            true
        );

        let old_whoami_req = Request::builder()
            .uri("/v1/whoami")
            .header("X-Api-Token", old_token.as_str())
            .body(Body::empty())
            .expect("old whoami request should build");
        let old_whoami_resp = app
            .clone()
            .oneshot(old_whoami_req)
            .await
            .expect("old whoami response should be returned");
        assert_eq!(old_whoami_resp.status(), StatusCode::UNAUTHORIZED);

        let reloaded_app = build_router(managed_admin_inventory_test_state(&path));
        let new_whoami_req = Request::builder()
            .uri("/v1/whoami")
            .header("X-Api-Token", new_token.as_str())
            .body(Body::empty())
            .expect("new whoami request should build");
        let new_whoami_resp = reloaded_app
            .oneshot(new_whoami_req)
            .await
            .expect("new whoami response should be returned");
        assert_eq!(new_whoami_resp.status(), StatusCode::OK);

        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn failed_token_state_persist_records_incident() {
        let state_path = unique_temp_state_file("token-state-file");
        let app = build_router(persistent_admin_inventory_test_state(&state_path));
        std::fs::create_dir_all(&state_path).expect("state dir should be created");

        let revoke_req = Request::builder()
            .method("POST")
            .uri("/v1/admin/tokens/revoke")
            .header("X-Api-Token", "admin-token")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                r#"{"token_id":"legacy-ops","reason":"broken persist"}"#.to_string(),
            ))
            .expect("request should build");
        let revoke_resp = app
            .clone()
            .oneshot(revoke_req)
            .await
            .expect("revoke response should be returned");
        assert_eq!(revoke_resp.status(), StatusCode::SERVICE_UNAVAILABLE);

        let incidents_req = Request::builder()
            .uri("/v1/incidents")
            .header("X-Api-Token", "admin-token")
            .body(Body::empty())
            .expect("request should build");
        let incidents_resp = app
            .oneshot(incidents_req)
            .await
            .expect("incidents response should be returned");
        assert_eq!(incidents_resp.status(), StatusCode::OK);
        let incidents_body = to_bytes(incidents_resp.into_body(), 1024 * 64)
            .await
            .expect("incidents body should be readable");
        let incidents_json: serde_json::Value =
            serde_json::from_slice(&incidents_body).expect("incidents response should be JSON");
        assert_eq!(
            incidents_json["data"]["incidents"]["recent"][0]["code"],
            "TOKEN_STATE_PERSIST"
        );
        assert_eq!(
            incidents_json["data"]["incidents"]["recent"][0]["severity"],
            "critical"
        );

        let _ = std::fs::remove_dir_all(&state_path);
    }

    #[tokio::test]
    async fn failed_token_rotation_persist_rolls_back_runtime_state() {
        let state_path = unique_temp_state_file("token-rotate-state-file");
        let app = build_router(persistent_admin_inventory_test_state(&state_path));
        std::fs::create_dir_all(&state_path).expect("state dir should be created");

        let rotate_req = Request::builder()
            .method("POST")
            .uri("/v1/admin/tokens/rotate")
            .header("X-Api-Token", "admin-token")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                r#"{"from_token_id":"legacy-ops","to_token_id":"admin-ops","reason":"broken rotate persist"}"#
                    .to_string(),
            ))
            .expect("request should build");
        let rotate_resp = app
            .clone()
            .oneshot(rotate_req)
            .await
            .expect("rotate response should be returned");
        assert_eq!(rotate_resp.status(), StatusCode::SERVICE_UNAVAILABLE);

        let ok_req = Request::builder()
            .uri("/v1/status")
            .header("X-Api-Token", "legacy-token")
            .body(Body::empty())
            .expect("request should build");
        let ok_resp = app
            .clone()
            .oneshot(ok_req)
            .await
            .expect("legacy token should still be usable after rollback");
        assert_eq!(ok_resp.status(), StatusCode::OK);

        let inventory_req = Request::builder()
            .uri("/v1/admin/tokens")
            .header("X-Api-Token", "admin-token")
            .body(Body::empty())
            .expect("request should build");
        let inventory_resp = app
            .oneshot(inventory_req)
            .await
            .expect("inventory response should be returned");
        assert_eq!(inventory_resp.status(), StatusCode::OK);
        let inventory_body = to_bytes(inventory_resp.into_body(), 1024 * 64)
            .await
            .expect("inventory body should be readable");
        let inventory_json: serde_json::Value =
            serde_json::from_slice(&inventory_body).expect("inventory response should be JSON");
        assert_eq!(inventory_json["data"]["summary"]["revoked"], 0);

        let _ = std::fs::remove_dir_all(&state_path);
    }

    #[tokio::test]
    async fn scoped_token_is_forbidden_from_admin_runtime_revoke_without_scope() {
        let app = build_router(scoped_test_state());

        let req = Request::builder()
            .method("POST")
            .uri("/v1/admin/tokens/revoke")
            .header("X-Api-Token", "tracking-only-token")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"token_id":"legacy-ops"}"#.to_string()))
            .expect("request should build");

        let resp = app.oneshot(req).await.expect("response should be returned");
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        let body = to_bytes(resp.into_body(), 1024 * 64)
            .await
            .expect("body should be readable");
        let json: serde_json::Value =
            serde_json::from_slice(&body).expect("forbidden response should be JSON");

        assert_eq!(json["error"]["code"], "FORBIDDEN");
        assert_eq!(
            json["error"]["message"],
            "API token does not have required scope: admin:write"
        );
    }

    #[tokio::test]
    async fn v1_whoami_returns_token_metadata_and_scopes() {
        let app = build_router(managed_key_test_state());

        let req = Request::builder()
            .uri("/v1/whoami")
            .header("X-Api-Token", "managed-token")
            .header("CF-Connecting-IP", "203.0.113.10")
            .body(Body::empty())
            .expect("request should build");

        let resp = app.oneshot(req).await.expect("response should be returned");
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers()
                .get(HEADER_SCHEMA_VERSION)
                .and_then(|value| value.to_str().ok()),
            Some("whoami.v1")
        );

        let body = to_bytes(resp.into_body(), 1024 * 64)
            .await
            .expect("body should be readable");
        let json: serde_json::Value =
            serde_json::from_slice(&body).expect("whoami response should be JSON");

        assert_eq!(json["data"]["token_id"], "managed-ops");
        assert_eq!(json["data"]["label"], "Managed Ops");
        assert_eq!(json["data"]["token_source"], "explicit");
        assert_eq!(json["data"]["created_by"], "security-team");
        assert_eq!(json["data"]["created_at_ms"], 1_700_000_000_000_u64);
        assert_eq!(json["data"]["expires_at_ms"], 4_102_444_800_000_u64);
        assert_eq!(json["data"]["rate_limit_class"], "partner");
        assert_eq!(json["data"]["rate_limit_per_minute"], 180);
        assert_eq!(json["data"]["rate_limit_burst_capacity"], 30);
        assert_eq!(json["data"]["rate_limit_burst_window_secs"], 10);
        assert_eq!(json["data"]["allowed_ips"][0], "203.0.113.0/24");
        assert_eq!(json["data"]["client_ip"], "203.0.113.10");
        assert!(json["data"]["last_used_at_ms"].as_u64().is_some());
        assert_eq!(json["data"]["scopes"][0], "tracking:read");
    }

    #[tokio::test]
    async fn token_rate_limit_class_overrides_default_headers_and_enforcement() {
        let mut state = managed_key_test_state();
        state.config.rate_limit_per_minute = 1000;
        state.config.rate_limit_burst_capacity = 100;
        state.config.rate_limit_burst_window_secs = 60;
        state
            .config
            .rate_limit_classes
            .insert("partner".to_string(), RateLimitPolicy::new(120, 2, 60));
        state.rate_limiter = Arc::new(RateLimiter::new(1000, 100, 60));
        let app = build_router(state);

        for _ in 0..2 {
            let req = Request::builder()
                .uri("/v1/whoami")
                .header("X-Api-Token", "managed-token")
                .header("CF-Connecting-IP", "203.0.113.10")
                .body(Body::empty())
                .expect("request should build");
            let resp = app
                .clone()
                .oneshot(req)
                .await
                .expect("response should be returned");
            assert_eq!(resp.status(), StatusCode::OK);
        }

        let third = Request::builder()
            .uri("/v1/whoami")
            .header("X-Api-Token", "managed-token")
            .header("CF-Connecting-IP", "203.0.113.10")
            .body(Body::empty())
            .expect("request should build");
        let resp = app
            .oneshot(third)
            .await
            .expect("response should be returned");

        assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            resp.headers()
                .get(HEADER_RATE_LIMIT_LIMIT)
                .and_then(|value| value.to_str().ok()),
            Some("120")
        );
        assert_eq!(
            resp.headers()
                .get(HEADER_RATE_LIMIT_BURST_LIMIT)
                .and_then(|value| value.to_str().ok()),
            Some("2")
        );
        assert_eq!(
            resp.headers()
                .get(HEADER_RATE_LIMIT_BURST_REMAINING)
                .and_then(|value| value.to_str().ok()),
            Some("0")
        );
    }

    #[tokio::test]
    async fn ip_allowlisted_token_accepts_client_ip_inside_cidr() {
        let app = build_router(managed_key_test_state());

        let req = Request::builder()
            .uri("/v1/whoami")
            .header("X-Api-Token", "managed-token")
            .header("CF-Connecting-IP", "203.0.113.99")
            .body(Body::empty())
            .expect("request should build");

        let resp = app.oneshot(req).await.expect("response should be returned");
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn expired_token_returns_token_expired() {
        let mut state = test_state();
        state.config.api_tokens = vec![ApiTokenConfig::explicit_with_metadata(
            "expired-token",
            "expired-ops",
            Some("Expired Ops".to_string()),
            [SCOPE_TRACKING_READ],
            ApiTokenMetadata {
                expires_at_ms: Some(1),
                ..ApiTokenMetadata::default()
            },
        )];
        state.allowed_tokens = Arc::new(build_token_lookup(&state.config.api_tokens));
        let app = build_router(state);

        let req = Request::builder()
            .uri("/v1/whoami")
            .header("X-Api-Token", "expired-token")
            .body(Body::empty())
            .expect("request should build");

        let resp = app.oneshot(req).await.expect("response should be returned");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        let body = to_bytes(resp.into_body(), 1024 * 16)
            .await
            .expect("body should be readable");
        let json: serde_json::Value =
            serde_json::from_slice(&body).expect("expired response should be JSON");

        assert_eq!(json["error"]["code"], "TOKEN_EXPIRED");
        assert_eq!(json["error"]["message"], "API token has expired");
    }

    #[tokio::test]
    async fn ip_allowlisted_token_rejects_unlisted_client_ip() {
        let app = build_router(managed_key_test_state());

        let req = Request::builder()
            .uri("/v1/whoami")
            .header("X-Api-Token", "managed-token")
            .header("CF-Connecting-IP", "198.51.100.20")
            .body(Body::empty())
            .expect("request should build");

        let resp = app.oneshot(req).await.expect("response should be returned");
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        let body = to_bytes(resp.into_body(), 1024 * 16)
            .await
            .expect("body should be readable");
        let json: serde_json::Value =
            serde_json::from_slice(&body).expect("ip restriction response should be JSON");

        assert_eq!(json["error"]["code"], "IP_NOT_ALLOWED");
        assert_eq!(
            json["error"]["message"],
            "API token is not allowed from the resolved client IP"
        );
    }

    #[tokio::test]
    async fn scoped_token_is_forbidden_from_docs_without_scope() {
        let app = build_router(scoped_test_state());

        let req = Request::builder()
            .uri("/openapi.json")
            .header("X-Api-Token", "tracking-only-token")
            .body(Body::empty())
            .expect("request should build");

        let resp = app.oneshot(req).await.expect("response should be returned");
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            resp.headers()
                .get(HEADER_RATE_LIMIT_REMAINING)
                .and_then(|value| value.to_str().ok()),
            Some("9")
        );
        assert_eq!(
            resp.headers()
                .get(HEADER_RATE_LIMIT_BURST_REMAINING)
                .and_then(|value| value.to_str().ok()),
            Some("9")
        );

        let body = to_bytes(resp.into_body(), 1024 * 64)
            .await
            .expect("body should be readable");
        let json: serde_json::Value =
            serde_json::from_slice(&body).expect("forbidden response should be JSON");

        assert_eq!(json["error"]["code"], "FORBIDDEN");
        assert_eq!(json["error"]["retryable"], false);
        assert_eq!(
            json["error"]["message"],
            "API token does not have required scope: docs:read"
        );
    }

    #[tokio::test]
    async fn openapi_json_is_protected_and_lists_v1_paths() {
        let app = build_router(test_state());

        let req = Request::builder()
            .uri("/openapi.json")
            .header("X-Api-Token", "secret-token")
            .body(Body::empty())
            .expect("request should build");

        let resp = app.oneshot(req).await.expect("response should be returned");
        assert_eq!(resp.status(), StatusCode::OK);

        let body = to_bytes(resp.into_body(), 1024 * 128)
            .await
            .expect("body should be readable");
        let json: serde_json::Value =
            serde_json::from_slice(&body).expect("openapi response should be JSON");

        assert_eq!(json["openapi"], "3.1.0");
        assert!(json["paths"]["/v1/changelog"].is_object());
        assert!(json["paths"]["/v1/incidents"].is_object());
        assert!(json["paths"]["/v1/admin/tokens"].is_object());
        assert!(json["paths"]["/v1/admin/tokens/managed/create"].is_object());
        assert!(json["paths"]["/v1/admin/tokens/revoke"].is_object());
        assert!(json["paths"]["/v1/admin/tokens/restore"].is_object());
        assert!(json["paths"]["/v1/admin/tokens/rotate"].is_object());
        assert!(json["paths"]["/v1/admin/tokens/managed/rotate-secret"].is_object());
        assert!(json["paths"]["/v1/bag/html"].is_object());
        assert!(json["paths"]["/v1/bag/detail"].is_object());
        assert!(json["paths"]["/v1/manifest/html"].is_object());
        assert!(json["paths"]["/v1/manifest/detail"].is_object());
        assert!(json["paths"]["/v1/status"].is_object());
        assert!(json["paths"]["/v1/track/html"].is_object());
        assert!(json["paths"]["/v1/track/detail"].is_object());
    }
}
