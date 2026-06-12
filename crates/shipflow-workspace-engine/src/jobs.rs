use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportAttemptStatus {
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Interrupted,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportAttemptRecord {
    pub attempt_id: String,
    pub job_item_id: String,
    pub attempt_number: u32,
    pub status: ImportAttemptStatus,
    pub error_message: Option<String>,
    pub raw_blob_id: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRecoverySummary {
    pub recovered_job_ids: Vec<String>,
    pub recovered_item_ids: Vec<String>,
    pub interrupted_attempt_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub initial_backoff_ms: u64,
    pub max_backoff_ms: u64,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            initial_backoff_ms: 1_000,
            max_backoff_ms: 30_000,
        }
    }
}

pub fn next_backoff_ms(policy: &RetryPolicy, attempt_number: u32) -> u64 {
    if attempt_number <= 1 {
        return policy.initial_backoff_ms;
    }

    let multiplier = 2_u64.saturating_pow(attempt_number.saturating_sub(1));
    policy
        .initial_backoff_ms
        .saturating_mul(multiplier)
        .min(policy.max_backoff_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_backoff_caps_at_policy_max() {
        let policy = RetryPolicy {
            max_attempts: 5,
            initial_backoff_ms: 100,
            max_backoff_ms: 250,
        };

        assert_eq!(next_backoff_ms(&policy, 1), 100);
        assert_eq!(next_backoff_ms(&policy, 2), 200);
        assert_eq!(next_backoff_ms(&policy, 3), 250);
        assert_eq!(next_backoff_ms(&policy, 10), 250);
    }
}
