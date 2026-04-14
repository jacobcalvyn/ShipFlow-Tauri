use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use tracing::warn;

#[derive(Serialize, Deserialize)]
struct DiskEntry {
    stored_at_ms: u64,
    expires_at_ms: u64,
    body: String,
}

#[derive(Debug, Clone)]
pub struct PersistentCacheHit {
    pub stored_at_ms: u64,
    pub body: String,
}

pub struct PersistentCache {
    root: PathBuf,
    max_entries: usize,
    sweep_interval_ms: u64,
    last_sweep_ms: Mutex<u64>,
}

impl PersistentCache {
    pub fn new(
        root: impl Into<PathBuf>,
        max_entries: usize,
        sweep_interval_secs: u64,
    ) -> anyhow::Result<Self> {
        let root = root.into();
        fs::create_dir_all(&root)?;
        let cache = Self {
            root,
            max_entries: max_entries.max(1),
            sweep_interval_ms: sweep_interval_secs.saturating_mul(1000),
            last_sweep_ms: Mutex::new(0),
        };
        cache.sweep_if_due(true);
        Ok(cache)
    }

    pub fn get_fresh(&self, kind: &str, id: &str) -> Option<PersistentCacheHit> {
        self.sweep_if_due(false);
        self.get(self.entry_path(kind, "fresh", id))
    }

    pub fn set_fresh(&self, kind: &str, id: &str, body: &str, ttl_secs: u64) {
        self.set(self.entry_path(kind, "fresh", id), body, ttl_secs);
    }

    pub fn get_stale(&self, kind: &str, id: &str) -> Option<PersistentCacheHit> {
        self.sweep_if_due(false);
        self.get(self.entry_path(kind, "stale", id))
    }

    pub fn set_stale(&self, kind: &str, id: &str, body: &str, ttl_secs: u64) {
        self.set(self.entry_path(kind, "stale", id), body, ttl_secs);
    }

    fn entry_path(&self, kind: &str, tier: &str, id: &str) -> PathBuf {
        let safe_id = URL_SAFE_NO_PAD.encode(id);
        self.root
            .join(kind)
            .join(tier)
            .join(format!("{safe_id}.json"))
    }

    fn get(&self, path: PathBuf) -> Option<PersistentCacheHit> {
        let raw = fs::read_to_string(&path).ok()?;
        let entry: DiskEntry = serde_json::from_str(&raw).ok()?;

        if now_ms() > entry.expires_at_ms {
            let _ = fs::remove_file(path);
            return None;
        }

        Some(PersistentCacheHit {
            stored_at_ms: entry.stored_at_ms,
            body: entry.body,
        })
    }

    fn set(&self, path: PathBuf, body: &str, ttl_secs: u64) {
        if ttl_secs == 0 {
            return;
        }

        self.sweep_if_due(false);

        let parent = match path.parent() {
            Some(parent) => parent,
            None => return,
        };
        if let Err(err) = fs::create_dir_all(parent) {
            warn!(error = %err, "persistent cache create_dir_all failed");
            return;
        }

        let entry = DiskEntry {
            stored_at_ms: now_ms(),
            expires_at_ms: now_ms().saturating_add(ttl_secs.saturating_mul(1000)),
            body: body.to_string(),
        };
        let raw = match serde_json::to_string(&entry) {
            Ok(v) => v,
            Err(err) => {
                warn!(error = %err, "persistent cache serialize failed");
                return;
            }
        };

        // Tulis ke file temp dulu supaya write lebih atomik.
        let tmp_path = tmp_path_for(&path);
        if let Err(err) = fs::write(&tmp_path, raw) {
            warn!(error = %err, "persistent cache write failed");
            return;
        }
        if let Err(err) = fs::rename(&tmp_path, &path) {
            let _ = fs::remove_file(&tmp_path);
            warn!(error = %err, "persistent cache rename failed");
            return;
        }

        self.sweep_if_due(false);
    }

