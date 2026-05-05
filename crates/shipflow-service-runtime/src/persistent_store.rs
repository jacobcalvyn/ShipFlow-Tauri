use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const MAX_PERSISTED_LOOKUP_ENTRIES: usize = 2_000;
const MAX_PERSISTED_LOOKUP_PAYLOAD_BYTES: usize = 128 * 1024;
const EMBEDDED_DATA_IMAGE_MARKER: &str = "data:image";
const SERVICE_STATE_DIR_NAME: &str = "shipflow-service-runtime";
const LOOKUP_STORE_FILE_NAME: &str = "lookup-store.json";
#[cfg(any(target_os = "macos", target_os = "windows"))]
const SERVICE_APP_DATA_DIR_NAME: &str = "ShipFlow Service";
#[cfg(any(target_os = "macos", target_os = "windows"))]
const LEGACY_DESKTOP_APP_DATA_DIR_NAME: &str = "ShipFlow Desktop";
#[cfg(all(unix, not(target_os = "macos")))]
const SERVICE_XDG_DATA_DIR_NAME: &str = "shipflow-service";
#[cfg(all(unix, not(target_os = "macos")))]
const LEGACY_DESKTOP_XDG_DATA_DIR_NAME: &str = "shipflow-desktop";

static PERSISTENT_STORE_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug)]
pub struct PersistentLookupStore {
    path: PathBuf,
    inner: Arc<Mutex<PersistentLookupStoreFile>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistentLookupStoreFile {
    version: u8,
    entries: HashMap<String, PersistentLookupEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistentLookupEntry {
    expires_at_unix_ms: u128,
    payload: String,
}

impl PersistentLookupStore {
    pub fn open_default() -> Self {
        let path = default_persistent_lookup_store_path();
        migrate_legacy_persistent_lookup_store(&path);
        Self::open(path)
    }

    pub fn open(path: PathBuf) -> Self {
        let loaded_from_disk = path.exists();
        let mut inner = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<PersistentLookupStoreFile>(&bytes).ok())
            .filter(|store| store.version == 1)
            .unwrap_or_else(|| PersistentLookupStoreFile {
                version: 1,
                entries: HashMap::new(),
            });
        let should_persist_sanitized_store = loaded_from_disk && compact_store(&mut inner);

        let store = Self {
            path,
            inner: Arc::new(Mutex::new(inner)),
        };
        if should_persist_sanitized_store {
            let snapshot = store
                .inner
                .lock()
                .expect("persistent lookup store lock poisoned")
                .clone();
            if let Err(error) = store.persist_snapshot(&snapshot) {
                eprintln!("[ShipFlowService] {error}");
            }
        }
        store
    }

    pub fn load_success(&self, key: &str) -> Option<String> {
        let now = unix_ms();
        let mut store = self
            .inner
            .lock()
            .expect("persistent lookup store lock poisoned");
        let should_remove = {
            let entry = store.entries.get(key)?;
            entry.expires_at_unix_ms <= now
                || persistent_lookup_skip_reason(&entry.payload).is_some()
        };

        if should_remove {
            store.entries.remove(key);
            let snapshot = store.clone();
            drop(store);
            let _ = self.persist_snapshot(&snapshot);
            return None;
        }

        store.entries.get(key).map(|entry| entry.payload.clone())
    }

    pub fn store_success(&self, key: String, payload: String, ttl: Duration) -> bool {
        if persistent_lookup_skip_reason(&payload).is_some() {
            self.remove_success(&key);
            return false;
        }

        let expires_at_unix_ms = unix_ms().saturating_add(ttl.as_millis());
        let snapshot = {
            let mut store = self
                .inner
                .lock()
                .expect("persistent lookup store lock poisoned");
            store.entries.insert(
                key,
                PersistentLookupEntry {
                    expires_at_unix_ms,
                    payload,
                },
            );
            compact_store(&mut store);
            store.clone()
        };

        if let Err(error) = self.persist_snapshot(&snapshot) {
            eprintln!("[ShipFlowService] {error}");
            return false;
        }
        true
    }

    pub fn remove_success(&self, key: &str) -> bool {
        let snapshot = {
            let mut store = self
                .inner
                .lock()
                .expect("persistent lookup store lock poisoned");
            if store.entries.remove(key).is_none() {
                return false;
            }
            store.clone()
        };

        if let Err(error) = self.persist_snapshot(&snapshot) {
            eprintln!("[ShipFlowService] {error}");
        }
        true
    }

    fn persist_snapshot(&self, snapshot: &PersistentLookupStoreFile) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!("Unable to prepare persistent lookup store directory: {error}")
            })?;
        }

        let temp_path = unique_store_temp_path(&self.path);
        let bytes = serde_json::to_vec(snapshot)
            .map_err(|error| format!("Unable to serialize persistent lookup store: {error}"))?;
        fs::write(&temp_path, bytes)
            .map_err(|error| format!("Unable to write persistent lookup store: {error}"))?;
        replace_store_file(temp_path, self.path.clone())
    }
}

