use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::http::StatusCode;
use base64::{engine::general_purpose::STANDARD as Base64Engine, Engine as _};
use rand::Rng;
use reqwest::Client;
use tracing::{debug, error, warn};

use crate::{
    app_state::AppState,
    error::AppError,
    incidents::{IncidentSeverity, IncidentStore, ServiceIncidentEvent},
    metrics::Metrics,
    request_context::current_request_context,
};

#[derive(Debug, Clone, Copy)]
pub enum CacheStatus {
    Upstream,
    MemoryFresh,
    PersistentFresh,
    MemoryStale,
    PersistentStale,
}

impl CacheStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Upstream => "upstream",
            Self::MemoryFresh => "memory_fresh",
            Self::PersistentFresh => "persistent_fresh",
            Self::MemoryStale => "memory_stale",
            Self::PersistentStale => "persistent_stale",
        }
    }

    pub fn cached(&self) -> bool {
        !matches!(self, Self::Upstream)
    }

    pub fn degraded(&self) -> bool {
        matches!(self, Self::MemoryStale | Self::PersistentStale)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct FetchMeta {
    pub cache_status: CacheStatus,
    pub source_latency_ms: Option<u64>,
    pub cache_age_ms: Option<u64>,
}

impl FetchMeta {
    pub fn new(
        cache_status: CacheStatus,
        source_latency_ms: Option<u64>,
        cache_age_ms: Option<u64>,
    ) -> Self {
        Self {
            cache_status,
            source_latency_ms,
            cache_age_ms,
        }
    }

    pub fn cached(&self) -> bool {
        self.cache_status.cached()
    }

    pub fn degraded(&self) -> bool {
        self.cache_status.degraded()
    }
}

#[derive(Debug, Clone)]
pub struct CachedBody {
    pub body: Arc<String>,
    pub stored_at_ms: u64,
}

impl CachedBody {
    pub fn new(body: Arc<String>, stored_at_ms: u64) -> Self {
        Self { body, stored_at_ms }
    }

    pub fn new_now(body: Arc<String>) -> Self {
        Self::new(body, now_ms())
    }

    pub fn age_ms(&self) -> u64 {
        now_ms().saturating_sub(self.stored_at_ms)
    }
}

#[derive(Debug, Clone)]
pub struct FetchedHtml {
    pub url: String,
    pub body: Arc<String>,
    pub meta: FetchMeta,
}

#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
struct FetchError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl FetchError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    fn server_busy() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "SERVER_BUSY",
            "server busy: concurrency limit reached",
        )
    }

    fn limiter_closed() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "CONCURRENCY_LIMITER_CLOSED",
            "concurrency limiter closed",
        )
    }

    fn upstream_request(err: reqwest::Error) -> Self {
        if err.is_timeout() {
            return Self::new(
                StatusCode::GATEWAY_TIMEOUT,
                "UPSTREAM_TIMEOUT",
                err.to_string(),
            );
        }

        Self::new(StatusCode::BAD_GATEWAY, "UPSTREAM_REQUEST", err.to_string())
    }

    fn upstream_status(status: StatusCode) -> Self {
        Self::new(
            StatusCode::BAD_GATEWAY,
            "UPSTREAM_STATUS",
            format!("upstream returned status {}", status),
        )
    }

    fn upstream_body(err: reqwest::Error) -> Self {
        Self::new(StatusCode::BAD_GATEWAY, "UPSTREAM_BODY", err.to_string())
    }

    fn into_app_error(self) -> AppError {
        AppError::new(self.status, self.code, anyhow::anyhow!(self.message))
    }
}

/// Encode ID dan gabungkan dengan base URL dari konfigurasi.
pub fn build_url(base_url: &str, id: &str) -> String {
    let encoded_id = Base64Engine
        .encode(id)
        .replace('+', "%2B")
        .replace('/', "%2F")
        .replace('=', "%3D");
    format!("{base_url}{encoded_id}")
}

struct FetchPlan<'a> {
    client: &'a Client,
    base_url: &'a str,
    semaphore: &'a tokio::sync::Semaphore,
    singleflight: &'a moka::future::Cache<String, FetchedHtml>,
    cache: &'a moka::future::Cache<String, CachedBody>,
    stale_cache: &'a moka::future::Cache<String, CachedBody>,
    persistent_cache: Option<&'a crate::persistent_cache::PersistentCache>,
    config: &'a crate::config::AppConfig,
    metrics: &'a Metrics,
    incident_store: &'a IncidentStore,
    kind: &'a str,
    cache_ttl_secs: u64,
}