    fn sweep_if_due(&self, force: bool) {
        let now = now_ms();
        {
            let mut last_sweep_ms = self
                .last_sweep_ms
                .lock()
                .expect("persistent cache mutex should not be poisoned");
            if !force
                && self.sweep_interval_ms > 0
                && now.saturating_sub(*last_sweep_ms) < self.sweep_interval_ms
            {
                return;
            }
            *last_sweep_ms = now;
        }

        if let Err(err) = self.sweep(now) {
            warn!(error = %err, "persistent cache sweep failed");
        }
    }

    fn sweep(&self, now: u64) -> anyhow::Result<()> {
        let mut entries = Vec::new();
        collect_entry_paths(&self.root, &mut entries)?;

        let mut live_entries = Vec::new();
        for path in entries {
            if path.extension().and_then(|v| v.to_str()) == Some("tmp") {
                let _ = fs::remove_file(&path);
                continue;
            }

            let raw = match fs::read_to_string(&path) {
                Ok(raw) => raw,
                Err(err) => {
                    warn!(error = %err, path = %path.display(), "persistent cache read failed during sweep");
                    let _ = fs::remove_file(&path);
                    continue;
                }
            };

            let entry: DiskEntry = match serde_json::from_str(&raw) {
                Ok(entry) => entry,
                Err(err) => {
                    warn!(error = %err, path = %path.display(), "persistent cache deserialize failed during sweep");
                    let _ = fs::remove_file(&path);
                    continue;
                }
            };

            if now > entry.expires_at_ms {
                let _ = fs::remove_file(&path);
                continue;
            }

            live_entries.push((entry.expires_at_ms, path));
        }

        if live_entries.len() <= self.max_entries {
            return Ok(());
        }

        live_entries.sort_by(|left, right| {
            left.0
                .cmp(&right.0)
                .then_with(|| left.1.as_os_str().cmp(right.1.as_os_str()))
        });

        let overflow = live_entries.len().saturating_sub(self.max_entries);
        for (_, path) in live_entries.into_iter().take(overflow) {
            if let Err(err) = fs::remove_file(&path) {
                warn!(error = %err, path = %path.display(), "persistent cache eviction failed");
            }
        }

        Ok(())
    }
}

fn collect_entry_paths(root: &Path, out: &mut Vec<PathBuf>) -> anyhow::Result<()> {
    if !root.exists() {
        return Ok(());
    }

    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_entry_paths(&path, out)?;
        } else {
            out.push(path);
        }
    }

    Ok(())
}

fn tmp_path_for(path: &Path) -> PathBuf {
    let mut tmp = path.to_path_buf();
    tmp.set_extension("tmp");
    tmp
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

    #[test]
    fn persistent_cache_roundtrip() {
        let root = std::env::temp_dir().join(format!("scrap-pid-v3-test-{}", now_ms()));
        let cache = PersistentCache::new(&root, 100, 0).expect("cache should be created");
        cache.set_fresh("track", "P123", "<html>ok</html>", 10);
        let hit = cache.get_fresh("track", "P123");
        assert_eq!(
            hit.as_ref().map(|entry| entry.body.as_str()),
            Some("<html>ok</html>")
        );
        assert!(hit.as_ref().map(|entry| entry.stored_at_ms).unwrap_or(0) > 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn persistent_cache_evicts_when_over_limit() {
        let root = std::env::temp_dir().join(format!("scrap-pid-v3-evict-{}", now_ms()));
        let cache = PersistentCache::new(&root, 2, 0).expect("cache should be created");

        cache.set_fresh("track", "A", "<html>a</html>", 10);
        cache.set_fresh("track", "B", "<html>b</html>", 20);
        cache.set_fresh("track", "C", "<html>c</html>", 30);

        assert!(cache.get_fresh("track", "A").is_none());
        assert_eq!(
            cache
                .get_fresh("track", "B")
                .as_ref()
                .map(|entry| entry.body.as_str()),
            Some("<html>b</html>")
        );
        assert_eq!(
            cache
                .get_fresh("track", "C")
                .as_ref()
                .map(|entry| entry.body.as_str()),
            Some("<html>c</html>")
        );

        let _ = fs::remove_dir_all(root);
    }
}
