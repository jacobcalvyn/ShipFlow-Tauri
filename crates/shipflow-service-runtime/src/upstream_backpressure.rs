use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore, TryAcquireError},
    time::timeout,
};

pub const MAX_CONCURRENT_UPSTREAM_LOOKUPS: usize = 15;
const MAX_QUEUED_UPSTREAM_LOOKUPS: usize = 60;
const UPSTREAM_LOOKUP_PERMIT_TIMEOUT_SECS: u64 = 15;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpstreamBackpressureError {
    QueueFull { depth: usize },
    LimiterUnavailable,
    Timeout,
}

#[derive(Clone)]
pub struct UpstreamBackpressure {
    limiter: Arc<Semaphore>,
    waiters: Arc<AtomicUsize>,
    max_concurrent: usize,
    max_queued: usize,
    permit_timeout: Duration,
}

impl Default for UpstreamBackpressure {
    fn default() -> Self {
        Self::with_limits(
            MAX_CONCURRENT_UPSTREAM_LOOKUPS,
            MAX_QUEUED_UPSTREAM_LOOKUPS,
            Duration::from_secs(UPSTREAM_LOOKUP_PERMIT_TIMEOUT_SECS),
        )
    }
}

impl UpstreamBackpressure {
    pub fn with_limits(max_concurrent: usize, max_queued: usize, permit_timeout: Duration) -> Self {
        Self {
            limiter: Arc::new(Semaphore::new(max_concurrent)),
            waiters: Arc::new(AtomicUsize::new(0)),
            max_concurrent,
            max_queued,
            permit_timeout,
        }
    }

    #[cfg(test)]
    pub fn with_limiter(
        limiter: Arc<Semaphore>,
        max_concurrent: usize,
        max_queued: usize,
        permit_timeout: Duration,
    ) -> Self {
        Self {
            limiter,
            waiters: Arc::new(AtomicUsize::new(0)),
            max_concurrent,
            max_queued,
            permit_timeout,
        }
    }

    pub async fn acquire(
        &self,
        route: &str,
        lookup_id: &str,
        request_id: &str,
    ) -> Result<OwnedSemaphorePermit, UpstreamBackpressureError> {
        let queued_for_permit = self.limiter.available_permits() == 0;
        let permit_started_at = Instant::now();
        match self.limiter.clone().try_acquire_owned() {
            Ok(permit) => return Ok(permit),
            Err(TryAcquireError::Closed) => {
                return Err(UpstreamBackpressureError::LimiterUnavailable);
            }
            Err(TryAcquireError::NoPermits) => {}
        }

        let queue_depth = self.increment_waiter()?;
        let _queue_waiter = QueueWaiter { backpressure: self };

        let permit = match timeout(self.permit_timeout, self.limiter.clone().acquire_owned()).await
        {
            Ok(Ok(permit)) => permit,
            Ok(Err(_)) => return Err(UpstreamBackpressureError::LimiterUnavailable),
            Err(_) => return Err(UpstreamBackpressureError::Timeout),
        };

        let permit_wait_ms = permit_started_at.elapsed().as_millis();
        if queued_for_permit || permit_wait_ms > 0 {
            eprintln!(
                "[ShipFlowBackpressure] service_upstream_lookup_permit route={} id={} requestId={} queued={} waitMs={} limit={} queueDepth={} maxQueue={}",
                route,
                lookup_id,
                request_id,
                queued_for_permit,
                permit_wait_ms,
                self.max_concurrent,
                queue_depth,
                self.max_queued
            );
        }

        Ok(permit)
    }

    fn increment_waiter(&self) -> Result<usize, UpstreamBackpressureError> {
        let mut current = self.waiters.load(Ordering::Acquire);
        loop {
            if current >= self.max_queued {
                return Err(UpstreamBackpressureError::QueueFull { depth: current });
            }

            match self.waiters.compare_exchange(
                current,
                current + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Ok(current + 1),
                Err(next) => current = next,
            }
        }
    }

    fn decrement_waiter(&self) {
        self.waiters
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                current.checked_sub(1)
            })
            .ok();
    }
}

struct QueueWaiter<'a> {
    backpressure: &'a UpstreamBackpressure,
}

impl Drop for QueueWaiter<'_> {
    fn drop(&mut self) {
        self.backpressure.decrement_waiter();
    }
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Duration};

    use tokio::sync::Semaphore;

    use super::{UpstreamBackpressure, UpstreamBackpressureError};

    #[tokio::test]
    async fn rejects_when_queue_is_full() {
        let limiter = Arc::new(Semaphore::new(1));
        let held_permit = limiter
            .clone()
            .acquire_owned()
            .await
            .expect("test permit should acquire");
        let backpressure =
            UpstreamBackpressure::with_limiter(limiter, 1, 0, Duration::from_millis(50));

        let error = backpressure
            .acquire("/v1/track/:shipment_id", "P1", "sf_req_test")
            .await
            .expect_err("queue should reject immediately");

        assert_eq!(error, UpstreamBackpressureError::QueueFull { depth: 0 });
        drop(held_permit);
    }
}
