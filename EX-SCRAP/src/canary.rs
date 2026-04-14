use std::{
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::http::StatusCode;
use serde::Serialize;

use crate::{
    app_state::AppState,
    incidents::{IncidentSeverity, ServiceIncidentEvent},
    request_context::current_request_context,
    upstream::build_url,
};

#[derive(Debug, Clone, Serialize)]
pub struct CanaryResponse {
    pub status: String,
    pub strict_mode: bool,
    pub degraded: bool,
    pub checked_at_ms: u64,
    pub latency_ms: Option<u64>,
    pub upstream_http_status: Option<u16>,
    pub body_bytes: Option<usize>,
    pub consecutive_failures: u32,
    pub fail_threshold: u32,
    pub last_success_at_ms: Option<u64>,
    pub reason: Option<String>,
}

#[derive(Default)]
struct CanaryStateInner {
    consecutive_failures: u32,
    last_success_at_ms: Option<u64>,
}

#[derive(Default)]
pub struct CanaryRuntimeState {
    inner: Mutex<CanaryStateInner>,
}

impl CanaryRuntimeState {
    pub fn new() -> Self {
        Self::default()
    }

    fn mark_success(&self, now_ms: u64) -> CanaryStateSnapshot {
        let mut inner = self
            .inner
            .lock()
            .expect("canary state mutex should not be poisoned");
        inner.consecutive_failures = 0;
        inner.last_success_at_ms = Some(now_ms);
        CanaryStateSnapshot {
            consecutive_failures: inner.consecutive_failures,
            last_success_at_ms: inner.last_success_at_ms,
        }
    }

    fn mark_failure(&self) -> CanaryStateSnapshot {
        let mut inner = self
            .inner
            .lock()
            .expect("canary state mutex should not be poisoned");
        inner.consecutive_failures = inner.consecutive_failures.saturating_add(1);
        CanaryStateSnapshot {
            consecutive_failures: inner.consecutive_failures,
            last_success_at_ms: inner.last_success_at_ms,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct CanaryStateSnapshot {
    consecutive_failures: u32,
    last_success_at_ms: Option<u64>,
}

struct RawProbe {
    latency_ms: u64,
    upstream_http_status: Option<u16>,
    body_bytes: Option<usize>,
    reason: Option<String>,
}

pub async fn probe_upstream_canary(state: &AppState) -> (StatusCode, CanaryResponse) {
    let checked_at_ms = now_ms();
    let strict_mode = state.config.upstream_canary_enabled;
    let fail_threshold = state.config.upstream_canary_fail_threshold.max(1);

    if !strict_mode {
        return (
            StatusCode::OK,
            CanaryResponse {
                status: "ready".to_string(),
                strict_mode: false,
                degraded: false,
                checked_at_ms,
                latency_ms: None,
                upstream_http_status: None,
                body_bytes: None,
                consecutive_failures: 0,
                fail_threshold,
                last_success_at_ms: None,
                reason: Some("strict canary is disabled".to_string()),
            },
        );
    }

    match run_probe_once(state).await {
        Ok(raw) => {
            let state_snapshot = state.canary_state.mark_success(checked_at_ms);
            (
                StatusCode::OK,
                CanaryResponse {
                    status: "ready".to_string(),
                    strict_mode: true,
                    degraded: false,
                    checked_at_ms,
                    latency_ms: Some(raw.latency_ms),
                    upstream_http_status: raw.upstream_http_status,
                    body_bytes: raw.body_bytes,
                    consecutive_failures: state_snapshot.consecutive_failures,
                    fail_threshold,
                    last_success_at_ms: state_snapshot.last_success_at_ms,
                    reason: None,
                },
            )
        }
        Err(raw) => {
            let state_snapshot = state.canary_state.mark_failure();
            let grace_ms = state.config.upstream_canary_grace_secs.saturating_mul(1000);
            let within_grace = state_snapshot
                .last_success_at_ms
                .map(|last_ok| checked_at_ms.saturating_sub(last_ok) <= grace_ms)
                .unwrap_or(false);
            let tolerated = within_grace || state_snapshot.consecutive_failures < fail_threshold;

            let status = if tolerated {
                StatusCode::OK
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            };
            let logical_status = if tolerated { "ready" } else { "degraded" };

            let mut reason = raw
                .reason
                .unwrap_or_else(|| "upstream canary failed".to_string());
            if tolerated {
                reason.push_str(&format!(
                    " (tolerated, failure_streak={}/{}, grace={}s)",
                    state_snapshot.consecutive_failures,
                    fail_threshold,
                    state.config.upstream_canary_grace_secs
                ));
            }

            let request_context = current_request_context();
            state.incident_store.record(ServiceIncidentEvent {
                kind: "upstream".to_string(),
                severity: if tolerated {
                    IncidentSeverity::Warning
                } else {
                    IncidentSeverity::Critical
                },
                code: "UPSTREAM_DEGRADED".to_string(),
                message: reason.clone(),
                request_id: request_context.as_ref().map(|ctx| ctx.request_id.clone()),
                path: None,
            });

            (
                status,
                CanaryResponse {
                    status: logical_status.to_string(),
                    strict_mode: true,
                    degraded: true,
                    checked_at_ms,
                    latency_ms: Some(raw.latency_ms),
                    upstream_http_status: raw.upstream_http_status,
                    body_bytes: raw.body_bytes,
                    consecutive_failures: state_snapshot.consecutive_failures,
                    fail_threshold,
                    last_success_at_ms: state_snapshot.last_success_at_ms,
                    reason: Some(reason),
                },
            )
        }
    }
}

async fn run_probe_once(state: &AppState) -> Result<RawProbe, RawProbe> {
    let canary_url = build_url(&state.config.track_url, &state.config.upstream_canary_id);
    let timeout_secs = state.config.upstream_canary_timeout_secs.max(1);
    let min_body_bytes = state.config.upstream_canary_min_body_bytes.max(32);
    let started_at = Instant::now();

    let response = match state
        .client
        .get(&canary_url)
        .timeout(Duration::from_secs(timeout_secs))
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(_) => {
            return Err(RawProbe {
                latency_ms: started_at.elapsed().as_millis() as u64,
                upstream_http_status: None,
                body_bytes: None,
                reason: Some("upstream request failed".to_string()),
            });
        }
    };

    let upstream_status = response.status();
    if !upstream_status.is_success() {
        return Err(RawProbe {
            latency_ms: started_at.elapsed().as_millis() as u64,
            upstream_http_status: Some(upstream_status.as_u16()),
            body_bytes: None,
            reason: Some(format!("upstream returned {}", upstream_status)),
        });
    }

    let body = match response.text().await {
        Ok(body) => body,
        Err(_) => {
            return Err(RawProbe {
                latency_ms: started_at.elapsed().as_millis() as u64,
                upstream_http_status: Some(upstream_status.as_u16()),
                body_bytes: None,
                reason: Some("failed to read upstream body".to_string()),
            });
        }
    };

    let body_bytes = body.len();
    if body_bytes < min_body_bytes {
        return Err(RawProbe {
            latency_ms: started_at.elapsed().as_millis() as u64,
            upstream_http_status: Some(upstream_status.as_u16()),
            body_bytes: Some(body_bytes),
            reason: Some(format!(
                "upstream body too small: {} bytes (min {})",
                body_bytes, min_body_bytes
            )),
        });
    }

    Ok(RawProbe {
        latency_ms: started_at.elapsed().as_millis() as u64,
        upstream_http_status: Some(upstream_status.as_u16()),
        body_bytes: Some(body_bytes),
        reason: None,
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
