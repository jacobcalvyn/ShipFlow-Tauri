use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy)]
struct TokenBucket {
    tokens: f64,
    last_refill: Instant,
}

#[derive(Debug, Clone, Copy)]
struct TokenBuckets {
    policy: RateLimitPolicy,
    sustained: TokenBucket,
    burst: TokenBucket,
    last_seen: Instant,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct RateLimitPolicy {
    pub per_minute: u32,
    pub burst_capacity: u32,
    pub burst_window_secs: u64,
}

impl RateLimitPolicy {
    pub fn new(per_minute: u32, burst_capacity: u32, burst_window_secs: u64) -> Self {
        Self {
            per_minute: per_minute.max(1),
            burst_capacity: burst_capacity.max(1),
            burst_window_secs: burst_window_secs.max(1),
        }
    }

    pub fn with_derived_burst(per_minute: u32, burst_window_secs: u64) -> Self {
        let burst_window_secs = burst_window_secs.max(1);
        Self::new(
            per_minute,
            derived_burst_capacity(per_minute, burst_window_secs),
            burst_window_secs,
        )
    }
}

pub fn derived_burst_capacity(per_minute: u32, burst_window_secs: u64) -> u32 {
    let numerator = (per_minute.max(1) as u64).saturating_mul(burst_window_secs.max(1));
    numerator.div_ceil(60).max(1) as u32
}

#[derive(Debug, Clone, Copy)]
pub struct RateLimitDecision {
    pub allowed: bool,
    pub limit: u32,
    pub remaining: u32,
    pub reset_at_epoch_secs: u64,
    pub retry_after_secs: Option<u64>,
    pub burst_limit: u32,
    pub burst_remaining: u32,
    pub burst_reset_at_epoch_secs: u64,
}

#[derive(Debug)]
pub struct RateLimiter {
    default_policy: RateLimitPolicy,
    buckets: Mutex<HashMap<String, TokenBuckets>>,
    cleanup_after: Duration,
}

impl RateLimiter {
    pub fn new(per_minute: u32, burst_capacity: u32, burst_window_secs: u64) -> Self {
        let default_policy = RateLimitPolicy::new(per_minute, burst_capacity, burst_window_secs);
        Self {
            default_policy,
            buckets: Mutex::new(HashMap::new()),
            cleanup_after: Duration::from_secs((60 * 10).max(default_policy.burst_window_secs * 4)),
        }
    }

    pub fn check(&self, key: &str) -> RateLimitDecision {
        self.check_with_policy(key, self.default_policy)
    }

    pub fn check_with_policy(&self, key: &str, policy: RateLimitPolicy) -> RateLimitDecision {
        let now = Instant::now();
        let mut buckets = self
            .buckets
            .lock()
            .expect("rate limiter mutex should not be poisoned");

        if buckets.len() > 10_000 {
            buckets.retain(|_, bucket| now.duration_since(bucket.last_seen) < self.cleanup_after);
        }

        let buckets_entry = buckets.entry(key.to_string()).or_insert(TokenBuckets {
            policy,
            sustained: TokenBucket {
                tokens: policy.per_minute as f64,
                last_refill: now,
            },
            burst: TokenBucket {
                tokens: policy.burst_capacity as f64,
                last_refill: now,
            },
            last_seen: now,
        });
        if buckets_entry.policy != policy {
            *buckets_entry = TokenBuckets {
                policy,
                sustained: TokenBucket {
                    tokens: policy.per_minute as f64,
                    last_refill: now,
                },
                burst: TokenBucket {
                    tokens: policy.burst_capacity as f64,
                    last_refill: now,
                },
                last_seen: now,
            };
        }
        refill_bucket(
            &mut buckets_entry.sustained,
            now,
            policy.per_minute as f64,
            policy.per_minute as f64 / 60.0,
        );
        refill_bucket(
            &mut buckets_entry.burst,
            now,
            policy.burst_capacity as f64,
            policy.burst_capacity as f64 / policy.burst_window_secs as f64,
        );
        buckets_entry.last_seen = now;

        let sustained_retry_after_secs = refill_wait_secs(
            buckets_entry.sustained.tokens,
            policy.per_minute as f64 / 60.0,
        );
        let burst_retry_after_secs = refill_wait_secs(
            buckets_entry.burst.tokens,
            policy.burst_capacity as f64 / policy.burst_window_secs as f64,
        );

        let allowed = buckets_entry.sustained.tokens >= 1.0 && buckets_entry.burst.tokens >= 1.0;
        if allowed {
            buckets_entry.sustained.tokens -= 1.0;
            buckets_entry.burst.tokens -= 1.0;
        };

        let sustained_remaining = buckets_entry.sustained.tokens.floor().max(0.0) as u32;
        let burst_remaining = buckets_entry.burst.tokens.floor().max(0.0) as u32;
        let remaining = sustained_remaining.min(burst_remaining);
        let retry_after_secs = if allowed {
            None
        } else {
            Some(sustained_retry_after_secs.max(burst_retry_after_secs))
        };
        let reset_after_secs = if allowed && remaining == 0 {
            sustained_retry_after_secs.max(burst_retry_after_secs)
        } else {
            retry_after_secs.unwrap_or(0)
        };
        let burst_reset_after_secs = if !allowed || burst_remaining == 0 {
            burst_retry_after_secs
        } else {
            0
        };

        RateLimitDecision {
            allowed,
            limit: policy.per_minute,
            remaining,
            reset_at_epoch_secs: now_epoch_secs().saturating_add(reset_after_secs),
            retry_after_secs,
            burst_limit: policy.burst_capacity,
            burst_remaining,
            burst_reset_at_epoch_secs: now_epoch_secs().saturating_add(burst_reset_after_secs),
        }
    }

