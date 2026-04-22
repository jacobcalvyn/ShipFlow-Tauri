use std::{
    env,
    fs::{self, OpenOptions},
    io::Write,
    panic,
    path::PathBuf,
    sync::OnceLock,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::service::SERVICE_STATE_DIR_NAME;

fn runtime_log_dir() -> PathBuf {
    #[cfg(test)]
    if let Some(path) = env::var_os("SHIPFLOW_SERVICE_STATE_DIR_OVERRIDE") {
        return PathBuf::from(path).join("logs");
    }

    env::temp_dir().join(SERVICE_STATE_DIR_NAME).join("logs")
}

fn runtime_log_path() -> PathBuf {
    let process_name = env::current_exe()
        .ok()
        .and_then(|path| path.file_stem().map(|name| name.to_string_lossy().into_owned()))
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "shipflow-runtime".into());

    runtime_log_dir().join(format!("{process_name}.log"))
}

fn log_timestamp() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}.{:03}", now.as_secs(), now.subsec_millis())
}

fn append_runtime_log_line(level: &str, message: &str) -> Result<(), String> {
    let log_path = runtime_log_path();
    let log_dir = log_path
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| "Unable to resolve runtime log directory.".to_string())?;
    fs::create_dir_all(&log_dir).map_err(|error| {
        format!(
            "Unable to create runtime log directory {}: {error}",
            log_dir.display()
        )
    })?;

    let line = format!(
        "[{}] [{}] [pid={}] {}\n",
        log_timestamp(),
        level,
        std::process::id(),
        message
    );

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| format!("Unable to open runtime log file {}: {error}", log_path.display()))?;

    file.write_all(line.as_bytes())
        .map_err(|error| format!("Unable to write runtime log line: {error}"))
}

pub(crate) fn log_runtime_event(level: &str, message: impl AsRef<str>) {
    let message = message.as_ref();
    eprintln!("{message}");
    let _ = append_runtime_log_line(level, message);
}

pub(crate) fn install_runtime_logging() {
    static PANIC_HOOK_ONCE: OnceLock<()> = OnceLock::new();

    PANIC_HOOK_ONCE.get_or_init(|| {
        let default_hook = panic::take_hook();
        panic::set_hook(Box::new(move |panic_info| {
            let location = panic_info
                .location()
                .map(|location| format!("{}:{}", location.file(), location.line()))
                .unwrap_or_else(|| "unknown location".into());

            let payload = if let Some(message) = panic_info.payload().downcast_ref::<&str>() {
                (*message).to_string()
            } else if let Some(message) = panic_info.payload().downcast_ref::<String>() {
                message.clone()
            } else {
                "non-string panic payload".into()
            };

            log_runtime_event("PANIC", format!("[ShipFlowRuntime] panic at {location}: {payload}"));
            default_hook(panic_info);
        }));
    });
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        panic::{self, AssertUnwindSafe},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::{append_runtime_log_line, runtime_log_path};
    use crate::test_support::runtime_state_dir_test_lock;

    fn with_state_dir<T>(label: &str, operation: impl FnOnce() -> T) -> T {
        let _guard = runtime_state_dir_test_lock()
            .lock()
            .expect("runtime log test lock poisoned");

        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let test_dir = std::env::temp_dir().join(format!("{label}-{unique_suffix}"));
        std::env::set_var("SHIPFLOW_SERVICE_STATE_DIR_OVERRIDE", &test_dir);

        let result = panic::catch_unwind(AssertUnwindSafe(operation));
        let _ = fs::remove_dir_all(&test_dir);
        std::env::remove_var("SHIPFLOW_SERVICE_STATE_DIR_OVERRIDE");

        match result {
            Ok(value) => value,
            Err(payload) => panic::resume_unwind(payload),
        }
    }

    #[test]
    fn runtime_log_is_written_to_overridden_state_dir() {
        with_state_dir("shipflow-runtime-log-test", || {
            append_runtime_log_line("INFO", "[ShipFlowRuntimeTest] runtime log smoke test")
                .expect("runtime log append should succeed");

            let log_contents =
                fs::read_to_string(runtime_log_path()).expect("runtime log file should be readable");

            assert!(log_contents.contains("[ShipFlowRuntimeTest] runtime log smoke test"));
            assert!(log_contents.contains("[INFO]"));
        });
    }
}
