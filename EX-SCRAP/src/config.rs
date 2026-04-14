use anyhow::{Context, Result};
use std::collections::HashMap;
use std::env;
use validator::Validate;

use crate::auth::{
    normalize_allowed_ip_rule, normalize_scopes, ApiTokenConfig, ApiTokenMetadata,
    RateLimitScopeClassDefault, TokenSource,
};
use crate::rate_limit::{derived_burst_capacity, RateLimitPolicy};

// Default URL scraping bawaan aplikasi (jika env tidak di-set).
const DEFAULT_SCRAPE_TRACK_URL: &str =
    "https://pid.posindonesia.co.id/lacak/admin/detail_lacak_banyak.php?id=";
const DEFAULT_SCRAPE_BAG_URL: &str =
    "https://pid.posindonesia.co.id/lacak/admin/detail_lacak_banyak_bag.php?id=";
const DEFAULT_SCRAPE_MANIFEST_URL: &str =
    "https://pid.posindonesia.co.id/lacak/admin/GetManifestR7_detil.php?id=";

/// Konfigurasi aplikasi yang dibaca dari environment / `.env`.
#[derive(Clone, serde::Serialize, serde::Deserialize, Validate)]
pub struct AppConfig {
    pub port: u16,

    #[validate(url)]
    pub track_url: String,

    #[validate(url)]
    pub bag_url: String,

    #[validate(url)]
    pub manifest_url: String,

    pub http_max_concurrency: usize,
    pub http_timeout_secs: u64,
    pub cache_max_entries: usize,
    pub track_cache_ttl_secs: u64,
    pub bag_cache_ttl_secs: u64,
    pub manifest_cache_ttl_secs: u64,
    pub upstream_queue_timeout_secs: u64,

    pub retry_max_attempts: u32,
    pub retry_base_delay_ms: u64,
    pub stale_if_error_ttl_secs: u64,
    pub rate_limit_per_minute: u32,
    pub rate_limit_burst_capacity: u32,
    pub rate_limit_burst_window_secs: u64,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub rate_limit_classes: HashMap<String, RateLimitPolicy>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub rate_limit_scope_class_defaults: Vec<RateLimitScopeClassDefault>,
    pub batch_concurrency: usize,
    pub batch_max_items: usize,
    pub job_result_ttl_secs: u64,
    pub job_store_max_entries: usize,
    pub webhook_timeout_secs: u64,
    pub webhook_max_attempts: u32,
    pub webhook_base_delay_ms: u64,
    pub webhook_secret: Option<String>,
    pub webhook_include_legacy_secret_header: bool,
    pub webhook_allowed_hosts: Vec<String>,
    pub persistent_cache_dir: Option<String>,
    pub persistent_cache_max_entries: usize,
    pub persistent_cache_sweep_interval_secs: u64,
    pub parser_guard_max_events: usize,
    pub incident_max_events: usize,
    pub upstream_canary_enabled: bool,
    pub upstream_canary_id: String,
    pub upstream_canary_timeout_secs: u64,
    pub upstream_canary_min_body_bytes: usize,
    pub upstream_canary_fail_threshold: u32,
    pub upstream_canary_grace_secs: u64,
    pub trust_proxy_headers_for_ip_allowlist: bool,
    pub api_token_state_file: Option<String>,
    pub managed_api_token_store_file: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub api_tokens: Vec<ApiTokenConfig>,
}