    pub fn allow(&self, key: &str) -> bool {
        self.check(key).allowed
    }

    pub fn allow_with_policy(&self, key: &str, policy: RateLimitPolicy) -> bool {
        self.check_with_policy(key, policy).allowed
    }
}

fn refill_bucket(bucket: &mut TokenBucket, now: Instant, capacity: f64, refill_per_sec: f64) {
    let elapsed = now.duration_since(bucket.last_refill).as_secs_f64();
    if elapsed > 0.0 {
        bucket.tokens = (bucket.tokens + elapsed * refill_per_sec).min(capacity);
        bucket.last_refill = now;
    }
}

fn refill_wait_secs(tokens: f64, refill_per_sec: f64) -> u64 {
    if refill_per_sec <= 0.0 || tokens >= 1.0 {
        return 0;
    }

    ((1.0 - tokens).max(0.0) / refill_per_sec).ceil() as u64
}

fn now_epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_limiter_blocks_after_capacity() {
        let limiter = RateLimiter::new(2, 2, 60);
        assert!(limiter.allow("token-a"));
        assert!(limiter.allow("token-a"));
        assert!(!limiter.allow("token-a"));
    }

    #[test]
    fn rate_limiter_isolated_per_token() {
        let limiter = RateLimiter::new(1, 1, 60);
        assert!(limiter.allow("token-a"));
        assert!(limiter.allow("token-b"));
        assert!(!limiter.allow("token-a"));
    }

    #[test]
    fn rate_limiter_reports_headers_metadata() {
        let limiter = RateLimiter::new(1, 1, 60);
        let first = limiter.check("token-a");
        assert!(first.allowed);
        assert_eq!(first.limit, 1);
        assert_eq!(first.remaining, 0);
        assert_eq!(first.burst_limit, 1);
        assert_eq!(first.burst_remaining, 0);

        let second = limiter.check("token-a");
        assert!(!second.allowed);
        assert_eq!(second.remaining, 0);
        assert_eq!(second.burst_remaining, 0);
        assert!(second.retry_after_secs.is_some());
        assert!(second.reset_at_epoch_secs >= first.reset_at_epoch_secs);
    }

    #[test]
    fn rate_limiter_enforces_burst_before_sustained_limit() {
        let limiter = RateLimiter::new(120, 2, 60);

        let first = limiter.check("token-a");
        let second = limiter.check("token-a");
        let third = limiter.check("token-a");

        assert!(first.allowed);
        assert!(second.allowed);
        assert!(!third.allowed);
        assert_eq!(third.limit, 120);
        assert_eq!(third.burst_limit, 2);
        assert_eq!(third.remaining, 0);
        assert_eq!(third.burst_remaining, 0);
        assert_eq!(third.retry_after_secs, Some(30));
    }

    #[test]
    fn rate_limiter_reports_next_reset_when_allowed_budget_is_exhausted() {
        let limiter = RateLimiter::new(2, 2, 60);

        let first = limiter.check("token-a");
        let second = limiter.check("token-a");

        assert!(first.allowed);
        assert!(second.allowed);
        assert_eq!(second.remaining, 0);
        assert!(second.reset_at_epoch_secs >= first.reset_at_epoch_secs);
        assert!(second.burst_reset_at_epoch_secs >= first.burst_reset_at_epoch_secs);
    }
}