/// Ambil HTML track (detail resi) dengan batas concurrency + cache.
pub async fn fetch_track_html(
    state: &AppState,
    id: &str,
) -> Result<(String, Arc<String>), AppError> {
    let fetched = fetch_track_html_with_meta(state, id).await?;
    Ok((fetched.url, fetched.body))
}

pub async fn fetch_track_html_with_meta(
    state: &AppState,
    id: &str,
) -> Result<FetchedHtml, AppError> {
    fetch_with_cache_and_limit(
        FetchPlan {
            client: &state.client,
            base_url: &state.config.track_url,
            semaphore: &state.upstream_semaphore,
            singleflight: &state.upstream_singleflight,
            cache: &state.track_html_cache,
            stale_cache: &state.track_stale_cache,
            persistent_cache: state.persistent_cache.as_deref(),
            config: &state.config,
            metrics: &state.metrics,
            incident_store: &state.incident_store,
            kind: "track",
            cache_ttl_secs: state.config.track_cache_ttl_secs,
        },
        id,
    )
    .await
}

/// Ambil HTML bag (nomor kantung) dengan batas concurrency + cache.
pub async fn fetch_bag_html(state: &AppState, id: &str) -> Result<(String, Arc<String>), AppError> {
    let fetched = fetch_bag_html_with_meta(state, id).await?;
    Ok((fetched.url, fetched.body))
}

pub async fn fetch_bag_html_with_meta(state: &AppState, id: &str) -> Result<FetchedHtml, AppError> {
    fetch_with_cache_and_limit(
        FetchPlan {
            client: &state.client,
            base_url: &state.config.bag_url,
            semaphore: &state.upstream_semaphore,
            singleflight: &state.upstream_singleflight,
            cache: &state.bag_html_cache,
            stale_cache: &state.bag_stale_cache,
            persistent_cache: state.persistent_cache.as_deref(),
            config: &state.config,
            metrics: &state.metrics,
            incident_store: &state.incident_store,
            kind: "bag",
            cache_ttl_secs: state.config.bag_cache_ttl_secs,
        },
        id,
    )
    .await
}

/// Ambil HTML manifest dengan batas concurrency + cache.
pub async fn fetch_manifest_html(
    state: &AppState,
    id: &str,
) -> Result<(String, Arc<String>), AppError> {
    let fetched = fetch_manifest_html_with_meta(state, id).await?;
    Ok((fetched.url, fetched.body))
}

pub async fn fetch_manifest_html_with_meta(
    state: &AppState,
    id: &str,
) -> Result<FetchedHtml, AppError> {
    fetch_with_cache_and_limit(
        FetchPlan {
            client: &state.client,
            base_url: &state.config.manifest_url,
            semaphore: &state.upstream_semaphore,
            singleflight: &state.upstream_singleflight,
            cache: &state.manifest_html_cache,
            stale_cache: &state.manifest_stale_cache,
            persistent_cache: state.persistent_cache.as_deref(),
            config: &state.config,
            metrics: &state.metrics,
            incident_store: &state.incident_store,
            kind: "manifest",
            cache_ttl_secs: state.config.manifest_cache_ttl_secs,
        },
        id,
    )
    .await
}