impl AppConfig {
    pub fn from_env() -> Result<Self> {
        let port = read_env_u16("PORT", 3000);

        // URL scraping
        let track_url =
            env::var("SCRAPE_TRACK_URL").unwrap_or_else(|_| DEFAULT_SCRAPE_TRACK_URL.to_string());
        if !track_url.ends_with('=') {
            anyhow::bail!("SCRAPE_TRACK_URL must end with '='");
        }

        let bag_url =
            env::var("SCRAPE_BAG_URL").unwrap_or_else(|_| DEFAULT_SCRAPE_BAG_URL.to_string());
        if !bag_url.ends_with('=') {
            anyhow::bail!("SCRAPE_BAG_URL must end with '='");
        }

        let manifest_url = env::var("SCRAPE_MANIFEST_URL")
            .unwrap_or_else(|_| DEFAULT_SCRAPE_MANIFEST_URL.to_string());
        if !manifest_url.ends_with('=') {
            anyhow::bail!("SCRAPE_MANIFEST_URL must end with '='");
        }

        let http_max_concurrency = read_env_usize("HTTP_MAX_CONCURRENCY", 45).max(1);
        let http_timeout_secs = read_env_u64("HTTP_TIMEOUT_SECS", 120).max(1);
        let cache_max_entries = read_env_usize("CACHE_MAX_ENTRIES", 1000);
        let cache_ttl_default_secs = read_env_u64("CACHE_TTL_SECS", 60);

        // Per-type TTL; fallback ke default jika tidak ada
        let track_cache_ttl_secs = read_env_u64("TRACK_CACHE_TTL_SECS", cache_ttl_default_secs);
        let bag_cache_ttl_secs = read_env_u64("BAG_CACHE_TTL_SECS", cache_ttl_default_secs);
        let manifest_cache_ttl_secs =
            read_env_u64("MANIFEST_CACHE_TTL_SECS", cache_ttl_default_secs);

        let upstream_queue_timeout_secs = read_env_u64("UPSTREAM_QUEUE_TIMEOUT_SECS", 15);

        let retry_max_attempts = read_env_u32("RETRY_MAX_ATTEMPTS", 3).max(1);
        let retry_base_delay_ms = read_env_u64("RETRY_BASE_DELAY_MS", 200);
        let stale_if_error_ttl_secs = read_env_u64("STALE_IF_ERROR_TTL_SECS", 300);
        let rate_limit_per_minute = read_env_u32("RATE_LIMIT_PER_MINUTE", 120).max(1);
        let rate_limit_burst_window_secs = read_env_u64("RATE_LIMIT_BURST_WINDOW_SECS", 10).max(1);
        let rate_limit_burst_capacity = read_env_u32(
            "RATE_LIMIT_BURST_CAPACITY",
            derived_burst_capacity(rate_limit_per_minute, rate_limit_burst_window_secs),
        )
        .max(1);
        let default_rate_limit_policy = RateLimitPolicy::new(
            rate_limit_per_minute,
            rate_limit_burst_capacity,
            rate_limit_burst_window_secs,
        );
        let rate_limit_classes = read_rate_limit_classes(default_rate_limit_policy)?;
        let rate_limit_scope_class_defaults =
            read_rate_limit_scope_class_defaults(&rate_limit_classes)?;
        let batch_concurrency = read_env_usize("BATCH_CONCURRENCY", 8).max(1);
        let batch_max_items = read_env_usize("BATCH_MAX_ITEMS", 100).max(1);
        let job_result_ttl_secs = read_env_u64("JOB_RESULT_TTL_SECS", 3600).max(60);
        let job_store_max_entries = read_env_usize("JOB_STORE_MAX_ENTRIES", 2000).max(100);
        let webhook_timeout_secs = read_env_u64("WEBHOOK_TIMEOUT_SECS", 10).max(1);
        let webhook_max_attempts = read_env_u32("WEBHOOK_MAX_ATTEMPTS", 3).max(1);
        let webhook_base_delay_ms = read_env_u64("WEBHOOK_BASE_DELAY_MS", 500);
        let webhook_secret = read_env_trimmed("WEBHOOK_SECRET");
        let webhook_include_legacy_secret_header =
            read_env_bool("WEBHOOK_INCLUDE_LEGACY_SECRET_HEADER", false);
        let webhook_allowed_hosts = read_env_csv_lowercase("WEBHOOK_ALLOWED_HOSTS");
        let persistent_cache_dir = read_env_trimmed("PERSIST_CACHE_DIR");
        let persistent_cache_max_entries =
            read_env_usize("PERSIST_CACHE_MAX_ENTRIES", 10_000).max(100);
        let persistent_cache_sweep_interval_secs =
            read_env_u64("PERSIST_CACHE_SWEEP_INTERVAL_SECS", 300).max(10);
        let parser_guard_max_events = read_env_usize("PARSER_GUARD_MAX_EVENTS", 200).max(10);
        let incident_max_events = read_env_usize("INCIDENT_MAX_EVENTS", 200).max(10);
        let upstream_canary_enabled = read_env_bool("UPSTREAM_CANARY_ENABLED", false);
        let upstream_canary_id = env::var("UPSTREAM_CANARY_ID")
            .unwrap_or_else(|_| "P0000000000000".to_string())
            .trim()
            .to_string();
        if upstream_canary_id.is_empty() {
            anyhow::bail!("UPSTREAM_CANARY_ID must not be empty");
        }
        let upstream_canary_timeout_secs = read_env_u64("UPSTREAM_CANARY_TIMEOUT_SECS", 8).max(1);
        let upstream_canary_min_body_bytes =
            read_env_usize("UPSTREAM_CANARY_MIN_BODY_BYTES", 200).max(32);
        let upstream_canary_fail_threshold =
            read_env_u32("UPSTREAM_CANARY_FAIL_THRESHOLD", 3).max(1);
        let upstream_canary_grace_secs = read_env_u64("UPSTREAM_CANARY_GRACE_SECS", 60);
        let trust_proxy_headers_for_ip_allowlist =
            read_env_bool("TRUST_PROXY_HEADERS_FOR_IP_ALLOWLIST", false);
        let api_token_state_file = read_env_trimmed("API_TOKEN_STATE_FILE");
        let managed_api_token_store_file = read_env_trimmed("MANAGED_API_TOKEN_STORE_FILE");

        // API tokens: support rotasi via API_TOKENS (comma-separated),
        // fallback ke API_TOKEN untuk kompatibilitas.
        let api_tokens = read_api_token_configs(&rate_limit_classes)?;

        let config = Self {
            port,
            track_url,
            bag_url,
            manifest_url,
            http_max_concurrency,
            http_timeout_secs,
            cache_max_entries,
            track_cache_ttl_secs,
            bag_cache_ttl_secs,
            manifest_cache_ttl_secs,
            upstream_queue_timeout_secs,
            retry_max_attempts,
            retry_base_delay_ms,
            stale_if_error_ttl_secs,
            rate_limit_per_minute,
            rate_limit_burst_capacity,
            rate_limit_burst_window_secs,
            rate_limit_classes,
            rate_limit_scope_class_defaults,
            batch_concurrency,
            batch_max_items,
            job_result_ttl_secs,
            job_store_max_entries,
            webhook_timeout_secs,
            webhook_max_attempts,
            webhook_base_delay_ms,
            webhook_secret,
            webhook_include_legacy_secret_header,
            webhook_allowed_hosts,
            persistent_cache_dir,
            persistent_cache_max_entries,
            persistent_cache_sweep_interval_secs,
            parser_guard_max_events,
            incident_max_events,
            upstream_canary_enabled,
            upstream_canary_id,
            upstream_canary_timeout_secs,
            upstream_canary_min_body_bytes,
            upstream_canary_fail_threshold,
            upstream_canary_grace_secs,
            trust_proxy_headers_for_ip_allowlist,
            api_token_state_file,
            managed_api_token_store_file,
            api_tokens,
        };

        config
            .validate()
            .context("Konfigurasi aplikasi tidak valid (cek format URL env var)")?;

        Ok(config)
    }

