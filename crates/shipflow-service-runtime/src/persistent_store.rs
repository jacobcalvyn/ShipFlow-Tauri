use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

const MAX_PERSISTED_LOOKUP_ENTRIES: usize = 2_000;
const MAX_PERSISTED_LOOKUP_PAYLOAD_BYTES: usize = 128 * 1024;
const MAX_BUFFERED_PERSISTENT_WRITES: usize = 1_024;
const MAX_WRITES_PER_TRANSACTION: usize = 128;
const EMBEDDED_DATA_IMAGE_MARKER: &str = "data:image";
const SERVICE_STATE_DIR_NAME: &str = "shipflow-service-runtime";
const LOOKUP_STORE_FILE_NAME: &str = "lookup-store.sqlite3";
const LEGACY_LOOKUP_STORE_FILE_NAME: &str = "lookup-store.json";
#[cfg(any(target_os = "macos", target_os = "windows"))]
const SERVICE_APP_DATA_DIR_NAME: &str = "ShipFlow Service";
#[cfg(any(target_os = "macos", target_os = "windows"))]
const LEGACY_DESKTOP_APP_DATA_DIR_NAME: &str = "ShipFlow Desktop";
#[cfg(target_os = "windows")]
const WINDOWS_SERVICE_DATA_DIR_NAME: &str = "Service";
#[cfg(all(unix, not(target_os = "macos")))]
const SERVICE_XDG_DATA_DIR_NAME: &str = "shipflow-service";
#[cfg(all(unix, not(target_os = "macos")))]
const LEGACY_DESKTOP_XDG_DATA_DIR_NAME: &str = "shipflow-desktop";

#[derive(Clone)]
pub struct PersistentLookupStore {
    inner: Arc<PersistentLookupStoreInner>,
}

struct PersistentLookupStoreInner {
    reader: Mutex<Connection>,
    writer: PersistentLookupWriter,
}

struct PersistentLookupWriter {
    sender: SyncSender<PersistentWriteCommand>,
    handle: Mutex<Option<thread::JoinHandle<()>>>,
}

enum PersistentWriteCommand {
    Upsert {
        key: String,
        payload: String,
        expires_at_unix_ms: i64,
        acknowledgement: Option<mpsc::Sender<bool>>,
    },
    Remove {
        key: String,
        acknowledgement: Option<mpsc::Sender<bool>>,
    },
    Flush(mpsc::Sender<()>),
    Shutdown,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyPersistentLookupStoreFile {
    version: u8,
    entries: HashMap<String, LegacyPersistentLookupEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyPersistentLookupEntry {
    expires_at_unix_ms: u128,
    payload: String,
}

impl std::fmt::Debug for PersistentLookupStore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PersistentLookupStore")
            .finish_non_exhaustive()
    }
}

impl PersistentLookupStore {
    pub fn open_default() -> Self {
        Self::try_open_default().expect("persistent lookup store should open")
    }

    pub fn try_open_default() -> Result<Self, String> {
        let path = default_persistent_lookup_store_path();
        let legacy_entries = load_default_legacy_entries(&path);
        Self::try_open_with_legacy_entries(path, legacy_entries)
    }

    pub fn open(path: PathBuf) -> Self {
        Self::try_open(path).expect("persistent lookup store should open")
    }

    pub fn try_open(path: PathBuf) -> Result<Self, String> {
        let legacy_entries = extract_legacy_entries_from_target(&path);
        Self::try_open_with_legacy_entries(path, legacy_entries)
    }