pub fn persistent_lookup_skip_reason(payload: &str) -> Option<&'static str> {
    if payload.len() > MAX_PERSISTED_LOOKUP_PAYLOAD_BYTES {
        return Some("payload_too_large");
    }

    if payload.contains(EMBEDDED_DATA_IMAGE_MARKER) {
        return Some("embedded_data_image");
    }

    None
}

pub fn default_persistent_lookup_store_path() -> PathBuf {
    if let Some(path) = std::env::var_os("SHIPFLOW_LOOKUP_STORE_PATH").map(PathBuf::from) {
        return path;
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(home_dir) = std::env::var_os("HOME").map(PathBuf::from) {
            return home_dir
                .join("Library")
                .join("Application Support")
                .join(SERVICE_APP_DATA_DIR_NAME)
                .join(SERVICE_STATE_DIR_NAME)
                .join(LOOKUP_STORE_FILE_NAME);
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(app_data) = std::env::var_os("APPDATA").map(PathBuf::from) {
            return app_data
                .join(SERVICE_APP_DATA_DIR_NAME)
                .join(SERVICE_STATE_DIR_NAME)
                .join(LOOKUP_STORE_FILE_NAME);
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(xdg_data_home) = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from) {
            return xdg_data_home
                .join(SERVICE_XDG_DATA_DIR_NAME)
                .join(SERVICE_STATE_DIR_NAME)
                .join(LOOKUP_STORE_FILE_NAME);
        }

        if let Some(home_dir) = std::env::var_os("HOME").map(PathBuf::from) {
            return home_dir
                .join(".local")
                .join("share")
                .join(SERVICE_XDG_DATA_DIR_NAME)
                .join(SERVICE_STATE_DIR_NAME)
                .join(LOOKUP_STORE_FILE_NAME);
        }
    }

    std::env::temp_dir()
        .join(SERVICE_STATE_DIR_NAME)
        .join(LOOKUP_STORE_FILE_NAME)
}

#[cfg(target_os = "macos")]
fn legacy_persistent_lookup_store_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from).map(|home_dir| {
        home_dir
            .join("Library")
            .join("Application Support")
            .join(LEGACY_DESKTOP_APP_DATA_DIR_NAME)
            .join(SERVICE_STATE_DIR_NAME)
            .join(LOOKUP_STORE_FILE_NAME)
    })
}

#[cfg(target_os = "windows")]
fn legacy_persistent_lookup_store_path() -> Option<PathBuf> {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|app_data| {
            app_data
                .join(LEGACY_DESKTOP_APP_DATA_DIR_NAME)
                .join(SERVICE_STATE_DIR_NAME)
                .join(LOOKUP_STORE_FILE_NAME)
        })
}

#[cfg(all(unix, not(target_os = "macos")))]
fn legacy_persistent_lookup_store_path() -> Option<PathBuf> {
    if let Some(xdg_data_home) = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from) {
        return Some(
            xdg_data_home
                .join(LEGACY_DESKTOP_XDG_DATA_DIR_NAME)
                .join(SERVICE_STATE_DIR_NAME)
                .join(LOOKUP_STORE_FILE_NAME),
        );
    }

    std::env::var_os("HOME").map(PathBuf::from).map(|home_dir| {
        home_dir
            .join(".local")
            .join("share")
            .join(LEGACY_DESKTOP_XDG_DATA_DIR_NAME)
            .join(SERVICE_STATE_DIR_NAME)
            .join(LOOKUP_STORE_FILE_NAME)
    })
}

