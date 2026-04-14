use std::env;

use dotenvy::dotenv;
use scrap_pid_v3::{config::AppConfig, server};
use tokio_util::sync::CancellationToken;
use tracing::error;
use tracing_subscriber::EnvFilter;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LogFormat {
    Text,
    Json,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenv().ok();

    let config = AppConfig::from_env()?;
    init_tracing_subscriber(LogFormat::from_env());
    let cancel = CancellationToken::new();

    if let Err(err) = tokio::spawn(server::run(config, cancel)).await {
        error!("server task error: {}", err);
    }

    Ok(())
}

impl LogFormat {
    fn from_env() -> Self {
        match env::var("LOG_FORMAT")
            .ok()
            .map(|value| value.trim().to_ascii_lowercase())
            .as_deref()
        {
            Some("json") => Self::Json,
            _ => Self::Text,
        }
    }
}

fn init_tracing_subscriber(log_format: LogFormat) {
    match log_format {
        LogFormat::Text => tracing_subscriber::fmt()
            .compact()
            .with_env_filter(build_env_filter())
            .init(),
        LogFormat::Json => tracing_subscriber::fmt()
            .json()
            .flatten_event(true)
            .with_current_span(false)
            .with_span_list(false)
            .with_env_filter(build_env_filter())
            .init(),
    }
}

fn build_env_filter() -> EnvFilter {
    EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"))
}

#[cfg(test)]
mod tests {
    use std::sync::{Mutex, OnceLock};

    use super::LogFormat;

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn log_format_defaults_to_text_for_unknown_values() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        std::env::set_var("LOG_FORMAT", "unknown");
        assert_eq!(LogFormat::from_env(), LogFormat::Text);
        std::env::remove_var("LOG_FORMAT");
    }

    #[test]
    fn log_format_accepts_json_case_insensitively() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        std::env::set_var("LOG_FORMAT", "JSON");
        assert_eq!(LogFormat::from_env(), LogFormat::Json);
        std::env::remove_var("LOG_FORMAT");
    }
}