    fn try_open_with_legacy_entries(
        requested_path: PathBuf,
        legacy_entries: Vec<(String, LegacyPersistentLookupEntry)>,
    ) -> Result<Self, String> {
        let (path, reader) = match prepare_database_path(&requested_path)
            .and_then(|path| open_database(&path).map(|connection| (path, connection)))
        {
            Ok(opened) => opened,
            Err(primary_error) => {
                shipflow_core::shipflow_log!(
                    "[ShipFlowService] persistent_lookup_primary_open_failed path={} error={primary_error}",
                    requested_path.display()
                );
                let fallback_path = std::env::temp_dir().join(format!(
                    "shipflow-lookup-store-{}-{}.sqlite3",
                    std::process::id(),
                    unix_ms()
                ));
                prepare_database_path(&fallback_path)
                    .and_then(|path| open_database(&path).map(|connection| (path, connection)))
                    .map_err(|fallback_error| {
                        format!(
                            "Persistent lookup store is unavailable. Primary error: {primary_error}; fallback error: {fallback_error}"
                        )
                    })?
            }
        };
        import_legacy_entries(&reader, legacy_entries);

        let (sender, receiver) = mpsc::sync_channel(MAX_BUFFERED_PERSISTENT_WRITES);
        let writer_path = path.clone();
        let handle = thread::Builder::new()
            .name("shipflow-lookup-writer".into())
            .spawn(move || run_persistent_writer(writer_path, receiver))
            .map_err(|error| format!("Unable to start persistent lookup writer: {error}"))?;

        Ok(Self {
            inner: Arc::new(PersistentLookupStoreInner {
                reader: Mutex::new(reader),
                writer: PersistentLookupWriter {
                    sender,
                    handle: Mutex::new(Some(handle)),
                },
            }),
        })
    }

    pub fn load_success(&self, key: &str) -> Option<String> {
        self.load_success_fresh(key, None)
    }

    pub fn load_success_fresh(&self, key: &str, max_age: Option<Duration>) -> Option<String> {
        let row = {
            let reader = self.inner.reader.lock().ok()?;
            reader
                .query_row(
                    "SELECT expires_at_unix_ms, payload, updated_at_unix_ms
                     FROM lookup_cache WHERE key = ?1",
                    params![key],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    },
                )
                .optional()
                .unwrap_or_else(|error| {
                    shipflow_core::shipflow_log!(
                        "[ShipFlowService] Unable to read persistent lookup store: {error}"
                    );
                    None
                })
        }?;

        let now = unix_ms();
        let too_old = max_age.is_some_and(|max_age| {
            let max_age_ms = i64::try_from(max_age.as_millis()).unwrap_or(i64::MAX);
            now.saturating_sub(row.2) > max_age_ms
        });
        if row.0 <= now || too_old || persistent_lookup_skip_reason(&row.1).is_some() {
            self.enqueue_remove_success(key.to_string());
            return None;
        }
        Some(row.1)
    }

    pub async fn load_success_async(&self, key: String, max_age: Duration) -> Option<String> {
        let store = self.clone();
        match tokio::task::spawn_blocking(move || store.load_success_fresh(&key, Some(max_age)))
            .await
        {
            Ok(payload) => payload,
            Err(error) => {
                shipflow_core::shipflow_log!(
                    "[ShipFlowService] persistent_lookup_read_task_failed error={error}"
                );
                None
            }
        }
    }

    pub fn store_success(&self, key: String, payload: String, ttl: Duration) -> bool {
        if persistent_lookup_skip_reason(&payload).is_some() {
            self.remove_success(&key);
            return false;
        }

        let (acknowledgement, response) = mpsc::channel();
        if self
            .inner
            .writer
            .sender
            .send(PersistentWriteCommand::Upsert {
                key,
                payload,
                expires_at_unix_ms: expires_at_unix_ms(ttl),
                acknowledgement: Some(acknowledgement),
            })
            .is_err()
        {
            return false;
        }
        response.recv().unwrap_or(false)
    }

    pub fn enqueue_store_success(&self, key: String, payload: String, ttl: Duration) -> bool {
        if persistent_lookup_skip_reason(&payload).is_some() {
            self.enqueue_remove_success(key);
            return false;
        }

        match self
            .inner
            .writer
            .sender
            .try_send(PersistentWriteCommand::Upsert {
                key,
                payload,
                expires_at_unix_ms: expires_at_unix_ms(ttl),
                acknowledgement: None,
            }) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => false,
        }
    }

    pub fn remove_success(&self, key: &str) -> bool {
        let (acknowledgement, response) = mpsc::channel();
        if self
            .inner
            .writer
            .sender
            .send(PersistentWriteCommand::Remove {
                key: key.to_string(),
                acknowledgement: Some(acknowledgement),
            })
            .is_err()
        {
            return false;
        }
        response.recv().unwrap_or(false)
    }

    pub fn enqueue_remove_success(&self, key: String) -> bool {
        self.inner
            .writer
            .sender
            .try_send(PersistentWriteCommand::Remove {
                key,
                acknowledgement: None,
            })
            .is_ok()
    }

    pub fn flush(&self) {
        let (acknowledgement, response) = mpsc::channel();
        if self
            .inner
            .writer
            .sender
            .send(PersistentWriteCommand::Flush(acknowledgement))
            .is_ok()
        {
            let _ = response.recv();
        }
    }
}