async fn fetch_with_cache_and_limit(
    plan: FetchPlan<'_>,
    id: &str,
) -> Result<FetchedHtml, AppError> {
    let url = build_url(plan.base_url, id);
    let fresh_cache_enabled = plan.config.cache_max_entries > 0 && plan.cache_ttl_secs > 0;
    let stale_enabled = plan.config.stale_if_error_ttl_secs > 0;

    let do_fetch = || async {
        let acquire_result = tokio::time::timeout(
            Duration::from_secs(plan.config.upstream_queue_timeout_secs),
            plan.semaphore.acquire(),
        )
        .await;

        let _permit = match acquire_result {
            Ok(Ok(permit)) => permit,
            Ok(Err(_)) => return Err(FetchError::limiter_closed()),
            Err(_) => {
                plan.metrics.inc_upstream_server_busy();
                return Err(FetchError::server_busy());
            }
        };

        let source_started_at = std::time::Instant::now();
        let body = fetch_html_body(
            plan.client,
            &url,
            plan.config.retry_max_attempts,
            plan.config.retry_base_delay_ms,
            plan.metrics,
            plan.kind,
        )
        .await?;
        let body_arc = Arc::new(body);
        let cached_body = CachedBody::new_now(body_arc.clone());

        if fresh_cache_enabled {
            plan.cache.insert(id.to_string(), cached_body.clone()).await;
        }

        if stale_enabled {
            plan.stale_cache
                .insert(id.to_string(), cached_body.clone())
                .await;
            if let Some(cache_l2) = plan.persistent_cache {
                cache_l2.set_stale(
                    plan.kind,
                    id,
                    body_arc.as_str(),
                    plan.config.stale_if_error_ttl_secs,
                );
            }
        }

        if plan.cache_ttl_secs > 0 {
            if let Some(cache_l2) = plan.persistent_cache {
                cache_l2.set_fresh(plan.kind, id, body_arc.as_str(), plan.cache_ttl_secs);
            }
        }

        debug!(kind = plan.kind, id, "fetch success");
        Ok::<FetchedHtml, FetchError>(FetchedHtml {
            url: url.clone(),
            body: body_arc,
            meta: FetchMeta::new(
                CacheStatus::Upstream,
                Some(source_started_at.elapsed().as_millis() as u64),
                None,
            ),
        })
    };

    if fresh_cache_enabled {
        if let Some(cached) = plan.cache.get(id).await {
            plan.metrics.inc_cache_hit();
            let cache_age_ms = cached.age_ms();
            return Ok(FetchedHtml {
                url,
                body: cached.body,
                meta: FetchMeta::new(CacheStatus::MemoryFresh, None, Some(cache_age_ms)),
            });
        }
    }

    if let Some(cache_l2) = plan.persistent_cache {
        if let Some(redis_cached) = cache_l2.get_fresh(plan.kind, id) {
            plan.metrics.inc_cache_hit();
            plan.metrics.inc_l2_cache_hit();
            let body_arc = Arc::new(redis_cached.body);
            let cached_body = CachedBody::new(body_arc.clone(), redis_cached.stored_at_ms);
            if fresh_cache_enabled {
                plan.cache.insert(id.to_string(), cached_body).await;
            }
            return Ok(FetchedHtml {
                url,
                body: body_arc,
                meta: FetchMeta::new(
                    CacheStatus::PersistentFresh,
                    None,
                    Some(now_ms().saturating_sub(redis_cached.stored_at_ms)),
                ),
            });
        }
        plan.metrics.inc_l2_cache_miss();
    }

    if fresh_cache_enabled {
        plan.metrics.inc_cache_miss();
    }

    let singleflight_key = format!("{}:{id}", plan.kind);
    let fetch_result = plan
        .singleflight
        .try_get_with(singleflight_key.clone(), do_fetch())
        .await;
    plan.singleflight.invalidate(&singleflight_key).await;

    match fetch_result {
        Ok(fetched) => Ok(fetched),
        Err(fetch_err) => {
            if stale_enabled {
                if let Some(stale) = plan.stale_cache.get(id).await {
                    warn!(
                        kind = plan.kind,
                        id, "serving stale cache due to upstream error"
                    );
                    record_upstream_incident(
                        plan.incident_store,
                        IncidentSeverity::Warning,
                        "UPSTREAM_STALE_SERVED",
                        format!(
                            "serving stale {} response due to upstream failure ({})",
                            plan.kind, fetch_err.code
                        ),
                    );
                    plan.metrics.inc_stale_served();
                    let cache_age_ms = stale.age_ms();
                    return Ok(FetchedHtml {
                        url,
                        body: stale.body,
                        meta: FetchMeta::new(CacheStatus::MemoryStale, None, Some(cache_age_ms)),
                    });
                }
                if let Some(cache_l2) = plan.persistent_cache {
                    if let Some(redis_stale) = cache_l2.get_stale(plan.kind, id) {
                        record_upstream_incident(
                            plan.incident_store,
                            IncidentSeverity::Warning,
                            "UPSTREAM_STALE_SERVED",
                            format!(
                                "serving stale {} response due to upstream failure ({})",
                                plan.kind, fetch_err.code
                            ),
                        );
                        plan.metrics.inc_stale_served();
                        plan.metrics.inc_l2_cache_hit();
                        let body_arc = Arc::new(redis_stale.body);
                        plan.stale_cache
                            .insert(
                                id.to_string(),
                                CachedBody::new(body_arc.clone(), redis_stale.stored_at_ms),
                            )
                            .await;
                        return Ok(FetchedHtml {
                            url,
                            body: body_arc,
                            meta: FetchMeta::new(
                                CacheStatus::PersistentStale,
                                None,
                                Some(now_ms().saturating_sub(redis_stale.stored_at_ms)),
                            ),
                        });
                    }
                    plan.metrics.inc_l2_cache_miss();
                }
            }

            record_upstream_incident(
                plan.incident_store,
                severity_for_fetch_error(fetch_err.code),
                fetch_err.code,
                format!("failed to fetch {} upstream data", plan.kind),
            );
            Err(fetch_err.as_ref().clone().into_app_error())
        }
    }
}