    pub fn default_rate_limit_policy(&self) -> RateLimitPolicy {
        RateLimitPolicy::new(
            self.rate_limit_per_minute,
            self.rate_limit_burst_capacity,
            self.rate_limit_burst_window_secs,
        )
    }
}

#[derive(Debug, serde::Deserialize)]
struct ApiTokenSpecEnv {
    token: String,
    token_id: String,
    label: Option<String>,
    #[serde(default)]
    scopes: Vec<String>,
    created_by: Option<String>,
    created_at_ms: Option<u64>,
    expires_at_ms: Option<u64>,
    #[serde(default)]
    allowed_ips: Vec<String>,
    rate_limit_class: Option<String>,
    rate_limit_per_minute: Option<u32>,
    rate_limit_burst_capacity: Option<u32>,
    rate_limit_burst_window_secs: Option<u64>,
}

#[derive(Debug, serde::Deserialize)]
struct RateLimitClassSpecEnv {
    name: String,
    rate_limit_per_minute: u32,
    rate_limit_burst_capacity: Option<u32>,
    rate_limit_burst_window_secs: Option<u64>,
}

#[derive(Debug, serde::Deserialize)]
struct RateLimitScopeClassDefaultEnv {
    scope: String,
    rate_limit_class: String,
}

fn read_api_token_configs(
    rate_limit_classes: &HashMap<String, RateLimitPolicy>,
) -> Result<Vec<ApiTokenConfig>> {
    if let Some(raw_specs) = read_env_trimmed("API_TOKEN_SPECS") {
        return parse_api_token_specs(&raw_specs, rate_limit_classes);
    }

    let tokens = read_legacy_api_tokens()?;
    let use_suffix = tokens.len() > 1;

    Ok(tokens
        .into_iter()
        .enumerate()
        .map(|(index, token)| {
            let token_id = if use_suffix {
                format!("legacy-{}", index + 1)
            } else {
                "legacy-default".to_string()
            };
            ApiTokenConfig::legacy_full_access(token, token_id)
        })
        .collect())
}

