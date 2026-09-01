use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::future::Future;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde::Serialize;
use shipflow_core::{
    model::{
        BagResponse, ContactEnrichment, ContactEnrichmentMetadata, ContactEnrichmentStatus,
        LookupKind, ManifestResponse, TrackResponse, TrackingError, TrackingSource,
        TrackingSourceConfig,
    },
    parser::{parse_lacak_mitra_contact_html_checked, populate_shipment_structure},
    upstream::{
        build_lacak_mitra_tracking_url, normalize_and_validate_bag_id,
        normalize_and_validate_manifest_id, normalize_and_validate_shipment_id,
        read_response_text_limited, resolve_bag_request, resolve_manifest_request,
        resolve_tracking_request,
    },
};
use tokio::sync::{futures::OwnedNotified, Notify};
use tokio::time::timeout;

use crate::contact_cache::{
    ContactCacheEntry, ContactCacheEntryStatus, ContactCacheState, ContactFetchAction,
};
use crate::persistent_store::{persistent_lookup_skip_reason, PersistentLookupStore};

const TRACK_CACHE_TTL_SECS: u64 = 30;
const BAG_CACHE_TTL_SECS: u64 = 60;
const MANIFEST_CACHE_TTL_SECS: u64 = 90;
const ERROR_CACHE_TTL_SECS: u64 = 8;
const CONTACT_LOOKUP_TIMEOUT: Duration = Duration::from_secs(5);
const CACHE_SUMMARY_MIN_EVENTS: u64 = 20;
const CACHE_SUMMARY_MIN_INTERVAL_SECS: u64 = 60;
const MAX_CONTACT_RESPONSE_BYTES: usize = 1024 * 1024;
pub const MAX_IN_MEMORY_LOOKUP_CACHE_ENTRIES: usize = 10_000;
pub const MAX_IN_MEMORY_LOOKUP_CACHE_ENTRY_BYTES: usize = 1024 * 1024;
pub const MAX_IN_MEMORY_LOOKUP_CACHE_BYTES: usize = 128 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Default)]
pub struct LookupRequestOptions {
    pub force_refresh: bool,
}

pub struct TrackingPermitProviders<Primary, Contact> {
    pub primary: Primary,
    pub contact: Contact,
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

type LogSink = Arc<dyn Fn(&str, String) + Send + Sync>;

#[derive(Clone, Default)]
pub struct LookupCacheState {
    inner: Arc<Mutex<LookupCacheInner>>,
    policy: LookupCachePolicy,
    log_sink: Option<LogSink>,
    persistent_store: Option<PersistentLookupStore>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LookupCacheSnapshot {
    pub ready: usize,
    pub loading: usize,
    pub capacity: usize,
    pub bytes: usize,
    pub byte_capacity: usize,
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
    last_accessed_at: Instant,
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
    RateLimited,
    ServiceUnavailable,
    Upstream,
}

enum LookupCacheAction {
    Return(CachedLookupEntry),
    StartFetch {
        notify: Arc<Notify>,
        generation: u64,
        allow_persistent: bool,
    },
    Wait(OwnedNotified),
    Reject(TrackingError),
}

struct LookupFetchGuard {
    state: LookupCacheState,
    cache_key: String,
    notify: Arc<Notify>,
    generation: u64,
    armed: bool,
}

impl LookupFetchGuard {
    fn new(
        state: LookupCacheState,
        cache_key: String,
        notify: Arc<Notify>,
        generation: u64,
    ) -> Self {
        Self {
            state,
            cache_key,
            notify,
            generation,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for LookupFetchGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }

        let mut inner = self.state.inner.lock().expect("lookup cache lock poisoned");
        if inner.generation == self.generation
            && inner.entries.get(&self.cache_key).is_some_and(|slot| {
                matches!(
                    slot,
                    LookupCacheSlot::Loading(current) if Arc::ptr_eq(current, &self.notify)
                )
            })
        {
            inner.entries.remove(&self.cache_key);
        }
        drop(inner);
        self.notify.notify_waiters();
    }
}

enum LookupLoaderError {
    Cacheable(TrackingError),
    NonCacheable(TrackingError),
}

impl LookupLoaderError {
    fn cacheable(error: TrackingError) -> Self {
        Self::Cacheable(error)
    }

    fn non_cacheable(error: TrackingError) -> Self {
        Self::NonCacheable(error)
    }

    fn into_tracking_error(self) -> TrackingError {
        match self {
            Self::Cacheable(error) | Self::NonCacheable(error) => error,
        }
    }
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
    pub fn with_log_sink(log_sink: impl Fn(&str, String) + Send + Sync + 'static) -> Self {
        Self {
            inner: Arc::new(Mutex::new(LookupCacheInner::default())),
            policy: LookupCachePolicy::default(),
            log_sink: Some(Arc::new(log_sink)),
            persistent_store: None,
        }
    }

    pub fn with_persistent_store(mut self, persistent_store: PersistentLookupStore) -> Self {
        self.persistent_store = Some(persistent_store);
        self
    }

    pub fn invalidate_all(&self, reason: &str) {
        let (entry_count, generation, metrics_summary) = {
            let mut inner = self.inner.lock().expect("lookup cache lock poisoned");
            let entry_count = inner.entries.len();
            inner.generation = inner.generation.wrapping_add(1);
            let generation = inner.generation;
            inner.entries.clear();
            let metrics_summary = inner.metrics.record_invalidation();
            (entry_count, generation, metrics_summary)
        };

        self.log(
            "INFO",
            format!(
                "[ShipFlowCache] invalidate_all reason={reason} generation={generation} cleared_entries={entry_count}"
            ),
        );
        if let Some(summary) = metrics_summary {
            self.log("INFO", summary);
        }
    }

    pub fn snapshot(&self) -> LookupCacheSnapshot {
        let inner = self.inner.lock().expect("lookup cache lock poisoned");
        snapshot_lookup_cache(&inner)
    }

    pub fn flush_persistent_store(&self) {
        if let Some(store) = &self.persistent_store {
            store.flush();
        }
    }

