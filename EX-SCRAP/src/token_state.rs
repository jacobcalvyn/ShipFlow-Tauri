use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::auth::{find_token_record_by_id, ApiTokenRecord, ApiTokenRevocationState};

const TOKEN_STATE_FILE_VERSION: u32 = 1;

#[derive(Debug)]
pub struct TokenStateStore {
    path: PathBuf,
    write_lock: Mutex<()>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PersistedTokenStateFile {
    version: u32,
    updated_at_ms: u64,
    #[serde(default)]
    revoked_tokens: BTreeMap<String, ApiTokenRevocationState>,
}

impl TokenStateStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            write_lock: Mutex::new(()),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load_into_lookup(&self, lookup: &HashMap<String, ApiTokenRecord>) -> Result<()> {
        if !self.path.exists() {
            return Ok(());
        }

        let raw = fs::read_to_string(&self.path).with_context(|| {
            format!(
                "failed to read API token state file: {}",
                self.path.display()
            )
        })?;
        let persisted: PersistedTokenStateFile = serde_json::from_str(&raw).with_context(|| {
            format!(
                "failed to parse API token state file as JSON: {}",
                self.path.display()
            )
        })?;

        if persisted.version != TOKEN_STATE_FILE_VERSION {
            anyhow::bail!(
                "unsupported API token state file version {} (expected {})",
                persisted.version,
                TOKEN_STATE_FILE_VERSION
            );
        }

        for (token_id, state) in persisted.revoked_tokens {
            let Some(record) = find_token_record_by_id(lookup, &token_id) else {
                continue;
            };
            record.apply_revocation_state(&state);
        }

        Ok(())
    }

    pub fn persist_lookup(&self, lookup: &HashMap<String, ApiTokenRecord>) -> Result<()> {
        let _guard = match self.write_lock.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };

        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!(
                    "failed to create API token state directory: {}",
                    parent.display()
                )
            })?;
        }

        let persisted = PersistedTokenStateFile {
            version: TOKEN_STATE_FILE_VERSION,
            updated_at_ms: current_time_ms(),
            revoked_tokens: lookup
                .values()
                .filter_map(|record| {
                    let state = record.revocation_state();
                    state.is_revoked().then(|| (record.token_id.clone(), state))
                })
                .collect(),
        };

        let payload = serde_json::to_vec_pretty(&persisted)
            .context("failed to serialize API token state file payload")?;
        let temp_path = self.path.with_extension("tmp");
        fs::write(&temp_path, payload).with_context(|| {
            format!(
                "failed to write temporary API token state file: {}",
                temp_path.display()
            )
        })?;

        if let Err(error) = fs::rename(&temp_path, &self.path) {
            let _ = fs::remove_file(&temp_path);
            return Err(error).with_context(|| {
                format!(
                    "failed to replace API token state file atomically: {}",
                    self.path.display()
                )
            });
        }

        Ok(())
    }
}

fn current_time_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, fs, path::PathBuf};

    use super::{current_time_ms, TokenStateStore};
    use crate::auth::{build_token_lookup, ApiTokenConfig};

    fn unique_state_file(name: &str) -> PathBuf {
        let now_ms = current_time_ms();
        std::env::temp_dir().join(format!("scrap-pid-v3-{name}-{now_ms}.json"))
    }

    #[test]
    fn token_state_store_roundtrip_revoked_tokens_only() {
        let path = unique_state_file("token-state");
        let tokens = vec![
            ApiTokenConfig::legacy_full_access("secret-a", "legacy-a"),
            ApiTokenConfig::legacy_full_access("secret-b", "legacy-b"),
        ];
        let lookup = build_token_lookup(&tokens);
        let record = lookup
            .get("secret-a")
            .expect("first token should exist in lookup");
        record.revoke(
            1_700_000_000_123,
            Some("admin-ops".to_string()),
            Some("suspected leak".to_string()),
            Some("legacy-b".to_string()),
        );

        let store = TokenStateStore::new(&path);
        store
            .persist_lookup(&lookup)
            .expect("token state should persist");

        let restored_lookup = build_token_lookup(&tokens);
        store
            .load_into_lookup(&restored_lookup)
            .expect("token state should reload");

        assert!(restored_lookup
            .get("secret-a")
            .expect("token should exist")
            .is_revoked());
        assert_eq!(
            restored_lookup
                .get("secret-a")
                .expect("token should exist")
                .revoke_reason()
                .as_deref(),
            Some("suspected leak")
        );
        assert!(!restored_lookup
            .get("secret-b")
            .expect("second token should exist")
            .is_revoked());

        let raw = fs::read_to_string(&path).expect("state file should be readable");
        let persisted: serde_json::Value =
            serde_json::from_str(&raw).expect("state file should contain valid JSON");
        assert!(persisted["revoked_tokens"]["legacy-a"].is_object());
        assert!(persisted["revoked_tokens"]["legacy-b"].is_null());

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn token_state_store_ignores_unknown_token_ids_on_reload() {
        let path = unique_state_file("token-state-unknown");
        fs::write(
            &path,
            r#"{"version":1,"updated_at_ms":1,"revoked_tokens":{"unknown-token":{"revoked_at_ms":2}}}"#,
        )
        .expect("fixture file should be written");

        let lookup =
            build_token_lookup(&[ApiTokenConfig::legacy_full_access("secret-a", "legacy-a")]);
        let store = TokenStateStore::new(&path);
        store
            .load_into_lookup(&lookup)
            .expect("unknown token ids should be ignored");
        assert!(!lookup
            .get("secret-a")
            .expect("token should exist")
            .is_revoked());

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn token_state_store_rejects_invalid_version() {
        let path = unique_state_file("token-state-invalid-version");
        fs::write(
            &path,
            r#"{"version":99,"updated_at_ms":1,"revoked_tokens":{}}"#,
        )
        .expect("fixture file should be written");

        let lookup = HashMap::new();
        let store = TokenStateStore::new(&path);
        let error = store
            .load_into_lookup(&lookup)
            .expect_err("invalid version should fail");
        assert!(error
            .to_string()
            .contains("unsupported API token state file version"));

        let _ = fs::remove_file(&path);
    }
}