fn parse_api_token_specs(
    raw: &str,
    rate_limit_classes: &HashMap<String, RateLimitPolicy>,
) -> Result<Vec<ApiTokenConfig>> {
    let parsed: Vec<ApiTokenSpecEnv> =
        serde_json::from_str(raw).context("API_TOKEN_SPECS must be a valid JSON array")?;

    if parsed.is_empty() {
        anyhow::bail!("API_TOKEN_SPECS must contain at least one token definition");
    }

    let mut configs = Vec::with_capacity(parsed.len());
    let mut seen_tokens = std::collections::HashSet::with_capacity(parsed.len());
    let mut seen_ids = std::collections::HashSet::with_capacity(parsed.len());

    for spec in parsed {
        let token = spec.token.trim().to_string();
        if token.is_empty() {
            anyhow::bail!("API_TOKEN_SPECS token must not be empty");
        }
        if !seen_tokens.insert(token.clone()) {
            anyhow::bail!("API_TOKEN_SPECS contains duplicate token values");
        }

        let token_id = spec.token_id.trim().to_string();
        if token_id.is_empty() {
            anyhow::bail!("API_TOKEN_SPECS token_id must not be empty");
        }
        if !seen_ids.insert(token_id.clone()) {
            anyhow::bail!("API_TOKEN_SPECS contains duplicate token_id values");
        }

        let label = spec
            .label
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let created_by = spec
            .created_by
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let scopes = normalize_scopes(spec.scopes);
        if scopes.is_empty() {
            anyhow::bail!("API_TOKEN_SPECS scopes must contain at least one scope");
        }

        if let (Some(created_at_ms), Some(expires_at_ms)) = (spec.created_at_ms, spec.expires_at_ms)
        {
            if expires_at_ms <= created_at_ms {
                anyhow::bail!("API_TOKEN_SPECS expires_at_ms must be greater than created_at_ms");
            }
        }

        let allowed_ips = parse_allowed_ips(&spec.allowed_ips)?;
        let rate_limit_class = normalize_rate_limit_class_name(spec.rate_limit_class)?;
        if let Some(class_name) = rate_limit_class.as_deref() {
            if class_name != "default" && !rate_limit_classes.contains_key(class_name) {
                anyhow::bail!("API_TOKEN_SPECS references unknown rate_limit_class: {class_name}");
            }
        }

        if spec.rate_limit_per_minute == Some(0) {
            anyhow::bail!("API_TOKEN_SPECS rate_limit_per_minute must be >= 1");
        }
        if spec.rate_limit_burst_capacity == Some(0) {
            anyhow::bail!("API_TOKEN_SPECS rate_limit_burst_capacity must be >= 1");
        }
        if spec.rate_limit_burst_window_secs == Some(0) {
            anyhow::bail!("API_TOKEN_SPECS rate_limit_burst_window_secs must be >= 1");
        }

        configs.push(ApiTokenConfig {
            token,
            token_id,
            label,
            scopes,
            source: TokenSource::Explicit,
            metadata: ApiTokenMetadata {
                created_by,
                created_at_ms: spec.created_at_ms,
                expires_at_ms: spec.expires_at_ms,
                allowed_ips,
                rate_limit_class,
                rate_limit_per_minute: spec.rate_limit_per_minute,
                rate_limit_burst_capacity: spec.rate_limit_burst_capacity,
                rate_limit_burst_window_secs: spec.rate_limit_burst_window_secs,
            },
        });
    }

    Ok(configs)
}

