use std::{
    collections::{BTreeSet, HashMap},
    net::IpAddr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, MutexGuard,
    },
};

use axum::http::Method;
use ipnet::IpNet;
use serde::{Deserialize, Serialize};

use crate::rate_limit::{derived_burst_capacity, RateLimitPolicy};

pub const SCOPE_ALL: &str = "*";
pub const SCOPE_TRACKING_READ: &str = "tracking:read";
pub const SCOPE_BAG_READ: &str = "bag:read";
pub const SCOPE_MANIFEST_READ: &str = "manifest:read";
pub const SCOPE_JOBS_READ: &str = "jobs:read";
pub const SCOPE_JOBS_WRITE: &str = "jobs:write";
pub const SCOPE_METRICS_READ: &str = "metrics:read";
pub const SCOPE_PARSER_GUARD_READ: &str = "parser_guard:read";
pub const SCOPE_DOCS_READ: &str = "docs:read";
pub const SCOPE_ADMIN_READ: &str = "admin:read";
pub const SCOPE_ADMIN_WRITE: &str = "admin:write";

const ALL_SCOPES: &[&str] = &[
    SCOPE_TRACKING_READ,
    SCOPE_BAG_READ,
    SCOPE_MANIFEST_READ,
    SCOPE_JOBS_READ,
    SCOPE_JOBS_WRITE,
    SCOPE_METRICS_READ,
    SCOPE_PARSER_GUARD_READ,
    SCOPE_DOCS_READ,
    SCOPE_ADMIN_READ,
    SCOPE_ADMIN_WRITE,
];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TokenSource {
    LegacyFullAccess,
    Explicit,
    Managed,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ApiTokenMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub allowed_ips: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate_limit_class: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate_limit_per_minute: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate_limit_burst_capacity: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate_limit_burst_window_secs: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RateLimitScopeClassDefault {
    pub scope: String,
    pub class_name: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ApiTokenRevocationState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revoked_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revoked_by_token_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revoke_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub successor_token_id: Option<String>,
}

impl ApiTokenRevocationState {
    pub fn is_revoked(&self) -> bool {
        self.revoked_at_ms.is_some()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiTokenConfig {
    #[serde(skip_serializing)]
    pub token: String,
    pub token_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub scopes: BTreeSet<String>,
    pub source: TokenSource,
    #[serde(flatten)]
    pub metadata: ApiTokenMetadata,
}

impl ApiTokenConfig {
    pub fn legacy_full_access(token: impl Into<String>, token_id: impl Into<String>) -> Self {
        Self {
            token: token.into(),
            token_id: token_id.into(),
            label: None,
            scopes: full_access_scopes(),
            source: TokenSource::LegacyFullAccess,
            metadata: ApiTokenMetadata::default(),
        }
    }

    pub fn explicit(
        token: impl Into<String>,
        token_id: impl Into<String>,
        label: Option<String>,
        scopes: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self::explicit_with_metadata(token, token_id, label, scopes, ApiTokenMetadata::default())
    }

    pub fn explicit_with_metadata(
        token: impl Into<String>,
        token_id: impl Into<String>,
        label: Option<String>,
        scopes: impl IntoIterator<Item = impl Into<String>>,
        metadata: ApiTokenMetadata,
    ) -> Self {
        Self {
            token: token.into(),
            token_id: token_id.into(),
            label,
            scopes: normalize_scopes(scopes),
            source: TokenSource::Explicit,
            metadata,
        }
    }

    pub fn managed_with_metadata(
        token: impl Into<String>,
        token_id: impl Into<String>,
        label: Option<String>,
        scopes: impl IntoIterator<Item = impl Into<String>>,
        metadata: ApiTokenMetadata,
    ) -> Self {
        Self {
            token: token.into(),
            token_id: token_id.into(),
            label,
            scopes: normalize_scopes(scopes),
            source: TokenSource::Managed,
            metadata,
        }
    }
}

#[derive(Debug)]
pub struct ApiTokenRecord {
    pub token_id: String,
    pub label: Option<String>,
    pub scopes: BTreeSet<String>,
    pub source: TokenSource,
    pub metadata: ApiTokenMetadata,
    allowed_ip_rules: Vec<IpAllowRule>,
    last_used_at_ms: AtomicU64,
    revoked_at_ms: AtomicU64,
    revoked_by_token_id: Mutex<Option<String>>,
    revoke_reason: Mutex<Option<String>>,
    successor_token_id: Mutex<Option<String>>,
}

impl ApiTokenRecord {
    pub fn has_scope(&self, scope: &str) -> bool {
        self.scopes.contains(SCOPE_ALL) || self.scopes.contains(scope)
    }

    pub fn scopes_vec(&self) -> Vec<String> {
        self.scopes.iter().cloned().collect()
    }

    pub fn mark_used(&self, used_at_ms: u64) {
        self.last_used_at_ms.store(used_at_ms, Ordering::Relaxed);
    }

    pub fn last_used_at_ms(&self) -> Option<u64> {
        match self.last_used_at_ms.load(Ordering::Relaxed) {
            0 => None,
            value => Some(value),
        }
    }

    pub fn revoke(
        &self,
        revoked_at_ms: u64,
        revoked_by_token_id: Option<String>,
        revoke_reason: Option<String>,
        successor_token_id: Option<String>,
    ) {
        self.revoked_at_ms.store(revoked_at_ms, Ordering::Relaxed);
        *recover_lock(&self.revoked_by_token_id) = revoked_by_token_id;
        *recover_lock(&self.revoke_reason) = revoke_reason;
        *recover_lock(&self.successor_token_id) = successor_token_id;
    }

    pub fn restore(&self) {
        self.revoked_at_ms.store(0, Ordering::Relaxed);
        *recover_lock(&self.revoked_by_token_id) = None;
        *recover_lock(&self.revoke_reason) = None;
        *recover_lock(&self.successor_token_id) = None;
    }

    pub fn is_revoked(&self) -> bool {
        self.revoked_at_ms.load(Ordering::Relaxed) != 0
    }

    pub fn revoked_at_ms(&self) -> Option<u64> {
        match self.revoked_at_ms.load(Ordering::Relaxed) {
            0 => None,
            value => Some(value),
        }
    }

    pub fn revoked_by_token_id(&self) -> Option<String> {
        recover_lock(&self.revoked_by_token_id).clone()
    }

    pub fn revoke_reason(&self) -> Option<String> {
        recover_lock(&self.revoke_reason).clone()
    }

    pub fn successor_token_id(&self) -> Option<String> {
        recover_lock(&self.successor_token_id).clone()
    }

    pub fn revocation_state(&self) -> ApiTokenRevocationState {
        ApiTokenRevocationState {
            revoked_at_ms: self.revoked_at_ms(),
            revoked_by_token_id: self.revoked_by_token_id(),
            revoke_reason: self.revoke_reason(),
            successor_token_id: self.successor_token_id(),
        }
    }

    pub fn apply_revocation_state(&self, state: &ApiTokenRevocationState) {
        match state.revoked_at_ms {
            Some(revoked_at_ms) => self.revoke(
                revoked_at_ms,
                state.revoked_by_token_id.clone(),
                state.revoke_reason.clone(),
                state.successor_token_id.clone(),
            ),
            None => self.restore(),
        }
    }

    pub fn is_expired(&self, now_ms: u64) -> bool {
        self.metadata
            .expires_at_ms
            .is_some_and(|expires_at_ms| expires_at_ms <= now_ms)
    }

    pub fn allows_ip(&self, client_ip: Option<IpAddr>) -> bool {
        if self.allowed_ip_rules.is_empty() {
            return true;
        }

        client_ip.is_some_and(|ip| self.allowed_ip_rules.iter().any(|rule| rule.matches(ip)))
    }

    pub fn allowed_ips_vec(&self) -> Vec<String> {
        self.metadata.allowed_ips.iter().cloned().collect()
    }

    pub fn configured_rate_limit_class(&self) -> Option<&str> {
        self.metadata.rate_limit_class.as_deref()
    }

    pub fn resolved_rate_limit(
        &self,
        default_policy: RateLimitPolicy,
        class_policies: &HashMap<String, RateLimitPolicy>,
        scope_class_defaults: &[RateLimitScopeClassDefault],
    ) -> ResolvedRateLimitPolicy {
        let scope_default_class = if self.configured_rate_limit_class().is_none()
            && self.source == TokenSource::Explicit
        {
            scope_class_defaults
                .iter()
                .find(|rule| rule.scope == SCOPE_ALL || self.has_scope(&rule.scope))
                .map(|rule| rule.class_name.as_str())
        } else {
            None
        };
        let base_class_name = self
            .configured_rate_limit_class()
            .or(scope_default_class)
            .unwrap_or("default")
            .to_string();
        let base_policy = if base_class_name == "default" {
            default_policy
        } else {
            class_policies
                .get(base_class_name.as_str())
                .copied()
                .unwrap_or(default_policy)
        };

        let per_minute = self
            .metadata
            .rate_limit_per_minute
            .unwrap_or(base_policy.per_minute);
        let burst_window_secs = self
            .metadata
            .rate_limit_burst_window_secs
            .unwrap_or(base_policy.burst_window_secs);
        let burst_capacity = self.metadata.rate_limit_burst_capacity.unwrap_or_else(|| {
            if self.metadata.rate_limit_per_minute.is_some()
                || self.metadata.rate_limit_burst_window_secs.is_some()
            {
                derived_burst_capacity(per_minute, burst_window_secs)
            } else {
                base_policy.burst_capacity
            }
        });
        let class_name = if self.configured_rate_limit_class().is_none()
            && (self.metadata.rate_limit_per_minute.is_some()
                || self.metadata.rate_limit_burst_capacity.is_some()
                || self.metadata.rate_limit_burst_window_secs.is_some())
        {
            "custom".to_string()
        } else {
            base_class_name
        };

        ResolvedRateLimitPolicy {
            class_name,
            policy: RateLimitPolicy::new(per_minute, burst_capacity, burst_window_secs),
        }
    }
}

#[derive(Debug, Clone)]
pub struct AuthContext {
    pub token_id: String,
    pub label: Option<String>,
    pub scopes: Vec<String>,
    pub source: TokenSource,
    pub created_by: Option<String>,
    pub created_at_ms: Option<u64>,
    pub expires_at_ms: Option<u64>,
    pub last_used_at_ms: Option<u64>,
    pub allowed_ips: Vec<String>,
    pub client_ip: Option<String>,
    pub rate_limit_class: String,
    pub rate_limit_per_minute: u32,
    pub rate_limit_burst_capacity: u32,
    pub rate_limit_burst_window_secs: u64,
}

#[derive(Debug, Clone)]
pub struct ResolvedRateLimitPolicy {
    pub class_name: String,
    pub policy: RateLimitPolicy,
}

impl AuthContext {
    pub fn from_record(
        record: &ApiTokenRecord,
        client_ip: Option<IpAddr>,
        resolved_rate_limit: ResolvedRateLimitPolicy,
    ) -> Self {
        Self {
            token_id: record.token_id.clone(),
            label: record.label.clone(),
            scopes: record.scopes_vec(),
            source: record.source,
            created_by: record.metadata.created_by.clone(),
            created_at_ms: record.metadata.created_at_ms,
            expires_at_ms: record.metadata.expires_at_ms,
            last_used_at_ms: record.last_used_at_ms(),
            allowed_ips: record.allowed_ips_vec(),
            client_ip: client_ip.map(|ip| ip.to_string()),
            rate_limit_class: resolved_rate_limit.class_name,
            rate_limit_per_minute: resolved_rate_limit.policy.per_minute,
            rate_limit_burst_capacity: resolved_rate_limit.policy.burst_capacity,
            rate_limit_burst_window_secs: resolved_rate_limit.policy.burst_window_secs,
        }
    }
}

pub fn build_token_lookup(configs: &[ApiTokenConfig]) -> HashMap<String, ApiTokenRecord> {
    configs
        .iter()
        .map(|config| {
            (
                config.token.clone(),
                ApiTokenRecord {
                    token_id: config.token_id.clone(),
                    label: config.label.clone(),
                    scopes: config.scopes.clone(),
                    source: config.source,
                    metadata: config.metadata.clone(),
                    allowed_ip_rules: compile_allowed_ip_rules(&config.metadata.allowed_ips),
                    last_used_at_ms: AtomicU64::new(0),
                    revoked_at_ms: AtomicU64::new(0),
                    revoked_by_token_id: Mutex::new(None),
                    revoke_reason: Mutex::new(None),
                    successor_token_id: Mutex::new(None),
                },
            )
        })
        .collect()
}

#[derive(Debug, Clone)]
enum IpAllowRule {
    Exact(IpAddr),
    Cidr(IpNet),
}

impl IpAllowRule {
    fn matches(&self, ip: IpAddr) -> bool {
        match self {
            Self::Exact(expected) => *expected == ip,
            Self::Cidr(network) => network.contains(&ip),
        }
    }
}

fn compile_allowed_ip_rules(raw_rules: &BTreeSet<String>) -> Vec<IpAllowRule> {
    raw_rules
        .iter()
        .filter_map(|rule| parse_allowed_ip_rule(rule))
        .collect()
}

pub fn normalize_allowed_ip_rule(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Ok(ip) = trimmed.parse::<IpAddr>() {
        return Some(ip.to_string());
    }

    trimmed
        .parse::<IpNet>()
        .ok()
        .map(|network| network.to_string())
}

fn parse_allowed_ip_rule(raw: &str) -> Option<IpAllowRule> {
    let normalized = normalize_allowed_ip_rule(raw)?;

    if let Ok(ip) = normalized.parse::<IpAddr>() {
        return Some(IpAllowRule::Exact(ip));
    }

    normalized.parse::<IpNet>().ok().map(IpAllowRule::Cidr)
}

pub fn find_token_record_by_id<'a>(
    lookup: &'a HashMap<String, ApiTokenRecord>,
    token_id: &str,
) -> Option<&'a ApiTokenRecord> {
    lookup.values().find(|record| record.token_id == token_id)
}

pub fn full_access_scopes() -> BTreeSet<String> {
    ALL_SCOPES
        .iter()
        .map(|scope| (*scope).to_string())
        .collect()
}

pub fn normalize_scopes(scopes: impl IntoIterator<Item = impl Into<String>>) -> BTreeSet<String> {
    scopes
        .into_iter()
        .map(Into::into)
        .map(|scope: String| scope.trim().to_ascii_lowercase())
        .filter(|scope| !scope.is_empty())
        .collect()
}

pub fn required_scope_for_request(_method: &Method, path: &str) -> Option<&'static str> {
    if path == "/metrics" {
        return Some(SCOPE_METRICS_READ);
    }

    if path == "/parserGuard" {
        return Some(SCOPE_PARSER_GUARD_READ);
    }

    if path == "/openapi.json" {
        return Some(SCOPE_DOCS_READ);
    }

    if matches!(
        path,
        "/v1/admin/tokens/revoke"
            | "/v1/admin/tokens/restore"
            | "/v1/admin/tokens/rotate"
            | "/v1/admin/tokens/managed/create"
            | "/v1/admin/tokens/managed/rotate-secret"
    ) {
        return Some(SCOPE_ADMIN_WRITE);
    }

    if path == "/v1/admin/tokens" {
        return Some(SCOPE_ADMIN_READ);
    }

    if matches!(path, "/v1/track/html" | "/v1/track/detail") {
        return Some(SCOPE_TRACKING_READ);
    }

    if matches!(path, "/v1/bag/html" | "/v1/bag/detail") {
        return Some(SCOPE_BAG_READ);
    }

    if matches!(path, "/v1/manifest/html" | "/v1/manifest/detail") {
        return Some(SCOPE_MANIFEST_READ);
    }

    None
}

