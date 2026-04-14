use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, RwLock, RwLockReadGuard},
};

use anyhow::{Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::Rng;
use serde::{Deserialize, Serialize};

use crate::auth::{
    build_token_lookup, ApiTokenConfig, ApiTokenMetadata, ApiTokenRecord, ApiTokenRevocationState,
};

const MANAGED_TOKEN_STORE_FILE_VERSION: u32 = 1;

pub struct ManagedTokenStore {
    path: PathBuf,
    write_lock: Mutex<()>,
    inner: RwLock<ManagedTokenStoreState>,
}

#[derive(Default)]
struct ManagedTokenStoreState {
    by_id: BTreeMap<String, ManagedTokenRecord>,
    secret_to_id: HashMap<String, String>,
}

struct ManagedTokenRecord {
    secret: String,
    record: Arc<ApiTokenRecord>,
}

#[derive(Debug, Clone)]
pub struct ManagedTokenCreateSpec {
    pub token_id: String,
    pub label: Option<String>,
    pub scopes: BTreeSet<String>,
    pub metadata: ApiTokenMetadata,
}

#[derive(Debug, Clone)]
pub struct ManagedTokenIssuedSecret {
    pub token: String,
    pub record: Arc<ApiTokenRecord>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PersistedManagedTokenFile {
    version: u32,
    updated_at_ms: u64,
    #[serde(default)]
    tokens: Vec<PersistedManagedTokenEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedManagedTokenEntry {
    token: String,
    token_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    scopes: BTreeSet<String>,
    #[serde(default)]
    metadata: ApiTokenMetadata,
    #[serde(default)]
    revocation_state: ApiTokenRevocationState,
}

impl ManagedTokenStore {
    pub fn load(path: impl Into<PathBuf>) -> Result<Self> {
        let path = path.into();
        let state = load_state_from_path(&path)?;
        Ok(Self {
            path,
            write_lock: Mutex::new(()),
            inner: RwLock::new(state),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn read_state(&self) -> RwLockReadGuard<'_, ManagedTokenStoreState> {
        recover_read(&self.inner)
    }

    pub fn validate_against_static(
        &self,
        static_lookup: &HashMap<String, ApiTokenRecord>,
    ) -> Result<()> {
        let static_ids: HashSet<String> = static_lookup
            .values()
            .map(|record| record.token_id.clone())
            .collect();
        let state = self.read_state();
        for (token_id, managed) in &state.by_id {
            if static_ids.contains(token_id) {
                anyhow::bail!(
                    "managed API token id conflicts with static token id: {}",
                    token_id
                );
            }
            if static_lookup.contains_key(&managed.secret) {
                anyhow::bail!(
                    "managed API token secret conflicts with static token secret for token_id {}",
                    token_id
                );
            }
        }
        Ok(())
    }

    pub fn list_records(&self) -> Vec<Arc<ApiTokenRecord>> {
        self.read_state()
            .by_id
            .values()
            .map(|managed| Arc::clone(&managed.record))
            .collect()
    }

    pub fn get_by_secret(&self, secret: &str) -> Option<Arc<ApiTokenRecord>> {
        let state = self.read_state();
        let token_id = state.secret_to_id.get(secret)?;
        Some(Arc::clone(&state.by_id.get(token_id)?.record))
    }

    pub fn find_by_id(&self, token_id: &str) -> Option<Arc<ApiTokenRecord>> {
        Some(Arc::clone(&self.read_state().by_id.get(token_id)?.record))
    }

    pub fn contains_token_id(&self, token_id: &str) -> bool {
        self.read_state().by_id.contains_key(token_id)
    }

    pub fn create_token(
        &self,
        spec: ManagedTokenCreateSpec,
        static_lookup: &HashMap<String, ApiTokenRecord>,
    ) -> Result<ManagedTokenIssuedSecret> {
        let _guard = lock_mutex(&self.write_lock);
        let mut state = self
            .inner
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        if state.by_id.contains_key(&spec.token_id) {
            anyhow::bail!("managed token_id already exists: {}", spec.token_id);
        }

        let token = generate_unique_token(&state, static_lookup)?;
        let persisted = PersistedManagedTokenEntry {
            token: token.clone(),
            token_id: spec.token_id.clone(),
            label: spec.label.clone(),
            scopes: spec.scopes.clone(),
            metadata: spec.metadata.clone(),
            revocation_state: ApiTokenRevocationState::default(),
        };
        let managed_record = build_managed_record(&persisted)?;
        state
            .secret_to_id
            .insert(token.clone(), persisted.token_id.clone());
        state
            .by_id
            .insert(persisted.token_id.clone(), managed_record);

        if let Err(error) = persist_state_to_path(&self.path, &state) {
            state.by_id.remove(&spec.token_id);
            state.secret_to_id.remove(&token);
            return Err(error);
        }

        let record = Arc::clone(
            &state
                .by_id
                .get(&spec.token_id)
                .expect("managed token should exist after create")
                .record,
        );
        Ok(ManagedTokenIssuedSecret { token, record })
    }

    pub fn rotate_token_secret(
        &self,
        token_id: &str,
        static_lookup: &HashMap<String, ApiTokenRecord>,
    ) -> Result<ManagedTokenIssuedSecret> {
        let _guard = lock_mutex(&self.write_lock);
        let mut state = self
            .inner
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let Some(previous) = state.by_id.get(token_id) else {
            anyhow::bail!("managed token_id not found: {}", token_id);
        };

        let replacement_token = generate_unique_token(&state, static_lookup)?;
        let replacement_entry = PersistedManagedTokenEntry {
            token: replacement_token.clone(),
            token_id: previous.record.token_id.clone(),
            label: previous.record.label.clone(),
            scopes: previous.record.scopes.clone(),
            metadata: previous.record.metadata.clone(),
            revocation_state: ApiTokenRevocationState::default(),
        };
        let replacement_record = build_managed_record(&replacement_entry)?;

        let old = state
            .by_id
            .insert(token_id.to_string(), replacement_record)
            .expect("managed token should exist before rotate");
        state.secret_to_id.remove(&old.secret);
        state
            .secret_to_id
            .insert(replacement_token.clone(), token_id.to_string());

        if let Err(error) = persist_state_to_path(&self.path, &state) {
            state.secret_to_id.remove(&replacement_token);
            state
                .secret_to_id
                .insert(old.secret.clone(), token_id.to_string());
            state.by_id.insert(token_id.to_string(), old);
            return Err(error);
        }

        let record = Arc::clone(
            &state
                .by_id
                .get(token_id)
                .expect("managed token should exist after rotate")
                .record,
        );
        Ok(ManagedTokenIssuedSecret {
            token: replacement_token,
            record,
        })
    }

    pub fn persist_current_state(&self) -> Result<()> {
        let _guard = lock_mutex(&self.write_lock);
        let state = self.read_state();
        persist_state_to_path(&self.path, &state)
    }
}

fn load_state_from_path(path: &Path) -> Result<ManagedTokenStoreState> {
    if !path.exists() {
        return Ok(ManagedTokenStoreState::default());
    }

    let raw = fs::read_to_string(path)
        .with_context(|| format!("failed to read managed API token store: {}", path.display()))?;
    let persisted: PersistedManagedTokenFile = serde_json::from_str(&raw).with_context(|| {
        format!(
            "failed to parse managed API token store as JSON: {}",
            path.display()
        )
    })?;

    if persisted.version != MANAGED_TOKEN_STORE_FILE_VERSION {
        anyhow::bail!(
            "unsupported managed API token store version {} (expected {})",
            persisted.version,
            MANAGED_TOKEN_STORE_FILE_VERSION
        );
    }

    let mut by_id = BTreeMap::new();
    let mut secret_to_id = HashMap::new();
    for entry in persisted.tokens {
        if by_id.contains_key(&entry.token_id) {
            anyhow::bail!("duplicate managed token_id in store: {}", entry.token_id);
        }
        if secret_to_id.contains_key(&entry.token) {
            anyhow::bail!("duplicate managed token secret in store");
        }
        let managed = build_managed_record(&entry)?;
        secret_to_id.insert(entry.token.clone(), entry.token_id.clone());
        by_id.insert(entry.token_id.clone(), managed);
    }

    Ok(ManagedTokenStoreState {
        by_id,
        secret_to_id,
    })
}

fn persist_state_to_path(path: &Path, state: &ManagedTokenStoreState) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "failed to create managed API token store directory: {}",
                parent.display()
            )
        })?;
    }

    let persisted = PersistedManagedTokenFile {
        version: MANAGED_TOKEN_STORE_FILE_VERSION,
        updated_at_ms: current_time_ms(),
        tokens: state
            .by_id
            .values()
            .map(|managed| PersistedManagedTokenEntry {
                token: managed.secret.clone(),
                token_id: managed.record.token_id.clone(),
                label: managed.record.label.clone(),
                scopes: managed.record.scopes.clone(),
                metadata: managed.record.metadata.clone(),
                revocation_state: managed.record.revocation_state(),
            })
            .collect(),
    };

    let payload = serde_json::to_vec_pretty(&persisted)
        .context("failed to serialize managed API token store payload")?;
    let temp_path = path.with_extension("tmp");
    fs::write(&temp_path, payload).with_context(|| {
        format!(
            "failed to write temporary managed API token store: {}",
            temp_path.display()
        )
    })?;

    if let Err(error) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(error).with_context(|| {
            format!(
                "failed to replace managed API token store atomically: {}",
                path.display()
            )
        });
    }

    Ok(())
}