fn parse_allowed_ips(raw_ips: &[String]) -> Result<std::collections::BTreeSet<String>> {
    let mut allowed_ips = std::collections::BTreeSet::new();

    for raw in raw_ips {
        let Some(normalized) = normalize_allowed_ip_rule(raw) else {
            if raw.trim().is_empty() {
                continue;
            }
            anyhow::bail!("invalid API_TOKEN_SPECS allowed_ip: {}", raw.trim());
        };

        if !allowed_ips.insert(normalized) {
            continue;
        }
    }

    Ok(allowed_ips)
}

fn read_legacy_api_tokens() -> Result<Vec<String>> {
    let mut tokens = Vec::new();
    let mut seen = std::collections::HashSet::new();

    if let Ok(raw) = env::var("API_TOKENS") {
        for token in raw.split(',').map(str::trim).filter(|v| !v.is_empty()) {
            if seen.insert(token.to_string()) {
                tokens.push(token.to_string());
            }
        }
    }

    if tokens.is_empty() {
        let single = env::var("API_TOKEN").context("API_TOKEN or API_TOKENS must be set")?;
        let single = single.trim();
        if single.is_empty() {
            anyhow::bail!("API_TOKEN must not be empty");
        }
        tokens.push(single.to_string());
    }

    Ok(tokens)
}

fn read_env_usize(key: &str, default: usize) -> usize {
    env::var(key)
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(default)
}

fn read_env_u64(key: &str, default: u64) -> u64 {
    env::var(key)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(default)
}

fn read_env_u16(key: &str, default: u16) -> u16 {
    env::var(key)
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(default)
}

fn read_env_u32(key: &str, default: u32) -> u32 {
    env::var(key)
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(default)
}

fn read_env_bool(key: &str, default: bool) -> bool {
    match env::var(key) {
        Ok(raw) => matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        Err(_) => default,
    }
}

fn read_env_trimmed(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn read_env_csv_lowercase(key: &str) -> Vec<String> {
    let Some(raw) = env::var(key).ok() else {
        return Vec::new();
    };

    let mut values: Vec<String> = raw
        .split(',')
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| v.to_ascii_lowercase())
        .collect();
    values.sort();
    values.dedup();
    values
}

