use std::error::Error;
use std::fmt::{Display, Formatter};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobAddress {
    pub id: String,
    pub sha256: String,
    pub media_type: String,
    pub byte_len: u64,
    pub relative_path: String,
}

#[derive(Debug)]
pub enum BlobStoreError {
    Io(std::io::Error),
}

impl Display for BlobStoreError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "blob store io error: {error}"),
        }
    }
}

impl Error for BlobStoreError {}

impl From<std::io::Error> for BlobStoreError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

pub fn address_blob(bytes: &[u8], media_type: &str) -> BlobAddress {
    let mut hasher = Sha256::new();
    hasher.update(media_type.as_bytes());
    hasher.update([0]);
    hasher.update(bytes);
    let sha256 = hex::encode(hasher.finalize());
    let extension = extension_for_media_type(media_type);
    let prefix = &sha256[..2];
    let relative_path = format!("blobs/{prefix}/{sha256}.{extension}");

    BlobAddress {
        id: sha256.clone(),
        sha256,
        media_type: media_type.to_string(),
        byte_len: bytes.len() as u64,
        relative_path,
    }
}

pub fn write_blob(
    root: &Path,
    bytes: &[u8],
    media_type: &str,
) -> Result<BlobAddress, BlobStoreError> {
    let address = address_blob(bytes, media_type);
    let path = absolute_blob_path(root, &address);
    if path.exists() {
        return Ok(address);
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let temp_path =
        path.with_file_name(format!(".{}.{}.tmp", address.sha256, unique_temp_suffix()));
    std::fs::write(&temp_path, bytes)?;

    match std::fs::rename(&temp_path, &path) {
        Ok(()) => Ok(address),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let _ = std::fs::remove_file(&temp_path);
            Ok(address)
        }
        Err(error) => {
            let _ = std::fs::remove_file(&temp_path);
            Err(error.into())
        }
    }
}

pub fn absolute_blob_path(root: &Path, address: &BlobAddress) -> PathBuf {
    address
        .relative_path
        .split('/')
        .fold(root.to_path_buf(), |path, segment| path.join(segment))
}

fn unique_temp_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{}-{nanos}", std::process::id())
}

fn extension_for_media_type(media_type: &str) -> &'static str {
    match media_type {
        "text/html" => "html",
        "application/json" => "json",
        _ => "bin",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_address_is_content_and_media_type_addressed() {
        let html_address = address_blob(b"<html></html>", "text/html");
        let json_address = address_blob(b"<html></html>", "application/json");

        assert_ne!(html_address.id, json_address.id);
        assert!(html_address.relative_path.starts_with("blobs/"));
        assert!(html_address.relative_path.ends_with(".html"));
        assert_eq!(html_address.byte_len, 13);
    }

    #[test]
    fn absolute_path_uses_relative_blob_segments() {
        let address = address_blob(br#"{"ok":true}"#, "application/json");
        let path = absolute_blob_path(Path::new("/workspace-data"), &address);

        assert!(path.ends_with(
            address
                .relative_path
                .replace('/', std::path::MAIN_SEPARATOR_STR)
        ));
    }

    #[test]
    fn write_blob_writes_content_addressed_file_once() {
        let root = std::env::temp_dir().join(format!(
            "shipflow-workspace-blob-test-{}",
            unique_temp_suffix()
        ));
        let address =
            write_blob(&root, br#"{"ok":true}"#, "application/json").expect("blob is written");
        let path = absolute_blob_path(&root, &address);

        assert!(path.exists());
        assert_eq!(
            std::fs::read(&path).expect("blob content is readable"),
            br#"{"ok":true}"#
        );

        let duplicate = write_blob(&root, br#"{"ok":true}"#, "application/json")
            .expect("duplicate write is idempotent");
        assert_eq!(duplicate, address);

        let _ = std::fs::remove_dir_all(root);
    }
}