#[cfg(not(any(target_os = "macos", target_os = "windows", unix)))]
fn legacy_persistent_lookup_store_path() -> Option<PathBuf> {
    None
}

fn migrate_legacy_persistent_lookup_store(path: &Path) {
    if path.exists() {
        return;
    }

    let Some(legacy_path) = legacy_persistent_lookup_store_path() else {
        return;
    };
    if !legacy_path.exists() || legacy_path == path {
        return;
    }

    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }

    let _ = fs::copy(legacy_path, path);
}

fn unique_store_temp_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "lookup-store.json".into());
    let counter = PERSISTENT_STORE_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    path.with_file_name(format!(
        "{file_name}.{}.{}.{}.tmp",
        std::process::id(),
        unix_ms(),
        counter
    ))
}

#[cfg(target_os = "windows")]
fn replace_store_file(temp_path: PathBuf, path: PathBuf) -> Result<(), String> {
    use std::io::ErrorKind;
    use std::time::Duration;

    let mut last_error = String::new();
    for _ in 0..64 {
        match fs::rename(&temp_path, &path) {
            Ok(()) => return Ok(()),
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::AlreadyExists | ErrorKind::PermissionDenied
                ) =>
            {
                std::thread::sleep(Duration::from_millis(2));
            }
            Err(error) => {
                let _ = fs::remove_file(&temp_path);
                return Err(format!(
                    "Unable to finalize persistent lookup store: {error}"
                ));
            }
        }

        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) if error.kind() == ErrorKind::PermissionDenied => {
                last_error = error.to_string();
                std::thread::sleep(Duration::from_millis(2));
                continue;
            }
            Err(error) => {
                let _ = fs::remove_file(&temp_path);
                return Err(format!(
                    "Unable to prepare persistent lookup store replacement: {error}"
                ));
            }
        }

        match fs::rename(&temp_path, &path) {
            Ok(()) => return Ok(()),
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::AlreadyExists | ErrorKind::PermissionDenied
                ) =>
            {
                last_error = error.to_string();
                std::thread::sleep(Duration::from_millis(2));
            }
            Err(error) => {
                let _ = fs::remove_file(&temp_path);
                return Err(format!(
                    "Unable to finalize persistent lookup store: {error}"
                ));
            }
        }
    }

    let _ = fs::remove_file(&temp_path);
    if last_error.is_empty() {
        last_error = "concurrent replacement did not settle".into();
    }
    Err(format!(
        "Unable to finalize persistent lookup store: {last_error}"
    ))
}

#[cfg(not(target_os = "windows"))]
fn replace_store_file(temp_path: PathBuf, path: PathBuf) -> Result<(), String> {
    fs::rename(&temp_path, &path).map_err(|error| {
        let _ = fs::remove_file(&temp_path);
        format!("Unable to finalize persistent lookup store: {error}")
    })
}

fn compact_store(store: &mut PersistentLookupStoreFile) -> bool {
    let now = unix_ms();
    let mut removed_entries = false;
    store.entries.retain(|_, entry| {
        let keep = entry.expires_at_unix_ms > now
            && persistent_lookup_skip_reason(&entry.payload).is_none();
        if !keep {
            removed_entries = true;
        }
        keep
    });

    if store.entries.len() <= MAX_PERSISTED_LOOKUP_ENTRIES {
        return removed_entries;
    }

    let mut entries = store
        .entries
        .iter()
        .map(|(key, entry)| (key.clone(), entry.expires_at_unix_ms))
        .collect::<Vec<_>>();
    entries.sort_by_key(|(_, expires_at)| *expires_at);

    for (key, _) in entries
        .into_iter()
        .take(store.entries.len() - MAX_PERSISTED_LOOKUP_ENTRIES)
    {
        store.entries.remove(&key);
        removed_entries = true;
    }

    removed_entries
}

