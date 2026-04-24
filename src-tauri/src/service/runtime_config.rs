use std::time::{SystemTime, UNIX_EPOCH};

use super::{
    ApiServiceConfig, ApiServiceMode, ApiServiceStatus, ApiServiceStatusKind,
    DesktopServiceConnectionMode,
};
use crate::tracking::model::TrackingSource;
use shipflow_service_runtime::{
    validate_service_runtime_config, ServiceRuntimeConfig, ServiceRuntimeMode,
};

pub(crate) fn running_status(config: &ApiServiceConfig) -> ApiServiceStatus {
    ApiServiceStatus {
        status: ApiServiceStatusKind::Running,
        enabled: true,
        mode: Some(config.mode.clone()),
        bind_address: Some(config.mode.bind_address_label().to_string()),
        port: Some(config.port),
        error_message: None,
    }
}

pub(crate) fn stopped_status(config: &ApiServiceConfig) -> ApiServiceStatus {
    ApiServiceStatus {
        status: ApiServiceStatusKind::Stopped,
        enabled: false,
        mode: Some(config.mode.clone()),
        bind_address: Some(config.mode.bind_address_label().to_string()),
        port: Some(config.port),
        error_message: None,
    }
}

pub(crate) fn error_status(
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

pub(crate) fn validate_service_config(
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

pub(crate) fn validate_desktop_service_connection_config(
    config: &ApiServiceConfig,
) -> Result<(), String> {
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

fn generate_internal_service_token() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("sf_internal_{timestamp:x}_{}", std::process::id())
}

pub(crate) fn build_tracking_runtime_config(
    saved_config: Option<ApiServiceConfig>,
    current_runtime_config: Option<&ApiServiceConfig>,
) -> ApiServiceConfig {
    let base_config = saved_config.unwrap_or(ApiServiceConfig {
        version: 1,
        desktop_connection_mode: DesktopServiceConnectionMode::ManagedLocal,
        desktop_service_url: "http://127.0.0.1:18422".into(),
        desktop_service_auth_token: String::new(),
        enabled: false,
        mode: ApiServiceMode::Local,
        port: 18422,
        auth_token: String::new(),
        tracking_source: TrackingSource::Default,
        external_api_base_url: String::new(),
        external_api_auth_token: String::new(),
        allow_insecure_external_api_http: false,
        keep_running_in_tray: true,
        last_updated_at: String::new(),
    });

    let auth_token = if base_config.auth_token.trim().is_empty() {
        current_runtime_config
            .map(|config| config.auth_token.trim())
            .filter(|token| !token.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(generate_internal_service_token)
    } else {
        base_config.auth_token.clone()
    };

    ApiServiceConfig {
        version: 1,
        desktop_connection_mode: base_config.desktop_connection_mode,
        desktop_service_url: base_config.desktop_service_url,
        desktop_service_auth_token: base_config.desktop_service_auth_token,
        enabled: true,
        mode: if base_config.enabled {
            base_config.mode
        } else {
            ApiServiceMode::Local
        },
        port: base_config.port,
        auth_token,
        tracking_source: base_config.tracking_source,
        external_api_base_url: base_config.external_api_base_url,
        external_api_auth_token: base_config.external_api_auth_token,
        allow_insecure_external_api_http: base_config.allow_insecure_external_api_http,
        keep_running_in_tray: if base_config.enabled {
            base_config.keep_running_in_tray
        } else {
            false
        },
        last_updated_at: base_config.last_updated_at,
    }
}

pub(crate) fn tracking_runtime_matches(left: &ApiServiceConfig, right: &ApiServiceConfig) -> bool {
    left.mode == right.mode
        && left.port == right.port
        && left.auth_token == right.auth_token
        && left.tracking_source == right.tracking_source
        && left.external_api_base_url == right.external_api_base_url
        && left.external_api_auth_token == right.external_api_auth_token
        && left.allow_insecure_external_api_http == right.allow_insecure_external_api_http
        && left.desktop_connection_mode == right.desktop_connection_mode
        && left.desktop_service_url == right.desktop_service_url
        && left.desktop_service_auth_token == right.desktop_service_auth_token
}

#[cfg(test)]
mod tests {
    use super::{
        build_tracking_runtime_config, validate_desktop_service_connection_config,
        validate_service_config, ApiServiceConfig, ApiServiceMode, DesktopServiceConnectionMode,
    };
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
            last_updated_at: "2026-04-19T00:00:00.000Z".into(),
        }
    }

    #[test]
    fn desktop_runtime_forces_local_service_when_public_api_is_disabled() {
        let runtime = build_tracking_runtime_config(Some(sample_config()), None);

        assert!(runtime.enabled);
        assert!(matches!(runtime.mode, ApiServiceMode::Local));
        assert!(!runtime.keep_running_in_tray);
        assert!(matches!(
            runtime.tracking_source,
            TrackingSource::ExternalApi
        ));
        assert_eq!(runtime.external_api_base_url, "https://scrap.example.test");
        assert_eq!(runtime.external_api_auth_token, "external-token");
        assert!(!runtime.auth_token.trim().is_empty());
    }

    #[test]
    fn desktop_runtime_reuses_current_internal_token_when_saved_config_has_none() {
        let current_runtime = ApiServiceConfig {
            auth_token: "sf_internal_existing".into(),
            ..sample_config()
        };

        let runtime = build_tracking_runtime_config(Some(sample_config()), Some(&current_runtime));

        assert_eq!(runtime.auth_token, "sf_internal_existing");
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
    fn validate_service_config_rejects_missing_auth_token() {
        let error = validate_service_config(&sample_config(), "0.0.0.0")
            .expect_err("missing auth token should fail validation");

        assert_eq!(error, "Auth token is required before enabling API service.");
    }

    #[test]
    fn validate_service_config_rejects_insecure_external_api_without_opt_in() {
        let config = ApiServiceConfig {
            auth_token: "sf_service_token".into(),
            external_api_base_url: "http://scrap.example.test".into(),
            allow_insecure_external_api_http: false,
            ..sample_config()
        };

        let error = validate_service_config(&config, "0.0.0.0")
            .expect_err("insecure external API should fail without explicit opt in");

        assert_eq!(
            error,
            "External API base URL must use HTTPS unless insecure HTTP is explicitly allowed."
        );
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

    #[test]
    fn desktop_runtime_does_not_replace_custom_service_connection_fields() {
        let runtime = build_tracking_runtime_config(
            Some(ApiServiceConfig {
                desktop_connection_mode: DesktopServiceConnectionMode::Custom,
                desktop_service_url: "http://127.0.0.1:18423".into(),
                desktop_service_auth_token: "sf_custom_service".into(),
                ..sample_config()
            }),
            None,
        );

        assert!(runtime.uses_custom_desktop_service_connection());
        assert_eq!(runtime.service_client_base_url(), "http://127.0.0.1:18423");
        assert_eq!(runtime.service_client_auth_token(), "sf_custom_service");
    }

    #[test]
    fn desktop_runtime_uses_default_local_config_when_saved_config_missing() {
        let runtime = build_tracking_runtime_config(None, None);

        assert!(runtime.enabled);
        assert!(matches!(runtime.mode, ApiServiceMode::Local));
        assert_eq!(runtime.port, 18422);
        assert!(matches!(runtime.tracking_source, TrackingSource::Default));
        assert!(runtime.external_api_base_url.is_empty());
        assert!(runtime.external_api_auth_token.is_empty());
        assert!(!runtime.auth_token.trim().is_empty());
    }
}