fn read_rate_limit_classes(
    default_policy: RateLimitPolicy,
) -> Result<HashMap<String, RateLimitPolicy>> {
    let Some(raw) = read_env_trimmed("RATE_LIMIT_CLASS_SPECS") else {
        return Ok(HashMap::new());
    };

    let parsed: Vec<RateLimitClassSpecEnv> =
        serde_json::from_str(&raw).context("RATE_LIMIT_CLASS_SPECS must be a valid JSON array")?;
    let mut classes = HashMap::with_capacity(parsed.len());

    for spec in parsed {
        let name = normalize_rate_limit_class_name(Some(spec.name))?
            .ok_or_else(|| anyhow::anyhow!("RATE_LIMIT_CLASS_SPECS name must not be empty"))?;
        if name == "default" {
            anyhow::bail!("RATE_LIMIT_CLASS_SPECS must not redefine reserved class name: default");
        }
        if spec.rate_limit_per_minute == 0 {
            anyhow::bail!("RATE_LIMIT_CLASS_SPECS rate_limit_per_minute must be >= 1");
        }
        if spec.rate_limit_burst_capacity == Some(0) {
            anyhow::bail!("RATE_LIMIT_CLASS_SPECS rate_limit_burst_capacity must be >= 1");
        }
        if spec.rate_limit_burst_window_secs == Some(0) {
            anyhow::bail!("RATE_LIMIT_CLASS_SPECS rate_limit_burst_window_secs must be >= 1");
        }

        let burst_window_secs = spec
            .rate_limit_burst_window_secs
            .unwrap_or(default_policy.burst_window_secs);
        let burst_capacity = spec.rate_limit_burst_capacity.unwrap_or_else(|| {
            derived_burst_capacity(spec.rate_limit_per_minute, burst_window_secs)
        });
        let policy = RateLimitPolicy::new(
            spec.rate_limit_per_minute,
            burst_capacity,
            burst_window_secs,
        );

        if classes.insert(name.clone(), policy).is_some() {
            anyhow::bail!("RATE_LIMIT_CLASS_SPECS contains duplicate class name: {name}");
        }
    }

    Ok(classes)
}

fn read_rate_limit_scope_class_defaults(
    rate_limit_classes: &HashMap<String, RateLimitPolicy>,
) -> Result<Vec<RateLimitScopeClassDefault>> {
    let Some(raw) = read_env_trimmed("RATE_LIMIT_SCOPE_CLASS_DEFAULTS") else {
        return Ok(Vec::new());
    };

    let parsed: Vec<RateLimitScopeClassDefaultEnv> = serde_json::from_str(&raw)
        .context("RATE_LIMIT_SCOPE_CLASS_DEFAULTS must be a valid JSON array")?;
    let mut rules = Vec::with_capacity(parsed.len());
    let mut seen_scopes = std::collections::HashSet::with_capacity(parsed.len());

    for spec in parsed {
        let normalized_scope = normalize_scopes([spec.scope])
            .into_iter()
            .next()
            .ok_or_else(|| {
                anyhow::anyhow!("RATE_LIMIT_SCOPE_CLASS_DEFAULTS scope must not be empty")
            })?;
        if !seen_scopes.insert(normalized_scope.clone()) {
            anyhow::bail!(
                "RATE_LIMIT_SCOPE_CLASS_DEFAULTS contains duplicate scope: {normalized_scope}"
            );
        }

        let class_name =
            normalize_rate_limit_class_name(Some(spec.rate_limit_class))?.ok_or_else(|| {
                anyhow::anyhow!(
                    "RATE_LIMIT_SCOPE_CLASS_DEFAULTS rate_limit_class must not be empty"
                )
            })?;
        if class_name != "default" && !rate_limit_classes.contains_key(&class_name) {
            anyhow::bail!(
                "RATE_LIMIT_SCOPE_CLASS_DEFAULTS references unknown rate_limit_class: {class_name}"
            );
        }

        rules.push(RateLimitScopeClassDefault {
            scope: normalized_scope,
            class_name,
        });
    }

    Ok(rules)
}

