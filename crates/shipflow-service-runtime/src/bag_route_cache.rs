use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use shipflow_core::model::BagRoute;
use tokio::sync::{futures::OwnedNotified, Notify};

use crate::persistent_store::default_persistent_lookup_store_path;

const BAG_ROUTE_STORE_FILE_NAME: &str = "bag-route-store.sqlite3";
const BAG_ROUTE_RETRY_CACHE_TTL_MS: u128 = 5 * 60 * 1000;
const BAG_ROUTE_LAST_USED_WRITE_INTERVAL_MS: u128 = 60 * 60 * 1000;
const MAX_BAG_ROUTE_CACHE_ENTRIES: usize = 20_000;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BagRouteCacheSnapshot {
    pub entries: usize,
    pub in_flight: usize,
    pub capacity: usize,
}

#[derive(Clone)]
pub struct BagRouteCacheState {
    path: Arc<PathBuf>,
    connection: Arc<Mutex<Connection>>,
    in_flight: Arc<Mutex<HashMap<String, Arc<Notify>>>>,
}

impl std::fmt::Debug for BagRouteCacheState {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BagRouteCacheState")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BagRouteCacheEntryStatus {
    #[default]
    Ok,
    Missing,
    Failed,
}

impl BagRouteCacheEntryStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Missing => "missing",
            Self::Failed => "failed",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "ok" => Some(Self::Ok),
            "missing" => Some(Self::Missing),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct BagRouteCacheEntry {
    pub bag_id: String,
    pub route: Option<BagRoute>,
    pub status: BagRouteCacheEntryStatus,
}

pub(crate) enum BagRouteFetchAction {
    Start(BagRouteFetchLease),
    Wait(OwnedNotified),
}

pub(crate) struct BagRouteFetchLease {
    state: BagRouteCacheState,
    bag_id: String,
    notify: Arc<Notify>,
}

impl Drop for BagRouteFetchLease {
    fn drop(&mut self) {
        let mut in_flight = self
            .state
            .in_flight
            .lock()
            .expect("bag route in-flight lock poisoned");
        if in_flight
            .get(&self.bag_id)
            .is_some_and(|current| Arc::ptr_eq(current, &self.notify))
        {
            in_flight.remove(&self.bag_id);
        }
        self.notify.notify_waiters();
    }
}

impl Default for BagRouteCacheState {
    fn default() -> Self {
        Self::open_default()
    }
}

