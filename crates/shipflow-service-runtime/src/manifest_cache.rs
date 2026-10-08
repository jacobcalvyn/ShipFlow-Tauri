//! Validated Print snapshots share the persistent metadata store with bag labels.
use rusqlite::{params, Connection, OptionalExtension};
use shipflow_core::model::{BagRoute, ManifestResponse};

use crate::bag_route_cache::BagRouteCacheState;

const RETENTION_MS: i64 = 90 * 24 * 60 * 60 * 1000;
const REFRESH_MS: i64 = 24 * 60 * 60 * 1000;
const MAX_SNAPSHOTS: i64 = 1_000;
const MAX_SNAPSHOT_BYTES: usize = 8 * 1024 * 1024;
const MAX_STORE_BYTES: i64 = 64 * 1024 * 1024;

pub(crate) fn initialize_database(connection: &Connection) -> Result<(), String> {
    connection.execute_batch("PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS manifest_print_cache (
            manifest_id TEXT PRIMARY KEY NOT NULL,
            response_json TEXT NOT NULL,
            fetched_at_unix_ms INTEGER NOT NULL,
            manifest_date TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS manifest_print_bags (
            manifest_id TEXT NOT NULL REFERENCES manifest_print_cache(manifest_id) ON DELETE CASCADE,
            bag_id TEXT NOT NULL,
            route_json TEXT NOT NULL,
            PRIMARY KEY(manifest_id, bag_id)
        );
        CREATE INDEX IF NOT EXISTS idx_manifest_print_bag_id ON manifest_print_bags(bag_id);")
        .map_err(|error| format!("Unable to initialize manifest snapshot store: {error}"))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

impl BagRouteCacheState {
    pub async fn get_manifest_async(&self, manifest_id: &str) -> Option<ManifestResponse> {
        let state = self.clone();
        let id = manifest_id.to_owned();
        tokio::task::spawn_blocking(move || {
            let connection = state.connection.lock().expect("metadata cache connection lock poisoned");
            let stored = connection.query_row("SELECT response_json, fetched_at_unix_ms FROM manifest_print_cache WHERE manifest_id = ?1 AND fetched_at_unix_ms > ?2", params![id, now_ms() - RETENTION_MS], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))).optional().map_err(|error| error.to_string())?;
            let Some((json, fetched_at)) = stored else { return Ok(None); };
            let mut snapshot: ManifestResponse = serde_json::from_str(&json).map_err(|error| error.to_string())?;
            let detail = snapshot.manifest_detail.as_mut().ok_or("Missing manifest snapshot metadata")?;
            if !detail.nomor_manifest.eq_ignore_ascii_case(&id) { return Err("Manifest snapshot identity mismatch".to_owned()); }
            detail.cache_status = if now_ms().saturating_sub(fetched_at) >= REFRESH_MS { "stale" } else { "cache_hit" }.into();
            Ok(Some(snapshot))
        }).await.unwrap_or_else(|error| Err(error.to_string())).unwrap_or_else(|error| {
            shipflow_core::shipflow_log!("[ShipFlowManifestCache] read_failed id={manifest_id} error={error}");
            None
        })
    }

    pub async fn store_manifest_async(
        &self,
        manifest_id: &str,
        snapshot: &ManifestResponse,
    ) -> Result<(), String> {
        let state = self.clone();
        let id = manifest_id.to_owned();
        let snapshot = snapshot.clone();
        tokio::task::spawn_blocking(move || {
            let detail = snapshot.manifest_detail.as_ref().ok_or("Missing Print metadata")?;
            if !detail.nomor_manifest.eq_ignore_ascii_case(&id) || detail.jumlah_kantung != snapshot.items.len() { return Err("Invalid manifest snapshot identity or count".to_owned()); }
            let json = serde_json::to_string(&snapshot).map_err(|error| error.to_string())?;
            if json.len() > MAX_SNAPSHOT_BYTES { return Err("Manifest snapshot exceeds the size limit".to_owned()); }
            let mut connection = state.connection.lock().expect("metadata cache connection lock poisoned");
            let transaction = connection.transaction().map_err(|error| error.to_string())?;
            transaction.execute("INSERT INTO manifest_print_cache (manifest_id, response_json, fetched_at_unix_ms, manifest_date) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(manifest_id) DO UPDATE SET response_json=excluded.response_json, fetched_at_unix_ms=excluded.fetched_at_unix_ms, manifest_date=excluded.manifest_date", params![id, json, now_ms(), detail.tanggal.as_deref().unwrap_or_default()]).map_err(|error| error.to_string())?;
            transaction.execute("DELETE FROM manifest_print_bags WHERE manifest_id = ?1", params![id]).map_err(|error| error.to_string())?;
            for item in &snapshot.items {
                let bag_id = item.nomor_kantung.as_deref().ok_or("Missing snapshot bag identifier")?;
                let route = BagRoute { nomor_kantung: bag_id.to_owned(), lokasi_asal: item.lokasi_asal.clone(), tujuan: item.tujuan.clone(), url: detail.source_url.clone() };
                transaction.execute("INSERT INTO manifest_print_bags (manifest_id, bag_id, route_json) VALUES (?1, ?2, ?3)", params![id, bag_id, serde_json::to_string(&route).map_err(|error| error.to_string())?]).map_err(|error| error.to_string())?;
            }
            transaction.execute("DELETE FROM manifest_print_cache WHERE fetched_at_unix_ms <= ?1", params![now_ms() - RETENTION_MS]).map_err(|error| error.to_string())?;
            loop {
                let (count, bytes): (i64, i64) = transaction.query_row("SELECT COUNT(*), COALESCE(SUM(LENGTH(CAST(response_json AS BLOB))), 0) FROM manifest_print_cache", [], |row| Ok((row.get(0)?, row.get(1)?))).map_err(|error| error.to_string())?;
                if count <= MAX_SNAPSHOTS && bytes <= MAX_STORE_BYTES { break; }
                transaction.execute("DELETE FROM manifest_print_cache WHERE manifest_id IN (SELECT manifest_id FROM manifest_print_cache ORDER BY fetched_at_unix_ms ASC LIMIT 1)", []).map_err(|error| error.to_string())?;
            }
            transaction.commit().map_err(|error| error.to_string())
        }).await.map_err(|error| error.to_string())?
    }

    pub async fn get_manifest_bag_route_async(&self, bag_id: &str) -> Option<BagRoute> {
        let state = self.clone();
        let id = bag_id.to_owned();
        tokio::task::spawn_blocking(move || {
            let connection = state.connection.lock().expect("metadata cache connection lock poisoned");
            let json = connection.query_row("SELECT bags.route_json FROM manifest_print_bags bags JOIN manifest_print_cache manifests USING(manifest_id) WHERE bags.bag_id = ?1 AND manifests.fetched_at_unix_ms > ?2 ORDER BY manifests.manifest_date DESC, manifests.fetched_at_unix_ms DESC LIMIT 1", params![id, now_ms() - RETENTION_MS], |row| row.get::<_, String>(0)).optional().map_err(|error| error.to_string())?;
            json.map(|json| serde_json::from_str::<BagRoute>(&json).map_err(|error| error.to_string())).transpose()
        }).await.unwrap_or_else(|error| Err(error.to_string())).unwrap_or_else(|error| {
            shipflow_core::shipflow_log!("[ShipFlowManifestCache] bag_route_read_failed id={bag_id} error={error}");
            None
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "P20260929082013165";
    const URL: &str = "https://posindo.mile.app/manifestR7/print?taskId=8932c2f5a5706c9c8224";

    fn snapshot() -> ManifestResponse {
        let mut response = shipflow_core::manifest_print::parse_manifest_print_html(
            include_str!("../../shipflow-core/tests/fixtures/mile_manifest_print.html"),
            URL,
            ID,
            10,
        )
        .unwrap();
        response.manifest_detail.as_mut().unwrap().fetched_at =
            crate::api_contract::generated_at_iso8601();
        response
    }

    fn path(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "shipflow-manifest-{label}-{}-{}.sqlite3",
            std::process::id(),
            now_ms()
        ))
    }

    #[tokio::test]
    async fn persists_snapshots_and_indexes_individual_bag_routes() {
        let path = path("reopen");
        let cache = BagRouteCacheState::open(path.clone());
        let original = snapshot();
        cache.store_manifest_async(ID, &original).await.unwrap();
        drop(cache);
        let reopened = BagRouteCacheState::open(path.clone());
        let response = reopened.get_manifest_async(ID).await.unwrap();
        let detail = response.manifest_detail.unwrap();
        assert_eq!(detail.cache_status, "cache_hit");
        assert_eq!(
            detail.fetched_at,
            original.manifest_detail.unwrap().fetched_at
        );
        let route = reopened
            .get_manifest_bag_route_async("PID108157373")
            .await
            .unwrap();
        assert_eq!(route.lokasi_asal.as_deref(), Some("SPP JAYAPURA 99100"));
        assert_eq!(route.tujuan.as_deref(), Some("LE MUARA TAMI 99351D1"));
        assert_ne!(route.tujuan.as_deref(), Some("DC JAYAPURA 9910A"));
        drop(reopened);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn replacement_removes_obsolete_bag_links_and_failed_write_keeps_snapshot() {
        let path = path("replacement");
        let cache = BagRouteCacheState::open(path.clone());
        let mut updated = snapshot();
        cache.store_manifest_async(ID, &updated).await.unwrap();
        updated.items[0].nomor_kantung = Some("PID999999999".into());
        cache.store_manifest_async(ID, &updated).await.unwrap();
        assert!(cache
            .get_manifest_bag_route_async("PID108132707")
            .await
            .is_none());
        assert!(cache
            .get_manifest_bag_route_async("PID999999999")
            .await
            .is_some());
        updated.items[0].nomor_kantung = None;
        assert!(cache.store_manifest_async(ID, &updated).await.is_err());
        assert!(cache
            .get_manifest_bag_route_async("PID999999999")
            .await
            .is_some());
        assert!(cache.get_manifest_async(ID).await.is_some());
        drop(cache);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn expired_snapshots_do_not_supply_routes_and_old_snapshots_are_marked_stale() {
        let path = path("expiry");
        let cache = BagRouteCacheState::open(path.clone());
        cache.store_manifest_async(ID, &snapshot()).await.unwrap();
        cache
            .connection
            .lock()
            .unwrap()
            .execute(
                "UPDATE manifest_print_cache SET fetched_at_unix_ms=?1",
                [now_ms() - REFRESH_MS - 1],
            )
            .unwrap();
        assert_eq!(
            cache
                .get_manifest_async(ID)
                .await
                .unwrap()
                .manifest_detail
                .unwrap()
                .cache_status,
            "stale"
        );
        cache
            .connection
            .lock()
            .unwrap()
            .execute(
                "UPDATE manifest_print_cache SET fetched_at_unix_ms=?1",
                [now_ms() - RETENTION_MS - 1],
            )
            .unwrap();
        assert!(cache.get_manifest_async(ID).await.is_none());
        assert!(cache
            .get_manifest_bag_route_async("PID108157373")
            .await
            .is_none());
        drop(cache);
        let _ = std::fs::remove_file(path);
    }
}