fn unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::fs;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use super::{
        persistent_lookup_skip_reason, unix_ms, PersistentLookupEntry, PersistentLookupStore,
        PersistentLookupStoreFile, MAX_PERSISTED_LOOKUP_PAYLOAD_BYTES,
    };

    fn unique_store_path() -> std::path::PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("shipflow-persistent-store-{timestamp}.json"))
    }

    #[test]
    fn stores_and_loads_success_payload() {
        let path = unique_store_path();
        let store = PersistentLookupStore::open(path.clone());
        assert!(store.store_success(
            "track:1".into(),
            "{\"ok\":true}".into(),
            Duration::from_secs(60),
        ));

        let reopened = PersistentLookupStore::open(path.clone());
        assert_eq!(
            reopened.load_success("track:1").as_deref(),
            Some("{\"ok\":true}")
        );

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn overwrites_existing_success_payload() {
        let path = unique_store_path();
        let store = PersistentLookupStore::open(path.clone());
        assert!(store.store_success(
            "track:1".into(),
            "{\"ok\":false}".into(),
            Duration::from_secs(60),
        ));
        assert!(store.store_success(
            "track:1".into(),
            "{\"ok\":true}".into(),
            Duration::from_secs(60),
        ));

        let reopened = PersistentLookupStore::open(path.clone());
        assert_eq!(
            reopened.load_success("track:1").as_deref(),
            Some("{\"ok\":true}")
        );

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn expired_entries_are_ignored() {
        let path = unique_store_path();
        let store = PersistentLookupStore::open(path.clone());
        assert!(store.store_success(
            "track:1".into(),
            "{\"ok\":true}".into(),
            Duration::from_millis(0),
        ));

        assert!(store.load_success("track:1").is_none());

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn skips_embedded_data_image_payloads() {
        let path = unique_store_path();
        let store = PersistentLookupStore::open(path.clone());
        let payload = r#"{"pod":{"photo1_url":"data:image/jpeg;base64,abc"}}"#;

        assert_eq!(
            persistent_lookup_skip_reason(payload),
            Some("embedded_data_image")
        );
        assert!(!store.store_success("track:pod".into(), payload.into(), Duration::from_secs(60)));

        let reopened = PersistentLookupStore::open(path.clone());
        assert!(reopened.load_success("track:pod").is_none());

        let _ = fs::remove_file(path);
    }

    #[test]
    fn skips_payloads_that_are_too_large_for_fast_startup() {
        let path = unique_store_path();
        let store = PersistentLookupStore::open(path.clone());
        let payload = "x".repeat(MAX_PERSISTED_LOOKUP_PAYLOAD_BYTES + 1);

        assert_eq!(
            persistent_lookup_skip_reason(&payload),
            Some("payload_too_large")
        );
        assert!(!store.store_success("track:large".into(), payload, Duration::from_secs(60)));

        let reopened = PersistentLookupStore::open(path.clone());
        assert!(reopened.load_success("track:large").is_none());

        let _ = fs::remove_file(path);
    }

    #[test]
    fn drops_legacy_oversized_entries_when_opening_store() {
        let path = unique_store_path();
        let expires_at_unix_ms = unix_ms().saturating_add(Duration::from_secs(60).as_millis());
        let mut entries = HashMap::new();
        entries.insert(
            "track:small".into(),
            PersistentLookupEntry {
                expires_at_unix_ms,
                payload: "{\"ok\":true}".into(),
            },
        );
        entries.insert(
            "track:image".into(),
            PersistentLookupEntry {
                expires_at_unix_ms,
                payload: r#"{"pod":{"signature_url":"data:image/png;base64,abc"}}"#.into(),
            },
        );
        entries.insert(
            "track:large".into(),
            PersistentLookupEntry {
                expires_at_unix_ms,
                payload: "x".repeat(MAX_PERSISTED_LOOKUP_PAYLOAD_BYTES + 1),
            },
        );
        let legacy_store = PersistentLookupStoreFile {
            version: 1,
            entries,
        };
        fs::write(
            &path,
            serde_json::to_vec(&legacy_store).expect("serialize legacy store"),
        )
        .expect("write legacy store");

        let store = PersistentLookupStore::open(path.clone());

        assert_eq!(
            store.load_success("track:small").as_deref(),
            Some("{\"ok\":true}")
        );
        assert!(store.load_success("track:image").is_none());
        assert!(store.load_success("track:large").is_none());

        let reopened = PersistentLookupStore::open(path.clone());
        assert_eq!(
            reopened.load_success("track:small").as_deref(),
            Some("{\"ok\":true}")
        );
        assert!(reopened.load_success("track:image").is_none());
        assert!(reopened.load_success("track:large").is_none());

        let _ = fs::remove_file(path);
    }
}