impl Drop for PersistentLookupStoreInner {
    fn drop(&mut self) {
        let _ = self.writer.sender.send(PersistentWriteCommand::Shutdown);
        if let Some(handle) = self
            .writer
            .handle
            .lock()
            .expect("persistent lookup writer handle lock poisoned")
            .take()
        {
            let _ = handle.join();
        }
    }
}

fn run_persistent_writer(path: PathBuf, receiver: Receiver<PersistentWriteCommand>) {
    let mut connection = match open_database(&path) {
        Ok(connection) => connection,
        Err(error) => {
            shipflow_core::shipflow_log!(
                "[ShipFlowService] Persistent lookup writer failed to start: {error}"
            );
            reject_pending_commands(receiver);
            return;
        }
    };

    while let Ok(first_command) = receiver.recv() {
        if matches!(first_command, PersistentWriteCommand::Shutdown) {
            break;
        }

        let mut commands = vec![first_command];
        while commands.len() < MAX_WRITES_PER_TRANSACTION {
            match receiver.try_recv() {
                Ok(PersistentWriteCommand::Shutdown) => {
                    process_write_batch(&mut connection, commands);
                    return;
                }
                Ok(command) => commands.push(command),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    process_write_batch(&mut connection, commands);
                    return;
                }
            }
        }
        process_write_batch(&mut connection, commands);
    }
}

fn process_write_batch(connection: &mut Connection, commands: Vec<PersistentWriteCommand>) {
    let transaction = match connection.transaction() {
        Ok(transaction) => transaction,
        Err(error) => {
            shipflow_core::shipflow_log!(
                "[ShipFlowService] Unable to start persistent lookup transaction: {error}"
            );
            acknowledge_failed_batch(commands);
            return;
        }
    };

    let mut acknowledgements = Vec::new();
    let mut flushes = Vec::new();
    let mut failed = false;
    for command in commands {
        match command {
            PersistentWriteCommand::Upsert {
                key,
                payload,
                expires_at_unix_ms,
                acknowledgement,
            } => {
                let result = upsert_lookup_entry(&transaction, &key, &payload, expires_at_unix_ms);
                failed |= result.is_err();
                if let Some(acknowledgement) = acknowledgement {
                    acknowledgements.push((acknowledgement, result.is_ok()));
                }
            }
            PersistentWriteCommand::Remove {
                key,
                acknowledgement,
            } => {
                let result =
                    transaction.execute("DELETE FROM lookup_cache WHERE key = ?1", params![key]);
                failed |= result.is_err();
                if let Some(acknowledgement) = acknowledgement {
                    acknowledgements.push((
                        acknowledgement,
                        result.map(|removed| removed > 0).unwrap_or(false),
                    ));
                }
            }
            PersistentWriteCommand::Flush(acknowledgement) => {
                flushes.push(acknowledgement);
            }
            PersistentWriteCommand::Shutdown => {}
        }
    }

    if !failed {
        failed = prune_lookup_entries(&transaction).is_err();
    }
    let committed = !failed && transaction.commit().is_ok();
    if !committed {
        shipflow_core::shipflow_log!(
            "[ShipFlowService] Persistent lookup write batch was rolled back."
        );
    }
    for (acknowledgement, result) in acknowledgements {
        let _ = acknowledgement.send(committed && result);
    }
    for acknowledgement in flushes {
        let _ = acknowledgement.send(());
    }
}

fn reject_pending_commands(receiver: Receiver<PersistentWriteCommand>) {
    while let Ok(command) = receiver.recv() {
        match command {
            PersistentWriteCommand::Upsert {
                acknowledgement, ..
            }
            | PersistentWriteCommand::Remove {
                acknowledgement, ..
            } => {
                if let Some(acknowledgement) = acknowledgement {
                    let _ = acknowledgement.send(false);
                }
            }
            PersistentWriteCommand::Flush(acknowledgement) => {
                let _ = acknowledgement.send(());
            }
            PersistentWriteCommand::Shutdown => return,
        }
    }
}

