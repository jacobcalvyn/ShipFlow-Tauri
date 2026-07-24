use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use shipflow_core::model::ContactEnrichment;
use tokio::sync::{futures::OwnedNotified, Notify};

use crate::persistent_store::default_persistent_lookup_store_path;

const CONTACT_STORE_FILE_NAME: &str = "contact-store.sqlite3";
const LEGACY_CONTACT_STORE_FILE_NAME: &str = "contact-store.json";
const CONTACT_CACHE_TTL_MS: u128 = 90 * 24 * 60 * 60 * 1000;
const CONTACT_FAILURE_CACHE_TTL_MS: u128 = 30 * 1000;
const CONTACT_LAST_USED_WRITE_INTERVAL_MS: u128 = 60 * 60 * 1000;
const MAX_CONTACT_CACHE_ENTRIES: usize = 20_000;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ContactCacheSnapshot {
    pub entries: usize,
    pub in_flight: usize,
    pub capacity: usize,
}

#[derive(Clone)]
pub struct ContactCacheState {
    path: Arc<PathBuf>,
    connection: Arc<Mutex<Connection>>,
    in_flight: Arc<Mutex<HashMap<String, Arc<Notify>>>>,
}

impl std::fmt::Debug for ContactCacheState {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ContactCacheState")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyContactCacheStoreFile {
    version: u8,
    entries: HashMap<String, ContactCacheEntry>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactCacheEntry {
    pub shipment_id: String,
    pub contact: ContactEnrichment,
    pub status: ContactCacheEntryStatus,
    pub source: String,
    pub fetched_at_unix_ms: u128,
    pub last_used_at_unix_ms: u128,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContactCacheEntryStatus {
    #[default]
    Ok,
    Missing,
    Failed,
}

impl ContactCacheEntryStatus {
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

pub(crate) enum ContactFetchAction {
    Start(ContactFetchLease),
    Wait(OwnedNotified),
}

pub(crate) struct ContactFetchLease {
    state: ContactCacheState,
    shipment_id: String,
    notify: Arc<Notify>,
}

impl Drop for ContactFetchLease {
    fn drop(&mut self) {
        let mut in_flight = self
            .state
            .in_flight
            .lock()
            .expect("contact in-flight lock poisoned");
        if in_flight
            .get(&self.shipment_id)
            .is_some_and(|current| Arc::ptr_eq(current, &self.notify))
        {
            in_flight.remove(&self.shipment_id);
        }
        self.notify.notify_waiters();
    }
}

impl Default for ContactCacheState {
    fn default() -> Self {
        Self::open_default()
    }
}

impl ContactCacheState {
    pub fn open_default() -> Self {
        if let Some(configured_path) = std::env::var_os("SHIPFLOW_CONTACT_STORE_PATH") {
            return Self::open(PathBuf::from(configured_path));
        }

        let path = default_persistent_lookup_store_path().with_file_name(CONTACT_STORE_FILE_NAME);
        let legacy_path =
            default_persistent_lookup_store_path().with_file_name(LEGACY_CONTACT_STORE_FILE_NAME);
        Self::open_with_legacy(path, Some(legacy_path))
    }

    pub fn open(path: PathBuf) -> Self {
        if is_legacy_json_store(&path) {
            let sqlite_path = path.with_extension("sqlite3");
            return Self::open_with_legacy(sqlite_path, Some(path));
        }
        Self::open_with_legacy(path, None)
    }

    fn open_with_legacy(path: PathBuf, legacy_path: Option<PathBuf>) -> Self {
        if let Some(parent) = path.parent() {
            if let Err(error) = fs::create_dir_all(parent) {
                shipflow_core::shipflow_log!(
                    "[ShipFlowContactCache] create_directory_failed path={} error={error}",
                    parent.display()
                );
            }
        }

        let connection = match Connection::open(&path) {
            Ok(connection) => connection,
            Err(error) => {
                shipflow_core::shipflow_log!(
                    "[ShipFlowContactCache] open_failed path={} error={error}; using in-memory fallback",
                    path.display()
                );
                Connection::open_in_memory().expect("contact cache in-memory fallback should open")
            }
        };
        initialize_database(&connection);
        if let Some(legacy_path) = legacy_path.as_deref() {
            migrate_legacy_store(&connection, legacy_path);
        }
        prune_connection(&connection, unix_ms());

        Self {
            path: Arc::new(path),
            connection: Arc::new(Mutex::new(connection)),
            in_flight: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn get(&self, shipment_id: &str) -> Option<ContactCacheEntry> {
        let now = unix_ms();
        let connection = self
            .connection
            .lock()
            .expect("contact cache connection lock poisoned");
        let stored = connection
            .query_row(
                "SELECT contact_json, status, source, fetched_at_unix_ms, last_used_at_unix_ms
                 FROM contact_cache
                 WHERE shipment_id = ?1",
                params![shipment_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                },
            )
            .optional()
            .unwrap_or_else(|error| {
                shipflow_core::shipflow_log!(
                    "[ShipFlowContactCache] read_error id={shipment_id} error={error}"
                );
                None
            })?;

        let Some(status) = ContactCacheEntryStatus::from_str(&stored.1) else {
            let _ = connection.execute(
                "DELETE FROM contact_cache WHERE shipment_id = ?1",
                params![shipment_id],
            );
            return None;
        };
        let fetched_at_unix_ms = stored.3.max(0) as u128;
        if is_expired(status, fetched_at_unix_ms, now) {
            let _ = connection.execute(
                "DELETE FROM contact_cache WHERE shipment_id = ?1",
                params![shipment_id],
            );
            return None;
        }

        let contact = match serde_json::from_str::<ContactEnrichment>(&stored.0) {
            Ok(contact) => contact,
            Err(error) => {
                shipflow_core::shipflow_log!(
                    "[ShipFlowContactCache] decode_error id={shipment_id} error={error}"
                );
                let _ = connection.execute(
                    "DELETE FROM contact_cache WHERE shipment_id = ?1",
                    params![shipment_id],
                );
                return None;
            }
        };
        let last_used_at_unix_ms = stored.4.max(0) as u128;
        if now.saturating_sub(last_used_at_unix_ms) >= CONTACT_LAST_USED_WRITE_INTERVAL_MS {
            let _ = connection.execute(
                "UPDATE contact_cache SET last_used_at_unix_ms = ?2 WHERE shipment_id = ?1",
                params![shipment_id, to_sql_millis(now)],
            );
        }

        Some(ContactCacheEntry {
            shipment_id: shipment_id.to_string(),
            contact,
            status,
            source: stored.2,
            fetched_at_unix_ms,
            last_used_at_unix_ms: now,
        })
    }

    pub async fn get_async(&self, shipment_id: &str) -> Option<ContactCacheEntry> {
        let state = self.clone();
        let shipment_id = shipment_id.to_string();
        let task_shipment_id = shipment_id.clone();
        tokio::task::spawn_blocking(move || state.get(&task_shipment_id))
            .await
            .unwrap_or_else(|error| {
                shipflow_core::shipflow_log!(
                    "[ShipFlowContactCache] async_read_failed id={} error={error}",
                    shipment_id
                );
                None
            })
    }

    pub async fn snapshot_async(&self) -> ContactCacheSnapshot {
        let state = self.clone();
        tokio::task::spawn_blocking(move || state.snapshot())
            .await
            .unwrap_or_else(|error| {
                shipflow_core::shipflow_log!(
                    "[ShipFlowContactCache] async_snapshot_failed error={error}"
                );
                ContactCacheSnapshot {
                    capacity: MAX_CONTACT_CACHE_ENTRIES,
                    ..ContactCacheSnapshot::default()
                }
            })
    }

    fn snapshot(&self) -> ContactCacheSnapshot {
        let entries = self
            .connection
            .lock()
            .expect("contact cache connection lock poisoned")
            .query_row("SELECT COUNT(*) FROM contact_cache", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap_or_else(|error| {
                shipflow_core::shipflow_log!("[ShipFlowContactCache] count_failed error={error}");
                0
            })
            .max(0) as usize;
        let in_flight = self
            .in_flight
            .lock()
            .expect("contact in-flight lock poisoned")
            .len();
        ContactCacheSnapshot {
            entries,
            in_flight,
            capacity: MAX_CONTACT_CACHE_ENTRIES,
        }
    }

    pub fn store(&self, shipment_id: &str, contact: ContactEnrichment) -> ContactCacheEntry {
        let status = if contact.pengirim.telepon.is_some() || contact.penerima.telepon.is_some() {
            ContactCacheEntryStatus::Ok
        } else {
            ContactCacheEntryStatus::Missing
        };
        self.store_with_status(shipment_id, contact, status)
    }

    pub async fn store_async(
        &self,
        shipment_id: &str,
        contact: ContactEnrichment,
    ) -> ContactCacheEntry {
        let state = self.clone();
        let shipment_id = shipment_id.to_string();
        let fallback_shipment_id = shipment_id.clone();
        let fallback_contact = contact.clone();
        tokio::task::spawn_blocking(move || state.store(&shipment_id, contact))
            .await
            .unwrap_or_else(|error| {
                shipflow_core::shipflow_log!(
                    "[ShipFlowContactCache] async_store_failed id={} error={error}",
                    fallback_shipment_id
                );
                fallback_entry(
                    fallback_shipment_id,
                    fallback_contact,
                    ContactCacheEntryStatus::Missing,
                )
            })
    }

    pub async fn store_failure_async(&self, shipment_id: &str) -> ContactCacheEntry {
        let state = self.clone();
        let shipment_id = shipment_id.to_string();
        let fallback_shipment_id = shipment_id.clone();
        tokio::task::spawn_blocking(move || {
            state.store_with_status(
                &shipment_id,
                ContactEnrichment::default(),
                ContactCacheEntryStatus::Failed,
            )
        })
        .await
        .unwrap_or_else(|error| {
            shipflow_core::shipflow_log!(
                "[ShipFlowContactCache] async_failure_store_failed id={} error={error}",
                fallback_shipment_id
            );
            fallback_entry(
                fallback_shipment_id,
                ContactEnrichment::default(),
                ContactCacheEntryStatus::Failed,
            )
        })
    }

    pub(crate) fn begin_fetch(&self, shipment_id: &str) -> ContactFetchAction {
        let mut in_flight = self
            .in_flight
            .lock()
            .expect("contact in-flight lock poisoned");
        if let Some(notify) = in_flight.get(shipment_id) {
            return ContactFetchAction::Wait(notify.clone().notified_owned());
        }

        let notify = Arc::new(Notify::new());
        in_flight.insert(shipment_id.to_string(), notify.clone());
        ContactFetchAction::Start(ContactFetchLease {
            state: self.clone(),
            shipment_id: shipment_id.to_string(),
            notify,
        })
    }

    fn store_with_status(
        &self,
        shipment_id: &str,
        contact: ContactEnrichment,
        status: ContactCacheEntryStatus,
    ) -> ContactCacheEntry {
        let entry = fallback_entry(shipment_id.to_string(), contact, status);
        let contact_json = match serde_json::to_string(&entry.contact) {
            Ok(contact_json) => contact_json,
            Err(error) => {
                shipflow_core::shipflow_log!(
                    "[ShipFlowContactCache] encode_error id={shipment_id} error={error}"
                );
                return entry;
            }
        };
        let connection = self
            .connection
            .lock()
            .expect("contact cache connection lock poisoned");
        if let Err(error) = connection.execute(
            "INSERT INTO contact_cache (
                 shipment_id,
                 contact_json,
                 status,
                 source,
                 fetched_at_unix_ms,
                 last_used_at_unix_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(shipment_id) DO UPDATE SET
                 contact_json = excluded.contact_json,
                 status = excluded.status,
                 source = excluded.source,
                 fetched_at_unix_ms = excluded.fetched_at_unix_ms,
                 last_used_at_unix_ms = excluded.last_used_at_unix_ms",
            params![
                shipment_id,
                contact_json,
                status.as_str(),
                entry.source.as_str(),
                to_sql_millis(entry.fetched_at_unix_ms),
                to_sql_millis(entry.last_used_at_unix_ms)
            ],
        ) {
            shipflow_core::shipflow_log!(
                "[ShipFlowContactCache] store_error id={shipment_id} error={error}"
            );
            return entry;
        }
        prune_connection(&connection, entry.fetched_at_unix_ms);
        entry
    }

    #[cfg(test)]
    fn set_fetched_at_for_test(&self, shipment_id: &str, fetched_at_unix_ms: u128) {
        self.connection
            .lock()
            .expect("contact cache connection lock poisoned")
            .execute(
                "UPDATE contact_cache SET fetched_at_unix_ms = ?2 WHERE shipment_id = ?1",
                params![shipment_id, to_sql_millis(fetched_at_unix_ms)],
            )
            .expect("test timestamp should update");
    }
}

fn initialize_database(connection: &Connection) {
    if let Err(error) = connection.busy_timeout(Duration::from_secs(5)) {
        shipflow_core::shipflow_log!("[ShipFlowContactCache] busy_timeout_failed error={error}");
    }
    if let Err(error) = connection.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         CREATE TABLE IF NOT EXISTS contact_cache (
             shipment_id TEXT PRIMARY KEY NOT NULL,
             contact_json TEXT NOT NULL,
             status TEXT NOT NULL,
             source TEXT NOT NULL,
             fetched_at_unix_ms INTEGER NOT NULL,
             last_used_at_unix_ms INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_contact_cache_last_used
             ON contact_cache(last_used_at_unix_ms);",
    ) {
        shipflow_core::shipflow_log!("[ShipFlowContactCache] initialize_failed error={error}");
    }
}

fn migrate_legacy_store(connection: &Connection, legacy_path: &Path) {
    let Some(store) = fs::read(legacy_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<LegacyContactCacheStoreFile>(&bytes).ok())
        .filter(|store| store.version == 1)
    else {
        return;
    };

    let now = unix_ms();
    let mut migrated = 0_usize;
    for entry in store.entries.into_values() {
        if is_expired(entry.status, entry.fetched_at_unix_ms, now) {
            continue;
        }
        let Ok(contact_json) = serde_json::to_string(&entry.contact) else {
            continue;
        };
        if connection
            .execute(
                "INSERT OR IGNORE INTO contact_cache (
                     shipment_id,
                     contact_json,
                     status,
                     source,
                     fetched_at_unix_ms,
                     last_used_at_unix_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    entry.shipment_id,
                    contact_json,
                    entry.status.as_str(),
                    entry.source,
                    to_sql_millis(entry.fetched_at_unix_ms),
                    to_sql_millis(entry.last_used_at_unix_ms)
                ],
            )
            .is_ok()
        {
            migrated += 1;
        }
    }
    if migrated > 0 {
        shipflow_core::shipflow_log!(
            "[ShipFlowContactCache] legacy_store_migrated path={} entries={migrated}",
            legacy_path.display()
        );
    }
}

fn prune_connection(connection: &Connection, now_unix_ms: u128) {
    let normal_cutoff = now_unix_ms.saturating_sub(CONTACT_CACHE_TTL_MS);
    let failure_cutoff = now_unix_ms.saturating_sub(CONTACT_FAILURE_CACHE_TTL_MS);
    if let Err(error) = connection.execute(
        "DELETE FROM contact_cache
         WHERE (status = 'failed' AND fetched_at_unix_ms <= ?1)
            OR (status != 'failed' AND fetched_at_unix_ms <= ?2)",
        params![to_sql_millis(failure_cutoff), to_sql_millis(normal_cutoff)],
    ) {
        shipflow_core::shipflow_log!("[ShipFlowContactCache] prune_expired_failed error={error}");
    }

    let entry_count = connection
        .query_row("SELECT COUNT(*) FROM contact_cache", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap_or(0)
        .max(0) as usize;
    let remove_count = entry_count.saturating_sub(MAX_CONTACT_CACHE_ENTRIES);
    if remove_count == 0 {
        return;
    }
    if let Err(error) = connection.execute(
        "DELETE FROM contact_cache
         WHERE shipment_id IN (
             SELECT shipment_id
             FROM contact_cache
             ORDER BY last_used_at_unix_ms ASC
             LIMIT ?1
         )",
        params![remove_count as i64],
    ) {
        shipflow_core::shipflow_log!("[ShipFlowContactCache] prune_capacity_failed error={error}");
    }
}

fn fallback_entry(
    shipment_id: String,
    contact: ContactEnrichment,
    status: ContactCacheEntryStatus,
) -> ContactCacheEntry {
    let now = unix_ms();
    ContactCacheEntry {
        shipment_id,
        contact,
        status,
        source: "lacak_mitra".into(),
        fetched_at_unix_ms: now,
        last_used_at_unix_ms: now,
    }
}

fn unix_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn to_sql_millis(value: u128) -> i64 {
    value.min(i64::MAX as u128) as i64
}

fn is_expired(
    status: ContactCacheEntryStatus,
    fetched_at_unix_ms: u128,
    now_unix_ms: u128,
) -> bool {
    let ttl = if status == ContactCacheEntryStatus::Failed {
        CONTACT_FAILURE_CACHE_TTL_MS
    } else {
        CONTACT_CACHE_TTL_MS
    };
    fetched_at_unix_ms
        .checked_add(ttl)
        .is_none_or(|expires_at| expires_at <= now_unix_ms)
}

fn is_legacy_json_store(path: &Path) -> bool {
    fs::read(path)
        .ok()
        .and_then(|bytes| bytes.into_iter().find(|byte| !byte.is_ascii_whitespace()))
        == Some(b'{')
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::{
        ContactCacheEntryStatus, ContactCacheState, ContactFetchAction, CONTACT_CACHE_TTL_MS,
        MAX_CONTACT_CACHE_ENTRIES,
    };
    use shipflow_core::model::{ContactDetail, ContactEnrichment};

    #[test]
    fn stores_contact_by_exact_shipment_id() {
        let path = test_path("exact");
        let cache = ContactCacheState::open(path.clone());

        cache.store(
            "P2606020189412.30",
            ContactEnrichment {
                pengirim: ContactDetail {
                    telepon: Some("628123".into()),
                    ..ContactDetail::default()
                },
                penerima: ContactDetail::default(),
            },
        );

        let entry = cache
            .get("P2606020189412.30")
            .expect("contact should be cached");
        assert_eq!(entry.status, ContactCacheEntryStatus::Ok);
        assert_eq!(entry.contact.pengirim.telepon.as_deref(), Some("628123"));
        assert!(cache.get("P260602018941230").is_none());

        cleanup_sqlite(path);
    }

    #[test]
    fn concurrent_contact_writes_remain_complete_after_reopen() {
        let path = test_path("concurrent");
        let cache = Arc::new(ContactCacheState::open(path.clone()));
        let writers = (0..16)
            .map(|index| {
                let cache = Arc::clone(&cache);
                std::thread::spawn(move || {
                    cache.store(
                        &format!("P{index:014}"),
                        ContactEnrichment {
                            penerima: ContactDetail {
                                telepon: Some(format!("62812{index:04}")),
                                ..ContactDetail::default()
                            },
                            ..ContactEnrichment::default()
                        },
                    );
                })
            })
            .collect::<Vec<_>>();

        for writer in writers {
            writer.join().expect("contact writer should finish");
        }
        drop(cache);

        let reopened = ContactCacheState::open(path.clone());
        for index in 0..16 {
            assert!(reopened.get(&format!("P{index:014}")).is_some());
        }
        drop(reopened);
        cleanup_sqlite(path);
    }

    #[test]
    fn drops_expired_contact_entries() {
        let path = test_path("expired");
        let cache = ContactCacheState::open(path.clone());
        cache.store(
            "P2606020189412",
            ContactEnrichment {
                penerima: ContactDetail {
                    telepon: Some("628123".into()),
                    ..ContactDetail::default()
                },
                ..ContactEnrichment::default()
            },
        );
        cache.set_fetched_at_for_test(
            "P2606020189412",
            super::unix_ms() - CONTACT_CACHE_TTL_MS - 1,
        );

        assert!(cache.get("P2606020189412").is_none());
        drop(cache);
        cleanup_sqlite(path);
    }

    #[test]
    fn prunes_oldest_contacts_when_cache_is_over_limit() {
        let path = test_path("limit");
        let cache = ContactCacheState::open(path.clone());
        {
            let connection = cache
                .connection
                .lock()
                .expect("contact cache connection lock poisoned");
            for index in 0..(MAX_CONTACT_CACHE_ENTRIES + 1) {
                connection
                    .execute(
                        "INSERT INTO contact_cache (
                             shipment_id,
                             contact_json,
                             status,
                             source,
                             fetched_at_unix_ms,
                             last_used_at_unix_ms
                         ) VALUES (?1, '{}', 'missing', 'lacak_mitra', ?2, ?3)",
                        rusqlite::params![
                            format!("P{index:014}"),
                            super::to_sql_millis(super::unix_ms()),
                            index as i64
                        ],
                    )
                    .expect("test contact should insert");
            }
            super::prune_connection(&connection, super::unix_ms());
        }

        assert!(cache.get("P00000000000000").is_none());
        let count = cache
            .connection
            .lock()
            .expect("contact cache connection lock poisoned")
            .query_row("SELECT COUNT(*) FROM contact_cache", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("contact count should load");
        assert_eq!(count as usize, MAX_CONTACT_CACHE_ENTRIES);
        drop(cache);
        cleanup_sqlite(path);
    }

    #[tokio::test]
    async fn coalesces_in_flight_contact_fetches_for_the_same_id() {
        let path = test_path("singleflight");
        let cache = ContactCacheState::open(path.clone());
        let first = match cache.begin_fetch("P2606020189412") {
            ContactFetchAction::Start(lease) => lease,
            ContactFetchAction::Wait(_) => panic!("first fetch should own the lease"),
        };
        let waiter = match cache.begin_fetch("P2606020189412") {
            ContactFetchAction::Wait(waiter) => waiter,
            ContactFetchAction::Start(_) => panic!("second fetch should wait"),
        };

        drop(first);
        tokio::time::timeout(std::time::Duration::from_millis(50), waiter)
            .await
            .expect("waiter should be notified");

        assert!(matches!(
            cache.begin_fetch("P2606020189412"),
            ContactFetchAction::Start(_)
        ));
        drop(cache);
        cleanup_sqlite(path);
    }

    fn test_path(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "shipflow-contact-cache-{label}-{}-{}.sqlite3",
            std::process::id(),
            chrono_like_test_suffix()
        ))
    }

    fn cleanup_sqlite(path: std::path::PathBuf) {
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
    }

    fn chrono_like_test_suffix() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0)
    }
}