async fn fetch_html_body(
    client: &Client,
    url: &str,
    max_attempts: u32,
    base_delay_ms: u64,
    metrics: &Metrics,
    kind: &str,
) -> Result<String, FetchError> {
    if max_attempts == 0 {
        return Err(FetchError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "INVALID_RETRY_CONFIG",
            "retry_max_attempts must be >= 1",
        ));
    }

    for attempt in 0..max_attempts {
        let attempt_number = attempt + 1;
        let is_last_attempt = attempt_number == max_attempts;
        let attempt_started_at = std::time::Instant::now();
        metrics.inc_upstream_attempt();

        match client.get(url).send().await {
            Ok(response) => {
                let status = response.status();
                if status.is_success() {
                    return response
                        .text()
                        .await
                        .map_err(|err| {
                            metrics.observe_upstream_attempt_duration(
                                kind,
                                "body_error",
                                attempt_started_at.elapsed().as_millis() as u64,
                            );
                            FetchError::upstream_body(err)
                        })
                        .inspect(|_| {
                            metrics.observe_upstream_attempt_duration(
                                kind,
                                "success",
                                attempt_started_at.elapsed().as_millis() as u64,
                            );
                        });
                }

                let retryable =
                    status.is_server_error() || status == axum::http::StatusCode::TOO_MANY_REQUESTS;
                metrics.observe_upstream_attempt_duration(
                    kind,
                    "status_error",
                    attempt_started_at.elapsed().as_millis() as u64,
                );
                if !retryable || is_last_attempt {
                    error!(%status, url, attempt = attempt_number, max_attempts, "upstream returned non-success status");
                    return Err(FetchError::upstream_status(status));
                }

                metrics.inc_upstream_retry();
                warn!(%status, url, attempt = attempt_number, max_attempts, "retrying upstream request due to retryable status");
            }
            Err(err) => {
                metrics.observe_upstream_attempt_duration(
                    kind,
                    "request_error",
                    attempt_started_at.elapsed().as_millis() as u64,
                );
                if is_last_attempt {
                    error!(url, error = %err, attempt = attempt_number, max_attempts, "upstream request failed after retries");
                    return Err(FetchError::upstream_request(err));
                }

                metrics.inc_upstream_retry();
                warn!(url, error = %err, attempt = attempt_number, max_attempts, "upstream request failed, will retry");
            }
        }

        let base_delay = base_delay_ms.saturating_mul(2u64.pow(attempt));
        let jitter = rand::rng().random_range(0..100); // 0-100ms jitter
        let delay = Duration::from_millis(base_delay + jitter);

        debug!("request failed, retrying in {:?}...", delay);
        tokio::time::sleep(delay).await;
    }

    Err(FetchError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "UPSTREAM_REQUEST",
        "upstream request failed",
    ))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn severity_for_fetch_error(code: &'static str) -> IncidentSeverity {
    match code {
        "SERVER_BUSY" | "CONCURRENCY_LIMITER_CLOSED" => IncidentSeverity::Warning,
        _ => IncidentSeverity::Critical,
    }
}

