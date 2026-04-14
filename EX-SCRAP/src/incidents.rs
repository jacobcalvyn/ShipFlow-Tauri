use std::{
    collections::VecDeque,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IncidentSeverity {
    Info,
    Warning,
    Critical,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServiceIncident {
    pub kind: String,
    pub severity: IncidentSeverity,
    pub code: String,
    pub message: String,
    pub first_seen_at_ms: u64,
    pub last_seen_at_ms: u64,
    pub occurrence_count: u64,
    pub request_id: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServiceIncidentsSnapshot {
    pub total_incidents: usize,
    pub recent: Vec<ServiceIncident>,
}

#[derive(Debug, Clone)]
pub struct ServiceIncidentEvent {
    pub kind: String,
    pub severity: IncidentSeverity,
    pub code: String,
    pub message: String,
    pub request_id: Option<String>,
    pub path: Option<String>,
}

struct IncidentStoreInner {
    recent: VecDeque<ServiceIncident>,
}

pub struct IncidentStore {
    max_events: usize,
    dedupe_window_ms: u64,
    inner: Mutex<IncidentStoreInner>,
}

impl IncidentStore {
    pub fn new(max_events: usize, dedupe_window_ms: u64) -> Self {
        Self {
            max_events: max_events.max(10),
            dedupe_window_ms: dedupe_window_ms.max(1_000),
            inner: Mutex::new(IncidentStoreInner {
                recent: VecDeque::new(),
            }),
        }
    }

    pub fn record(&self, event: ServiceIncidentEvent) {
        let now_ms = now_ms();
        let mut inner = self
            .inner
            .lock()
            .expect("incident store mutex should not be poisoned");

        if let Some(existing) = inner.recent.front_mut() {
            let within_dedupe_window =
                now_ms.saturating_sub(existing.last_seen_at_ms) <= self.dedupe_window_ms;
            let same_key = existing.kind == event.kind
                && existing.severity == event.severity
                && existing.code == event.code
                && existing.message == event.message
                && existing.path == event.path;
            if within_dedupe_window && same_key {
                existing.last_seen_at_ms = now_ms;
                existing.occurrence_count = existing.occurrence_count.saturating_add(1);
                if event.request_id.is_some() {
                    existing.request_id = event.request_id;
                }
                return;
            }
        }

        inner.recent.push_front(ServiceIncident {
            kind: event.kind,
            severity: event.severity,
            code: event.code,
            message: event.message,
            first_seen_at_ms: now_ms,
            last_seen_at_ms: now_ms,
            occurrence_count: 1,
            request_id: event.request_id,
            path: event.path,
        });
        while inner.recent.len() > self.max_events {
            inner.recent.pop_back();
        }
    }

    pub fn snapshot(&self) -> ServiceIncidentsSnapshot {
        let inner = self
            .inner
            .lock()
            .expect("incident store mutex should not be poisoned");
        ServiceIncidentsSnapshot {
            total_incidents: inner.recent.len(),
            recent: inner.recent.iter().cloned().collect(),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{IncidentSeverity, IncidentStore, ServiceIncidentEvent};

    #[test]
    fn incident_store_dedupes_same_event_within_window() {
        let store = IncidentStore::new(20, 60_000);
        store.record(ServiceIncidentEvent {
            kind: "upstream".to_string(),
            severity: IncidentSeverity::Warning,
            code: "UPSTREAM_DEGRADED".to_string(),
            message: "upstream degraded".to_string(),
            request_id: Some("req_a".to_string()),
            path: Some("/v1/status".to_string()),
        });
        store.record(ServiceIncidentEvent {
            kind: "upstream".to_string(),
            severity: IncidentSeverity::Warning,
            code: "UPSTREAM_DEGRADED".to_string(),
            message: "upstream degraded".to_string(),
            request_id: Some("req_b".to_string()),
            path: Some("/v1/status".to_string()),
        });

        let snapshot = store.snapshot();
        assert_eq!(snapshot.total_incidents, 1);
        assert_eq!(snapshot.recent[0].occurrence_count, 2);
        assert_eq!(snapshot.recent[0].request_id.as_deref(), Some("req_b"));
    }

    #[test]
    fn incident_store_keeps_distinct_events_separate() {
        let store = IncidentStore::new(20, 60_000);
        store.record(ServiceIncidentEvent {
            kind: "upstream".to_string(),
            severity: IncidentSeverity::Warning,
            code: "UPSTREAM_DEGRADED".to_string(),
            message: "upstream degraded".to_string(),
            request_id: None,
            path: Some("/v1/status".to_string()),
        });
        store.record(ServiceIncidentEvent {
            kind: "token_state".to_string(),
            severity: IncidentSeverity::Critical,
            code: "TOKEN_STATE_PERSIST".to_string(),
            message: "persist failed".to_string(),
            request_id: None,
            path: Some("/v1/admin/tokens/revoke".to_string()),
        });

        let snapshot = store.snapshot();
        assert_eq!(snapshot.total_incidents, 2);
        assert_eq!(snapshot.recent[0].code, "TOKEN_STATE_PERSIST");
        assert_eq!(snapshot.recent[1].code, "UPSTREAM_DEGRADED");
    }
}