impl BagRouteCacheState {
    pub fn open_default() -> Self {
        let path = std::env::var_os("SHIPFLOW_BAG_ROUTE_STORE_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                default_persistent_lookup_store_path().with_file_name(BAG_ROUTE_STORE_FILE_NAME)
            });
        Self::open(path)
    }

    pub fn open(path: PathBuf) -> Self {
        if let Some(parent) = path.parent() {
            if let Err(error) = fs::create_dir_all(parent) {
                shipflow_core::shipflow_log!(
                    "[ShipFlowBagRouteCache] create_directory_failed path={} error={error}",
                    parent.display()
                );
            }
        }

        let connection = match open_initialized_database(&path) {
            Ok(connection) => connection,
            Err(error) => {
                shipflow_core::shipflow_log!(
                    "[ShipFlowBagRouteCache] persistent_store_unavailable path={} error={error}; using in-memory fallback",
                    path.display()
                );
                let fallback = Connection::open_in_memory().unwrap_or_else(|fallback_error| {
                    panic!(
                        "Bag route cache storage is unavailable. Persistent error: {error}; in-memory error: {fallback_error}"
                    )
                });
                initialize_database(&fallback).unwrap_or_else(|fallback_error| {
                    panic!(
                        "Bag route cache schema is unavailable. Persistent error: {error}; in-memory error: {fallback_error}"
                    )
                });
                fallback
            }
        };
        prune_connection(&connection, unix_ms());

        Self {
            path: Arc::new(path),
            connection: Arc::new(Mutex::new(connection)),
            in_flight: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn get(&self, bag_id: &str) -> Option<BagRouteCacheEntry> {
        let now = unix_ms();
        let connection = self
            .connection
            .lock()
            .expect("bag route cache connection lock poisoned");
        let stored = connection
            .query_row(
                "SELECT route_json, status, fetched_at_unix_ms, last_used_at_unix_ms
                 FROM bag_route_cache
                 WHERE bag_id = ?1",
                params![bag_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()
            .unwrap_or_else(|error| {
                shipflow_core::shipflow_log!(
                    "[ShipFlowBagRouteCache] read_error id={bag_id} error={error}"
                );
                None
            })?;

        let Some(status) = BagRouteCacheEntryStatus::from_str(&stored.1) else {
            let _ = connection.execute(
                "DELETE FROM bag_route_cache WHERE bag_id = ?1",
                params![bag_id],
            );
            return None;
        };
        let fetched_at_unix_ms = stored.2.max(0) as u128;
        if status != BagRouteCacheEntryStatus::Ok
            && now.saturating_sub(fetched_at_unix_ms) >= BAG_ROUTE_RETRY_CACHE_TTL_MS
        {
            let _ = connection.execute(
                "DELETE FROM bag_route_cache WHERE bag_id = ?1",
                params![bag_id],
            );
            return None;
        }

        let route = match stored.0 {
            Some(route_json) => match serde_json::from_str::<BagRoute>(&route_json) {
                Ok(route) => Some(route),
                Err(error) => {
                    shipflow_core::shipflow_log!(
                        "[ShipFlowBagRouteCache] decode_error id={bag_id} error={error}"
                    );
                    let _ = connection.execute(
                        "DELETE FROM bag_route_cache WHERE bag_id = ?1",
                        params![bag_id],
                    );
                    return None;
                }
            },
            None => None,
        };
        let last_used_at_unix_ms = stored.3.max(0) as u128;
        if now.saturating_sub(last_used_at_unix_ms) >= BAG_ROUTE_LAST_USED_WRITE_INTERVAL_MS {
            let _ = connection.execute(
                "UPDATE bag_route_cache SET last_used_at_unix_ms = ?2 WHERE bag_id = ?1",
                params![bag_id, to_sql_millis(now)],
            );
        }

        Some(BagRouteCacheEntry {
            bag_id: bag_id.to_string(),
            route,
            status,
        })
    }

    pub async fn get_async(&self, bag_id: &str) -> Option<BagRouteCacheEntry> {
        let state = self.clone();
        let bag_id = bag_id.to_string();
        let task_bag_id = bag_id.clone();
        tokio::task::spawn_blocking(move || state.get(&task_bag_id))
            .await
            .unwrap_or_else(|error| {
                shipflow_core::shipflow_log!(
                    "[ShipFlowBagRouteCache] async_read_failed id={} error={error}",
                    bag_id
                );
                None
            })
    }

    pub async fn snapshot_async(&self) -> BagRouteCacheSnapshot {
        let state = self.clone();
        tokio::task::spawn_blocking(move || state.snapshot())
            .await
            .unwrap_or_else(|error| {
                shipflow_core::shipflow_log!(
                    "[ShipFlowBagRouteCache] async_snapshot_failed error={error}"
                );
                BagRouteCacheSnapshot {
                    capacity: MAX_BAG_ROUTE_CACHE_ENTRIES,
                    ..BagRouteCacheSnapshot::default()
                }
            })
    }

    fn snapshot(&self) -> BagRouteCacheSnapshot {
        let entries = self
            .connection
            .lock()
            .expect("bag route cache connection lock poisoned")
            .query_row("SELECT COUNT(*) FROM bag_route_cache", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap_or(0)
            .max(0) as usize;
        let in_flight = self
            .in_flight
            .lock()
            .expect("bag route in-flight lock poisoned")
            .len();
        BagRouteCacheSnapshot {
            entries,
            in_flight,
            capacity: MAX_BAG_ROUTE_CACHE_ENTRIES,
        }
    }

    pub async fn store_async(&self, bag_id: &str, route: BagRoute) -> BagRouteCacheEntry {
        let status = if route.tujuan.is_some() {
            BagRouteCacheEntryStatus::Ok
        } else {
            BagRouteCacheEntryStatus::Missing
        };
        let state = self.clone();
        let bag_id = bag_id.to_string();
        let fallback_bag_id = bag_id.clone();
        let fallback_route = route.clone();
        tokio::task::spawn_blocking(move || state.store(&bag_id, Some(route), status))
            .await
            .unwrap_or_else(|error| {
                shipflow_core::shipflow_log!(
                    "[ShipFlowBagRouteCache] async_store_failed id={} error={error}",
                    fallback_bag_id
                );
                BagRouteCacheEntry {
                    bag_id: fallback_bag_id,
                    route: Some(fallback_route),
                    status,
                }
            })
    }

    pub async fn store_failure_async(&self, bag_id: &str) -> BagRouteCacheEntry {
        let state = self.clone();
        let bag_id = bag_id.to_string();
        let fallback_bag_id = bag_id.clone();
        tokio::task::spawn_blocking(move || {
            state.store(&bag_id, None, BagRouteCacheEntryStatus::Failed)
        })
        .await
        .unwrap_or_else(|error| {
            shipflow_core::shipflow_log!(
                "[ShipFlowBagRouteCache] async_failure_store_failed id={} error={error}",
                fallback_bag_id
            );
            BagRouteCacheEntry {
                bag_id: fallback_bag_id,
                route: None,
                status: BagRouteCacheEntryStatus::Failed,
            }
        })
    }

    pub(crate) fn begin_fetch(&self, bag_id: &str) -> BagRouteFetchAction {
        let mut in_flight = self
            .in_flight
            .lock()
            .expect("bag route in-flight lock poisoned");
        if let Some(notify) = in_flight.get(bag_id) {
            return BagRouteFetchAction::Wait(notify.clone().notified_owned());
        }

        let notify = Arc::new(Notify::new());
        in_flight.insert(bag_id.to_string(), notify.clone());
        BagRouteFetchAction::Start(BagRouteFetchLease {
            state: self.clone(),
            bag_id: bag_id.to_string(),
            notify,
        })
    }

    fn store(
        &self,
        bag_id: &str,
        route: Option<BagRoute>,
        status: BagRouteCacheEntryStatus,
    ) -> BagRouteCacheEntry {
        let now = unix_ms();
        let route_json = route
            .as_ref()
            .and_then(|route| serde_json::to_string(route).ok());
        let connection = self
            .connection
            .lock()
            .expect("bag route cache connection lock poisoned");
        if let Err(error) = connection.execute(
            "INSERT INTO bag_route_cache (
                 bag_id, route_json, status, fetched_at_unix_ms, last_used_at_unix_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(bag_id) DO UPDATE SET
                 route_json = excluded.route_json,
                 status = excluded.status,
                 fetched_at_unix_ms = excluded.fetched_at_unix_ms,
                 last_used_at_unix_ms = excluded.last_used_at_unix_ms",
            params![
                bag_id,
                route_json,
                status.as_str(),
                to_sql_millis(now),
                to_sql_millis(now)
            ],
        ) {
            shipflow_core::shipflow_log!(
                "[ShipFlowBagRouteCache] store_error id={bag_id} error={error}"
            );
        } else {
            prune_connection(&connection, now);
        }

        BagRouteCacheEntry {
            bag_id: bag_id.to_string(),
            route,
            status,
        }
    }

    #[cfg(test)]
    fn set_fetched_at_for_test(&self, bag_id: &str, fetched_at_unix_ms: u128) {
        self.connection
            .lock()
            .expect("bag route cache connection lock poisoned")
            .execute(
                "UPDATE bag_route_cache SET fetched_at_unix_ms = ?2 WHERE bag_id = ?1",
                params![bag_id, to_sql_millis(fetched_at_unix_ms)],
            )
            .expect("test timestamp should update");
    }
}

fn open_initialized_database(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path)
        .map_err(|error| format!("Unable to open bag route cache database: {error}"))?;
    initialize_database(&connection)?;
    Ok(connection)
}

fn initialize_database(connection: &Connection) -> Result<(), String> {
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| format!("Unable to configure bag route cache database: {error}"))?;
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS bag_route_cache (
                 bag_id TEXT PRIMARY KEY NOT NULL,
                 route_json TEXT,
                 status TEXT NOT NULL,
                 fetched_at_unix_ms INTEGER NOT NULL,
                 last_used_at_unix_ms INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_bag_route_cache_last_used
                 ON bag_route_cache(last_used_at_unix_ms);",
        )
        .map_err(|error| format!("Unable to initialize bag route cache database: {error}"))?;
    Ok(())
}

fn prune_connection(connection: &Connection, now_unix_ms: u128) {
    let retry_cutoff = now_unix_ms.saturating_sub(BAG_ROUTE_RETRY_CACHE_TTL_MS);
    if let Err(error) = connection.execute(
        "DELETE FROM bag_route_cache
         WHERE status != 'ok' AND fetched_at_unix_ms <= ?1",
        params![to_sql_millis(retry_cutoff)],
    ) {
        shipflow_core::shipflow_log!(
            "[ShipFlowBagRouteCache] prune_retry_entries_failed error={error}"
        );
    }

    let entry_count = connection
        .query_row("SELECT COUNT(*) FROM bag_route_cache", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap_or(0)
        .max(0) as usize;
    let remove_count = entry_count.saturating_sub(MAX_BAG_ROUTE_CACHE_ENTRIES);
    if remove_count == 0 {
        return;
    }
    if let Err(error) = connection.execute(
        "DELETE FROM bag_route_cache
         WHERE bag_id IN (
             SELECT bag_id FROM bag_route_cache
             ORDER BY last_used_at_unix_ms ASC
             LIMIT ?1
         )",
        params![remove_count as i64],
    ) {
        shipflow_core::shipflow_log!("[ShipFlowBagRouteCache] prune_capacity_failed error={error}");
    }
}

fn unix_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn to_sql_millis(value: u128) -> i64 {
    value.min(i64::MAX as u128) as i64
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{
        unix_ms, BagRouteCacheEntryStatus, BagRouteCacheState, BagRouteFetchAction,
        BAG_ROUTE_RETRY_CACHE_TTL_MS,
    };
    use shipflow_core::model::BagRoute;

    #[tokio::test]
    async fn persists_successful_routes_without_normal_ttl_expiry() {
        let path = test_path("persistent");
        let cache = BagRouteCacheState::open(path.clone());
        cache
            .store_async(
                "PID96722106",
                BagRoute {
                    nomor_kantung: "PID96722106".into(),
                    lokasi_asal: Some("KCU JAYAPURA 99000".into()),
                    tujuan: Some("DC JAYAPURA 9910A".into()),
                    url: "https://example.test/print-bag".into(),
                },
            )
            .await;
        cache.set_fetched_at_for_test("PID96722106", 1);
        drop(cache);

        let reopened = BagRouteCacheState::open(path.clone());
        let entry = reopened
            .get_async("PID96722106")
            .await
            .expect("successful route should remain cached");
        assert_eq!(entry.status, BagRouteCacheEntryStatus::Ok);
        assert_eq!(
            entry.route.and_then(|route| route.tujuan).as_deref(),
            Some("DC JAYAPURA 9910A")
        );
        cleanup_sqlite(path);
    }

    #[tokio::test]
    async fn expires_failed_entries_after_retry_window() {
        let path = test_path("failure");
        let cache = BagRouteCacheState::open(path.clone());
        cache.store_failure_async("PID96722106").await;
        cache.set_fetched_at_for_test(
            "PID96722106",
            unix_ms().saturating_sub(BAG_ROUTE_RETRY_CACHE_TTL_MS + 1),
        );

        assert!(cache.get_async("PID96722106").await.is_none());
        cleanup_sqlite(path);
    }

    #[tokio::test]
    async fn coalesces_in_flight_fetches_for_the_same_bag_id() {
        let path = test_path("single-flight");
        let cache = BagRouteCacheState::open(path.clone());
        let lease = match cache.begin_fetch("PID96722106") {
            BagRouteFetchAction::Start(lease) => lease,
            BagRouteFetchAction::Wait(_) => panic!("first lookup should own the fetch"),
        };
        let waiter = match cache.begin_fetch("PID96722106") {
            BagRouteFetchAction::Wait(waiter) => waiter,
            BagRouteFetchAction::Start(_) => panic!("second lookup should be coalesced"),
        };

        drop(lease);
        tokio::time::timeout(std::time::Duration::from_millis(100), waiter)
            .await
            .expect("waiter should be notified when fetch finishes");
        cleanup_sqlite(path);
    }

    fn test_path(label: &str) -> PathBuf {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "shipflow-bag-route-cache-{label}-{}-{timestamp}.sqlite3",
            std::process::id()
        ))
    }

    fn cleanup_sqlite(path: std::path::PathBuf) {
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
    }
}
