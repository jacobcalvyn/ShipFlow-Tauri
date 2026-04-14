use std::{collections::HashMap, sync::Arc};

use moka::future::Cache;
use reqwest::Client;
use tokio::sync::Semaphore;

use crate::{
    auth::ApiTokenRecord,
    canary::CanaryRuntimeState,
    config::AppConfig,
    drift_guard::DriftGuard,
    incidents::IncidentStore,
    jobs::JobStore,
    managed_tokens::ManagedTokenStore,
    metrics::Metrics,
    persistent_cache::PersistentCache,
    rate_limit::RateLimiter,
    token_state::TokenStateStore,
    upstream::{CachedBody, FetchedHtml},
};

/// State global untuk Axum yang menyimpan konfigurasi, HTTP client,
/// batas concurrency, dan cache HTML sederhana.
#[derive(Clone)]
pub struct AppState {
    pub config: AppConfig,
    pub client: Client,

    // Global upstream concurrency limiter shared by all endpoint types.
    pub upstream_semaphore: Arc<Semaphore>,
    pub allowed_tokens: Arc<HashMap<String, ApiTokenRecord>>,
    pub rate_limiter: Arc<RateLimiter>,
    pub metrics: Arc<Metrics>,
    pub job_store: Arc<JobStore>,
    pub drift_guard: Arc<DriftGuard>,
    pub incident_store: Arc<IncidentStore>,
    pub canary_state: Arc<CanaryRuntimeState>,
    pub persistent_cache: Option<Arc<PersistentCache>>,
    pub token_state_store: Option<Arc<TokenStateStore>>,
    pub managed_token_store: Option<Arc<ManagedTokenStore>>,
    pub upstream_singleflight: Cache<String, FetchedHtml>,
    // Menggunakan moka::future::Cache untuk concurrent LRU cache yang efisien.
    // Key: ID (String), Value: CachedBody (HTML + stored_at_ms).
    pub track_html_cache: Cache<String, CachedBody>,
    pub bag_html_cache: Cache<String, CachedBody>,
    pub manifest_html_cache: Cache<String, CachedBody>,
    pub track_stale_cache: Cache<String, CachedBody>,
    pub bag_stale_cache: Cache<String, CachedBody>,
    pub manifest_stale_cache: Cache<String, CachedBody>,
}

// Struct CachedHtml lama dihapus karena moka menangani expiry secara internal.
