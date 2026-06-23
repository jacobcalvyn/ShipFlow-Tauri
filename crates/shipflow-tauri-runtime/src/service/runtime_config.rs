use super::{ApiServiceConfig, ApiServiceMode, ApiServiceStatus, ApiServiceStatusKind};
use shipflow_service_runtime::{
    validate_service_runtime_config, ServiceRuntimeConfig, ServiceRuntimeMode,
};

pub fn running_status(config: &ApiServiceConfig) -> ApiServiceStatus {
    ApiServiceStatus {
        status: ApiServiceStatusKind::Running,
        enabled: true,
        mode: Some(config.mode.clone()),
        bind_address: Some(config.mode.bind_address_label().to_string()),
        port: Some(config.port),
        error_message: None,
    }
}

pub fn stopped_status(config: &ApiServiceConfig) -> ApiServiceStatus {
    ApiServiceStatus {
        status: ApiServiceStatusKind::Stopped,
        enabled: false,
        mode: Some(config.mode.clone()),
        bind_address: Some(config.mode.bind_address_label().to_string()),
        port: Some(config.port),
        error_message: None,
    }
}

pub fn error_status(
    config: &ApiServiceConfig,
    bind_address: &str,
    message: String,
) -> ApiServiceStatus {
    ApiServiceStatus {
        status: ApiServiceStatusKind::Error,
        enabled: config.enabled,
        mode: Some(config.mode.clone()),
        bind_address: Some(bind_address.to_string()),
        port: Some(config.port),
        error_message: Some(message),
    }
}

pub fn validate_service_config(
    config: &ApiServiceConfig,
    _bind_address: &str,
) -> Result<(), String> {
    validate_service_runtime_config(&ServiceRuntimeConfig {
        mode: match config.mode {
            ApiServiceMode::Local => ServiceRuntimeMode::Local,
            ApiServiceMode::Lan => ServiceRuntimeMode::Lan,
        },
        port: config.port,
        auth_token: config.auth_token.clone(),
        tracking_source: config.tracking_source_config(),
    })
}

pub fn validate_desktop_service_connection_config(config: &ApiServiceConfig) -> Result<(), String> {
    if !config.uses_custom_desktop_service_connection() {
        return Ok(());
    }

    let service_url = config.desktop_service_url.trim();
    if service_url.is_empty() {
        return Err("Desktop service URL is required for custom service connections.".into());
    }

    let parsed_url = reqwest::Url::parse(service_url)
        .map_err(|error| format!("Desktop service URL is invalid: {error}"))?;
    if !matches!(parsed_url.scheme(), "http" | "https") {
        return Err("Desktop service URL must use HTTP or HTTPS.".into());
    }
    if parsed_url.host_str().is_none() {
        return Err("Desktop service URL must include a host.".into());
    }
    if parsed_url.query().is_some() || parsed_url.fragment().is_some() {
        return Err("Desktop service URL must not include query strings or fragments.".into());
    }

    if config.desktop_service_auth_token.trim().is_empty() {
        return Err("Desktop service token is required for custom service connections.".into());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{validate_desktop_service_connection_config, ApiServiceConfig};
    use crate::service::{ApiServiceMode, DesktopServiceConnectionMode};
    use crate::tracking::model::TrackingSource;

    fn sample_config() -> ApiServiceConfig {
        ApiServiceConfig {
            version: 1,
            desktop_connection_mode: DesktopServiceConnectionMode::ManagedLocal,
            desktop_service_url: "http://127.0.0.1:18422".into(),
            desktop_service_auth_token: String::new(),
            enabled: false,
            mode: ApiServiceMode::Lan,
            port: 19422,
            auth_token: String::new(),
            tracking_source: TrackingSource::ExternalApi,
            external_api_base_url: "https://scrap.example.test".into(),
            external_api_auth_token: "external-token".into(),
            allow_insecure_external_api_http: false,
            keep_running_in_tray: true,
            start_at_login: true,
            last_updated_at: "2026-04-19T00:00:00.000Z".into(),
        }
    }

    #[test]
    fn tracking_source_config_preserves_external_api_fields() {
        let config = ApiServiceConfig {
            tracking_source: TrackingSource::ExternalApi,
            external_api_base_url: "https://scrap.example.test".into(),
            external_api_auth_token: "external-token".into(),
            allow_insecure_external_api_http: true,
            ..sample_config()
        };

        let tracking_source = config.tracking_source_config();

        assert!(matches!(
            tracking_source.tracking_source,
            TrackingSource::ExternalApi
        ));
        assert_eq!(
            tracking_source.external_api_base_url,
            "https://scrap.example.test"
        );
        assert_eq!(tracking_source.external_api_auth_token, "external-token");
        assert!(tracking_source.allow_insecure_external_api_http);
    }

    #[test]
    fn validate_desktop_service_connection_rejects_custom_connection_without_token() {
        let config = ApiServiceConfig {
            desktop_connection_mode: DesktopServiceConnectionMode::Custom,
            desktop_service_url: "http://127.0.0.1:18422".into(),
            desktop_service_auth_token: String::new(),
            ..sample_config()
        };

        let error = validate_desktop_service_connection_config(&config)
            .expect_err("missing custom service token should fail validation");

        assert_eq!(
            error,
            "Desktop service token is required for custom service connections."
        );
    }
}
