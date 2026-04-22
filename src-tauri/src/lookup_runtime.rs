use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::future::Future;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde::Serialize;
use tokio::sync::Notify;

use crate::runtime_log::log_runtime_event;
use crate::tracking::{
    model::{
        BagResponse, LookupKind, ManifestResponse, TrackResponse, TrackingError, TrackingSource,
        TrackingSourceConfig,
    },
    upstream::{
        normalize_and_validate_bag_id, normalize_and_validate_manifest_id,
        normalize_and_validate_shipment_id, resolve_bag_request, resolve_manifest_request,
        resolve_tracking_request,
    },
};

const TRACK_CACHE_TTL_SECS: u64 = 30;
const BAG_CACHE_TTL_SECS: u64 = 60;
const MANIFEST_CACHE_TTL_SECS: u64 = 90;
const ERROR_CACHE_TTL_SECS: u64 = 8;
const CACHE_SUMMARY_MIN_EVENTS: u64 = 20;
const CACHE_SUMMARY_MIN_INTERVAL_SECS: u64 = 60;

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct LookupRequestOptions {
    pub(crate) force_refresh: bool,
}

#[derive(Clone, Copy, Debug)]
struct LookupCachePolicy {
    track_ttl: Duration,
    bag_ttl: Duration,
    manifest_ttl: Duration,
    error_ttl: Duration,
}

impl Default for LookupCachePolicy {
    fn default() -> Self {
        Self {
            track_ttl: Duration::from_secs(TRACK_CACHE_TTL_SECS),
            bag_ttl: Duration::from_secs(BAG_CACHE_TTL_SECS),
            manifest_ttl: Duration::from_secs(MANIFEST_CACHE_TTL_SECS),
            error_ttl: Duration::from_secs(ERROR_CACHE_TTL_SECS),
        }
    }
}

