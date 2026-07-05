use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use shipflow_core::model::ContactEnrichment;

use crate::persistent_store::default_persistent_lookup_store_path;

const CONTACT_STORE_FILE_NAME: &str = "contact-store.json";
const CONTACT_CACHE_TTL_MS: u128 = 90 * 24 * 60 * 60 * 1000;
const MAX_CONTACT_CACHE_ENTRIES: usize = 20_000;

#[derive(Clone, Debug)]
pub struct ContactCacheState {
    path: PathBuf,
    inner: Arc<Mutex<ContactCacheStoreFile>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContactCacheStoreFile {
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
}

impl Default for ContactCacheState {
    fn default() -> Self {
        Self::open_default()
    }
}

impl ContactCacheState {
    pub fn open_default() -> Self {
        let path = std::env::var_os("SHIPFLOW_CONTACT_STORE_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                default_persistent_lookup_store_path().with_file_name(CONTACT_STORE_FILE_NAME)
            });
        Self::open(path)
    }

    pub fn open(path: PathBuf) -> Self {
        let mut inner = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<ContactCacheStoreFile>(&bytes).ok())
            .filter(|store| store.version == 1)
            .unwrap_or_else(|| ContactCacheStoreFile {
                version: 1,
                entries: HashMap::new(),
            });
        inner.prune(unix_ms());

        Self {
            path,
            inner: Arc::new(Mutex::new(inner)),
        }
    }

    pub fn get(&self, shipment_id: &str) -> Option<ContactCacheEntry> {
        let (snapshot, entry) = {
            let mut store = self.inner.lock().expect("contact cache lock poisoned");
            let now = unix_ms();
            let entry = store.entries.get_mut(shipment_id)?;
            if is_expired(entry, now) {
                store.entries.remove(shipment_id);
                (Some(store.clone()), None)
            } else {
                entry.last_used_at_unix_ms = now;
                let entry = store.entries.get(shipment_id).cloned();
                (Some(store.clone()), entry)
            }
        };

        if let Some(snapshot) = snapshot {
            let _ = self.persist_snapshot(&snapshot);
        }
        entry
    }

    pub fn store(&self, shipment_id: &str, contact: ContactEnrichment) -> ContactCacheEntry {
        let now = unix_ms();
        let status = if contact.pengirim.telepon.is_some() || contact.penerima.telepon.is_some() {
            ContactCacheEntryStatus::Ok
        } else {
            ContactCacheEntryStatus::Missing
        };
        let entry = ContactCacheEntry {
            shipment_id: shipment_id.to_string(),
            contact,
            status,
            source: "lacak_mitra".into(),
            fetched_at_unix_ms: now,
            last_used_at_unix_ms: now,
        };
        let snapshot = {
            let mut store = self.inner.lock().expect("contact cache lock poisoned");
            store.entries.insert(shipment_id.to_string(), entry.clone());
            store.prune(now);
            store.clone()
        };
        if let Err(error) = self.persist_snapshot(&snapshot) {
            eprintln!("[ShipFlowContactCache] store_error id={shipment_id} error={error}");
        }
        entry
    }

    fn persist_snapshot(&self, snapshot: &ContactCacheStoreFile) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Unable to prepare contact cache directory: {error}"))?;
        }

        let bytes = serde_json::to_vec(snapshot)
            .map_err(|error| format!("Unable to serialize contact cache: {error}"))?;
        fs::write(&self.path, bytes)
            .map_err(|error| format!("Unable to write contact cache: {error}"))
    }
}

fn unix_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn is_expired(entry: &ContactCacheEntry, now_unix_ms: u128) -> bool {
    entry
        .fetched_at_unix_ms
        .checked_add(CONTACT_CACHE_TTL_MS)
        .is_none_or(|expires_at| expires_at <= now_unix_ms)
}

impl ContactCacheStoreFile {
    fn prune(&mut self, now_unix_ms: u128) {
        self.entries
            .retain(|_, entry| !is_expired(entry, now_unix_ms));

        if self.entries.len() <= MAX_CONTACT_CACHE_ENTRIES {
            return;
        }

        let mut entries_by_last_used = self
            .entries
            .iter()
            .map(|(shipment_id, entry)| (shipment_id.clone(), entry.last_used_at_unix_ms))
            .collect::<Vec<_>>();
        entries_by_last_used.sort_by_key(|(_, last_used_at)| *last_used_at);

        let remove_count = self.entries.len() - MAX_CONTACT_CACHE_ENTRIES;
        for (shipment_id, _) in entries_by_last_used.into_iter().take(remove_count) {
            self.entries.remove(&shipment_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ContactCacheEntryStatus, ContactCacheState, CONTACT_CACHE_TTL_MS, MAX_CONTACT_CACHE_ENTRIES,
    };
    use shipflow_core::model::{ContactDetail, ContactEnrichment};

    #[test]
    fn stores_contact_by_exact_shipment_id() {
        let path = std::env::temp_dir().join(format!(
            "shipflow-contact-cache-test-{}-{}.json",
            std::process::id(),
            chrono_like_test_suffix()
        ));
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

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn drops_expired_contact_entries() {
        let path = std::env::temp_dir().join(format!(
            "shipflow-contact-cache-expired-test-{}-{}.json",
            std::process::id(),
            chrono_like_test_suffix()
        ));
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

        {
            let mut store = cache
                .inner
                .lock()
                .expect("cache lock should not be poisoned");
            let entry = store
                .entries
                .get_mut("P2606020189412")
                .expect("entry should exist");
            entry.fetched_at_unix_ms = super::unix_ms() - CONTACT_CACHE_TTL_MS - 1;
        }

        assert!(cache.get("P2606020189412").is_none());

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn prunes_oldest_contacts_when_cache_is_over_limit() {
        let path = std::env::temp_dir().join(format!(
            "shipflow-contact-cache-limit-test-{}-{}.json",
            std::process::id(),
            chrono_like_test_suffix()
        ));
        let cache = ContactCacheState::open(path.clone());

        {
            let mut store = cache
                .inner
                .lock()
                .expect("cache lock should not be poisoned");
            for index in 0..(MAX_CONTACT_CACHE_ENTRIES + 1) {
                store.entries.insert(
                    format!("P{index:014}"),
                    super::ContactCacheEntry {
                        shipment_id: format!("P{index:014}"),
                        contact: ContactEnrichment::default(),
                        status: ContactCacheEntryStatus::Missing,
                        source: "lacak_mitra".into(),
                        fetched_at_unix_ms: super::unix_ms(),
                        last_used_at_unix_ms: index as u128,
                    },
                );
            }
            store.prune(super::unix_ms());
            assert_eq!(store.entries.len(), MAX_CONTACT_CACHE_ENTRIES);
            assert!(!store.entries.contains_key("P00000000000000"));
        }

        let _ = std::fs::remove_file(path);
    }

    fn chrono_like_test_suffix() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0)
    }
}
