use std::net::{IpAddr, Ipv4Addr};

use serde::{Deserialize, Serialize};
use shipflow_core::{
    model::{TrackingError, TrackingSourceConfig},
    upstream::validate_tracking_source_config,
};

pub const SERVICE_STATUS_PRODUCT: &str = "shipflow-service";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ServiceRuntimeMode {
    Local,
    Lan,
}

impl ServiceRuntimeMode {
    pub fn bind_address(&self) -> IpAddr {
        match self {
            Self::Local => IpAddr::V4(Ipv4Addr::LOCALHOST),
            Self::Lan => IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        }
    }

    pub fn bind_address_label(&self) -> &'static str {
        match self {
            Self::Local => "127.0.0.1",
            Self::Lan => "0.0.0.0",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceRuntimeConfig {
    pub mode: ServiceRuntimeMode,
    pub port: u16,
    pub auth_token: String,
    pub tracking_source: TrackingSourceConfig,
}

pub fn validate_service_runtime_config(config: &ServiceRuntimeConfig) -> Result<(), String> {
    if config.auth_token.trim().is_empty() {
        return Err("Auth token is required before enabling API service.".into());
    }

    validate_tracking_source_config(&config.tracking_source).map_err(|error| match error {
        TrackingError::BadRequest(message)
        | TrackingError::NotFound(message)
        | TrackingError::Upstream(message) => message,
    })?;

    if config.port == 0 {
        return Err(format!(
            "Unable to start API service on {}:{}: invalid port.",
            config.mode.bind_address_label(),
            config.port
        ));
    }

    Ok(())
}