fn acknowledge_failed_batch(commands: Vec<PersistentWriteCommand>) {
    for command in commands {
        match command {
            PersistentWriteCommand::Upsert {
                acknowledgement, ..
            }
            | PersistentWriteCommand::Remove {
                acknowledgement, ..
            } => {
                if let Some(acknowledgement) = acknowledgement {
                    let _ = acknowledgement.send(false);
                }
            }
            PersistentWriteCommand::Flush(acknowledgement) => {
                let _ = acknowledgement.send(());
            }
            PersistentWriteCommand::Shutdown => {}
        }
    }
}

fn upsert_lookup_entry(
    transaction: &Transaction<'_>,
    key: &str,
    payload: &str,
    expires_at_unix_ms: i64,
) -> rusqlite::Result<()> {
    transaction.execute(
        "INSERT INTO lookup_cache (key, expires_at_unix_ms, payload, updated_at_unix_ms)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(key) DO UPDATE SET
             expires_at_unix_ms = excluded.expires_at_unix_ms,
             payload = excluded.payload,
             updated_at_unix_ms = excluded.updated_at_unix_ms",
        params![key, expires_at_unix_ms, payload, unix_ms()],
    )?;
    Ok(())
}

fn prune_lookup_entries(transaction: &Transaction<'_>) -> rusqlite::Result<()> {
    transaction.execute(
        "DELETE FROM lookup_cache
         WHERE expires_at_unix_ms <= ?1
            OR length(payload) > ?2
            OR instr(payload, ?3) > 0",
        params![
            unix_ms(),
            MAX_PERSISTED_LOOKUP_PAYLOAD_BYTES as i64,
            EMBEDDED_DATA_IMAGE_MARKER
        ],
    )?;
    transaction.execute(
        "DELETE FROM lookup_cache
         WHERE key IN (
             SELECT key FROM lookup_cache
             ORDER BY expires_at_unix_ms ASC, updated_at_unix_ms ASC
             LIMIT MAX(0, (SELECT COUNT(*) FROM lookup_cache) - ?1)
         )",
        params![MAX_PERSISTED_LOOKUP_ENTRIES as i64],
    )?;
    Ok(())
}

fn open_database(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path)
        .map_err(|error| format!("Unable to open persistent lookup database: {error}"))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| format!("Unable to configure persistent lookup database: {error}"))?;
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS lookup_cache (
                 key TEXT PRIMARY KEY NOT NULL,
                 expires_at_unix_ms INTEGER NOT NULL,
                 payload TEXT NOT NULL,
                 updated_at_unix_ms INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_lookup_cache_expiry
                 ON lookup_cache(expires_at_unix_ms);",
        )
        .map_err(|error| format!("Unable to initialize persistent lookup database: {error}"))?;
    Ok(connection)
}

fn prepare_database_path(path: &Path) -> Result<PathBuf, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!("Unable to prepare persistent lookup database directory: {error}")
        })?;
    }
    Ok(path.to_path_buf())
}

fn import_legacy_entries(
    connection: &Connection,
    entries: Vec<(String, LegacyPersistentLookupEntry)>,
) {
    if entries.is_empty() {
        return;
    }

    let mut statement = match connection.prepare(
        "INSERT OR IGNORE INTO lookup_cache
         (key, expires_at_unix_ms, payload, updated_at_unix_ms)
         VALUES (?1, ?2, ?3, ?4)",
    ) {
        Ok(statement) => statement,
        Err(error) => {
            shipflow_core::shipflow_log!(
                "[ShipFlowService] Unable to prepare legacy cache migration: {error}"
            );
            return;
        }
    };
    let now = unix_ms();
    for (key, entry) in entries {
        let Ok(expires_at_unix_ms) = i64::try_from(entry.expires_at_unix_ms) else {
            continue;
        };
        if expires_at_unix_ms <= now || persistent_lookup_skip_reason(&entry.payload).is_some() {
            continue;
        }
        if let Err(error) = statement.execute(params![key, expires_at_unix_ms, entry.payload, now])
        {
            shipflow_core::shipflow_log!(
                "[ShipFlowService] Unable to migrate legacy cache entry: {error}"
            );
        }
    }
}

fn load_default_legacy_entries(path: &Path) -> Vec<(String, LegacyPersistentLookupEntry)> {
    let mut candidates = vec![path.with_file_name(LEGACY_LOOKUP_STORE_FILE_NAME)];
    candidates.extend(legacy_persistent_lookup_store_paths());
    for candidate in candidates {
        if let Some(entries) = read_legacy_entries(&candidate) {
            return entries;
        }
    }
    Vec::new()
}

