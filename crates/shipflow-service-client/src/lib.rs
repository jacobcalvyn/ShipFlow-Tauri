use std::collections::HashMap;
use std::fmt;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use reqwest::{Client, StatusCode, Url};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use shipflow_core::model::{BagResponse, ManifestResponse, TrackResponse, TrackingError};
use shipflow_ipc::{
    connect_local_ipc, read_json_frame, write_json_frame, RpcMessage, RpcRequest, PROTOCOL_VERSION,
};
use shipflow_service_runtime::{FORCE_REFRESH_HEADER_NAME, SERVICE_STATUS_PRODUCT};

const SERVICE_STATUS_VERIFICATION_TTL: Duration = Duration::from_secs(10);

static SERVICE_STATUS_VERIFICATION_CACHE: OnceLock<Mutex<HashMap<String, Instant>>> =
    OnceLock::new();
static IPC_REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ServiceConnectionTransport {
    Http { base_url: String },
    LocalIpc { endpoint: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServiceConnectionConfig {
    pub transport: ServiceConnectionTransport,
    pub auth_token: String,
}

impl ServiceConnectionConfig {
    pub fn new(base_url: impl Into<String>, auth_token: impl Into<String>) -> Self {
        Self {
            transport: ServiceConnectionTransport::Http {
                base_url: base_url.into(),
            },
            auth_token: auth_token.into(),
        }
    }

    pub fn new_ipc(endpoint: impl Into<String>, auth_token: impl Into<String>) -> Self {
        Self {
            transport: ServiceConnectionTransport::LocalIpc {
                endpoint: endpoint.into(),
            },
            auth_token: auth_token.into(),
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        match &self.transport {
            ServiceConnectionTransport::Http { base_url } => {
                let url = Url::parse(base_url.trim())
                    .map_err(|error| format!("ShipFlow Service URL is invalid: {error}"))?;
                if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
                    return Err(
                        "ShipFlow Service URL must be an HTTP or HTTPS URL with a host.".into(),
                    );
                }
            }
            ServiceConnectionTransport::LocalIpc { endpoint } => {
                if endpoint.trim().is_empty() {
                    return Err("ShipFlow Service IPC endpoint is missing.".into());
                }
            }
        }
        if self.auth_token.trim().is_empty() {
            return Err("ShipFlow Service internal credential is missing.".into());
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServiceApiEnvelope<T> {
    data: T,
}

#[derive(Debug)]
struct ServiceIpcError {
    code: String,
    message: String,
}

impl ServiceIpcError {
    fn transport(message: impl Into<String>) -> Self {
        Self {
            code: "transport_error".into(),
            message: message.into(),
        }
    }
}

impl fmt::Display for ServiceIpcError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

pub async fn track_shipment(
    client: &Client,
    config: &ServiceConnectionConfig,
    shipment_id: &str,
    force_refresh: bool,
) -> Result<TrackResponse, TrackingError> {
    fetch_lookup(
        client,
        config,
        "track",
        shipment_id,
        "tracking",
        force_refresh,
    )
    .await
}

pub async fn track_bag(
    client: &Client,
    config: &ServiceConnectionConfig,
    bag_id: &str,
    force_refresh: bool,
) -> Result<BagResponse, TrackingError> {
    fetch_lookup(client, config, "bag", bag_id, "bag", force_refresh).await
}

pub async fn track_manifest(
    client: &Client,
    config: &ServiceConnectionConfig,
    manifest_id: &str,
    force_refresh: bool,
) -> Result<ManifestResponse, TrackingError> {
    fetch_lookup(
        client,
        config,
        "manifest",
        manifest_id,
        "manifest",
        force_refresh,
    )
    .await
}

pub async fn test_connection(
    client: &Client,
    config: &ServiceConnectionConfig,
) -> Result<String, String> {
    verify_service_connection(client, config).await?;
    Ok(match &config.transport {
        ServiceConnectionTransport::Http { base_url } => format!(
            "ShipFlow Service is reachable at {}.",
            base_url.trim_end_matches('/')
        ),
        ServiceConnectionTransport::LocalIpc { .. } => {
            "ShipFlow Service is reachable over native IPC.".into()
        }
    })
}

async fn fetch_lookup<T: DeserializeOwned>(
    client: &Client,
    config: &ServiceConnectionConfig,
    route: &str,
    lookup_id: &str,
    label: &str,
    force_refresh: bool,
) -> Result<T, TrackingError> {
    config.validate().map_err(TrackingError::BadRequest)?;
    verify_service_connection_cached(client, config)
        .await
        .map_err(TrackingError::Upstream)?;

    if matches!(
        &config.transport,
        ServiceConnectionTransport::LocalIpc { .. }
    ) {
        return fetch_lookup_ipc(config, route, lookup_id, force_refresh).await;
    }

    let ServiceConnectionTransport::Http { base_url } = &config.transport else {
        unreachable!("IPC transport returned above")
    };
    let endpoint =
        build_lookup_endpoint(base_url, route, lookup_id).map_err(TrackingError::Upstream)?;
    let mut request = client.get(endpoint).bearer_auth(config.auth_token.trim());
    if force_refresh {
        request = request.header(FORCE_REFRESH_HEADER_NAME, "true");
    }
    let response = request.send().await.map_err(|error| {
        TrackingError::Upstream(format!("Unable to reach ShipFlow Service: {error}"))
    })?;
    let status = response.status();
    let raw_body = response.text().await.map_err(|error| {
        TrackingError::Upstream(format!(
            "Unable to read ShipFlow Service {label} response: {error}"
        ))
    })?;

    if status.is_success() {
        return serde_json::from_str::<ServiceApiEnvelope<T>>(&raw_body)
            .map(|envelope| envelope.data)
            .map_err(|error| {
                TrackingError::Upstream(format!(
                    "ShipFlow Service returned an invalid {label} response: {error}"
                ))
            });
    }

    let message = extract_service_error_message(status, Some(&raw_body));
    match status.as_u16() {
        400 => Err(TrackingError::BadRequest(message)),
        404 => Err(TrackingError::NotFound(message)),
        429 => Err(TrackingError::RateLimited(message)),
        503 => Err(TrackingError::ServiceUnavailable(message)),
        _ => Err(TrackingError::Upstream(message)),
    }
}

async fn verify_service_connection_cached(
    client: &Client,
    config: &ServiceConnectionConfig,
) -> Result<(), String> {
    let key = verification_cache_key(config);
    let now = Instant::now();
    if SERVICE_STATUS_VERIFICATION_CACHE
        .get_or_init(Default::default)
        .lock()
        .expect("service verification cache lock poisoned")
        .get(&key)
        .is_some_and(|verified_until| *verified_until > now)
    {
        return Ok(());
    }

    verify_service_connection(client, config).await?;
    SERVICE_STATUS_VERIFICATION_CACHE
        .get_or_init(Default::default)
        .lock()
        .expect("service verification cache lock poisoned")
        .insert(key, Instant::now() + SERVICE_STATUS_VERIFICATION_TTL);
    Ok(())
}

async fn verify_service_connection(
    client: &Client,
    config: &ServiceConnectionConfig,
) -> Result<(), String> {
    config.validate()?;
    if matches!(
        &config.transport,
        ServiceConnectionTransport::LocalIpc { .. }
    ) {
        let value = request_ipc(config, "service.status", serde_json::json!({}))
            .await
            .map_err(|error| error.to_string())?;
        if value.get("product").and_then(|value| value.as_str()) != Some(SERVICE_STATUS_PRODUCT)
            || value.get("service").and_then(|value| value.as_str()) != Some("running")
        {
            return Err("The configured IPC endpoint is not a running ShipFlow Service.".into());
        }
        return Ok(());
    }
    let ServiceConnectionTransport::Http { base_url } = &config.transport else {
        unreachable!("IPC transport returned above")
    };
    let status_endpoint = build_v1_endpoint(base_url, "status")?;
    let response = client
        .get(status_endpoint)
        .send()
        .await
        .map_err(|error| format!("Unable to reach ShipFlow Service: {error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("Unable to read ShipFlow Service status: {error}"))?;
    if !status.is_success() {
        return Err(extract_service_error_message(status, Some(&body)));
    }
    verify_status_payload(&body)?;

    let auth_endpoint = build_v1_endpoint(base_url, "auth/check")?;
    let response = client
        .get(auth_endpoint)
        .bearer_auth(config.auth_token.trim())
        .send()
        .await
        .map_err(|error| format!("Unable to verify ShipFlow Service credential: {error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("Unable to read ShipFlow Service auth response: {error}"))?;
    if !status.is_success() {
        return Err(extract_service_error_message(status, Some(&body)));
    }
    Ok(())
}

fn build_lookup_endpoint(base_url: &str, route: &str, lookup_id: &str) -> Result<Url, String> {
    let mut endpoint = Url::parse(base_url)
        .map_err(|error| format!("ShipFlow Service URL is invalid: {error}"))?;
    endpoint
        .path_segments_mut()
        .map_err(|_| "ShipFlow Service URL cannot be used as an HTTP base URL.".to_string())?
        .push("v1")
        .push(route)
        .push(lookup_id.trim());
    Ok(endpoint)
}

fn build_v1_endpoint(base_url: &str, endpoint: &str) -> Result<Url, String> {
    let mut url = Url::parse(base_url)
        .map_err(|error| format!("ShipFlow Service URL is invalid: {error}"))?;
    let mut segments = url
        .path_segments_mut()
        .map_err(|_| "ShipFlow Service URL cannot be used as an HTTP base URL.".to_string())?;
    segments.push("v1");
    for segment in endpoint.split('/') {
        if !segment.is_empty() {
            segments.push(segment);
        }
    }
    drop(segments);
    Ok(url)
}

fn verification_cache_key(config: &ServiceConnectionConfig) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    config.auth_token.hash(&mut hasher);
    let endpoint = match &config.transport {
        ServiceConnectionTransport::Http { base_url } => base_url.to_ascii_lowercase(),
        ServiceConnectionTransport::LocalIpc { endpoint } => endpoint.clone(),
    };
    format!("{}:{:016x}", endpoint, hasher.finish())
}

async fn fetch_lookup_ipc<T: DeserializeOwned>(
    config: &ServiceConnectionConfig,
    route: &str,
    lookup_id: &str,
    force_refresh: bool,
) -> Result<T, TrackingError> {
    let method = match route {
        "track" => "tracking.track",
        "bag" => "tracking.bag",
        "manifest" => "tracking.manifest",
        _ => {
            return Err(TrackingError::BadRequest(format!(
                "Unsupported ShipFlow IPC lookup route: {route}"
            )))
        }
    };
    let result = request_ipc(
        config,
        method,
        serde_json::json!({
            "lookupId": lookup_id,
            "forceRefresh": force_refresh,
        }),
    )
    .await
    .map_err(tracking_error_from_ipc_error)?;
    serde_json::from_value(result).map_err(|error| {
        TrackingError::Upstream(format!(
            "ShipFlow Service returned an invalid IPC lookup response: {error}"
        ))
    })
}

async fn request_ipc(
    config: &ServiceConnectionConfig,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, ServiceIpcError> {
    let ServiceConnectionTransport::LocalIpc { endpoint } = &config.transport else {
        return Err(ServiceIpcError::transport(
            "ShipFlow Service IPC transport is not configured.",
        ));
    };
    let sequence = IPC_REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1;
    let request = RpcRequest {
        protocol_version: PROTOCOL_VERSION,
        id: format!("service-client-{}-{sequence}", std::process::id()),
        method: method.into(),
        auth_token: Some(config.auth_token.clone()),
        params,
    };
    let operation = async {
        let mut stream = connect_local_ipc(endpoint).await.map_err(|error| {
            ServiceIpcError::transport(format!(
                "Unable to connect to ShipFlow Service IPC: {error}"
            ))
        })?;
        write_json_frame(&mut stream, &request)
            .await
            .map_err(|error| {
                ServiceIpcError::transport(format!(
                    "Unable to write ShipFlow Service IPC request: {error}"
                ))
            })?;
        let message: RpcMessage = read_json_frame(&mut stream).await.map_err(|error| {
            ServiceIpcError::transport(format!(
                "Unable to read ShipFlow Service IPC response: {error}"
            ))
        })?;
        match message {
            RpcMessage::Response { id, result, .. } if id == request.id => Ok(result),
            RpcMessage::Error { id, error, .. } if id == request.id => Err(ServiceIpcError {
                code: error.code,
                message: error.message,
            }),
            _ => Err(ServiceIpcError::transport(
                "ShipFlow Service returned an invalid IPC correlation id.",
            )),
        }
    };
    tokio::time::timeout(Duration::from_secs(100), operation)
        .await
        .map_err(|_| ServiceIpcError::transport("ShipFlow Service IPC request timed out."))?
}

fn tracking_error_from_ipc_error(error: ServiceIpcError) -> TrackingError {
    match error.code.as_str() {
        "bad_request" | "invalid_params" => TrackingError::BadRequest(error.message),
        "not_found" => TrackingError::NotFound(error.message),
        "rate_limited" => TrackingError::RateLimited(error.message),
        "service_unavailable" => TrackingError::ServiceUnavailable(error.message),
        _ => TrackingError::Upstream(error.to_string()),
    }
}

fn verify_status_payload(raw_body: &str) -> Result<(), String> {
    let payload = serde_json::from_str::<serde_json::Value>(raw_body)
        .map_err(|error| format!("ShipFlow Service returned invalid status JSON: {error}"))?;
    let data = payload
        .get("data")
        .ok_or_else(|| "ShipFlow Service status response is missing data.".to_string())?;
    if data.get("product").and_then(|value| value.as_str()) != Some(SERVICE_STATUS_PRODUCT) {
        return Err("The configured endpoint is not a ShipFlow Service instance.".into());
    }
    if data.get("service").and_then(|value| value.as_str()) != Some("running") {
        return Err("ShipFlow Service is not reporting a running status.".into());
    }
    Ok(())
}

fn extract_service_error_message(status: StatusCode, raw_body: Option<&str>) -> String {
    if let Some(body) = raw_body.map(str::trim).filter(|value| !value.is_empty()) {
        if let Ok(payload) = serde_json::from_str::<serde_json::Value>(body) {
            if let Some(message) = payload
                .get("error")
                .and_then(|value| value.get("message"))
                .and_then(|value| value.as_str())
            {
                return message.trim().to_string();
            }
        }
        return format!("ShipFlow Service returned HTTP {status}: {body}");
    }
    format!("ShipFlow Service returned HTTP {status}.")
}

#[cfg(test)]
mod tests {
    use super::{
        build_lookup_endpoint, build_v1_endpoint, ServiceConnectionConfig,
        ServiceConnectionTransport,
    };

    #[test]
    fn lookup_path_preserves_and_encodes_exact_id() {
        let endpoint =
            build_lookup_endpoint("http://127.0.0.1:18422", "track", "P2606020189412.30")
                .expect("endpoint builds");

        assert_eq!(
            endpoint.as_str(),
            "http://127.0.0.1:18422/v1/track/P2606020189412.30"
        );
    }

    #[test]
    fn v1_endpoint_supports_nested_routes() {
        let endpoint =
            build_v1_endpoint("http://127.0.0.1:18422", "auth/check").expect("endpoint builds");
        assert_eq!(endpoint.as_str(), "http://127.0.0.1:18422/v1/auth/check");
    }

    #[test]
    fn connection_requires_internal_credential() {
        let config = ServiceConnectionConfig::new("http://127.0.0.1:18422", "");
        assert!(config.validate().is_err());
    }

    #[test]
    fn ipc_connection_does_not_require_an_http_port() {
        let config = ServiceConnectionConfig::new_ipc("shipflow-test-ipc", "sf_internal");
        config.validate().expect("IPC connection should validate");
        assert!(matches!(
            config.transport,
            ServiceConnectionTransport::LocalIpc { .. }
        ));
    }
}