    pub fn prune_expired_and_over_capacity(&self) -> LookupCacheSnapshot {
        let (removed, snapshot) = {
            let mut inner = self.inner.lock().expect("lookup cache lock poisoned");
            let removed = prune_lookup_cache(&mut inner, Instant::now());
            (removed, snapshot_lookup_cache(&inner))
        };
        if removed > 0 {
            self.log(
                "INFO",
                format!(
                    "[ShipFlowCache] maintenance removed={removed} ready={} loading={} capacity={} bytes={} byteCapacity={}",
                    snapshot.ready,
                    snapshot.loading,
                    snapshot.capacity,
                    snapshot.bytes,
                    snapshot.byte_capacity
                ),
            );
        }
        snapshot
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
        Fut: Future<Output = Result<T, LookupLoaderError>> + Send,
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
                                self.log(
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
                LookupCacheAction::Wait(notified) => {
                    notified.await;
                }
                LookupCacheAction::Reject(error) => return Err(error),
                LookupCacheAction::StartFetch {
                    notify,
                    generation,
                    allow_persistent,
                } => {
                    let mut fetch_guard = LookupFetchGuard::new(
                        self.clone(),
                        cache_key.clone(),
                        notify.clone(),
                        generation,
                    );
                    if allow_persistent && !options.force_refresh {
                        if let Some(payload) = self
                            .load_persistent_success(
                                kind,
                                &normalized_id,
                                &cache_key,
                                self.policy.ttl_for(kind),
                            )
                            .await
                        {
                            match serde_json::from_str::<T>(&payload) {
                                Ok(value) => {
                                    let payload_bytes = payload.len();
                                    let hydrated = self.resolve_persistent_cache_slot(
                                        &cache_key, kind, payload, generation, &notify,
                                    );
                                    if !hydrated
                                        && payload_bytes > MAX_IN_MEMORY_LOOKUP_CACHE_ENTRY_BYTES
                                    {
                                        self.log(
                                            "INFO",
                                            format!(
                                                "[ShipFlowCache] persistent_cache_hydration_skipped kind={} id={} key={} reason=payload_too_large bytes={} maxBytes={MAX_IN_MEMORY_LOOKUP_CACHE_ENTRY_BYTES}",
                                                lookup_kind_label(kind),
                                                normalized_id,
                                                cache_key,
                                                payload_bytes
                                            ),
                                        );
                                    }
                                    notify.notify_waiters();
                                    fetch_guard.disarm();
                                    return Ok(value);
                                }
                                Err(error) => {
                                    if let Some(store) = &self.persistent_store {
                                        store.enqueue_remove_success(cache_key.clone());
                                    }
                                    self.log(
                                        "WARN",
                                        format!(
                                            "[ShipFlowCache] persistent_cache_decode_failed kind={} id={} key={} error={error}",
                                            lookup_kind_label(kind),
                                            normalized_id,
                                            cache_key
                                        ),
                                    );
                                }
                            }
                        }
                    }

                    let result = loader
                        .take()
                        .expect("lookup cache loader must only start once")(
                    )
                    .await;
                    let cached_entry = match &result {
                        Ok(payload) => match serde_json::to_string(payload) {
                            Ok(serialized_payload)
                                if serialized_payload.len()
                                    <= MAX_IN_MEMORY_LOOKUP_CACHE_ENTRY_BYTES =>
                            {
                                Some(CachedLookupEntry::success(
                                    kind,
                                    serialized_payload,
                                    self.policy,
                                ))
                            }
                            Ok(serialized_payload) => {
                                self.log(
                                    "INFO",
                                    format!(
                                        "[ShipFlowCache] cache_store_skipped kind={} id={} key={} reason=payload_too_large bytes={} maxBytes={MAX_IN_MEMORY_LOOKUP_CACHE_ENTRY_BYTES}",
                                        lookup_kind_label(kind),
                                        normalized_id,
                                        cache_key,
                                        serialized_payload.len()
                                    ),
                                );
                                None
                            }
                            Err(error) => {
                                self.log(
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
                        Err(LookupLoaderError::Cacheable(error)) => {
                            Some(CachedLookupEntry::error(kind, error, self.policy))
                        }
                        Err(LookupLoaderError::NonCacheable(_)) => None,
                    };

                    if let Some(entry) = cached_entry.as_ref() {
                        self.store_persistent_success(kind, &normalized_id, &cache_key, entry);
                    }

                    let metrics_summary = {
                        let mut inner = self.inner.lock().expect("lookup cache lock poisoned");
                        if inner.generation == generation {
                            if let Some(entry) = cached_entry {
                                inner
                                    .entries
                                    .insert(cache_key.clone(), LookupCacheSlot::Ready(entry));
                                prune_lookup_cache(&mut inner, Instant::now());
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
                    fetch_guard.disarm();
                    if let Some(summary) = metrics_summary {
                        self.log("INFO", summary);
                    }
                    return result.map_err(LookupLoaderError::into_tracking_error);
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
                    let mut entry = entry;
                    entry.last_accessed_at = now;
                    inner
                        .entries
                        .insert(cache_key.to_string(), LookupCacheSlot::Ready(entry.clone()));
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
                        LookupCacheAction::Wait(notify.clone().notified_owned()),
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
                    prune_lookup_cache(&mut inner, now);
                    (
                        LookupCacheAction::StartFetch {
                            notify,
                            generation,
                            allow_persistent: false,
                        },
                        metrics_summary,
                        event_log,
                    )
                }
                None => {
                    let metrics_summary = inner
                        .metrics
                        .record_event(kind, LookupCacheMetricEvent::Miss);
                    prune_lookup_cache(&mut inner, now);
                    if inner.entries.len() >= MAX_IN_MEMORY_LOOKUP_CACHE_ENTRIES {
                        (
                            LookupCacheAction::Reject(TrackingError::ServiceUnavailable(
                                "The in-memory lookup cache is at capacity. Please retry shortly."
                                    .into(),
                            )),
                            metrics_summary,
                            format!(
                                "[ShipFlowCache] cache_capacity_rejected kind={} id={normalized_id} key={cache_key} capacity={MAX_IN_MEMORY_LOOKUP_CACHE_ENTRIES}",
                                lookup_kind_label(kind)
                            ),
                        )
                    } else {
                        let notify = Arc::new(Notify::new());
                        let generation = inner.generation;
                        inner.entries.insert(
                            cache_key.to_string(),
                            LookupCacheSlot::Loading(notify.clone()),
                        );
                        (
                            LookupCacheAction::StartFetch {
                                notify,
                                generation,
                                allow_persistent: true,
                            },
                            metrics_summary,
                            format!(
                            "[ShipFlowCache] cache_miss kind={} id={normalized_id} key={cache_key}",
                            lookup_kind_label(kind)
                        ),
                        )
                    }
                }
            }
        };

        self.log("INFO", event_log);
        if let Some(summary) = metrics_summary {
            self.log("INFO", summary);
        }

        action
    }

    fn resolve_persistent_cache_slot(
        &self,
        cache_key: &str,
        kind: LookupKind,
        payload: String,
        generation: u64,
        notify: &Arc<Notify>,
    ) -> bool {
        let mut inner = self.inner.lock().expect("lookup cache lock poisoned");
        let owns_loading_slot = inner.generation == generation
            && inner.entries.get(cache_key).is_some_and(|slot| {
                matches!(
                    slot,
                    LookupCacheSlot::Loading(current) if Arc::ptr_eq(current, notify)
                )
            });
        if !owns_loading_slot {
            return false;
        }

        if payload.len() > MAX_IN_MEMORY_LOOKUP_CACHE_ENTRY_BYTES {
            inner.entries.remove(cache_key);
            return false;
        }

        inner.entries.insert(
            cache_key.to_string(),
            LookupCacheSlot::Ready(CachedLookupEntry::success(kind, payload, self.policy)),
        );
        prune_lookup_cache(&mut inner, Instant::now());
        true
    }

    fn remove_entry(&self, cache_key: &str) {
        let mut inner = self.inner.lock().expect("lookup cache lock poisoned");
        inner.entries.remove(cache_key);
    }

    async fn load_persistent_success(
        &self,
        kind: LookupKind,
        normalized_id: &str,
        cache_key: &str,
        max_age: Duration,
    ) -> Option<String> {
        let store = self.persistent_store.as_ref()?.clone();
        let payload = store
            .load_success_async(cache_key.to_string(), max_age)
            .await?;
        self.log(
            "INFO",
            format!(
                "[ShipFlowCache] persistent_cache_hit kind={} id={normalized_id} key={cache_key}",
                lookup_kind_label(kind)
            ),
        );
        Some(payload)
    }

    fn store_persistent_success(
        &self,
        kind: LookupKind,
        normalized_id: &str,
        cache_key: &str,
        entry: &CachedLookupEntry,
    ) {
        let Some(persistent_store) = self.persistent_store.clone() else {
            return;
        };
        let CachedLookupValue::Success(payload) = &entry.value else {
            return;
        };

        if let Some(reason) = persistent_lookup_skip_reason(payload) {
            let bytes = payload.len();
            persistent_store.enqueue_remove_success(cache_key.to_string());
            self.log(
                "INFO",
                format!(
                    "[ShipFlowCache] persistent_cache_store_skipped kind={} id={normalized_id} key={cache_key} reason={reason} bytes={bytes}",
                    lookup_kind_label(kind)
                ),
            );
            return;
        }

        if persistent_store.enqueue_store_success(
            cache_key.to_string(),
            payload.clone(),
            self.policy.ttl_for(kind),
        ) {
            self.log(
                "INFO",
                format!(
                    "[ShipFlowCache] persistent_cache_store_queued kind={} id={normalized_id} key={cache_key}",
                    lookup_kind_label(kind)
                ),
            );
        } else {
            self.log(
                "WARN",
                format!(
                    "[ShipFlowCache] persistent_cache_store_dropped kind={} id={normalized_id} key={cache_key} reason=writer_queue_full",
                    lookup_kind_label(kind)
                ),
            );
        }
    }

    fn log(&self, level: &str, message: String) {
        if let Some(log_sink) = &self.log_sink {
            log_sink(level, message);
        }
    }

    #[cfg(test)]
    fn with_policy(policy: LookupCachePolicy) -> Self {
        Self {
            inner: Arc::new(Mutex::new(LookupCacheInner::default())),
            policy,
            log_sink: None,
            persistent_store: None,
        }
    }
}

impl CachedLookupEntry {
    fn success(kind: LookupKind, payload: String, policy: LookupCachePolicy) -> Self {
        let now = Instant::now();
        Self {
            expires_at: now + policy.ttl_for(kind),
            last_accessed_at: now,
            value: CachedLookupValue::Success(payload),
        }
    }

    fn error(_kind: LookupKind, error: &TrackingError, policy: LookupCachePolicy) -> Self {
        let now = Instant::now();
        Self {
            expires_at: now + policy.error_ttl,
            last_accessed_at: now,
            value: CachedLookupValue::Error(CachedLookupError::from_tracking_error(error)),
        }
    }
    fn is_expired(&self, now: Instant) -> bool {
        now >= self.expires_at
    }

    fn estimated_bytes(&self) -> usize {
        match &self.value {
            CachedLookupValue::Success(payload) => payload.len(),
            CachedLookupValue::Error(error) => error.message.len(),
        }
    }
}

fn snapshot_lookup_cache(inner: &LookupCacheInner) -> LookupCacheSnapshot {
    let mut snapshot = LookupCacheSnapshot {
        capacity: MAX_IN_MEMORY_LOOKUP_CACHE_ENTRIES,
        byte_capacity: MAX_IN_MEMORY_LOOKUP_CACHE_BYTES,
        ..LookupCacheSnapshot::default()
    };
    for slot in inner.entries.values() {
        match slot {
            LookupCacheSlot::Ready(entry) => {
                snapshot.ready += 1;
                snapshot.bytes = snapshot.bytes.saturating_add(entry.estimated_bytes());
            }
            LookupCacheSlot::Loading(_) => snapshot.loading += 1,
        }
    }
    snapshot
}

fn prune_lookup_cache(inner: &mut LookupCacheInner, now: Instant) -> usize {
    prune_lookup_cache_with_limits(
        inner,
        now,
        MAX_IN_MEMORY_LOOKUP_CACHE_ENTRIES,
        MAX_IN_MEMORY_LOOKUP_CACHE_BYTES,
    )
}

fn prune_lookup_cache_with_limits(
    inner: &mut LookupCacheInner,
    now: Instant,
    max_entries: usize,
    max_bytes: usize,
) -> usize {
    let before = inner.entries.len();
    inner.entries.retain(|_, slot| match slot {
        LookupCacheSlot::Ready(entry) => !entry.is_expired(now),
        LookupCacheSlot::Loading(_) => true,
    });

    let loading = inner
        .entries
        .values()
        .filter(|slot| matches!(slot, LookupCacheSlot::Loading(_)))
        .count();
    let allowed_ready = max_entries.saturating_sub(loading);
    let mut ready_entries = inner
        .entries
        .iter()
        .filter_map(|(key, slot)| match slot {
            LookupCacheSlot::Ready(entry) => {
                Some((key.clone(), entry.last_accessed_at, entry.estimated_bytes()))
            }
            LookupCacheSlot::Loading(_) => None,
        })
        .collect::<Vec<_>>();
    ready_entries.sort_unstable_by_key(|(_, last_accessed_at, _)| *last_accessed_at);
    let mut ready_count = ready_entries.len();
    let mut ready_bytes = ready_entries
        .iter()
        .fold(0usize, |total, (_, _, bytes)| total.saturating_add(*bytes));
    for (cache_key, _, bytes) in ready_entries {
        if ready_count <= allowed_ready && ready_bytes <= max_bytes {
            break;
        }
        if inner.entries.remove(&cache_key).is_some() {
            ready_count = ready_count.saturating_sub(1);
            ready_bytes = ready_bytes.saturating_sub(bytes);
        }
    }

    before.saturating_sub(inner.entries.len())
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
            TrackingError::RateLimited(message) => Self {
                kind: CachedLookupErrorKind::RateLimited,
                message: message.clone(),
            },
            TrackingError::ServiceUnavailable(message) => Self {
                kind: CachedLookupErrorKind::ServiceUnavailable,
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
            CachedLookupErrorKind::RateLimited => TrackingError::RateLimited(self.message.clone()),
            CachedLookupErrorKind::ServiceUnavailable => {
                TrackingError::ServiceUnavailable(self.message.clone())
            }
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

fn source_fingerprint_for_lookup(source_config: &TrackingSourceConfig) -> String {
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

pub async fn resolve_tracking_request_cached<F, Fut, Permit, ContactF, ContactFut, ContactPermit>(
    lookup_cache: &LookupCacheState,
    contact_cache: &ContactCacheState,
    client: &reqwest::Client,
    source_config: &TrackingSourceConfig,
    shipment_id: &str,
    options: LookupRequestOptions,
    permit_providers: TrackingPermitProviders<F, ContactF>,
) -> Result<TrackResponse, TrackingError>
where
    F: FnOnce() -> Fut + Send,
    Fut: Future<Output = Result<Permit, TrackingError>> + Send,
    Permit: Send,
    ContactF: Fn() -> ContactFut + Send + Sync,
    ContactFut: Future<Output = Result<ContactPermit, TrackingError>> + Send,
    ContactPermit: Send,
{
    let TrackingPermitProviders {
        primary: acquire_fetch_permit,
        contact: acquire_contact_permit,
    } = permit_providers;
    let normalized_shipment_id = normalize_and_validate_shipment_id(shipment_id)?;
    let source_fingerprint = source_fingerprint_for_lookup(source_config);
    let lookup_client = client.clone();
    let enrich_client = client.clone();
    let tracking_source = source_config.clone();
    let lookup_id = normalized_shipment_id.clone();

    let mut result = lookup_cache
        .resolve_cached_lookup(
            LookupKind::Track,
            normalized_shipment_id.clone(),
            source_fingerprint,
            options,
            move || async move {
                let _permit = acquire_fetch_permit()
                    .await
                    .map_err(LookupLoaderError::non_cacheable)?;
                resolve_tracking_request(&lookup_client, &tracking_source, &lookup_id)
                    .await
                    .map_err(LookupLoaderError::cacheable)
            },
        )
        .await?;
    populate_shipment_structure(&mut result, &normalized_shipment_id);

    enrich_tracking_contacts(
        contact_cache,
        &enrich_client,
        source_config,
        &normalized_shipment_id,
        result,
        acquire_contact_permit,
    )
    .await
}

async fn enrich_tracking_contacts<ContactF, ContactFut, ContactPermit>(
    contact_cache: &ContactCacheState,
    client: &reqwest::Client,
    source_config: &TrackingSourceConfig,
    shipment_id: &str,
    mut response: TrackResponse,
    acquire_contact_permit: ContactF,
) -> Result<TrackResponse, TrackingError>
where
    ContactF: Fn() -> ContactFut + Send + Sync,
    ContactFut: Future<Output = Result<ContactPermit, TrackingError>> + Send,
    ContactPermit: Send,
{
    if source_config.tracking_source != TrackingSource::Default {
        response.contact_enrichment = Some(contact_enrichment_metadata(
            ContactEnrichmentStatus::Skipped,
            &response,
        ));
        return Ok(response);
    }

    if contact_phone_present(&response.detail.actors.pengirim.telepon)
        && contact_phone_present(&response.detail.actors.penerima.telepon)
    {
        response.contact_enrichment = Some(contact_enrichment_metadata(
            ContactEnrichmentStatus::Skipped,
            &response,
        ));
        return Ok(response);
    }

    loop {
        if let Some(entry) = contact_cache.get_async(shipment_id).await {
            apply_cached_contact(&mut response, shipment_id, &entry);
            return Ok(response);
        }

        match contact_cache.begin_fetch(shipment_id) {
            ContactFetchAction::Wait(waiter) => {
                waiter.await;
            }
            ContactFetchAction::Start(fetch_lease) => {
                let _fetch_lease = fetch_lease;
                let permit = match acquire_contact_permit().await {
                    Ok(permit) => permit,
                    Err(error) => {
                        response.contact_enrichment = Some(contact_enrichment_metadata(
                            ContactEnrichmentStatus::Failed,
                            &response,
                        ));
                        shipflow_core::shipflow_log!(
                            "[ShipFlowContactCache] permit_failed id={} error={:?}",
                            shipment_id,
                            error
                        );
                        return Ok(response);
                    }
                };
                let fetch_result = fetch_contact_enrichment(client, shipment_id).await;
                drop(permit);

                match fetch_result {
                    Ok(contact) => {
                        let entry = contact_cache.store_async(shipment_id, contact).await;
                        merge_contact_enrichment(&mut response, &entry.contact);
                        let status = match entry.status {
                            ContactCacheEntryStatus::Ok => ContactEnrichmentStatus::Fetched,
                            ContactCacheEntryStatus::Missing => ContactEnrichmentStatus::Missing,
                            ContactCacheEntryStatus::Failed => ContactEnrichmentStatus::Failed,
                        };
                        response.contact_enrichment =
                            Some(contact_enrichment_metadata(status, &response));
                        shipflow_core::shipflow_log!(
                            "[ShipFlowContactCache] fetch_ok id={} status={:?} sender_phone_present={} recipient_phone_present={}",
                            shipment_id,
                            entry.status,
                            contact_phone_present(&response.detail.actors.pengirim.telepon),
                            contact_phone_present(&response.detail.actors.penerima.telepon)
                        );
                    }
                    Err(error) => {
                        contact_cache.store_failure_async(shipment_id).await;
                        response.contact_enrichment = Some(contact_enrichment_metadata(
                            ContactEnrichmentStatus::Failed,
                            &response,
                        ));
                        shipflow_core::shipflow_log!(
                            "[ShipFlowContactCache] fetch_failed id={} error={:?}",
                            shipment_id,
                            error
                        );
                    }
                }

                return Ok(response);
            }
        }
    }
}

async fn fetch_contact_enrichment(
    client: &reqwest::Client,
    shipment_id: &str,
) -> Result<ContactEnrichment, TrackingError> {
    let url = build_lacak_mitra_tracking_url(shipment_id);
    match timeout(CONTACT_LOOKUP_TIMEOUT, async {
        let upstream_response = client.get(&url).send().await.map_err(|error| {
            TrackingError::Upstream(format!("Lacak Mitra contact request failed: {error}"))
        })?;
        if !upstream_response.status().is_success() {
            return Err(TrackingError::Upstream(format!(
                "Lacak Mitra contact endpoint returned HTTP {}.",
                upstream_response.status()
            )));
        }
        let html = read_response_text_limited(
            upstream_response,
            MAX_CONTACT_RESPONSE_BYTES,
            "Lacak Mitra contact response",
        )
        .await?;
        parse_lacak_mitra_contact_html_checked(&html)
    })
    .await
    {
        Ok(result) => result,
        Err(_) => Err(TrackingError::Upstream(format!(
            "Lacak Mitra contact request timed out after {} seconds.",
            CONTACT_LOOKUP_TIMEOUT.as_secs()
        ))),
    }
}

fn apply_cached_contact(
    response: &mut TrackResponse,
    shipment_id: &str,
    entry: &ContactCacheEntry,
) {
    merge_contact_enrichment(response, &entry.contact);
    let status = match entry.status {
        ContactCacheEntryStatus::Ok => ContactEnrichmentStatus::CacheHit,
        ContactCacheEntryStatus::Missing => ContactEnrichmentStatus::Missing,
        ContactCacheEntryStatus::Failed => ContactEnrichmentStatus::Failed,
    };
    response.contact_enrichment = Some(contact_enrichment_metadata(status, response));
    shipflow_core::shipflow_log!(
        "[ShipFlowContactCache] cache_hit id={} status={:?} sender_phone_present={} recipient_phone_present={}",
        shipment_id,
        entry.status,
        contact_phone_present(&response.detail.actors.pengirim.telepon),
        contact_phone_present(&response.detail.actors.penerima.telepon)
    );
}

fn merge_contact_enrichment(response: &mut TrackResponse, contact: &ContactEnrichment) {
    if !contact_phone_present(&response.detail.actors.pengirim.telepon) {
        response.detail.actors.pengirim.telepon = contact.pengirim.telepon.clone();
    }
    if !contact_phone_present(&response.detail.actors.penerima.telepon) {
        response.detail.actors.penerima.telepon = contact.penerima.telepon.clone();
    }
}

fn contact_enrichment_metadata(
    status: ContactEnrichmentStatus,
    response: &TrackResponse,
) -> ContactEnrichmentMetadata {
    ContactEnrichmentMetadata {
        source: "lacak_mitra".into(),
        status,
        sender_phone_present: contact_phone_present(&response.detail.actors.pengirim.telepon),
        recipient_phone_present: contact_phone_present(&response.detail.actors.penerima.telepon),
    }
}

fn contact_phone_present(value: &Option<String>) -> bool {
    value.as_deref().is_some_and(|value| {
        let normalized = value.trim();
        !normalized.is_empty() && normalized != "-"
    })
}

pub async fn resolve_bag_request_cached<F, Fut, Permit>(
    lookup_cache: &LookupCacheState,
    client: &reqwest::Client,
    source_config: &TrackingSourceConfig,
    bag_id: &str,
    options: LookupRequestOptions,
    acquire_fetch_permit: F,
) -> Result<BagResponse, TrackingError>
where
    F: FnOnce() -> Fut + Send,
    Fut: Future<Output = Result<Permit, TrackingError>> + Send,
    Permit: Send,
{
    let normalized_bag_id = normalize_and_validate_bag_id(bag_id)?;
    let source_fingerprint = source_fingerprint_for_lookup(source_config);
    let client = client.clone();
    let tracking_source = source_config.clone();
    let lookup_id = normalized_bag_id.clone();

    lookup_cache
        .resolve_cached_lookup(
            LookupKind::Bag,
            normalized_bag_id,
            source_fingerprint,
            options,
            move || async move {
                let _permit = acquire_fetch_permit()
                    .await
                    .map_err(LookupLoaderError::non_cacheable)?;
                resolve_bag_request(&client, &tracking_source, &lookup_id)
                    .await
                    .map_err(LookupLoaderError::cacheable)
            },
        )
        .await
}

pub async fn resolve_manifest_request_cached<F, Fut, Permit>(
    lookup_cache: &LookupCacheState,
    client: &reqwest::Client,
    source_config: &TrackingSourceConfig,
    manifest_id: &str,
    options: LookupRequestOptions,
    acquire_fetch_permit: F,
) -> Result<ManifestResponse, TrackingError>
where
    F: FnOnce() -> Fut + Send,
    Fut: Future<Output = Result<Permit, TrackingError>> + Send,
    Permit: Send,
{
    let normalized_manifest_id = normalize_and_validate_manifest_id(manifest_id)?;
    let source_fingerprint = source_fingerprint_for_lookup(source_config);
    let client = client.clone();
    let tracking_source = source_config.clone();
    let lookup_id = normalized_manifest_id.clone();

    lookup_cache
        .resolve_cached_lookup(
            LookupKind::Manifest,
            normalized_manifest_id,
            source_fingerprint,
            options,
            move || async move {
                let _permit = acquire_fetch_permit()
                    .await
                    .map_err(LookupLoaderError::non_cacheable)?;
                resolve_manifest_request(&client, &tracking_source, &lookup_id)
                    .await
                    .map_err(LookupLoaderError::cacheable)
            },
        )
        .await
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use super::{
        build_cache_key, prune_lookup_cache_with_limits, source_fingerprint_for_lookup,
        CachedLookupEntry, CachedLookupValue, LookupCacheAction, LookupCacheMetricEvent,
        LookupCacheMetrics, LookupCachePolicy, LookupCacheSlot, LookupCacheState,
        LookupLoaderError, LookupRequestOptions, MAX_IN_MEMORY_LOOKUP_CACHE_ENTRIES,
        MAX_IN_MEMORY_LOOKUP_CACHE_ENTRY_BYTES,
    };
    use crate::persistent_store::PersistentLookupStore;
    use shipflow_core::model::{
        BagResponse, LookupKind, TrackingError, TrackingSource, TrackingSourceConfig,
    };
    use tokio::sync::Barrier;

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
    fn source_fingerprint_changes_when_lookup_source_changes() {
        let internal = source_fingerprint_for_lookup(&TrackingSourceConfig::default());
        let external = source_fingerprint_for_lookup(&TrackingSourceConfig {
            tracking_source: TrackingSource::ExternalApi,
            external_api_base_url: "https://scrappid3.example.test/v1/openapi.json".into(),
            external_api_auth_token: "service-token".into(),
            allow_insecure_external_api_http: false,
        });

        assert_ne!(internal, external);
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
                    source_fingerprint_for_lookup(&TrackingSourceConfig::default()),
                    LookupRequestOptions::default(),
                    {
                        let fetch_count = Arc::clone(&fetch_count);
                        move || async move {
                            fetch_count.fetch_add(1, Ordering::SeqCst);
                            Ok(shipflow_core::model::TrackResponse {
                                url: "https://example.test/track/P2600001".into(),
                                detail: shipflow_core::model::TrackDetail::default(),
                                status_akhir: shipflow_core::model::TrackStatusAkhir::default(),
                                pod: shipflow_core::model::TrackPod::default(),
                                history: Vec::new(),
                                history_summary: shipflow_core::model::HistorySummary::default(),
                                shipment_identity: shipflow_core::model::ShipmentIdentity::default(
                                ),
                                multi_koli: shipflow_core::model::MultiKoliSummary::default(),
                                contact_enrichment: None,
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
                    source_fingerprint_for_lookup(&TrackingSourceConfig::default()),
                    LookupRequestOptions {
                        force_refresh: true,
                    },
                    {
                        let fetch_count = Arc::clone(&fetch_count);
                        move || async move {
                            fetch_count.fetch_add(1, Ordering::SeqCst);
                            Ok(shipflow_core::model::TrackResponse {
                                url: "https://example.test/track/P2600001".into(),
                                detail: shipflow_core::model::TrackDetail::default(),
                                status_akhir: shipflow_core::model::TrackStatusAkhir::default(),
                                pod: shipflow_core::model::TrackPod::default(),
                                history: Vec::new(),
                                history_summary: shipflow_core::model::HistorySummary::default(),
                                shipment_identity: shipflow_core::model::ShipmentIdentity::default(
                                ),
                                multi_koli: shipflow_core::model::MultiKoliSummary::default(),
                                contact_enrichment: None,
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
    fn contact_phone_present_treats_dash_as_missing() {
        assert!(!super::contact_phone_present(&None));
        assert!(!super::contact_phone_present(&Some(String::new())));
        assert!(!super::contact_phone_present(&Some("-".into())));
        assert!(super::contact_phone_present(&Some("08111925400".into())));
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
                                Ok(shipflow_core::model::ManifestResponse {
                                    url: "https://example.test/manifest/MAN-1".into(),
                                    ..shipflow_core::model::ManifestResponse::default()
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
                                Ok(shipflow_core::model::ManifestResponse {
                                    url: "https://example.test/manifest/MAN-1".into(),
                                    ..shipflow_core::model::ManifestResponse::default()
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
    fn coalesced_waiter_cannot_miss_notify_waiters_signal() {
        let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
        runtime.block_on(async {
            let cache = LookupCacheState::with_policy(create_test_policy());
            let options = LookupRequestOptions::default();
            let fetch_notify = match cache.next_action(
                "manifest:MAN-RACE",
                LookupKind::Manifest,
                "MAN-RACE",
                options,
            ) {
                LookupCacheAction::StartFetch { notify, .. } => notify,
                _ => panic!("first lookup should start a fetch"),
            };
            let waiter = match cache.next_action(
                "manifest:MAN-RACE",
                LookupKind::Manifest,
                "MAN-RACE",
                options,
            ) {
                LookupCacheAction::Wait(waiter) => waiter,
                _ => panic!("second lookup should wait for the fetch"),
            };

            fetch_notify.notify_waiters();

            tokio::time::timeout(Duration::from_millis(50), waiter)
                .await
                .expect("registered waiter should observe an earlier notify_waiters call");
        });
    }

    #[test]
    fn cancelled_loader_clears_the_loading_slot() {
        let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
        runtime.block_on(async {
            let cache = LookupCacheState::with_policy(create_test_policy());
            let lookup = cache.resolve_cached_lookup::<BagResponse, _, _>(
                LookupKind::Bag,
                "PID-CANCELLED".into(),
                "pos-bag".into(),
                LookupRequestOptions::default(),
                || async { std::future::pending::<Result<BagResponse, LookupLoaderError>>().await },
            );

            tokio::time::timeout(Duration::from_millis(10), lookup)
                .await
                .expect_err("test lookup should be cancelled by its caller deadline");

            assert_eq!(
                cache.snapshot().loading,
                0,
                "cancelled owners must not leave a permanently loading cache slot"
            );
        });
    }

    #[test]
    fn cache_pruning_enforces_capacity_and_removes_oldest_ready_entries() {
        let cache = LookupCacheState::with_policy(create_test_policy());
        let now = Instant::now();
        {
            let mut inner = cache.inner.lock().expect("lookup cache lock poisoned");
            for index in 0..=MAX_IN_MEMORY_LOOKUP_CACHE_ENTRIES {
                inner.entries.insert(
                    format!("track:P{index}"),
                    LookupCacheSlot::Ready(CachedLookupEntry {
                        expires_at: now + Duration::from_secs(60),
                        last_accessed_at: now + Duration::from_nanos(index as u64),
                        value: CachedLookupValue::Success("{}".into()),
                    }),
                );
            }
        }

        let snapshot = cache.prune_expired_and_over_capacity();
        let inner = cache.inner.lock().expect("lookup cache lock poisoned");

        assert_eq!(snapshot.ready, MAX_IN_MEMORY_LOOKUP_CACHE_ENTRIES);
        assert_eq!(snapshot.loading, 0);
        assert!(!inner.entries.contains_key("track:P0"));
        assert!(inner
            .entries
            .contains_key(&format!("track:P{MAX_IN_MEMORY_LOOKUP_CACHE_ENTRIES}")));
    }

    #[test]
    fn cache_pruning_enforces_weighted_byte_budget() {
        let cache = LookupCacheState::with_policy(create_test_policy());
        let now = Instant::now();
        {
            let mut inner = cache.inner.lock().expect("lookup cache lock poisoned");
            for index in 0..3 {
                inner.entries.insert(
                    format!("track:P{index}"),
                    LookupCacheSlot::Ready(CachedLookupEntry {
                        expires_at: now + Duration::from_secs(60),
                        last_accessed_at: now + Duration::from_nanos(index),
                        value: CachedLookupValue::Success("x".repeat(10)),
                    }),
                );
            }
            prune_lookup_cache_with_limits(&mut inner, now, 10, 20);
        }

        let inner = cache.inner.lock().expect("lookup cache lock poisoned");
        assert!(!inner.entries.contains_key("track:P0"));
        assert!(inner.entries.contains_key("track:P1"));
        assert!(inner.entries.contains_key("track:P2"));
    }

    #[test]
    fn oversized_payload_is_returned_but_not_cached() {
        let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
        runtime.block_on(async {
            let cache = LookupCacheState::with_policy(create_test_policy());
            let response = cache
                .resolve_cached_lookup(
                    LookupKind::Bag,
                    "PID-LARGE".into(),
                    "pos-bag".into(),
                    LookupRequestOptions::default(),
                    || async {
                        Ok(BagResponse {
                            url: "x".repeat(MAX_IN_MEMORY_LOOKUP_CACHE_ENTRY_BYTES + 1),
                            nomor_kantung: Some("PID-LARGE".into()),
                            ..BagResponse::default()
                        })
                    },
                )
                .await
                .expect("large lookup should still be returned");

            assert_eq!(response.nomor_kantung.as_deref(), Some("PID-LARGE"));
            assert_eq!(cache.snapshot().ready, 0);
        });
    }

    #[test]
    fn oversized_persistent_hydration_clears_its_loading_slot() {
        let cache = LookupCacheState::with_policy(create_test_policy());
        let cache_key = "bag:source:PID-PERSISTENT-LARGE";
        let notify = Arc::new(tokio::sync::Notify::new());
        let generation = {
            let mut inner = cache.inner.lock().expect("lookup cache lock poisoned");
            let generation = inner.generation;
            inner
                .entries
                .insert(cache_key.into(), LookupCacheSlot::Loading(notify.clone()));
            generation
        };

        let hydrated = cache.resolve_persistent_cache_slot(
            cache_key,
            LookupKind::Bag,
            "x".repeat(MAX_IN_MEMORY_LOOKUP_CACHE_ENTRY_BYTES + 1),
            generation,
            &notify,
        );

        assert!(!hydrated);
        assert!(!cache
            .inner
            .lock()
            .expect("lookup cache lock poisoned")
            .entries
            .contains_key(cache_key));
    }

    #[test]
    fn memory_cache_takes_precedence_over_persistent_cache() {
        let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
        runtime.block_on(async {
            let path = std::env::temp_dir().join(format!(
                "shipflow-lookup-memory-precedence-{}-{}.sqlite3",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("system clock should be after epoch")
                    .as_nanos()
            ));
            let store = PersistentLookupStore::open(path.clone());
            let key = build_cache_key(LookupKind::Bag, "pos-bag", "PID-PRECEDENCE");
            store.store_success(
                key.clone(),
                serde_json::to_string(&BagResponse {
                    nomor_kantung: Some("PERSISTENT".into()),
                    ..BagResponse::default()
                })
                .unwrap(),
                Duration::from_secs(60),
            );
            let cache = LookupCacheState::with_policy(create_test_policy())
                .with_persistent_store(store.clone());
            {
                let mut inner = cache.inner.lock().expect("lookup cache lock poisoned");
                inner.entries.insert(
                    key,
                    LookupCacheSlot::Ready(CachedLookupEntry::success(
                        LookupKind::Bag,
                        serde_json::to_string(&BagResponse {
                            nomor_kantung: Some("MEMORY".into()),
                            ..BagResponse::default()
                        })
                        .unwrap(),
                        create_test_policy(),
                    )),
                );
            }

            let result: BagResponse = cache
                .resolve_cached_lookup(
                    LookupKind::Bag,
                    "PID-PRECEDENCE".into(),
                    "pos-bag".into(),
                    LookupRequestOptions::default(),
                    || async {
                        panic!("a ready memory entry must not load persistent or upstream data");
                        #[allow(unreachable_code)]
                        Ok::<BagResponse, LookupLoaderError>(BagResponse::default())
                    },
                )
                .await
                .expect("memory lookup should succeed");

            assert_eq!(result.nomor_kantung.as_deref(), Some("MEMORY"));
            drop(cache);
            drop(store);
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
            let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
        });
    }

    #[test]
    fn cache_rejects_a_new_miss_when_all_capacity_is_loading() {
        let cache = LookupCacheState::with_policy(create_test_policy());
        {
            let mut inner = cache.inner.lock().expect("lookup cache lock poisoned");
            for index in 0..MAX_IN_MEMORY_LOOKUP_CACHE_ENTRIES {
                inner.entries.insert(
                    format!("track:P{index}"),
                    LookupCacheSlot::Loading(Arc::new(tokio::sync::Notify::new())),
                );
            }
        }

        let action = cache.next_action(
            "track:P-OVERFLOW",
            LookupKind::Track,
            "P-OVERFLOW",
            LookupRequestOptions::default(),
        );

        assert!(matches!(
            action,
            LookupCacheAction::Reject(TrackingError::ServiceUnavailable(_))
        ));
        assert_eq!(cache.snapshot().loading, MAX_IN_MEMORY_LOOKUP_CACHE_ENTRIES);
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
                            Err(LookupLoaderError::cacheable(TrackingError::NotFound(
                                "Bag was not found.".into(),
                            )))
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
                            Err(LookupLoaderError::cacheable(TrackingError::NotFound(
                                "Bag was not found.".into(),
                            )))
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
                            Err(LookupLoaderError::cacheable(TrackingError::NotFound(
                                "Bag was not found.".into(),
                            )))
                        }
                    },
                )
                .await
                .expect_err("expired negative cache should refetch");

            assert_eq!(fetch_count.load(Ordering::SeqCst), 2);
        });
    }

    #[test]
    fn non_cacheable_loader_errors_are_not_cached() {
        let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
        runtime.block_on(async {
            let cache = LookupCacheState::with_policy(create_test_policy());
            let fetch_count = Arc::new(AtomicUsize::new(0));

            let first_error = cache
                .resolve_cached_lookup::<BagResponse, _, _>(
                    LookupKind::Bag,
                    "PID-BUSY".into(),
                    "pos-bag".into(),
                    LookupRequestOptions::default(),
                    {
                        let fetch_count = Arc::clone(&fetch_count);
                        move || async move {
                            fetch_count.fetch_add(1, Ordering::SeqCst);
                            Err(LookupLoaderError::non_cacheable(
                                TrackingError::RateLimited("Service is busy.".into()),
                            ))
                        }
                    },
                )
                .await
                .expect_err("first lookup should fail without caching the error");

            let second = cache
                .resolve_cached_lookup(
                    LookupKind::Bag,
                    "PID-BUSY".into(),
                    "pos-bag".into(),
                    LookupRequestOptions::default(),
                    {
                        let fetch_count = Arc::clone(&fetch_count);
                        move || async move {
                            fetch_count.fetch_add(1, Ordering::SeqCst);
                            Ok(BagResponse {
                                nomor_kantung: Some("PID-BUSY".into()),
                                ..BagResponse::default()
                            })
                        }
                    },
                )
                .await
                .expect("second lookup should refetch and succeed");

            assert!(matches!(first_error, TrackingError::RateLimited(_)));
            assert_eq!(second.nomor_kantung.as_deref(), Some("PID-BUSY"));
            assert_eq!(fetch_count.load(Ordering::SeqCst), 2);
        });
    }

    #[test]
    fn cacheable_rate_limited_errors_replay_as_rate_limited() {
        let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
        runtime.block_on(async {
            let cache = LookupCacheState::with_policy(create_test_policy());
            let fetch_count = Arc::new(AtomicUsize::new(0));

            let first_error = cache
                .resolve_cached_lookup::<BagResponse, _, _>(
                    LookupKind::Bag,
                    "PID-429".into(),
                    "pos-bag".into(),
                    LookupRequestOptions::default(),
                    {
                        let fetch_count = Arc::clone(&fetch_count);
                        move || async move {
                            fetch_count.fetch_add(1, Ordering::SeqCst);
                            Err(LookupLoaderError::cacheable(TrackingError::RateLimited(
                                "Too many requests.".into(),
                            )))
                        }
                    },
                )
                .await
                .expect_err("first lookup should fail");

            let second_error = cache
                .resolve_cached_lookup::<BagResponse, _, _>(
                    LookupKind::Bag,
                    "PID-429".into(),
                    "pos-bag".into(),
                    LookupRequestOptions::default(),
                    {
                        let fetch_count = Arc::clone(&fetch_count);
                        move || async move {
                            fetch_count.fetch_add(1, Ordering::SeqCst);
                            Err(LookupLoaderError::cacheable(TrackingError::Upstream(
                                "should not refetch".into(),
                            )))
                        }
                    },
                )
                .await
                .expect_err("cached rate limit should replay");

            assert!(matches!(first_error, TrackingError::RateLimited(_)));
            assert!(matches!(second_error, TrackingError::RateLimited(_)));
            assert_eq!(fetch_count.load(Ordering::SeqCst), 1);
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
            let stale_fetch_started = Arc::new(Barrier::new(2));

            let stale_task = tokio::spawn({
                let cache = cache.clone();
                let stale_fetch_count = Arc::clone(&stale_fetch_count);
                let stale_fetch_started = Arc::clone(&stale_fetch_started);
                async move {
                    cache
                        .resolve_cached_lookup(
                            LookupKind::Bag,
                            "PID-GEN".into(),
                            "pos-bag".into(),
                            LookupRequestOptions::default(),
                            move || async move {
                                stale_fetch_count.fetch_add(1, Ordering::SeqCst);
                                stale_fetch_started.wait().await;
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

            stale_fetch_started.wait().await;
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
