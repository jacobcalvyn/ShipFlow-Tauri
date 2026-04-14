use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use rand::Rng;
use serde::Serialize;
use serde_json::Value;

pub const JOB_KIND_TRACK_LITE_BATCH: &str = "track_lite_batch";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Queued,
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct JobSummary {
    pub job_id: String,
    pub status: JobStatus,
    pub total: usize,
    pub success: usize,
    pub failed: usize,
    pub error: Option<String>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub completed_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct JobResultSnapshot {
    #[serde(flatten)]
    pub summary: JobSummary,
    pub result: Option<Value>,
}

#[derive(Clone)]
pub struct JobRecord {
    pub kind: &'static str,
    pub summary: JobSummary,
    pub result: Option<Value>,
}

pub struct JobStore {
    entries: Mutex<HashMap<String, JobRecord>>,
    result_ttl: Duration,
    max_entries: usize,
}

impl JobStore {
    pub fn new(result_ttl_secs: u64, max_entries: usize) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            result_ttl: Duration::from_secs(result_ttl_secs.max(60)),
            max_entries: max_entries.max(100),
        }
    }

    pub fn create(&self, kind: &'static str, total: usize) -> JobSummary {
        let now = now_ms();
        let job_id = format!("job-{}-{:016x}", now, rand::rng().random::<u64>());
        let summary = JobSummary {
            job_id: job_id.clone(),
            status: JobStatus::Queued,
            total,
            success: 0,
            failed: 0,
            error: None,
            created_at_ms: now,
            updated_at_ms: now,
            completed_at_ms: None,
        };

        let mut entries = self
            .entries
            .lock()
            .expect("job store mutex should not be poisoned");
        self.purge_expired_locked(&mut entries, now);

        entries.insert(
            job_id,
            JobRecord {
                kind,
                summary: summary.clone(),
                result: None,
            },
        );

        if entries.len() > self.max_entries {
            evict_oldest_locked(&mut entries);
        }

        summary
    }

    pub fn mark_running(&self, job_id: &str) -> bool {
        let now = now_ms();
        let mut entries = self
            .entries
            .lock()
            .expect("job store mutex should not be poisoned");
        self.purge_expired_locked(&mut entries, now);

        let Some(record) = entries.get_mut(job_id) else {
            return false;
        };

        record.summary.status = JobStatus::Running;
        record.summary.updated_at_ms = now;
        true
    }

    pub fn mark_completed<T: Serialize>(
        &self,
        job_id: &str,
        success: usize,
        failed: usize,
        result: &T,
    ) -> bool {
        let now = now_ms();
        let serialized = match serde_json::to_value(result) {
            Ok(value) => value,
            Err(_) => return false,
        };
        let mut entries = self
            .entries
            .lock()
            .expect("job store mutex should not be poisoned");
        self.purge_expired_locked(&mut entries, now);

        let Some(record) = entries.get_mut(job_id) else {
            return false;
        };

        record.summary.status = JobStatus::Completed;
        record.summary.success = success;
        record.summary.failed = failed;
        record.summary.error = None;
        record.summary.updated_at_ms = now;
        record.summary.completed_at_ms = Some(now);
        record.result = Some(serialized);
        true
    }

    pub fn mark_failed(&self, job_id: &str, message: String) -> bool {
        let now = now_ms();
        let mut entries = self
            .entries
            .lock()
            .expect("job store mutex should not be poisoned");
        self.purge_expired_locked(&mut entries, now);

        let Some(record) = entries.get_mut(job_id) else {
            return false;
        };

        record.summary.status = JobStatus::Failed;
        record.summary.success = 0;
        record.summary.failed = record.summary.total;
        record.summary.error = Some(message);
        record.summary.updated_at_ms = now;
        record.summary.completed_at_ms = Some(now);
        true
    }

    pub fn get_summary(&self, job_id: &str, kind: &'static str) -> Option<JobSummary> {
        let now = now_ms();
        let mut entries = self
            .entries
            .lock()
            .expect("job store mutex should not be poisoned");
        self.purge_expired_locked(&mut entries, now);
        let record = entries.get(job_id)?;
        if record.kind != kind {
            return None;
        }
        Some(record.summary.clone())
    }

    pub fn get_result(&self, job_id: &str, kind: &'static str) -> Option<JobResultSnapshot> {
        let now = now_ms();
        let mut entries = self
            .entries
            .lock()
            .expect("job store mutex should not be poisoned");
        self.purge_expired_locked(&mut entries, now);
        let record = entries.get(job_id)?.clone();
        if record.kind != kind {
            return None;
        }
        Some(JobResultSnapshot {
            summary: record.summary,
            result: record.result,
        })
    }

    fn purge_expired_locked(&self, entries: &mut HashMap<String, JobRecord>, now_ms: u64) {
        let ttl_ms = self.result_ttl.as_millis() as u64;
        entries.retain(|_, record| match record.summary.completed_at_ms {
            Some(done_at) => now_ms.saturating_sub(done_at) <= ttl_ms,
            None => true,
        });
    }
}