fn record_upstream_incident(
    incident_store: &IncidentStore,
    severity: IncidentSeverity,
    code: &'static str,
    message: String,
) {
    let request_context = current_request_context();
    incident_store.record(ServiceIncidentEvent {
        kind: "upstream".to_string(),
        severity,
        code: code.to_string(),
        message,
        request_id: request_context
            .as_ref()
            .map(|context| context.request_id.clone()),
        path: request_context.map(|context| context.path),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        sync::Barrier,
    };

    use crate::incidents::IncidentStore;

    fn test_config() -> crate::config::AppConfig {
        crate::config::AppConfig {
            port: 3000,
            track_url: "https://example.com/track?id=".to_string(),
            bag_url: "https://example.com/bag?id=".to_string(),
            manifest_url: "https://example.com/manifest?id=".to_string(),
            http_max_concurrency: 1,
            http_timeout_secs: 5,
            cache_max_entries: 10,
            track_cache_ttl_secs: 10,
            bag_cache_ttl_secs: 10,
            manifest_cache_ttl_secs: 10,
            upstream_queue_timeout_secs: 0,
            retry_max_attempts: 1,
            retry_base_delay_ms: 0,
            stale_if_error_ttl_secs: 60,
            rate_limit_per_minute: 60,
            rate_limit_burst_capacity: 10,
            rate_limit_burst_window_secs: 10,
            rate_limit_classes: std::collections::HashMap::new(),
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
            api_tokens: vec![crate::auth::ApiTokenConfig::legacy_full_access(
                "secret",
                "legacy-default",
            )],
        }
    }

    #[test]
    fn build_url_escapes_reserved_base64_chars() {
        let url = build_url("https://example.com?id=", "???~~~");
        assert!(url.contains("Pz8%2Ffn5%2B"));

        let url_with_padding = build_url("https://example.com?id=", "??");
        assert!(url_with_padding.ends_with("Pz8%3D"));
    }

    #[tokio::test]
    async fn fetch_html_body_returns_error_on_final_attempt_without_panic() {
        let client = Client::builder()
            .timeout(Duration::from_secs(1))
            .build()
            .expect("client should build");
        let metrics = Metrics::default();
        let err = fetch_html_body(&client, "http://127.0.0.1:9/", 1, 0, &metrics, "track")
            .await
            .expect_err("final attempt should return an error");

        assert_eq!(err.code, "UPSTREAM_REQUEST");
        assert_eq!(err.status, StatusCode::BAD_GATEWAY);
    }

    #[tokio::test]
    async fn fetch_html_body_maps_timeout_to_upstream_timeout() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener should bind");
        let addr = listener.local_addr().expect("listener should have addr");

        let server_task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept should work");
            let mut buf = [0u8; 1024];
            let _ = socket.read(&mut buf).await;
            tokio::time::sleep(Duration::from_millis(200)).await;
        });

        let client = Client::builder()
            .timeout(Duration::from_millis(50))
            .build()
            .expect("client should build");
        let metrics = Metrics::default();
        let err = fetch_html_body(&client, &format!("http://{addr}/"), 1, 0, &metrics, "track")
            .await
            .expect_err("request should timeout");

        assert_eq!(err.code, "UPSTREAM_TIMEOUT");
        assert_eq!(err.status, StatusCode::GATEWAY_TIMEOUT);

        server_task.abort();
    }

    #[tokio::test]
    async fn fetch_with_cache_returns_server_busy_on_queue_timeout() {
        let client = Client::builder().build().expect("client should build");
        let semaphore = tokio::sync::Semaphore::new(0);
        let singleflight = moka::future::Cache::builder().max_capacity(10).build();
        let cache = moka::future::Cache::builder().max_capacity(10).build();
        let stale_cache = moka::future::Cache::builder().max_capacity(10).build();
        let config = test_config();
        let metrics = Metrics::default();
        let incident_store = IncidentStore::new(20, 60_000);

        let err = fetch_with_cache_and_limit(
            FetchPlan {
                client: &client,
                base_url: "https://example.com/track?id=",
                semaphore: &semaphore,
                singleflight: &singleflight,
                cache: &cache,
                stale_cache: &stale_cache,
                persistent_cache: None,
                config: &config,
                metrics: &metrics,
                incident_store: &incident_store,
                kind: "track",
                cache_ttl_secs: 0,
            },
            "ABC",
        )
        .await
        .expect_err("semaphore timeout should fail");

        assert_eq!(err.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(err.code, "SERVER_BUSY");
    }

    #[tokio::test]
    async fn stale_cache_is_served_when_upstream_fails() {
        let client = Client::builder()
            .timeout(Duration::from_millis(200))
            .build()
            .expect("client should build");
        let semaphore = tokio::sync::Semaphore::new(1);
        let singleflight = moka::future::Cache::builder().max_capacity(10).build();
        let cache = moka::future::Cache::builder().max_capacity(10).build();
        let stale_cache = moka::future::Cache::builder().max_capacity(10).build();
        stale_cache
            .insert(
                "ABC".to_string(),
                CachedBody::new(Arc::new("<html>stale</html>".to_string()), now_ms() - 1234),
            )
            .await;

        let config = test_config();
        let metrics = Metrics::default();
        let incident_store = IncidentStore::new(20, 60_000);

        let fetched = fetch_with_cache_and_limit(
            FetchPlan {
                client: &client,
                base_url: "http://127.0.0.1:9/",
                semaphore: &semaphore,
                singleflight: &singleflight,
                cache: &cache,
                stale_cache: &stale_cache,
                persistent_cache: None,
                config: &config,
                metrics: &metrics,
                incident_store: &incident_store,
                kind: "track",
                cache_ttl_secs: 0,
            },
            "ABC",
        )
        .await
        .expect("stale cache should be returned");

        assert_eq!(fetched.body.as_str(), "<html>stale</html>");
        assert_eq!(fetched.meta.cache_status.as_str(), "memory_stale");
        assert!(fetched.meta.cache_age_ms.unwrap_or(0) >= 1234);
    }

    #[tokio::test]
    async fn singleflight_still_coalesces_when_cache_disabled() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener should bind");
        let addr = listener.local_addr().expect("listener should have addr");
        let requests = Arc::new(AtomicUsize::new(0));
        let requests_clone = requests.clone();

        let server_task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.expect("accept should work");
                requests_clone.fetch_add(1, Ordering::SeqCst);

                let mut buf = [0u8; 1024];
                let _ = socket.read(&mut buf).await;
                tokio::time::sleep(Duration::from_millis(100)).await;
                socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 15\r\nConnection: close\r\n\r\n<html>ok</html>",
                    )
                    .await
                    .expect("response should write");
            }
        });

        let client = Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .expect("client should build");
        let semaphore = Arc::new(tokio::sync::Semaphore::new(4));
        let singleflight = moka::future::Cache::builder().max_capacity(10).build();
        let cache = moka::future::Cache::builder().max_capacity(10).build();
        let stale_cache = moka::future::Cache::builder().max_capacity(10).build();
        let mut config = test_config();
        config.cache_max_entries = 0;
        config.track_cache_ttl_secs = 0;

        let barrier = Arc::new(Barrier::new(3));
        let base_url = format!("http://{addr}/?id=");

        let first = {
            let barrier = barrier.clone();
            let base_url = base_url.clone();
            let semaphore = semaphore.clone();
            let singleflight = singleflight.clone();
            let cache = cache.clone();
            let stale_cache = stale_cache.clone();
            let config = config.clone();
            let client = client.clone();
            let incident_store = IncidentStore::new(20, 60_000);
            async move {
                barrier.wait().await;
                let metrics = Metrics::default();
                fetch_with_cache_and_limit(
                    FetchPlan {
                        client: &client,
                        base_url: &base_url,
                        semaphore: semaphore.as_ref(),
                        singleflight: &singleflight,
                        cache: &cache,
                        stale_cache: &stale_cache,
                        persistent_cache: None,
                        config: &config,
                        metrics: &metrics,
                        incident_store: &incident_store,
                        kind: "track",
                        cache_ttl_secs: 0,
                    },
                    "ABC",
                )
                .await
            }
        };

        let second = {
            let barrier = barrier.clone();
            let base_url = base_url.clone();
            let semaphore = semaphore.clone();
            let singleflight = singleflight.clone();
            let cache = cache.clone();
            let stale_cache = stale_cache.clone();
            let config = config.clone();
            let client = client.clone();
            let incident_store = IncidentStore::new(20, 60_000);
            async move {
                barrier.wait().await;
                let metrics = Metrics::default();
                fetch_with_cache_and_limit(
                    FetchPlan {
                        client: &client,
                        base_url: &base_url,
                        semaphore: semaphore.as_ref(),
                        singleflight: &singleflight,
                        cache: &cache,
                        stale_cache: &stale_cache,
                        persistent_cache: None,
                        config: &config,
                        metrics: &metrics,
                        incident_store: &incident_store,
                        kind: "track",
                        cache_ttl_secs: 0,
                    },
                    "ABC",
                )
                .await
            }
        };

        let join_one = tokio::spawn(first);
        let join_two = tokio::spawn(second);
        barrier.wait().await;

        let fetched_one = join_one
            .await
            .expect("first join should succeed")
            .expect("first fetch should succeed");
        let fetched_two = join_two
            .await
            .expect("second join should succeed")
            .expect("second fetch should succeed");

        assert_eq!(fetched_one.body.as_str(), "<html>ok</html>");
        assert_eq!(fetched_two.body.as_str(), "<html>ok</html>");
        assert_eq!(fetched_one.meta.cache_status.as_str(), "upstream");
        assert_eq!(requests.load(Ordering::SeqCst), 1);

        server_task.abort();
    }
}
