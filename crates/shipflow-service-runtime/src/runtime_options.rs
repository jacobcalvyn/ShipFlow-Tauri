use serde::{Deserialize, Serialize};
use std::{path::PathBuf, time::Duration};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct RuntimeOptions {
    pub require_persistence: bool,
    pub data_directory: Option<PathBuf>,
    pub config_id: String,
    pub http_concurrency: usize,
    pub http_queue: usize,
    pub lookup_concurrency: usize,
    pub public_concurrency: usize,
    pub lookup_queue: usize,
    pub contact_concurrency: usize,
    pub track_ttl_seconds: u64,
    pub bag_ttl_seconds: u64,
    pub manifest_ttl_seconds: u64,
    pub cache_entries: usize,
    #[serde(rename = "cacheMiB")]
    pub cache_mib: usize,
    pub persistent_entries: usize,
}
impl Default for RuntimeOptions {
    fn default() -> Self {
        Self {
            require_persistence: false,
            data_directory: None,
            config_id: String::new(),
            http_concurrency: 128,
            http_queue: 512,
            lookup_concurrency: 30,
            public_concurrency: 24,
            lookup_queue: 240,
            contact_concurrency: 15,
            track_ttl_seconds: 30,
            bag_ttl_seconds: 60,
            manifest_ttl_seconds: 90,
            cache_entries: 10_000,
            cache_mib: 128,
            persistent_entries: 2_000,
        }
    }
}
impl RuntimeOptions {
    pub fn validate(&self) -> Result<(), String> {
        for (name, value, max) in [
            ("httpConcurrency", self.http_concurrency, 512),
            ("httpQueue", self.http_queue, 4096),
            ("lookupConcurrency", self.lookup_concurrency, 100),
            ("publicConcurrency", self.public_concurrency, 100),
            ("lookupQueue", self.lookup_queue, 2000),
            ("contactConcurrency", self.contact_concurrency, 50),
            ("cacheEntries", self.cache_entries, 100_000),
            ("cacheMiB", self.cache_mib, 1024),
            ("persistentEntries", self.persistent_entries, 100_000),
        ] {
            if value == 0 || value > max {
                return Err(format!("{name} must be between 1 and {max}."));
            }
        }
        if self.public_concurrency > self.lookup_concurrency
            || self.http_concurrency < self.public_concurrency
        {
            return Err("Public concurrency must fit both HTTP and upstream concurrency.".into());
        }
        for ttl in [
            self.track_ttl_seconds,
            self.bag_ttl_seconds,
            self.manifest_ttl_seconds,
        ] {
            if !(1..=86400).contains(&ttl) {
                return Err("Cache TTL must be between 1 and 86400 seconds.".into());
            }
        }
        if self.require_persistence
            && self
                .data_directory
                .as_ref()
                .is_none_or(|p| !p.is_absolute())
        {
            return Err(
                "An absolute dataDirectory is required for persistent service mode.".into(),
            );
        }
        if self.config_id.len() > 128 {
            return Err("Invalid configuration identity.".into());
        }
        Ok(())
    }
    pub fn lookup_wait(&self) -> Duration {
        Duration::from_secs(60)
    }
}

/// A committed write probe distinguishes a readable database from writable persistence.
pub fn probe_storage(connection: &mut rusqlite::Connection) -> Result<(), String> {
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    transaction.execute_batch("CREATE TABLE IF NOT EXISTS shipflow_storage_probe (id INTEGER PRIMARY KEY, value INTEGER NOT NULL); INSERT INTO shipflow_storage_probe VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET value = value + 1;")
        .map_err(|e| e.to_string())?;
    transaction.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_the_desktop_cache_mib_configuration_field() {
        let options: RuntimeOptions = serde_json::from_value(serde_json::json!({"cacheMiB": 256}))
            .expect("desktop Docker configuration must deserialize");
        assert_eq!(options.cache_mib, 256);
        assert_eq!(serde_json::to_value(options).unwrap()["cacheMiB"], 256);
    }

    #[test]
    fn validates_limits_and_required_storage() {
        assert!(RuntimeOptions::default().validate().is_ok());
        assert!(RuntimeOptions {
            public_concurrency: 31,
            ..Default::default()
        }
        .validate()
        .is_err());
        assert!(RuntimeOptions {
            require_persistence: true,
            ..Default::default()
        }
        .validate()
        .is_err());
        assert!(RuntimeOptions {
            track_ttl_seconds: 0,
            ..Default::default()
        }
        .validate()
        .is_err());
    }
}