fn evict_oldest_locked(entries: &mut HashMap<String, JobRecord>) {
    // Prioritaskan evict job yang sudah terminal agar job aktif tidak hilang.
    let evict_key = entries
        .iter()
        .filter(|(_, record)| {
            matches!(
                record.summary.status,
                JobStatus::Completed | JobStatus::Failed
            )
        })
        .min_by_key(|(_, record)| record.summary.created_at_ms)
        .map(|(key, _)| key.clone())
        .or_else(|| {
            entries
                .iter()
                .min_by_key(|(_, record)| record.summary.created_at_ms)
                .map(|(key, _)| key.clone())
        });

    if let Some(key) = evict_key {
        entries.remove(&key);
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
    use super::*;
    use std::collections::HashMap;

    use crate::track_batch::TrackLiteBatchResponse;

    #[test]
    fn create_and_update_job_flow() {
        let store = JobStore::new(300, 100);
        let created = store.create(JOB_KIND_TRACK_LITE_BATCH, 2);
        assert_eq!(created.status, JobStatus::Queued);

        assert!(store.mark_running(&created.job_id));
        let running = store
            .get_summary(&created.job_id, JOB_KIND_TRACK_LITE_BATCH)
            .expect("job should exist");
        assert_eq!(running.status, JobStatus::Running);

        let result = TrackLiteBatchResponse {
            total: 2,
            success: 1,
            failed: 1,
            results: Vec::new(),
        };
        assert!(store.mark_completed(&created.job_id, 1, 1, &result));
        let done = store
            .get_result(&created.job_id, JOB_KIND_TRACK_LITE_BATCH)
            .expect("job should exist");
        assert_eq!(done.summary.status, JobStatus::Completed);
        assert_eq!(done.summary.success, 1);
        assert_eq!(done.summary.failed, 1);
        assert!(done.result.is_some());
    }

    #[test]
    fn evict_oldest_prefers_terminal_job() {
        fn summary(job_id: &str, status: JobStatus, created_at_ms: u64) -> JobSummary {
            JobSummary {
                job_id: job_id.to_string(),
                status,
                total: 1,
                success: 0,
                failed: 0,
                error: None,
                created_at_ms,
                updated_at_ms: created_at_ms,
                completed_at_ms: None,
            }
        }

        let mut entries = HashMap::new();
        entries.insert(
            "running".to_string(),
            JobRecord {
                kind: JOB_KIND_TRACK_LITE_BATCH,
                summary: summary("running", JobStatus::Running, 1),
                result: None,
            },
        );
        entries.insert(
            "completed".to_string(),
            JobRecord {
                kind: JOB_KIND_TRACK_LITE_BATCH,
                summary: summary("completed", JobStatus::Completed, 2),
                result: None,
            },
        );
        entries.insert(
            "queued".to_string(),
            JobRecord {
                kind: JOB_KIND_TRACK_LITE_BATCH,
                summary: summary("queued", JobStatus::Queued, 3),
                result: None,
            },
        );

        evict_oldest_locked(&mut entries);

        assert!(entries.contains_key("running"));
        assert!(entries.contains_key("queued"));
        assert!(!entries.contains_key("completed"));
    }
}
