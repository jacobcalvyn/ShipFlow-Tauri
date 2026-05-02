use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use super::{paths::ensure_service_state_dir, set_user_only_permissions};

static STATE_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[cfg(target_os = "windows")]
fn replace_state_file_windows(
    path: PathBuf,
    temp_path: PathBuf,
    label: &str,
) -> Result<(), String> {
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
                return Err(format!("Unable to finalize {label}: {error}"));
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
                return Err(format!("Unable to prepare {label} replacement: {error}"));
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
                return Err(format!("Unable to finalize {label}: {error}"));
            }
        }
    }

    let _ = fs::remove_file(&temp_path);
    if last_error.is_empty() {
        last_error = "concurrent replacement did not settle".into();
    }
    Err(format!("Unable to finalize {label}: {last_error}"))
}

pub(super) fn write_state_file(path: PathBuf, payload: Vec<u8>, label: &str) -> Result<(), String> {
    ensure_service_state_dir()?;
    let file_name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "state".into());
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let counter = STATE_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp_path = path.with_file_name(format!(
        "{file_name}.{}.{}.{}.tmp",
        std::process::id(),
        timestamp,
        counter
    ));

    fs::write(&temp_path, payload)
        .map_err(|error| format!("Unable to write temporary {label}: {error}"))?;
    set_user_only_permissions(&temp_path, 0o600);

    #[cfg(target_os = "windows")]
    {
        replace_state_file_windows(path, temp_path, label)
    }

    #[cfg(not(target_os = "windows"))]
    {
        fs::rename(&temp_path, &path).map_err(|error| {
            let _ = fs::remove_file(&temp_path);
            format!("Unable to finalize {label}: {error}")
        })
    }
}