fn build_managed_record(entry: &PersistedManagedTokenEntry) -> Result<ManagedTokenRecord> {
    let config = ApiTokenConfig::managed_with_metadata(
        entry.token.clone(),
        entry.token_id.clone(),
        entry.label.clone(),
        entry.scopes.iter().cloned(),
        entry.metadata.clone(),
    );
    let mut lookup = build_token_lookup(&[config]);
    let record = lookup
        .remove(&entry.token)
        .ok_or_else(|| anyhow::anyhow!("failed to build managed token lookup entry"))?;
    record.apply_revocation_state(&entry.revocation_state);

    Ok(ManagedTokenRecord {
        secret: entry.token.clone(),
        record: Arc::new(record),
    })
}

fn generate_unique_token(
    state: &ManagedTokenStoreState,
    static_lookup: &HashMap<String, ApiTokenRecord>,
) -> Result<String> {
    for _ in 0..32 {
        let candidate = generate_token_secret();
        if !state.secret_to_id.contains_key(&candidate) && !static_lookup.contains_key(&candidate) {
            return Ok(candidate);
        }
    }

    anyhow::bail!("failed to generate a unique managed API token secret")
}

fn generate_token_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill(&mut bytes);
    format!("mt_{}", URL_SAFE_NO_PAD.encode(bytes))
}