fn extract_legacy_entries_from_target(path: &Path) -> Vec<(String, LegacyPersistentLookupEntry)> {
    let Some(entries) = read_legacy_entries(path) else {
        return Vec::new();
    };
    let backup = path.with_extension("legacy.json");
    if let Err(error) = fs::rename(path, &backup) {
        shipflow_core::shipflow_log!(
            "[ShipFlowService] Unable to preserve legacy lookup store {}: {error}",
            path.display()
        );
    }
    entries
}

fn read_legacy_entries(path: &Path) -> Option<Vec<(String, LegacyPersistentLookupEntry)>> {
    let store = fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<LegacyPersistentLookupStoreFile>(&bytes).ok())
        .filter(|store| store.version == 1)?;
    Some(store.entries.into_iter().collect())
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
        if let Some(path) = windows_shipflow_lookup_store_path() {
            return path;
        }
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            return local_app_data
                .join(SERVICE_APP_DATA_DIR_NAME)
                .join(SERVICE_STATE_DIR_NAME)
                .join(LOOKUP_STORE_FILE_NAME);
        }
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

#[cfg(target_os = "windows")]
fn windows_shipflow_lookup_store_path() -> Option<PathBuf> {
    std::env::var_os("SHIPFLOW_WINDOWS_DATA_ROOT")
        .map(PathBuf::from)
        .map(|data_root| {
            data_root
                .join(WINDOWS_SERVICE_DATA_DIR_NAME)
                .join(SERVICE_STATE_DIR_NAME)
                .join(LOOKUP_STORE_FILE_NAME)
        })
}

#[cfg(target_os = "macos")]
fn legacy_persistent_lookup_store_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from).map(|home_dir| {
        home_dir
            .join("Library")
            .join("Application Support")
            .join(LEGACY_DESKTOP_APP_DATA_DIR_NAME)
            .join(SERVICE_STATE_DIR_NAME)
            .join(LEGACY_LOOKUP_STORE_FILE_NAME)
    })
}

#[cfg(target_os = "windows")]
fn legacy_persistent_lookup_store_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(app_data) = std::env::var_os("APPDATA").map(PathBuf::from) {
        paths.push(
            app_data
                .join(SERVICE_APP_DATA_DIR_NAME)
                .join(SERVICE_STATE_DIR_NAME)
                .join(LEGACY_LOOKUP_STORE_FILE_NAME),
        );
        paths.push(
            app_data
                .join(LEGACY_DESKTOP_APP_DATA_DIR_NAME)
                .join(SERVICE_STATE_DIR_NAME)
                .join(LEGACY_LOOKUP_STORE_FILE_NAME),
        );
    }
    paths
}

#[cfg(any(target_os = "macos", all(unix, not(target_os = "macos"))))]
fn legacy_persistent_lookup_store_paths() -> Vec<PathBuf> {
    legacy_persistent_lookup_store_path().into_iter().collect()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn legacy_persistent_lookup_store_path() -> Option<PathBuf> {
    if let Some(xdg_data_home) = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from) {
        return Some(
            xdg_data_home
                .join(LEGACY_DESKTOP_XDG_DATA_DIR_NAME)
                .join(SERVICE_STATE_DIR_NAME)
                .join(LEGACY_LOOKUP_STORE_FILE_NAME),
        );
    }
    std::env::var_os("HOME").map(PathBuf::from).map(|home_dir| {
        home_dir
            .join(".local")
            .join("share")
            .join(LEGACY_DESKTOP_XDG_DATA_DIR_NAME)
            .join(SERVICE_STATE_DIR_NAME)
            .join(LEGACY_LOOKUP_STORE_FILE_NAME)
    })
}

#[cfg(not(any(target_os = "macos", target_os = "windows", unix)))]
fn legacy_persistent_lookup_store_paths() -> Vec<PathBuf> {
    Vec::new()
}

fn expires_at_unix_ms(ttl: Duration) -> i64 {
    unix_ms().saturating_add(i64::try_from(ttl.as_millis()).unwrap_or(i64::MAX))
}