impl LookupCachePolicy {
    fn ttl_for(self, kind: LookupKind) -> Duration {
        match kind {
            LookupKind::Track => self.track_ttl,
            LookupKind::Bag => self.bag_ttl,
            LookupKind::Manifest => self.manifest_ttl,
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct LookupCacheState {
    inner: Arc<Mutex<LookupCacheInner>>,
    policy: LookupCachePolicy,
}

#[derive(Default)]
struct LookupCacheInner {
    entries: HashMap<String, LookupCacheSlot>,
    generation: u64,
    metrics: LookupCacheMetrics,
}

#[derive(Clone)]
enum LookupCacheSlot {
    Ready(CachedLookupEntry),
    Loading(Arc<Notify>),
}

#[derive(Clone)]
struct CachedLookupEntry {
    expires_at: Instant,
    value: CachedLookupValue,
}

#[derive(Clone)]
enum CachedLookupValue {
    Success(String),
    Error(CachedLookupError),
}

#[derive(Clone)]
struct CachedLookupError {
    kind: CachedLookupErrorKind,
    message: String,
}

#[derive(Clone)]
enum CachedLookupErrorKind {
    BadRequest,
    NotFound,
    Upstream,
}

enum LookupCacheAction {
    Return(CachedLookupEntry),
    StartFetch(Arc<Notify>, u64),
    Wait(Arc<Notify>),
}

#[derive(Default)]
struct LookupCacheMetrics {
    overall: LookupCacheMetricBucket,
    track: LookupCacheMetricBucket,
    bag: LookupCacheMetricBucket,
    manifest: LookupCacheMetricBucket,
    last_summary_total: u64,
    last_summary_at: Option<Instant>,
}

#[derive(Clone, Copy, Default)]
struct LookupCacheMetricBucket {
    hits: u64,
    misses: u64,
    bypasses: u64,
    stales: u64,
    coalesced: u64,
    store_successes: u64,
    store_errors: u64,
    invalidations: u64,
}

#[derive(Clone, Copy)]
enum LookupCacheMetricEvent {
    Hit,
    Miss,
    Bypass,
    Stale,
    Coalesced,
    StoreSuccess,
    StoreError,
    Invalidation,
}

impl LookupCacheState {
    pub(crate) fn invalidate_all(&self, reason: &str) {
        let (entry_count, generation, metrics_summary) = {
            let mut inner = self.inner.lock().expect("lookup cache lock poisoned");
            let entry_count = inner.entries.len();
            inner.generation = inner.generation.wrapping_add(1);
            let generation = inner.generation;
            inner.entries.clear();
            let metrics_summary = inner.metrics.record_invalidation();
            (entry_count, generation, metrics_summary)
        };

        log_runtime_event(
            "INFO",
            format!(
                "[ShipFlowCache] invalidate_all reason={reason} generation={generation} cleared_entries={entry_count}"
            ),
        );
        if let Some(summary) = metrics_summary {
            log_runtime_event("INFO", summary);
        }
    }

    async fn resolve_cached_lookup<T, F, Fut>(
        &self,
        kind: LookupKind,
        normalized_id: String,
        source_fingerprint: String,
        options: LookupRequestOptions,
        loader: F,
    ) -> Result<T, TrackingError>
    where
        T: Serialize + DeserializeOwned + Send,
        F: FnOnce() -> Fut + Send,
        Fut: Future<Output = Result<T, TrackingError>> + Send,
    {
        let cache_key = build_cache_key(kind, &source_fingerprint, &normalized_id);
        let mut loader = Some(loader);

        loop {
            let action = self.next_action(&cache_key, kind, &normalized_id, options);

            match action {
                LookupCacheAction::Return(entry) => match entry.value {
                    CachedLookupValue::Success(payload) => {
                        match serde_json::from_str::<T>(&payload) {
                            Ok(value) => return Ok(value),
                            Err(error) => {
                                self.remove_entry(&cache_key);
                                log_runtime_event(
                                    "WARN",
                                    format!(
                                        "[ShipFlowCache] cache_decode_failed kind={} id={} key={} error={error}",
                                        lookup_kind_label(kind),
                                        normalized_id,
                                        cache_key
                                    ),
                                );
                            }
                        }
                    }
                    CachedLookupValue::Error(error) => return Err(error.to_tracking_error()),
                },
                LookupCacheAction::Wait(notify) => {
                    notify.notified().await;
                }
                LookupCacheAction::StartFetch(notify, generation) => {
                    let result = loader
                        .take()
                        .expect("lookup cache loader must only start once")(
                    )
                    .await;
                    let cached_entry = match &result {
                        Ok(payload) => match serde_json::to_string(payload) {
                            Ok(serialized_payload) => Some(CachedLookupEntry::success(
                                kind,
                                serialized_payload,
                                self.policy,
                            )),
                            Err(error) => {
                                log_runtime_event(
                                    "WARN",
                                    format!(
                                        "[ShipFlowCache] cache_store_skipped kind={} id={} key={} error={error}",
                                        lookup_kind_label(kind),
                                        normalized_id,
                                        cache_key
                                    ),
                                );
                                None
                            }
                        },
                        Err(error) => Some(CachedLookupEntry::error(kind, error, self.policy)),
                    };

                    let metrics_summary = {
                        let mut inner = self.inner.lock().expect("lookup cache lock poisoned");
                        if inner.generation == generation {
                            if let Some(entry) = cached_entry {
                                inner
                                    .entries
                                    .insert(cache_key.clone(), LookupCacheSlot::Ready(entry));
                            } else {
                                inner.entries.remove(&cache_key);
                            }
                        }
                        inner.metrics.record_event(
                            kind,
                            if result.is_ok() {
                                LookupCacheMetricEvent::StoreSuccess
                            } else {
                                LookupCacheMetricEvent::StoreError
                            },
                        )
                    };

                    notify.notify_waiters();
                    if let Some(summary) = metrics_summary {
                        log_runtime_event("INFO", summary);
                    }
                    return result;
                }
            }
        }
    }

    fn next_action(
        &self,
        cache_key: &str,
        kind: LookupKind,
        normalized_id: &str,
        options: LookupRequestOptions,
    ) -> LookupCacheAction {
        let now = Instant::now();
        let (action, metrics_summary, event_log) = {
            let mut inner = self.inner.lock().expect("lookup cache lock poisoned");
            let current_slot = inner.entries.get(cache_key).cloned();

            match current_slot {
                Some(LookupCacheSlot::Ready(entry))
                    if !options.force_refresh && !entry.is_expired(now) =>
                {
                    let metrics_summary = inner
                        .metrics
                        .record_event(kind, LookupCacheMetricEvent::Hit);
                    (
                        LookupCacheAction::Return(entry.clone()),
                        metrics_summary,
                        format!(
                            "[ShipFlowCache] cache_hit kind={} id={normalized_id} key={cache_key}",
                            lookup_kind_label(kind)
                        ),
                    )
                }
                Some(LookupCacheSlot::Loading(notify)) => {
                    let metrics_summary = inner
                        .metrics
                        .record_event(kind, LookupCacheMetricEvent::Coalesced);
                    (
                        LookupCacheAction::Wait(notify.clone()),
                        metrics_summary,
                        format!(
                            "[ShipFlowCache] cache_coalesced kind={} id={normalized_id} key={cache_key}",
                            lookup_kind_label(kind)
                        ),
                    )
                }
                Some(LookupCacheSlot::Ready(_entry)) => {
                    let event = if options.force_refresh {
                        LookupCacheMetricEvent::Bypass
                    } else {
                        LookupCacheMetricEvent::Stale
                    };
                    let event_log = if options.force_refresh {
                        format!(
                            "[ShipFlowCache] cache_bypass kind={} id={normalized_id} key={cache_key}",
                            lookup_kind_label(kind)
                        )
                    } else {
                        format!(
                            "[ShipFlowCache] cache_stale kind={} id={normalized_id} key={cache_key}",
                            lookup_kind_label(kind)
                        )
                    };
                    let metrics_summary = inner.metrics.record_event(kind, event);
                    let notify = Arc::new(Notify::new());
                    let generation = inner.generation;
                    inner.entries.insert(
                        cache_key.to_string(),
                        LookupCacheSlot::Loading(notify.clone()),
                    );
                    (
                        LookupCacheAction::StartFetch(notify, generation),
                        metrics_summary,
                        event_log,
                    )
                }
                None => {
                    let metrics_summary = inner
                        .metrics
                        .record_event(kind, LookupCacheMetricEvent::Miss);
                    let notify = Arc::new(Notify::new());
                    let generation = inner.generation;
                    inner.entries.insert(
                        cache_key.to_string(),
                        LookupCacheSlot::Loading(notify.clone()),
                    );
                    (
                        LookupCacheAction::StartFetch(notify, generation),
                        metrics_summary,
                        format!(
                            "[ShipFlowCache] cache_miss kind={} id={normalized_id} key={cache_key}",
                            lookup_kind_label(kind)
                        ),
                    )
                }
            }
        };

        log_runtime_event("INFO", event_log);
        if let Some(summary) = metrics_summary {
            log_runtime_event("INFO", summary);
        }

        action
    }

    fn remove_entry(&self, cache_key: &str) {
        let mut inner = self.inner.lock().expect("lookup cache lock poisoned");
        inner.entries.remove(cache_key);
    }

    #[cfg(test)]
    fn with_policy(policy: LookupCachePolicy) -> Self {
        Self {
            inner: Arc::new(Mutex::new(LookupCacheInner::default())),
            policy,
        }
    }
}

impl CachedLookupEntry {
    fn success(kind: LookupKind, payload: String, policy: LookupCachePolicy) -> Self {
        Self {
            expires_at: Instant::now() + policy.ttl_for(kind),
            value: CachedLookupValue::Success(payload),
        }
    }

    fn error(_kind: LookupKind, error: &TrackingError, policy: LookupCachePolicy) -> Self {
        Self {
            expires_at: Instant::now() + policy.error_ttl,
            value: CachedLookupValue::Error(CachedLookupError::from_tracking_error(error)),
        }
    }
    fn is_expired(&self, now: Instant) -> bool {
        now >= self.expires_at
    }
}

impl CachedLookupError {
    fn from_tracking_error(error: &TrackingError) -> Self {
        match error {
            TrackingError::BadRequest(message) => Self {
                kind: CachedLookupErrorKind::BadRequest,
                message: message.clone(),
            },
            TrackingError::NotFound(message) => Self {
                kind: CachedLookupErrorKind::NotFound,
                message: message.clone(),
            },
            TrackingError::Upstream(message) => Self {
                kind: CachedLookupErrorKind::Upstream,
                message: message.clone(),
            },
        }
    }

    fn to_tracking_error(&self) -> TrackingError {
        match self.kind {
            CachedLookupErrorKind::BadRequest => TrackingError::BadRequest(self.message.clone()),
            CachedLookupErrorKind::NotFound => TrackingError::NotFound(self.message.clone()),
            CachedLookupErrorKind::Upstream => TrackingError::Upstream(self.message.clone()),
        }
    }
}

impl LookupCacheMetrics {
    fn record_event(&mut self, kind: LookupKind, event: LookupCacheMetricEvent) -> Option<String> {
        self.overall.record(event);
        self.bucket_for_kind_mut(kind).record(event);
        self.maybe_build_summary("threshold")
    }

    fn record_invalidation(&mut self) -> Option<String> {
        self.overall.record(LookupCacheMetricEvent::Invalidation);
        let now = Instant::now();
        self.last_summary_total = self.overall.total_events();
        self.last_summary_at = Some(now);
        Some(format!(
            "[ShipFlowCacheMetrics] reason=invalidation totalEvents={} overall{{{}}} track{{{}}} bag{{{}}} manifest{{{}}}",
            self.overall.total_events(),
            self.overall.format_summary(),
            self.track.format_summary(),
            self.bag.format_summary(),
            self.manifest.format_summary()
        ))
    }

    fn bucket_for_kind_mut(&mut self, kind: LookupKind) -> &mut LookupCacheMetricBucket {
        match kind {
            LookupKind::Track => &mut self.track,
            LookupKind::Bag => &mut self.bag,
            LookupKind::Manifest => &mut self.manifest,
        }
    }

    fn maybe_build_summary(&mut self, reason: &str) -> Option<String> {
        let now = Instant::now();
        let total = self.overall.total_events();
        let reason = match self.last_summary_at {
            None if total >= CACHE_SUMMARY_MIN_EVENTS => Some(reason),
            None => None,
            Some(last_summary_at) => {
                let since_last_count = total.saturating_sub(self.last_summary_total);
                if since_last_count >= CACHE_SUMMARY_MIN_EVENTS {
                    Some(reason)
                } else if since_last_count > 0
                    && now.duration_since(last_summary_at)
                        >= Duration::from_secs(CACHE_SUMMARY_MIN_INTERVAL_SECS)
                {
                    Some("interval")
                } else {
                    None
                }
            }
        };

        let reason = reason?;

        self.last_summary_total = total;
        self.last_summary_at = Some(now);

        Some(format!(
            "[ShipFlowCacheMetrics] reason={reason} totalEvents={total} overall{{{}}} track{{{}}} bag{{{}}} manifest{{{}}}",
            self.overall.format_summary(),
            self.track.format_summary(),
            self.bag.format_summary(),
            self.manifest.format_summary()
        ))
    }
}

impl LookupCacheMetricBucket {
    fn record(&mut self, event: LookupCacheMetricEvent) {
        match event {
            LookupCacheMetricEvent::Hit => self.hits += 1,
            LookupCacheMetricEvent::Miss => self.misses += 1,
            LookupCacheMetricEvent::Bypass => self.bypasses += 1,
            LookupCacheMetricEvent::Stale => self.stales += 1,
            LookupCacheMetricEvent::Coalesced => self.coalesced += 1,
            LookupCacheMetricEvent::StoreSuccess => self.store_successes += 1,
            LookupCacheMetricEvent::StoreError => self.store_errors += 1,
            LookupCacheMetricEvent::Invalidation => self.invalidations += 1,
        }
    }

    fn total_events(self) -> u64 {
        self.hits
            + self.misses
            + self.bypasses
            + self.stales
            + self.coalesced
            + self.store_successes
            + self.store_errors
            + self.invalidations
    }

    fn served_from_cache(self) -> u64 {
        self.hits
    }

    fn needed_fetch(self) -> u64 {
        self.misses + self.bypasses + self.stales
    }

    fn hit_ratio_percent(self) -> f64 {
        let denominator = self.served_from_cache() + self.needed_fetch();
        if denominator == 0 {
            return 0.0;
        }

        (self.served_from_cache() as f64 / denominator as f64) * 100.0
    }

    fn format_summary(self) -> String {
        format!(
            "ratio={:.1}% served={} fetch={} hit={} miss={} bypass={} stale={} joined={} store_ok={} store_err={} invalidations={}",
            self.hit_ratio_percent(),
            self.served_from_cache(),
            self.needed_fetch(),
            self.hits,
            self.misses,
            self.bypasses,
            self.stales,
            self.coalesced,
            self.store_successes,
            self.store_errors,
            self.invalidations
        )
    }
}

fn build_cache_key(kind: LookupKind, source_fingerprint: &str, normalized_id: &str) -> String {
    format!(
        "{}:{}:{}",
        lookup_kind_label(kind),
        source_fingerprint,
        normalized_id
    )
}

fn lookup_kind_label(kind: LookupKind) -> &'static str {
    match kind {
        LookupKind::Track => "track",
        LookupKind::Bag => "bag",
        LookupKind::Manifest => "manifest",
    }
}

fn tracking_source_label(source: &TrackingSource) -> &'static str {
    match source {
        TrackingSource::Default => "default",
        TrackingSource::ExternalApi => "external_api",
    }
}

fn source_fingerprint_for_tracking(source_config: &TrackingSourceConfig) -> String {
    let normalized_base_url = source_config
        .external_api_base_url
        .trim()
        .trim_end_matches('/')
        .to_ascii_lowercase();
    let auth_token_hash = hash_string(source_config.external_api_auth_token.trim());

    format!(
        "{}:{}:{}:{}",
        tracking_source_label(&source_config.tracking_source),
        normalized_base_url,
        source_config.allow_insecure_external_api_http,
        auth_token_hash
    )
}

fn hash_string(value: &str) -> String {
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

pub(crate) async fn resolve_tracking_request_cached(
    lookup_cache: &LookupCacheState,
    client: &reqwest::Client,
    source_config: &TrackingSourceConfig,
    shipment_id: &str,
    options: LookupRequestOptions,
) -> Result<TrackResponse, TrackingError> {
    let normalized_shipment_id = normalize_and_validate_shipment_id(shipment_id)?;
    let source_fingerprint = source_fingerprint_for_tracking(source_config);
    let client = client.clone();
    let tracking_source = source_config.clone();
    let lookup_id = normalized_shipment_id.clone();

    lookup_cache
        .resolve_cached_lookup(
            LookupKind::Track,
            normalized_shipment_id,
            source_fingerprint,
            options,
            move || async move {
                resolve_tracking_request(&client, &tracking_source, &lookup_id).await
            },
        )
        .await
}

pub(crate) async fn resolve_bag_request_cached(
    lookup_cache: &LookupCacheState,
    client: &reqwest::Client,
    bag_id: &str,
    options: LookupRequestOptions,
) -> Result<BagResponse, TrackingError> {
    let normalized_bag_id = normalize_and_validate_bag_id(bag_id)?;
    let client = client.clone();
    let lookup_id = normalized_bag_id.clone();

    lookup_cache
        .resolve_cached_lookup(
            LookupKind::Bag,
            normalized_bag_id,
            "pos-bag".into(),
            options,
            move || async move { resolve_bag_request(&client, &lookup_id).await },
        )
        .await
}

pub(crate) async fn resolve_manifest_request_cached(
    lookup_cache: &LookupCacheState,
    client: &reqwest::Client,
    manifest_id: &str,
    options: LookupRequestOptions,
) -> Result<ManifestResponse, TrackingError> {
    let normalized_manifest_id = normalize_and_validate_manifest_id(manifest_id)?;
    let client = client.clone();
    let lookup_id = normalized_manifest_id.clone();

    lookup_cache
        .resolve_cached_lookup(
            LookupKind::Manifest,
            normalized_manifest_id,
            "pos-manifest".into(),
            options,
            move || async move { resolve_manifest_request(&client, &lookup_id).await },
        )
        .await
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use super::{
        source_fingerprint_for_tracking, LookupCacheMetricEvent, LookupCacheMetrics,
        LookupCachePolicy, LookupCacheState, LookupRequestOptions,
    };
    use crate::tracking::model::{BagResponse, LookupKind, TrackingError, TrackingSourceConfig};

    fn create_test_policy() -> LookupCachePolicy {
        LookupCachePolicy {
            track_ttl: Duration::from_millis(20),
            bag_ttl: Duration::from_millis(20),
            manifest_ttl: Duration::from_millis(20),
            error_ttl: Duration::from_millis(10),
        }
    }

    #[test]
    fn builds_operational_summary_after_threshold() {
        let mut metrics = LookupCacheMetrics::default();

        for _ in 0..9 {
            assert!(metrics
                .record_event(LookupKind::Track, LookupCacheMetricEvent::Miss)
                .is_none());
            assert!(metrics
                .record_event(LookupKind::Track, LookupCacheMetricEvent::StoreSuccess)
                .is_none());
        }

        assert!(metrics
            .record_event(LookupKind::Track, LookupCacheMetricEvent::Miss)
            .is_none());
        let summary = metrics
            .record_event(LookupKind::Track, LookupCacheMetricEvent::StoreSuccess)
            .expect("summary should be emitted after enough events");

        assert!(summary.contains("[ShipFlowCacheMetrics]"));
        assert!(summary.contains("track{ratio=0.0% served=0 fetch=10 hit=0 miss=10"));
        assert!(summary.contains("ratio=0.0%"));
    }

    #[test]
    fn returns_cached_success_without_refetching() {
        let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
        runtime.block_on(async {
            let cache = LookupCacheState::with_policy(create_test_policy());
            let fetch_count = Arc::new(AtomicUsize::new(0));

            let first = cache
                .resolve_cached_lookup(
                    LookupKind::Bag,
                    "PID-1".into(),
                    "pos-bag".into(),
                    LookupRequestOptions::default(),
                    {
                        let fetch_count = Arc::clone(&fetch_count);
                        move || async move {
                            fetch_count.fetch_add(1, Ordering::SeqCst);
                            Ok(BagResponse {
                                nomor_kantung: Some("PID-1".into()),
                                ..BagResponse::default()
                            })
                        }
                    },
                )
                .await
                .expect("first lookup should succeed");

            let second = cache
                .resolve_cached_lookup(
                    LookupKind::Bag,
                    "PID-1".into(),
                    "pos-bag".into(),
                    LookupRequestOptions::default(),
                    {
                        let fetch_count = Arc::clone(&fetch_count);
                        move || async move {
                            fetch_count.fetch_add(1, Ordering::SeqCst);
                            Ok(BagResponse {
                                nomor_kantung: Some("PID-1".into()),
                                ..BagResponse::default()
                            })
                        }
                    },
                )
                .await
                .expect("second lookup should succeed");

            assert_eq!(first.nomor_kantung.as_deref(), Some("PID-1"));
            assert_eq!(second.nomor_kantung.as_deref(), Some("PID-1"));
            assert_eq!(fetch_count.load(Ordering::SeqCst), 1);
        });
    }

    #[test]
    fn force_refresh_bypasses_ready_cache() {
        let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
        runtime.block_on(async {
            let cache = LookupCacheState::with_policy(create_test_policy());
            let fetch_count = Arc::new(AtomicUsize::new(0));

            cache
                .resolve_cached_lookup(
                    LookupKind::Track,
                    "P2600001".into(),
                    source_fingerprint_for_tracking(&TrackingSourceConfig::default()),
                    LookupRequestOptions::default(),
                    {
                        let fetch_count = Arc::clone(&fetch_count);
                        move || async move {
                            fetch_count.fetch_add(1, Ordering::SeqCst);
                            Ok(crate::tracking::model::TrackResponse {
                                url: "https://example.test/track/P2600001".into(),
                                detail: crate::tracking::model::TrackDetail::default(),
                                status_akhir: crate::tracking::model::TrackStatusAkhir::default(),
                                pod: crate::tracking::model::TrackPod::default(),
                                history: Vec::new(),
                                history_summary: crate::tracking::model::HistorySummary::default(),
                            })
                        }
                    },
                )
                .await
                .expect("first lookup should succeed");

            cache
                .resolve_cached_lookup(
                    LookupKind::Track,
                    "P2600001".into(),
                    source_fingerprint_for_tracking(&TrackingSourceConfig::default()),
                    LookupRequestOptions {
                        force_refresh: true,
                    },
                    {
                        let fetch_count = Arc::clone(&fetch_count);
                        move || async move {
                            fetch_count.fetch_add(1, Ordering::SeqCst);
                            Ok(crate::tracking::model::TrackResponse {
                                url: "https://example.test/track/P2600001".into(),
                                detail: crate::tracking::model::TrackDetail::default(),
                                status_akhir: crate::tracking::model::TrackStatusAkhir::default(),
                                pod: crate::tracking::model::TrackPod::default(),
                                history: Vec::new(),
                                history_summary: crate::tracking::model::HistorySummary::default(),
                            })
                        }
                    },
                )
                .await
                .expect("force refreshed lookup should succeed");

            assert_eq!(fetch_count.load(Ordering::SeqCst), 2);
        });
    }

    #[test]
    fn coalesces_parallel_requests_for_same_key() {
        let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
        runtime.block_on(async {
            let cache = LookupCacheState::with_policy(create_test_policy());
            let fetch_count = Arc::new(AtomicUsize::new(0));

            let first_task = tokio::spawn({
                let cache = cache.clone();
                let fetch_count = Arc::clone(&fetch_count);
                async move {
                    cache
                        .resolve_cached_lookup(
                            LookupKind::Manifest,
                            "MAN-1".into(),
                            "pos-manifest".into(),
                            LookupRequestOptions::default(),
                            move || async move {
                                fetch_count.fetch_add(1, Ordering::SeqCst);
                                tokio::time::sleep(Duration::from_millis(25)).await;
                                Ok(crate::tracking::model::ManifestResponse {
                                    url: "https://example.test/manifest/MAN-1".into(),
                                    ..crate::tracking::model::ManifestResponse::default()
                                })
                            },
                        )
                        .await
                }
            });

            let second_task = tokio::spawn({
                let cache = cache.clone();
                let fetch_count = Arc::clone(&fetch_count);
                async move {
                    cache
                        .resolve_cached_lookup(
                            LookupKind::Manifest,
                            "MAN-1".into(),
                            "pos-manifest".into(),
                            LookupRequestOptions::default(),
                            move || async move {
                                fetch_count.fetch_add(1, Ordering::SeqCst);
                                Ok(crate::tracking::model::ManifestResponse {
                                    url: "https://example.test/manifest/MAN-1".into(),
                                    ..crate::tracking::model::ManifestResponse::default()
                                })
                            },
                        )
                        .await
                }
            });

            let first = first_task.await.expect("first task should join");
            let second = second_task.await.expect("second task should join");

            assert!(first.is_ok());
            assert!(second.is_ok());
            assert_eq!(fetch_count.load(Ordering::SeqCst), 1);
        });
    }

    #[test]
    fn caches_negative_results_for_a_short_ttl() {
        let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
        runtime.block_on(async {
            let cache = LookupCacheState::with_policy(create_test_policy());
            let fetch_count = Arc::new(AtomicUsize::new(0));

            let first_error = cache
                .resolve_cached_lookup::<BagResponse, _, _>(
                    LookupKind::Bag,
                    "PID-ERR".into(),
                    "pos-bag".into(),
                    LookupRequestOptions::default(),
                    {
                        let fetch_count = Arc::clone(&fetch_count);
                        move || async move {
                            fetch_count.fetch_add(1, Ordering::SeqCst);
                            Err(TrackingError::NotFound("Bag was not found.".into()))
                        }
                    },
                )
                .await
                .expect_err("first lookup should fail");

            let second_error = cache
                .resolve_cached_lookup::<BagResponse, _, _>(
                    LookupKind::Bag,
                    "PID-ERR".into(),
                    "pos-bag".into(),
                    LookupRequestOptions::default(),
                    {
                        let fetch_count = Arc::clone(&fetch_count);
                        move || async move {
                            fetch_count.fetch_add(1, Ordering::SeqCst);
                            Err(TrackingError::NotFound("Bag was not found.".into()))
                        }
                    },
                )
                .await
                .expect_err("second lookup should fail from cache");

            assert!(matches!(first_error, TrackingError::NotFound(_)));
            assert!(matches!(second_error, TrackingError::NotFound(_)));
            assert_eq!(fetch_count.load(Ordering::SeqCst), 1);

            tokio::time::sleep(Duration::from_millis(15)).await;

            cache
                .resolve_cached_lookup::<BagResponse, _, _>(
                    LookupKind::Bag,
                    "PID-ERR".into(),
                    "pos-bag".into(),
                    LookupRequestOptions::default(),
                    {
                        let fetch_count = Arc::clone(&fetch_count);
                        move || async move {
                            fetch_count.fetch_add(1, Ordering::SeqCst);
                            Err(TrackingError::NotFound("Bag was not found.".into()))
                        }
                    },
                )
                .await
                .expect_err("expired negative cache should refetch");

            assert_eq!(fetch_count.load(Ordering::SeqCst), 2);
        });
    }

    #[test]
    fn invalidate_all_forces_the_next_lookup_to_refetch() {
        let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
        runtime.block_on(async {
            let cache = LookupCacheState::with_policy(create_test_policy());
            let fetch_count = Arc::new(AtomicUsize::new(0));

            for _ in 0..2 {
                cache
                    .resolve_cached_lookup(
                        LookupKind::Bag,
                        "PID-RESET".into(),
                        "pos-bag".into(),
                        LookupRequestOptions::default(),
                        {
                            let fetch_count = Arc::clone(&fetch_count);
                            move || async move {
                                fetch_count.fetch_add(1, Ordering::SeqCst);
                                Ok(BagResponse {
                                    nomor_kantung: Some("PID-RESET".into()),
                                    ..BagResponse::default()
                                })
                            }
                        },
                    )
                    .await
                    .expect("lookup should succeed");
            }

            cache.invalidate_all("test_invalidation");

            cache
                .resolve_cached_lookup(
                    LookupKind::Bag,
                    "PID-RESET".into(),
                    "pos-bag".into(),
                    LookupRequestOptions::default(),
                    {
                        let fetch_count = Arc::clone(&fetch_count);
                        move || async move {
                            fetch_count.fetch_add(1, Ordering::SeqCst);
                            Ok(BagResponse {
                                nomor_kantung: Some("PID-RESET".into()),
                                ..BagResponse::default()
                            })
                        }
                    },
                )
                .await
                .expect("lookup after invalidation should succeed");

            assert_eq!(fetch_count.load(Ordering::SeqCst), 2);
        });
    }

    #[test]
    fn invalidation_drops_late_results_from_an_older_generation() {
        let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
        runtime.block_on(async {
            let cache = LookupCacheState::with_policy(LookupCachePolicy {
                bag_ttl: Duration::from_millis(100),
                ..create_test_policy()
            });
            let stale_fetch_count = Arc::new(AtomicUsize::new(0));
            let fresh_fetch_count = Arc::new(AtomicUsize::new(0));

            let stale_task = tokio::spawn({
                let cache = cache.clone();
                let stale_fetch_count = Arc::clone(&stale_fetch_count);
                async move {
                    cache
                        .resolve_cached_lookup(
                            LookupKind::Bag,
                            "PID-GEN".into(),
                            "pos-bag".into(),
                            LookupRequestOptions::default(),
                            move || async move {
                                stale_fetch_count.fetch_add(1, Ordering::SeqCst);
                                tokio::time::sleep(Duration::from_millis(25)).await;
                                Ok(BagResponse {
                                    nomor_kantung: Some("PID-GEN-STALE".into()),
                                    ..BagResponse::default()
                                })
                            },
                        )
                        .await
                }
            });

            tokio::time::sleep(Duration::from_millis(5)).await;
            cache.invalidate_all("test_generation_change");

            let fresh_result = cache
                .resolve_cached_lookup(
                    LookupKind::Bag,
                    "PID-GEN".into(),
                    "pos-bag".into(),
                    LookupRequestOptions::default(),
                    {
                        let fresh_fetch_count = Arc::clone(&fresh_fetch_count);
                        move || async move {
                            fresh_fetch_count.fetch_add(1, Ordering::SeqCst);
                            Ok(BagResponse {
                                nomor_kantung: Some("PID-GEN-FRESH".into()),
                                ..BagResponse::default()
                            })
                        }
                    },
                )
                .await
                .expect("fresh lookup should succeed");

            let stale_result = stale_task
                .await
                .expect("stale task should join")
                .expect("stale lookup should still resolve for its own caller");

            let cached_result = cache
                .resolve_cached_lookup(
                    LookupKind::Bag,
                    "PID-GEN".into(),
                    "pos-bag".into(),
                    LookupRequestOptions::default(),
                    {
                        let fresh_fetch_count = Arc::clone(&fresh_fetch_count);
                        move || async move {
                            fresh_fetch_count.fetch_add(1, Ordering::SeqCst);
                            Ok(BagResponse {
                                nomor_kantung: Some("PID-GEN-LATE".into()),
                                ..BagResponse::default()
                            })
                        }
                    },
                )
                .await
                .expect("cached lookup should succeed");

            assert_eq!(stale_result.nomor_kantung.as_deref(), Some("PID-GEN-STALE"));
            assert_eq!(fresh_result.nomor_kantung.as_deref(), Some("PID-GEN-FRESH"));
            assert_eq!(
                cached_result.nomor_kantung.as_deref(),
                Some("PID-GEN-FRESH")
            );
            assert_eq!(stale_fetch_count.load(Ordering::SeqCst), 1);
            assert_eq!(fresh_fetch_count.load(Ordering::SeqCst), 1);
        });
    }
}