fn current_time_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn lock_mutex<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn recover_read<T>(lock: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, fs, path::PathBuf};

    use super::{current_time_ms, ManagedTokenCreateSpec, ManagedTokenStore};
    use crate::auth::{ApiTokenMetadata, SCOPE_TRACKING_READ};

    fn unique_store_file(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "scrap-pid-v3-managed-token-store-{name}-{}.json",
            current_time_ms()
        ))
    }

    #[test]
    fn managed_token_store_create_and_reload_roundtrip() {
        let path = unique_store_file("roundtrip");
        let store = ManagedTokenStore::load(&path).expect("store should load");
        let issued = store
            .create_token(
                ManagedTokenCreateSpec {
                    token_id: "partner-managed".to_string(),
                    label: Some("Partner Managed".to_string()),
                    scopes: [SCOPE_TRACKING_READ.to_string()].into_iter().collect(),
                    metadata: ApiTokenMetadata::default(),
                },
                &HashMap::new(),
            )
            .expect("managed token should be created");

        assert!(issued.token.starts_with("mt_"));
        assert_eq!(issued.record.token_id, "partner-managed");

        let reloaded = ManagedTokenStore::load(&path).expect("store should reload");
        let record = reloaded
            .get_by_secret(&issued.token)
            .expect("token should be available after reload");
        assert_eq!(record.token_id, "partner-managed");

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn managed_token_store_rotate_invalidates_old_secret() {
        let path = unique_store_file("rotate");
        let store = ManagedTokenStore::load(&path).expect("store should load");
        let issued = store
            .create_token(
                ManagedTokenCreateSpec {
                    token_id: "managed-ops".to_string(),
                    label: None,
                    scopes: [SCOPE_TRACKING_READ.to_string()].into_iter().collect(),
                    metadata: ApiTokenMetadata::default(),
                },
                &HashMap::new(),
            )
            .expect("managed token should be created");

        let rotated = store
            .rotate_token_secret("managed-ops", &HashMap::new())
            .expect("managed token should rotate");

        assert_ne!(issued.token, rotated.token);
        assert!(store.get_by_secret(&issued.token).is_none());
        assert!(store.get_by_secret(&rotated.token).is_some());

        let _ = fs::remove_file(&path);
    }
}
