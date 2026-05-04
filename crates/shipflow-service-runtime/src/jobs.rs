use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use shipflow_core::model::TrackResponse;

use crate::api_contract::generated_at_iso8601;

static JOB_COUNTER: AtomicU64 = AtomicU64::new(0);

pub const MAX_BATCH_SHIPMENT_IDS: usize = 1_000;
pub const MAX_BATCH_SHIPMENT_ID_LENGTH: usize = 128;

const MAX_RETAINED_BATCH_JOBS: usize = 100;
const BATCH_JOB_RETENTION_MS: u128 = 6 * 60 * 60 * 1_000;

#[derive(Clone, Debug, Default)]
pub struct BatchJobRegistry {
    inner: Arc<Mutex<HashMap<String, BatchJobRecord>>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchTrackJobStart {
    pub job_id: String,
    pub status: BatchJobStatus,
    pub status_endpoint: String,
    pub result_endpoint: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchJobSnapshot {
    pub job_id: String,
    pub status: BatchJobStatus,
    pub total: usize,
    pub completed: usize,
    pub failed: usize,
    pub cancel_requested: bool,
    pub error_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchJobResultSnapshot {
    #[serde(flatten)]
    pub status: BatchJobSnapshot,
    pub results: Vec<BatchTrackJobItemResult>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchTrackJobItemResult {
    pub id: String,
    pub status: BatchJobItemStatus,
    pub data: Option<TrackResponse>,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BatchJobStatus {
    Queued,
    Running,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BatchJobItemStatus {
    Success,
    Error,
    Cancelled,
}

#[derive(Clone, Debug)]
struct BatchJobRecord {
    status: BatchJobStatus,
    total: usize,
    completed: usize,
    failed: usize,
    cancel_requested: bool,
    error_message: Option<String>,
    created_at: String,
    updated_at: String,
    updated_at_unix_ms: u128,
    results: Vec<BatchTrackJobItemResult>,
}

impl BatchJobRegistry {
    pub fn create_track_job(&self, total: usize) -> Result<BatchTrackJobStart, String> {
        let job_id = generate_job_id();
        let now_ms = unix_ms();
        let now = generated_at_iso8601();
        let record = BatchJobRecord {
            status: BatchJobStatus::Queued,
            total,
            completed: 0,
            failed: 0,
            cancel_requested: false,
            error_message: None,
            created_at: now.clone(),
            updated_at: now,
            updated_at_unix_ms: now_ms,
            results: Vec::with_capacity(total.min(256)),
        };

        {
            let mut jobs = self.inner.lock().expect("batch job registry lock poisoned");
            prune_jobs_locked(&mut jobs, now_ms);
            if jobs.len() >= MAX_RETAINED_BATCH_JOBS {
                return Err("Too many batch jobs are active. Try again later.".into());
            }
            jobs.insert(job_id.clone(), record);
        }

        Ok(BatchTrackJobStart {
            status: BatchJobStatus::Queued,
            status_endpoint: format!("/v1/jobs/{job_id}"),
            result_endpoint: format!("/v1/jobs/{job_id}/result"),
            job_id,
        })
    }

    pub fn mark_running(&self, job_id: &str) {
        self.update_job(job_id, |record| {
            record.status = BatchJobStatus::Running;
        });
    }

    pub fn push_success(&self, job_id: &str, id: String, data: TrackResponse) -> bool {
        self.push_result(
            job_id,
            BatchTrackJobItemResult {
                id,
                status: BatchJobItemStatus::Success,
                data: Some(data),
                error: None,
            },
        )
    }

    pub fn push_error(&self, job_id: &str, id: String, error: String) -> bool {
        self.push_result(
            job_id,
            BatchTrackJobItemResult {
                id,
                status: BatchJobItemStatus::Error,
                data: None,
                error: Some(error),
            },
        )
    }

    pub fn push_cancelled(&self, job_id: &str, id: String) -> bool {
        self.push_result(
            job_id,
            BatchTrackJobItemResult {
                id,
                status: BatchJobItemStatus::Cancelled,
                data: None,
                error: None,
            },
        )
    }

    pub fn finish(&self, job_id: &str) {
        self.update_job(job_id, |record| {
            if record.status == BatchJobStatus::Running || record.status == BatchJobStatus::Queued {
                record.status = if record.cancel_requested {
                    BatchJobStatus::Cancelled
                } else {
                    BatchJobStatus::Completed
                };
            }
        });
    }

    pub fn fail(&self, job_id: &str, error: String) {
        self.update_job(job_id, |record| {
            record.status = BatchJobStatus::Failed;
            record.error_message = Some(error);
        });
    }

    pub fn request_cancel(&self, job_id: &str) -> Option<BatchJobSnapshot> {
        self.update_job(job_id, |record| {
            record.cancel_requested = true;
            if record.status == BatchJobStatus::Queued {
                record.status = BatchJobStatus::Cancelled;
            }
        });
        self.status(job_id)
    }

    pub fn is_cancel_requested(&self, job_id: &str) -> bool {
        self.inner
            .lock()
            .expect("batch job registry lock poisoned")
            .get(job_id)
            .is_some_and(|record| record.cancel_requested)
    }

    pub fn status(&self, job_id: &str) -> Option<BatchJobSnapshot> {
        let mut jobs = self.inner.lock().expect("batch job registry lock poisoned");
        prune_jobs_locked(&mut jobs, unix_ms());
        jobs.get(job_id).map(|record| snapshot(job_id, record))
    }

    pub fn result(&self, job_id: &str) -> Option<BatchJobResultSnapshot> {
        let mut jobs = self.inner.lock().expect("batch job registry lock poisoned");
        prune_jobs_locked(&mut jobs, unix_ms());
        jobs.get(job_id).map(|record| BatchJobResultSnapshot {
            status: snapshot(job_id, record),
            results: record.results.clone(),
        })
    }

    fn push_result(&self, job_id: &str, result: BatchTrackJobItemResult) -> bool {
        let mut jobs = self.inner.lock().expect("batch job registry lock poisoned");
        let Some(record) = jobs.get_mut(job_id) else {
            return false;
        };

        if result.status == BatchJobItemStatus::Error {
            record.failed += 1;
        }
        record.completed += 1;
        touch_record(record);
        record.results.push(result);
        true
    }

    fn update_job(&self, job_id: &str, update: impl FnOnce(&mut BatchJobRecord)) {
        let mut jobs = self.inner.lock().expect("batch job registry lock poisoned");
        prune_jobs_locked(&mut jobs, unix_ms());
        if let Some(record) = jobs.get_mut(job_id) {
            update(record);
            touch_record(record);
        }
    }
}

fn snapshot(job_id: &str, record: &BatchJobRecord) -> BatchJobSnapshot {
    BatchJobSnapshot {
        job_id: job_id.to_string(),
        status: record.status,
        total: record.total,
        completed: record.completed,
        failed: record.failed,
        cancel_requested: record.cancel_requested,
        error_message: record.error_message.clone(),
        created_at: record.created_at.clone(),
        updated_at: record.updated_at.clone(),
    }
}

fn generate_job_id() -> String {
    let counter = JOB_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("job_{}_{}", unix_ms(), counter)
}

fn touch_record(record: &mut BatchJobRecord) {
    record.updated_at_unix_ms = unix_ms();
    record.updated_at = generated_at_iso8601();
}

fn is_terminal_status(status: BatchJobStatus) -> bool {
    matches!(
        status,
        BatchJobStatus::Completed | BatchJobStatus::Cancelled | BatchJobStatus::Failed
    )
}

fn prune_jobs_locked(jobs: &mut HashMap<String, BatchJobRecord>, now_ms: u128) {
    jobs.retain(|_, record| {
        !is_terminal_status(record.status)
            || now_ms.saturating_sub(record.updated_at_unix_ms) <= BATCH_JOB_RETENTION_MS
    });

    if jobs.len() < MAX_RETAINED_BATCH_JOBS {
        return;
    }

    let mut terminal_jobs = jobs
        .iter()
        .filter(|(_, record)| is_terminal_status(record.status))
        .map(|(job_id, record)| (job_id.clone(), record.updated_at_unix_ms))
        .collect::<Vec<_>>();
    terminal_jobs.sort_by_key(|(_, updated_at)| *updated_at);

    let remove_count = jobs
        .len()
        .saturating_sub(MAX_RETAINED_BATCH_JOBS.saturating_sub(1));
    for (job_id, _) in terminal_jobs.into_iter().take(remove_count) {
        jobs.remove(&job_id);
    }
}

fn unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::{BatchJobRegistry, BatchJobStatus};

    #[test]
    fn tracks_batch_job_progress() {
        let registry = BatchJobRegistry::default();
        let job = registry.create_track_job(2).expect("job should be created");
        registry.mark_running(&job.job_id);
        registry.push_error(&job.job_id, "P1".into(), "not found".into());

        let status = registry.status(&job.job_id).expect("job should exist");
        assert_eq!(status.status, BatchJobStatus::Running);
        assert_eq!(status.completed, 1);
        assert_eq!(status.failed, 1);

        registry.finish(&job.job_id);
        let result = registry
            .result(&job.job_id)
            .expect("job result should exist");
        assert_eq!(result.status.status, BatchJobStatus::Completed);
        assert_eq!(result.results.len(), 1);
    }
}