fn recover_lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::{
        normalize_allowed_ip_rule, ApiTokenConfig, ApiTokenMetadata, RateLimitPolicy,
        RateLimitScopeClassDefault,
    };

    #[test]
    fn allows_ip_matches_cidr_rule() {
        let metadata = ApiTokenMetadata {
            allowed_ips: ["203.0.113.0/24".to_string()].into_iter().collect(),
            ..ApiTokenMetadata::default()
        };
        let lookup = super::build_token_lookup(&[ApiTokenConfig::explicit_with_metadata(
            "token-a",
            "partner-a",
            None,
            [super::SCOPE_TRACKING_READ],
            metadata,
        )]);
        let record = lookup.get("token-a").expect("token should exist");

        assert!(record.allows_ip(Some("203.0.113.10".parse().expect("ip should parse"))));
        assert!(!record.allows_ip(Some("198.51.100.10".parse().expect("ip should parse"))));
    }

    #[test]
    fn normalize_allowed_ip_rule_canonicalizes_exact_and_cidr_values() {
        assert_eq!(
            normalize_allowed_ip_rule("203.0.113.10"),
            Some("203.0.113.10".to_string())
        );
        assert_eq!(
            normalize_allowed_ip_rule("203.0.113.10/24"),
            Some("203.0.113.10/24".to_string())
        );
        assert_eq!(
            normalize_allowed_ip_rule("2001:DB8::/64"),
            Some("2001:db8::/64".to_string())
        );
        assert_eq!(normalize_allowed_ip_rule(""), None);
        assert_eq!(normalize_allowed_ip_rule("invalid"), None);
    }

    #[test]
    fn resolved_rate_limit_uses_scope_default_for_explicit_tokens() {
        let lookup = super::build_token_lookup(&[ApiTokenConfig::explicit(
            "token-a",
            "partner-a",
            None,
            [super::SCOPE_TRACKING_READ],
        )]);
        let record = lookup.get("token-a").expect("token should exist");
        let mut class_policies = HashMap::new();
        class_policies.insert("partner".to_string(), RateLimitPolicy::new(180, 30, 10));
        let scope_defaults = vec![RateLimitScopeClassDefault {
            scope: super::SCOPE_TRACKING_READ.to_string(),
            class_name: "partner".to_string(),
        }];

        let resolved = record.resolved_rate_limit(
            RateLimitPolicy::new(120, 20, 10),
            &class_policies,
            &scope_defaults,
        );

        assert_eq!(resolved.class_name, "partner");
        assert_eq!(resolved.policy, RateLimitPolicy::new(180, 30, 10));
    }

    #[test]
    fn resolved_rate_limit_keeps_legacy_tokens_on_default_without_explicit_class() {
        let lookup =
            super::build_token_lookup(&[ApiTokenConfig::legacy_full_access("token-a", "legacy-a")]);
        let record = lookup.get("token-a").expect("token should exist");
        let mut class_policies = HashMap::new();
        class_policies.insert("admin".to_string(), RateLimitPolicy::new(300, 60, 10));
        let scope_defaults = vec![RateLimitScopeClassDefault {
            scope: super::SCOPE_ADMIN_WRITE.to_string(),
            class_name: "admin".to_string(),
        }];

        let resolved = record.resolved_rate_limit(
            RateLimitPolicy::new(120, 20, 10),
            &class_policies,
            &scope_defaults,
        );

        assert_eq!(resolved.class_name, "default");
        assert_eq!(resolved.policy, RateLimitPolicy::new(120, 20, 10));
    }
}