fn unix_ms() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::fs;
    use std::sync::Arc;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use super::{
        persistent_lookup_skip_reason, unix_ms, LegacyPersistentLookupEntry,
        LegacyPersistentLookupStoreFile, PersistentLookupStore, MAX_PERSISTED_LOOKUP_PAYLOAD_BYTES,
    };

    fn unique_store_path() -> std::path::PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("shipflow-persistent-store-{timestamp}.sqlite3"))
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
        store.flush();

        let reopened = PersistentLookupStore::open(path);
        assert_eq!(
            reopened.load_success("track:1").as_deref(),
            Some("{\"ok\":true}")
        );
    }

    #[test]
    fn concurrent_success_writes_remain_complete_after_reopen() {
        let path = unique_store_path();
        let store = Arc::new(PersistentLookupStore::open(path.clone()));
        let writers = (0..64)
            .map(|index| {
                let store = Arc::clone(&store);
                std::thread::spawn(move || {
                    assert!(store.store_success(
                        format!("track:{index}"),
                        format!(r#"{{"index":{index}}}"#),
                        Duration::from_secs(60),
                    ));
                })
            })
            .collect::<Vec<_>>();
        for writer in writers {
            writer.join().expect("lookup store writer should finish");
        }
        store.flush();

        let reopened = PersistentLookupStore::open(path);
        for index in 0..64 {
            assert_eq!(
                reopened.load_success(&format!("track:{index}")),
                Some(format!(r#"{{"index":{index}}}"#))
            );
        }
    }

    #[test]
    fn queued_writes_are_durable_after_flush() {
        let path = unique_store_path();
        let store = PersistentLookupStore::open(path.clone());
        for index in 0..128 {
            assert!(store.enqueue_store_success(
                format!("track:{index}"),
                format!(r#"{{"index":{index}}}"#),
                Duration::from_secs(60),
            ));
        }
        store.flush();

        let reopened = PersistentLookupStore::open(path);
        for index in 0..128 {
            assert!(reopened.load_success(&format!("track:{index}")).is_some());
        }
    }

    #[test]
    fn expired_entries_are_ignored() {
        let store = PersistentLookupStore::open(unique_store_path());
        assert!(store.store_success(
            "track:1".into(),
            "{\"ok\":true}".into(),
            Duration::from_millis(0),
        ));
        assert!(store.load_success("track:1").is_none());
    }

    #[test]
    fn skips_embedded_images_and_oversized_payloads() {
        let store = PersistentLookupStore::open(unique_store_path());
        let image_payload = r#"{"pod":{"photo1_url":"data:image/jpeg;base64,abc"}}"#;
        let large_payload = "x".repeat(MAX_PERSISTED_LOOKUP_PAYLOAD_BYTES + 1);

        assert_eq!(
            persistent_lookup_skip_reason(image_payload),
            Some("embedded_data_image")
        );
        assert_eq!(
            persistent_lookup_skip_reason(&large_payload),
            Some("payload_too_large")
        );
        assert!(!store.store_success(
            "track:image".into(),
            image_payload.into(),
            Duration::from_secs(60)
        ));
        assert!(!store.store_success("track:large".into(), large_payload, Duration::from_secs(60)));
    }

    #[test]
    fn migrates_valid_legacy_json_and_preserves_a_backup() {
        let path = unique_store_path();
        let mut entries = HashMap::new();
        entries.insert(
            "track:small".into(),
            LegacyPersistentLookupEntry {
                expires_at_unix_ms: u128::try_from(unix_ms()).unwrap_or_default()
                    + Duration::from_secs(60).as_millis(),
                payload: "{\"ok\":true}".into(),
            },
        );
        entries.insert(
            "track:image".into(),
            LegacyPersistentLookupEntry {
                expires_at_unix_ms: u128::try_from(unix_ms()).unwrap_or_default()
                    + Duration::from_secs(60).as_millis(),
                payload: r#"{"pod":{"signature_url":"data:image/png;base64,abc"}}"#.into(),
            },
        );
        fs::write(
            &path,
            serde_json::to_vec(&LegacyPersistentLookupStoreFile {
                version: 1,
                entries,
            })
            .expect("serialize legacy store"),
        )
        .expect("write legacy store");

        let store = PersistentLookupStore::open(path.clone());
        assert_eq!(
            store.load_success("track:small").as_deref(),
            Some("{\"ok\":true}")
        );
        assert!(store.load_success("track:image").is_none());
        assert!(path.with_extension("legacy.json").exists());
    }
}
