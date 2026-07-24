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

pub const MAX_CONCURRENT_UPSTREAM_LOOKUPS: usize = 30;
pub const MAX_CONCURRENT_PUBLIC_UPSTREAM_LOOKUPS: usize = 24;
pub const MAX_CONCURRENT_CONTACT_LOOKUPS: usize = 15;
pub const MAX_CONCURRENT_HTTP_REQUESTS: usize = 128;
const MAX_QUEUED_UPSTREAM_LOOKUPS: usize = 300;
const MAX_QUEUED_PUBLIC_UPSTREAM_LOOKUPS: usize = 240;
const MAX_QUEUED_CONTACT_LOOKUPS: usize = 150;
const MAX_QUEUED_HTTP_REQUESTS: usize = 512;
const UPSTREAM_LOOKUP_PERMIT_TIMEOUT_SECS: u64 = 60;
const CONTACT_LOOKUP_PERMIT_TIMEOUT_SECS: u64 = 30;
const HTTP_REQUEST_PERMIT_TIMEOUT_SECS: u64 = 5;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UpstreamBackpressureSnapshot {
    pub active: usize,
    pub available: usize,
    pub queued: usize,
    pub max_concurrent: usize,
    pub max_queued: usize,
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
    pub fn http_ingress_default() -> Self {
        Self::with_limits(
            MAX_CONCURRENT_HTTP_REQUESTS,
            MAX_QUEUED_HTTP_REQUESTS,
            Duration::from_secs(HTTP_REQUEST_PERMIT_TIMEOUT_SECS),
        )
    }

    pub fn public_default() -> Self {
        Self::with_limits(
            MAX_CONCURRENT_PUBLIC_UPSTREAM_LOOKUPS,
            MAX_QUEUED_PUBLIC_UPSTREAM_LOOKUPS,
            Duration::from_secs(UPSTREAM_LOOKUP_PERMIT_TIMEOUT_SECS),
        )
    }

    pub fn contact_default() -> Self {
        Self::with_limits(
            MAX_CONCURRENT_CONTACT_LOOKUPS,
            MAX_QUEUED_CONTACT_LOOKUPS,
            Duration::from_secs(CONTACT_LOOKUP_PERMIT_TIMEOUT_SECS),
        )
    }

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

        let queue_depth = match self.increment_waiter() {
            Ok(depth) => depth,
            Err(error) => {
                self.log_rejection(route, lookup_id, request_id, error);
                return Err(error);
            }
        };
        let _queue_waiter = QueueWaiter { backpressure: self };

        let permit = match timeout(self.permit_timeout, self.limiter.clone().acquire_owned()).await
        {
            Ok(Ok(permit)) => permit,
            Ok(Err(_)) => return Err(UpstreamBackpressureError::LimiterUnavailable),
            Err(_) => {
                let error = UpstreamBackpressureError::Timeout;
                self.log_rejection(route, lookup_id, request_id, error);
                return Err(error);
            }
        };

        let permit_wait_ms = permit_started_at.elapsed().as_millis();
        if queued_for_permit || permit_wait_ms > 0 {
            shipflow_core::shipflow_log!(
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

    pub fn snapshot(&self) -> UpstreamBackpressureSnapshot {
        let available = self.limiter.available_permits();
        UpstreamBackpressureSnapshot {
            active: self.max_concurrent.saturating_sub(available),
            available,
            queued: self.waiters.load(Ordering::Acquire),
            max_concurrent: self.max_concurrent,
            max_queued: self.max_queued,
        }
    }

    fn log_rejection(
        &self,
        route: &str,
        lookup_id: &str,
        request_id: &str,
        error: UpstreamBackpressureError,
    ) {
        let snapshot = self.snapshot();
        shipflow_core::shipflow_log!(
            "[ShipFlowBackpressure] service_upstream_lookup_rejected route={} id={} requestId={} reason={:?} active={} queued={} limit={} maxQueue={}",
            route,
            lookup_id,
            request_id,
            error,
            snapshot.active,
            snapshot.queued,
            snapshot.max_concurrent,
            snapshot.max_queued
        );
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
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        time::Duration,
    };

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

    #[tokio::test]
    async fn limits_active_requests_and_releases_the_next_waiter() {
        let backpressure = UpstreamBackpressure::with_limits(2, 4, Duration::from_secs(1));
        let first = backpressure
            .acquire("test", "P1", "request-1")
            .await
            .expect("first permit should acquire");
        let second = backpressure
            .acquire("test", "P2", "request-2")
            .await
            .expect("second permit should acquire");

        let waiting = {
            let backpressure = backpressure.clone();
            tokio::spawn(async move {
                backpressure
                    .acquire("test", "P3", "request-3")
                    .await
                    .expect("queued permit should acquire")
            })
        };
        tokio::task::yield_now().await;

        assert_eq!(
            backpressure.snapshot(),
            super::UpstreamBackpressureSnapshot {
                active: 2,
                available: 0,
                queued: 1,
                max_concurrent: 2,
                max_queued: 4,
            }
        );

        drop(first);
        let third = waiting.await.expect("waiter should join");
        assert_eq!(backpressure.snapshot().active, 2);

        drop(second);
        drop(third);
        assert_eq!(backpressure.snapshot().active, 0);
    }

    #[tokio::test]
    async fn timed_out_waiter_is_removed_from_queue_depth() {
        let backpressure = UpstreamBackpressure::with_limits(1, 2, Duration::from_millis(10));
        let held = backpressure
            .acquire("test", "P1", "request-1")
            .await
            .expect("held permit should acquire");

        let error = backpressure
            .acquire("test", "P2", "request-2")
            .await
            .expect_err("waiter should time out");

        assert_eq!(error, UpstreamBackpressureError::Timeout);
        assert_eq!(backpressure.snapshot().queued, 0);
        drop(held);
    }

    #[tokio::test]
    async fn burst_never_exceeds_the_concurrency_limit() {
        let concurrency = 5;
        let request_count = 100;
        let backpressure =
            UpstreamBackpressure::with_limits(concurrency, request_count, Duration::from_secs(2));
        let active = Arc::new(AtomicUsize::new(0));
        let maximum_active = Arc::new(AtomicUsize::new(0));
        let requests = (0..request_count)
            .map(|index| {
                let backpressure = backpressure.clone();
                let active = Arc::clone(&active);
                let maximum_active = Arc::clone(&maximum_active);
                tokio::spawn(async move {
                    let _permit = backpressure
                        .acquire("burst", &format!("P{index}"), &format!("request-{index}"))
                        .await
                        .expect("burst request should acquire");
                    let current = active.fetch_add(1, Ordering::AcqRel) + 1;
                    maximum_active.fetch_max(current, Ordering::AcqRel);
                    tokio::time::sleep(Duration::from_millis(2)).await;
                    active.fetch_sub(1, Ordering::AcqRel);
                })
            })
            .collect::<Vec<_>>();

        for request in requests {
            request.await.expect("burst request should finish");
        }

        assert_eq!(active.load(Ordering::Acquire), 0);
        assert!(maximum_active.load(Ordering::Acquire) <= concurrency);
        assert_eq!(backpressure.snapshot().queued, 0);
    }
}
