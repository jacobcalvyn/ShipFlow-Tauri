use std::env;
use std::fmt::Arguments;
use std::fs::{create_dir_all, metadata, remove_file, rename, File, OpenOptions};
#[cfg(unix)]
use std::fs::{set_permissions, Permissions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const DEFAULT_MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_LOG_ENTRY_BYTES: usize = 32 * 1024;
const LOG_FILE_ENV: &str = "SHIPFLOW_NATIVE_LOG_FILE";
const LOG_MAX_BYTES_ENV: &str = "SHIPFLOW_NATIVE_LOG_MAX_BYTES";

static LOG_DESTINATION: OnceLock<Mutex<LogDestination>> = OnceLock::new();

enum LogDestination {
    File(RotatingLogFile),
    Stderr,
}

struct RotatingLogFile {
    active_path: PathBuf,
    backup_path: PathBuf,
    file: Option<File>,
    current_bytes: u64,
    max_file_bytes: u64,
}

impl RotatingLogFile {
    fn open(active_path: PathBuf, max_file_bytes: u64) -> io::Result<Self> {
        if let Some(parent) = active_path.parent() {
            create_dir_all(parent)?;
        }
        let backup_path = PathBuf::from(format!("{}.1", active_path.display()));
        let current_bytes = metadata(&active_path)
            .map(|value| value.len())
            .unwrap_or_default();
        if current_bytes >= max_file_bytes {
            rotate_paths(&active_path, &backup_path)?;
        }
        let file = open_log_file(&active_path)?;
        let current_bytes = file.metadata()?.len();
        Ok(Self {
            active_path,
            backup_path,
            file: Some(file),
            current_bytes,
            max_file_bytes,
        })
    }

    fn write_line(&mut self, line: &str) -> io::Result<()> {
        let line_bytes = line.len() as u64 + 1;
        if self.current_bytes > 0 && self.current_bytes + line_bytes > self.max_file_bytes {
            self.rotate()?;
        }
        let file = self.file.as_mut().ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotConnected, "runtime log file is closed")
        })?;
        file.write_all(line.as_bytes())?;
        file.write_all(b"\n")?;
        file.flush()?;
        self.current_bytes += line_bytes;
        Ok(())
    }

    fn rotate(&mut self) -> io::Result<()> {
        if let Some(file) = self.file.as_mut() {
            file.flush()?;
        }
        drop(self.file.take());
        rotate_paths(&self.active_path, &self.backup_path)?;
        self.file = Some(open_log_file(&self.active_path)?);
        self.current_bytes = 0;
        Ok(())
    }
}

fn open_log_file(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new().create(true).append(true).open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        set_permissions(path, Permissions::from_mode(0o600))?;
    }
    Ok(file)
}

fn rotate_paths(active_path: &Path, backup_path: &Path) -> io::Result<()> {
    match remove_file(backup_path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    match rename(active_path, backup_path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    Ok(())
}

fn configured_destination() -> LogDestination {
    let Some(path) = env::var_os(LOG_FILE_ENV).filter(|value| !value.is_empty()) else {
        return LogDestination::Stderr;
    };
    let max_file_bytes = env::var(LOG_MAX_BYTES_ENV)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value >= 1024)
        .unwrap_or(DEFAULT_MAX_FILE_BYTES);
    match RotatingLogFile::open(PathBuf::from(path), max_file_bytes) {
        Ok(file) => LogDestination::File(file),
        Err(error) => {
            eprintln!("[ShipFlowRuntimeLog] initialize_failed error={error}");
            LogDestination::Stderr
        }
    }
}

fn bounded_line(arguments: Arguments<'_>) -> String {
    let raw = arguments.to_string().replace(['\r', '\n'], "\\n");
    let redacted = redact_tokens(&raw);
    if redacted.len() <= MAX_LOG_ENTRY_BYTES {
        return redacted;
    }
    let mut boundary = MAX_LOG_ENTRY_BYTES;
    while !redacted.is_char_boundary(boundary) {
        boundary -= 1;
    }
    format!("{}[TRUNCATED]", &redacted[..boundary])
}

fn redact_tokens(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut result = String::with_capacity(value.len());
    let mut cursor = 0;
    while cursor < bytes.len() {
        if bytes[cursor..].starts_with(b"sf_") {
            let mut end = cursor + 3;
            while end < bytes.len()
                && (bytes[end].is_ascii_alphanumeric() || matches!(bytes[end], b'_' | b'-'))
            {
                end += 1;
            }
            if end - (cursor + 3) >= 16 {
                result.push_str("[REDACTED_TOKEN]");
                cursor = end;
                continue;
            }
        }
        let character = value[cursor..]
            .chars()
            .next()
            .expect("cursor must remain on a character boundary");
        result.push(character);
        cursor += character.len_utf8();
    }
    result
}

pub fn write(arguments: Arguments<'_>) {
    let line = bounded_line(arguments);
    let destination = LOG_DESTINATION.get_or_init(|| Mutex::new(configured_destination()));
    let Ok(mut destination) = destination.lock() else {
        eprintln!("[ShipFlowRuntimeLog] lock_poisoned");
        eprintln!("{line}");
        return;
    };
    match &mut *destination {
        LogDestination::File(file) => {
            if let Err(error) = file.write_line(&line) {
                eprintln!("[ShipFlowRuntimeLog] write_failed error={error}");
                eprintln!("{line}");
            }
        }
        LogDestination::Stderr => eprintln!("{line}"),
    }
}

#[cfg(test)]
mod tests {
    use super::{redact_tokens, RotatingLogFile};
    use std::fs::{metadata, read_to_string, remove_dir_all};
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_directory(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be valid")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "shipflow-runtime-log-{name}-{}-{unique}",
            std::process::id()
        ))
    }

    #[test]
    fn rotates_during_a_long_running_process() {
        let directory = test_directory("rotation");
        let active_path = directory.join("shipflow-service.log");
        let mut writer =
            RotatingLogFile::open(active_path.clone(), 64).expect("runtime log must open");

        writer
            .write_line("[ShipFlowLifecycle] first_event payload=1234567890")
            .expect("first line must write");
        writer
            .write_line("[ShipFlowLifecycle] second_event payload=1234567890")
            .expect("second line must write");

        let backup = read_to_string(format!("{}.1", active_path.display()))
            .expect("rotated backup must exist");
        let active = read_to_string(&active_path).expect("active log must exist");
        assert!(backup.contains("first_event"));
        assert!(active.contains("second_event"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                metadata(&active_path)
                    .expect("active log metadata must exist")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600,
            );
        }
        remove_dir_all(directory).expect("temporary runtime log must be removed");
    }

    #[test]
    fn redacts_shipflow_tokens() {
        let token = format!("sf_{}", "a".repeat(32));
        let redacted = redact_tokens(&format!("authorization={token}"));
        assert_eq!(redacted, "authorization=[REDACTED_TOKEN]");
    }
}