fn normalize_rate_limit_class_name(raw: Option<String>) -> Result<Option<String>> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let trimmed = raw.trim().to_ascii_lowercase();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if !trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        anyhow::bail!("rate_limit_class must use only alphanumeric, '-', '_' or '.'");
    }
    Ok(Some(trimmed))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::{
        parse_api_token_specs, read_legacy_api_tokens, read_rate_limit_classes,
        read_rate_limit_scope_class_defaults,
    };
    use crate::auth::{
        RateLimitScopeClassDefault, TokenSource, SCOPE_ALL, SCOPE_DOCS_READ, SCOPE_TRACKING_READ,
    };
    use crate::rate_limit::RateLimitPolicy;

    #[test]
    fn parse_api_token_specs_reads_explicit_scopes() {
        let parsed = parse_api_token_specs(
            r#"[{"token":"secret-a","token_id":"partner-a","label":"Partner A","created_by":"ops","created_at_ms":1700000000000,"expires_at_ms":1800000000000,"allowed_ips":["203.0.113.0/24"],"scopes":["tracking:read","docs:read"]}]"#,
            &HashMap::new(),
        )
        .expect("specs should parse");

        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].token_id, "partner-a");
        assert_eq!(parsed[0].label.as_deref(), Some("Partner A"));
        assert_eq!(parsed[0].metadata.created_by.as_deref(), Some("ops"));
        assert_eq!(parsed[0].metadata.created_at_ms, Some(1_700_000_000_000));
        assert_eq!(parsed[0].metadata.expires_at_ms, Some(1_800_000_000_000));
        assert_eq!(
            parsed[0]
                .metadata
                .allowed_ips
                .iter()
                .next()
                .map(ToString::to_string),
            Some("203.0.113.0/24".to_string())
        );
        assert_eq!(parsed[0].metadata.rate_limit_class, None);
        assert!(parsed[0].scopes.contains(SCOPE_TRACKING_READ));
        assert!(parsed[0].scopes.contains(SCOPE_DOCS_READ));
        assert_eq!(parsed[0].source, TokenSource::Explicit);
    }

    #[test]
    fn parse_api_token_specs_accepts_cidr_and_exact_ip_together() {
        let parsed = parse_api_token_specs(
            r#"[{"token":"secret-a","token_id":"partner-a","scopes":["tracking:read"],"allowed_ips":["203.0.113.0/24","198.51.100.10"]}]"#,
            &HashMap::new(),
        )
        .expect("specs should parse");

        let allowed_ips: Vec<_> = parsed[0].metadata.allowed_ips.iter().cloned().collect();
        assert_eq!(
            allowed_ips,
            vec!["198.51.100.10".to_string(), "203.0.113.0/24".to_string()]
        );
    }

    #[test]
    fn parse_api_token_specs_rejects_invalid_allowed_ip() {
        let err = parse_api_token_specs(
            r#"[{"token":"secret-a","token_id":"partner-a","scopes":["tracking:read"],"allowed_ips":["invalid-ip"]}]"#,
            &HashMap::new(),
        )
        .expect_err("invalid IP should be rejected");

        assert!(err
            .to_string()
            .contains("invalid API_TOKEN_SPECS allowed_ip"));
    }

    #[test]
    fn legacy_api_tokens_preserve_input_order_after_dedup() {
        std::env::set_var("API_TOKENS", "bravo,alpha,bravo");
        std::env::remove_var("API_TOKEN");

        let parsed = read_legacy_api_tokens().expect("legacy tokens should parse");

        assert_eq!(parsed, vec!["bravo".to_string(), "alpha".to_string()]);

        std::env::remove_var("API_TOKENS");
    }

    #[test]
    fn parse_api_token_specs_accepts_known_rate_limit_class_and_overrides() {
        let mut classes = HashMap::new();
        classes.insert("partner".to_string(), RateLimitPolicy::new(240, 40, 10));

        let parsed = parse_api_token_specs(
            r#"[{"token":"secret-a","token_id":"partner-a","scopes":["tracking:read"],"rate_limit_class":"partner","rate_limit_per_minute":300}]"#,
            &classes,
        )
        .expect("specs should parse");

        assert_eq!(
            parsed[0].metadata.rate_limit_class.as_deref(),
            Some("partner")
        );
        assert_eq!(parsed[0].metadata.rate_limit_per_minute, Some(300));
    }

    #[test]
    fn parse_api_token_specs_rejects_unknown_rate_limit_class() {
        let err = parse_api_token_specs(
            r#"[{"token":"secret-a","token_id":"partner-a","scopes":["tracking:read"],"rate_limit_class":"unknown"}]"#,
            &HashMap::new(),
        )
        .expect_err("unknown class should be rejected");

        assert!(err
            .to_string()
            .contains("references unknown rate_limit_class"));
    }

    #[test]
    fn read_rate_limit_classes_parses_named_policies() {
        let classes =
            read_rate_limit_classes(RateLimitPolicy::new(120, 20, 10)).unwrap_or_default();
        assert!(classes.is_empty());

        let parsed = read_rate_limit_classes_from_raw_for_test(
            r#"[{"name":"partner","rate_limit_per_minute":240,"rate_limit_burst_window_secs":15},{"name":"docs","rate_limit_per_minute":30,"rate_limit_burst_capacity":10}]"#,
            RateLimitPolicy::new(120, 20, 10),
        )
        .expect("class specs should parse");

        assert_eq!(parsed["partner"].per_minute, 240);
        assert_eq!(parsed["partner"].burst_window_secs, 15);
        assert_eq!(parsed["partner"].burst_capacity, 60);
        assert_eq!(parsed["docs"].burst_capacity, 10);
        assert_eq!(parsed["docs"].burst_window_secs, 10);
    }

    #[test]
    fn read_rate_limit_scope_class_defaults_preserves_order_and_wildcard() {
        let mut classes = HashMap::new();
        classes.insert("partner".to_string(), RateLimitPolicy::new(180, 30, 10));
        classes.insert("docs".to_string(), RateLimitPolicy::new(30, 5, 10));

        let parsed = read_rate_limit_scope_class_defaults_from_raw_for_test(
            r#"[{"scope":"docs:read","rate_limit_class":"docs"},{"scope":"*","rate_limit_class":"partner"}]"#,
            &classes,
        )
        .expect("scope defaults should parse");

        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].scope, SCOPE_DOCS_READ);
        assert_eq!(parsed[0].class_name, "docs");
        assert_eq!(parsed[1].scope, SCOPE_ALL);
        assert_eq!(parsed[1].class_name, "partner");
    }

    #[test]
    fn read_rate_limit_scope_class_defaults_rejects_unknown_class() {
        let err = read_rate_limit_scope_class_defaults_from_raw_for_test(
            r#"[{"scope":"tracking:read","rate_limit_class":"missing"}]"#,
            &HashMap::new(),
        )
        .expect_err("unknown class should be rejected");

        assert!(err
            .to_string()
            .contains("references unknown rate_limit_class"));
    }

    fn read_rate_limit_classes_from_raw_for_test(
        raw: &str,
        default_policy: RateLimitPolicy,
    ) -> anyhow::Result<HashMap<String, RateLimitPolicy>> {
        std::env::set_var("RATE_LIMIT_CLASS_SPECS", raw);
        let result = read_rate_limit_classes(default_policy);
        std::env::remove_var("RATE_LIMIT_CLASS_SPECS");
        result
    }

    fn read_rate_limit_scope_class_defaults_from_raw_for_test(
        raw: &str,
        rate_limit_classes: &HashMap<String, RateLimitPolicy>,
    ) -> anyhow::Result<Vec<RateLimitScopeClassDefault>> {
        std::env::set_var("RATE_LIMIT_SCOPE_CLASS_DEFAULTS", raw);
        let result = read_rate_limit_scope_class_defaults(rate_limit_classes);
        std::env::remove_var("RATE_LIMIT_SCOPE_CLASS_DEFAULTS");
        result
    }
}
