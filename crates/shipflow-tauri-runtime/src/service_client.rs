use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::service::{ApiServiceConfig, SERVICE_STATUS_PRODUCT};
use crate::tracking;
use crate::tracking::model::{BagResponse, ManifestResponse, TrackResponse};
use shipflow_service_runtime::jobs::{
    BatchJobResultSnapshot, BatchJobStatus, BatchTrackJobItemResult, BatchTrackJobStart,
};

pub use shipflow_service_runtime::jobs::BatchJobItemStatus;
pub use shipflow_service_runtime::FORCE_REFRESH_HEADER_NAME;

const SERVICE_STATUS_VERIFICATION_TTL: Duration = Duration::from_secs(10);

static SERVICE_STATUS_VERIFICATION_CACHE: OnceLock<Mutex<HashMap<String, Instant>>> =
    OnceLock::new();

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceBatchTrackRequest {
    shipment_ids: Vec<String>,
    force_refresh: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServiceApiEnvelope<T> {
    data: T,
}

fn extract_service_error_message(status: reqwest::StatusCode, raw_body: Option<&str>) -> String {
    if let Some(body) = raw_body.map(str::trim).filter(|value| !value.is_empty()) {
        if let Ok(payload) = serde_json::from_str::<serde_json::Value>(body) {
            if let Some(message) = payload
                .get("error")
                .and_then(|value| value.get("message"))
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                return message.to_string();
            }

            if let Some(message) = payload
                .get("error")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                return message.to_string();
            }
        }

        return format!("ShipFlow Service returned HTTP {}: {}", status, body);
    }

    format!("ShipFlow Service returned HTTP {}.", status)
}

fn build_service_status_endpoint(base_url: &str) -> Result<String, String> {
    build_service_v1_endpoint(base_url, "v1/status")
}

fn build_service_lookup_endpoint(
    base_url: &str,
    route: &str,
    lookup_id: &str,
) -> Result<String, tracking::model::TrackingError> {
    let mut endpoint = reqwest::Url::parse(base_url).map_err(|error| {
        tracking::model::TrackingError::Upstream(format!(
            "ShipFlow Service URL is invalid: {error}"
        ))
    })?;
    endpoint
        .path_segments_mut()
        .map_err(|_| {
            tracking::model::TrackingError::Upstream(
                "ShipFlow Service URL cannot be used as an HTTP base URL.".into(),
            )
        })?
        .push("v1")
        .push(route)
        .push(lookup_id.trim());
    Ok(endpoint.into())
}

fn build_service_v1_endpoint(base_url: &str, endpoint: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse(base_url)
        .map_err(|error| format!("ShipFlow Service URL is invalid: {error}"))?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "ShipFlow Service URL cannot be used as an HTTP base URL.".to_string())?;
        for segment in endpoint.trim_start_matches('/').split('/') {
            if !segment.is_empty() {
                segments.push(segment);
            }
        }
    }
    Ok(url.into())
}

fn build_service_relative_endpoint(base_url: &str, endpoint: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse(base_url)
        .map_err(|error| format!("ShipFlow Service URL is invalid: {error}"))?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "ShipFlow Service URL cannot be used as an HTTP base URL.".to_string())?;
        segments.clear();
        for segment in endpoint.trim_start_matches('/').split('/') {
            if !segment.is_empty() {
                segments.push(segment);
            }
        }
    }
    Ok(url.into())
}

pub async fn track_shipment_via_service(
    client: &reqwest::Client,
    config: &ApiServiceConfig,
    shipment_id: &str,
    force_refresh: bool,
) -> Result<TrackResponse, tracking::model::TrackingError> {
    fetch_lookup_via_service(
        client,
        config,
        "track",
        shipment_id,
        "tracking",
        force_refresh,
    )
    .await
}

pub async fn track_bag_via_service(
    client: &reqwest::Client,
    config: &ApiServiceConfig,
    bag_id: &str,
    force_refresh: bool,
) -> Result<BagResponse, tracking::model::TrackingError> {
    fetch_lookup_via_service(client, config, "bag", bag_id, "bag", force_refresh).await
}

pub async fn track_manifest_via_service(
    client: &reqwest::Client,
    config: &ApiServiceConfig,
    manifest_id: &str,
    force_refresh: bool,
) -> Result<ManifestResponse, tracking::model::TrackingError> {
    fetch_lookup_via_service(
        client,
        config,
        "manifest",
        manifest_id,
        "manifest",
        force_refresh,
    )
    .await
}

pub async fn track_shipments_batch_via_service(
    client: &reqwest::Client,
    config: &ApiServiceConfig,
    shipment_ids: Vec<String>,
    force_refresh: bool,
) -> Result<Vec<BatchTrackJobItemResult>, tracking::model::TrackingError> {
    track_shipments_batch_via_service_with_progress(
        client,
        config,
        shipment_ids,
        force_refresh,
        |_| {},
    )
    .await
}

pub async fn track_shipments_batch_via_service_with_progress<F>(
    client: &reqwest::Client,
    config: &ApiServiceConfig,
    shipment_ids: Vec<String>,
    force_refresh: bool,
    mut on_result: F,
) -> Result<Vec<BatchTrackJobItemResult>, tracking::model::TrackingError>
where
    F: FnMut(BatchTrackJobItemResult) + Send,
{
    let auth_token = config.service_client_auth_token();
    if auth_token.is_empty() {
        return Err(tracking::model::TrackingError::BadRequest(
            "ShipFlow Service token is required.".into(),
        ));
    }

    if shipment_ids.is_empty() {
        return Ok(Vec::new());
    }

    if should_verify_service_before_lookup(config) {
        verify_api_service_connection_cached(client, config)
            .await
            .map_err(tracking::model::TrackingError::Upstream)?;
    }

    let base_url = config.service_client_base_url();
    let start_endpoint = build_service_v1_endpoint(&base_url, "v1/jobs/track-batch")
        .map_err(tracking::model::TrackingError::Upstream)?;
    let response = client
        .post(start_endpoint)
        .bearer_auth(auth_token)
        .header("content-type", "application/json")
        .body(
            serde_json::to_string(&ServiceBatchTrackRequest {
                shipment_ids,
                force_refresh,
            })
            .map_err(|error| {
                tracking::model::TrackingError::Upstream(format!(
                    "Unable to serialize ShipFlow Service batch request: {error}"
                ))
            })?,
        )
        .send()
        .await
        .map_err(|error| {
            tracking::model::TrackingError::Upstream(format!(
                "Unable to reach ShipFlow Service batch endpoint: {error}"
            ))
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let raw_body = response.text().await.ok();
        return Err(tracking::model::TrackingError::Upstream(
            extract_service_error_message(status, raw_body.as_deref()),
        ));
    }

    let raw_body = response.text().await.map_err(|error| {
        tracking::model::TrackingError::Upstream(format!(
            "Unable to read ShipFlow Service batch start response: {error}"
        ))
    })?;
    let start = serde_json::from_str::<ServiceApiEnvelope<BatchTrackJobStart>>(&raw_body)
        .map_err(|error| {
            tracking::model::TrackingError::Upstream(format!(
                "ShipFlow Service returned an invalid batch start response: {error}"
            ))
        })?
        .data;

    poll_service_batch_result(client, config, &start, |result| {
        on_result(result);
    })
    .await
}

async fn poll_service_batch_result<F>(
    client: &reqwest::Client,
    config: &ApiServiceConfig,
    start: &BatchTrackJobStart,
    mut on_result: F,
) -> Result<Vec<BatchTrackJobItemResult>, tracking::model::TrackingError>
where
    F: FnMut(BatchTrackJobItemResult) + Send,
{
    let auth_token = config.service_client_auth_token();
    let base_url = config.service_client_base_url();
    let status_endpoint = build_service_relative_endpoint(&base_url, &start.status_endpoint)
        .map_err(tracking::model::TrackingError::Upstream)?;
    let result_endpoint = build_service_relative_endpoint(&base_url, &start.result_endpoint)
        .map_err(tracking::model::TrackingError::Upstream)?;
    let mut emitted_result_count = 0_usize;

    for _ in 0..600 {
        let response = client
            .get(status_endpoint.clone())
            .bearer_auth(auth_token)
            .send()
            .await
            .map_err(|error| {
                tracking::model::TrackingError::Upstream(format!(
                    "Unable to read ShipFlow Service batch status: {error}"
                ))
            })?;

        if !response.status().is_success() {
            let status = response.status();
            let raw_body = response.text().await.ok();
            return Err(tracking::model::TrackingError::Upstream(
                extract_service_error_message(status, raw_body.as_deref()),
            ));
        }

        let raw_body = response.text().await.map_err(|error| {
            tracking::model::TrackingError::Upstream(format!(
                "Unable to read ShipFlow Service batch status response: {error}"
            ))
        })?;
        let status = serde_json::from_str::<
            ServiceApiEnvelope<shipflow_service_runtime::jobs::BatchJobSnapshot>,
        >(&raw_body)
        .map_err(|error| {
            tracking::model::TrackingError::Upstream(format!(
                "ShipFlow Service returned an invalid batch status response: {error}"
            ))
        })?
        .data;

        let response = client
            .get(result_endpoint.clone())
            .bearer_auth(auth_token)
            .send()
            .await
            .map_err(|error| {
                tracking::model::TrackingError::Upstream(format!(
                    "Unable to read ShipFlow Service batch result: {error}"
                ))
            })?;

        if !response.status().is_success() {
            let status = response.status();
            let raw_body = response.text().await.ok();
            return Err(tracking::model::TrackingError::Upstream(
                extract_service_error_message(status, raw_body.as_deref()),
            ));
        }

        let raw_body = response.text().await.map_err(|error| {
            tracking::model::TrackingError::Upstream(format!(
                "Unable to read ShipFlow Service batch result response: {error}"
            ))
        })?;
        let result = serde_json::from_str::<ServiceApiEnvelope<BatchJobResultSnapshot>>(&raw_body)
            .map_err(|error| {
                tracking::model::TrackingError::Upstream(format!(
                    "ShipFlow Service returned an invalid batch result response: {error}"
                ))
            })?
            .data;
        for result in result.results.iter().skip(emitted_result_count) {
            on_result(result.clone());
        }
        emitted_result_count = result.results.len();

        if matches!(
            status.status,
            BatchJobStatus::Completed | BatchJobStatus::Cancelled | BatchJobStatus::Failed
        ) {
            return Ok(result.results);
        }

        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    Err(tracking::model::TrackingError::Upstream(
        "ShipFlow Service batch job timed out.".into(),
    ))
}

async fn fetch_lookup_via_service<T: DeserializeOwned>(
    client: &reqwest::Client,
    config: &ApiServiceConfig,
    route: &str,
    lookup_id: &str,
    label: &str,
    force_refresh: bool,
) -> Result<T, tracking::model::TrackingError> {
    let total_started_at = Instant::now();
    let auth_token = config.service_client_auth_token();
    if auth_token.is_empty() {
        return Err(tracking::model::TrackingError::BadRequest(
            "ShipFlow Service token is required.".into(),
        ));
    }

    if should_verify_service_before_lookup(config) {
        let verify_started_at = Instant::now();
        verify_api_service_connection_cached(client, config)
            .await
            .map_err(tracking::model::TrackingError::Upstream)?;
        log_desktop_service_timing(
            route,
            lookup_id,
            "status_verify",
            verify_started_at,
            "result=ok",
        );
    }

    let endpoint =
        build_service_lookup_endpoint(&config.service_client_base_url(), route, lookup_id)?;
    let mut request = client.get(endpoint).bearer_auth(auth_token);
    if force_refresh {
        request = request.header(FORCE_REFRESH_HEADER_NAME, "true");
    }
    let http_started_at = Instant::now();
    let response = request.send().await.map_err(|error| {
        tracking::model::TrackingError::Upstream(format!(
            "Unable to reach ShipFlow Service: {error}"
        ))
    })?;
    let status = response.status();
    log_desktop_service_timing(
        route,
        lookup_id,
        "http",
        http_started_at,
        format!("status={status}"),
    );

    if status.is_success() {
        let body_started_at = Instant::now();
        let raw_body = response.text().await.map_err(|error| {
            tracking::model::TrackingError::Upstream(format!(
                "Unable to read ShipFlow Service {label} response: {error}"
            ))
        })?;
        log_desktop_service_timing(
            route,
            lookup_id,
            "body_read",
            body_started_at,
            format!("bytes={}", raw_body.len()),
        );

        let parse_started_at = Instant::now();
        let parsed = serde_json::from_str::<ServiceApiEnvelope<T>>(&raw_body)
            .map(|envelope| envelope.data)
            .map_err(|error| {
                tracking::model::TrackingError::Upstream(format!(
                    "ShipFlow Service returned an invalid {label} response: {error}"
                ))
            });
        log_desktop_service_timing(
            route,
            lookup_id,
            "parse",
            parse_started_at,
            format!("result={}", if parsed.is_ok() { "ok" } else { "error" }),
        );
        log_desktop_service_timing(
            route,
            lookup_id,
            "total",
            total_started_at,
            format!("result={}", if parsed.is_ok() { "ok" } else { "error" }),
        );
        return parsed;
    }

    let raw_body = response.text().await.ok();
    let message = extract_service_error_message(status, raw_body.as_deref());
    log_desktop_service_timing(route, lookup_id, "total", total_started_at, "result=error");

    match status.as_u16() {
        400 => Err(tracking::model::TrackingError::BadRequest(message)),
        404 => Err(tracking::model::TrackingError::NotFound(message)),
        _ => Err(tracking::model::TrackingError::Upstream(message)),
    }
}

fn log_desktop_service_timing(
    route: &str,
    lookup_id: &str,
    stage: &str,
    started_at: Instant,
    detail: impl AsRef<str>,
) {
    eprintln!(
        "[ShipFlowPerf] desktop_service route={} id={} stage={} durationMs={} {}",
        route,
        lookup_id.trim(),
        stage,
        started_at.elapsed().as_millis(),
        detail.as_ref()
    );
}

pub async fn test_api_service_connection(
    client: &reqwest::Client,
    config: &ApiServiceConfig,
) -> Result<String, String> {
    verify_api_service_connection(client, config).await?;
    Ok(format!(
        "ShipFlow Service is reachable at {}.",
        config.service_client_base_url()
    ))
}

async fn verify_api_service_connection(
    client: &reqwest::Client,
    config: &ApiServiceConfig,
) -> Result<(), String> {
    let auth_token = config.service_client_auth_token();
    if auth_token.is_empty() {
        return Err("ShipFlow Service token is required.".into());
    }

    let base_url = config.service_client_base_url();
    let endpoint = build_service_status_endpoint(&base_url)?;
    let response = client
        .get(endpoint)
        .bearer_auth(auth_token)
        .send()
        .await
        .map_err(|error| format!("Unable to reach ShipFlow Service: {error}"))?;

    let status = response.status();
    let raw_body = response
        .text()
        .await
        .map_err(|error| format!("Unable to read ShipFlow Service status response: {error}"))?;

    if !status.is_success() {
        return Err(extract_service_error_message(status, Some(&raw_body)));
    }

    verify_service_status_payload(&raw_body)?;

    Ok(())
}

async fn verify_api_service_connection_cached(
    client: &reqwest::Client,
    config: &ApiServiceConfig,
) -> Result<(), String> {
    let cache_key = service_status_verification_cache_key(config);
    let now = Instant::now();
    if SERVICE_STATUS_VERIFICATION_CACHE
        .get_or_init(Default::default)
        .lock()
        .expect("service status verification cache lock poisoned")
        .get(&cache_key)
        .is_some_and(|verified_until| *verified_until > now)
    {
        return Ok(());
    }

    verify_api_service_connection(client, config).await?;

    SERVICE_STATUS_VERIFICATION_CACHE
        .get_or_init(Default::default)
        .lock()
        .expect("service status verification cache lock poisoned")
        .insert(cache_key, Instant::now() + SERVICE_STATUS_VERIFICATION_TTL);

    Ok(())
}

fn should_verify_service_before_lookup(config: &ApiServiceConfig) -> bool {
    config.uses_custom_desktop_service_connection()
}

fn service_status_verification_cache_key(config: &ApiServiceConfig) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    config.service_client_auth_token().hash(&mut hasher);
    format!(
        "{}:{:016x}",
        config.service_client_base_url().to_ascii_lowercase(),
        hasher.finish()
    )
}

fn verify_service_status_payload(raw_body: &str) -> Result<(), String> {
    let payload = serde_json::from_str::<serde_json::Value>(raw_body).map_err(|error| {
        format!("ShipFlow Service returned an invalid status response: {error}")
    })?;
    let data = payload
        .get("data")
        .ok_or_else(|| "ShipFlow Service status response is missing data.".to_string())?;

    let product = data
        .get("product")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    if product != SERVICE_STATUS_PRODUCT {
        return Err("The configured endpoint is not a ShipFlow Service instance.".into());
    }

    let service = data
        .get("service")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    if service != "running" {
        return Err("ShipFlow Service is not reporting a running status.".into());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use reqwest::StatusCode;

    use crate::{
        service::{ApiServiceConfig, ApiServiceMode, DesktopServiceConnectionMode},
        tracking::model::TrackingSource,
    };

    use super::{
        build_service_lookup_endpoint, build_service_status_endpoint,
        extract_service_error_message, should_verify_service_before_lookup,
        verify_service_status_payload,
    };

    fn sample_custom_service_config(base_url: String) -> ApiServiceConfig {
        ApiServiceConfig {
            version: 1,
            desktop_connection_mode: DesktopServiceConnectionMode::Custom,
            desktop_service_url: base_url,
            desktop_service_auth_token: "sf_custom_service_token".into(),
            enabled: false,
            mode: ApiServiceMode::Local,
            port: 18422,
            auth_token: String::new(),
            tracking_source: TrackingSource::Default,
            external_api_base_url: String::new(),
            external_api_auth_token: String::new(),
            allow_insecure_external_api_http: false,
            keep_running_in_tray: true,
            start_at_login: true,
            last_updated_at: "2026-04-25T00:00:00.000Z".into(),
        }
    }

    #[test]
    fn prefers_json_error_payload_message() {
        let message = extract_service_error_message(
            StatusCode::BAD_GATEWAY,
            Some(r#"{"error":{"message":"Bag endpoint returned HTTP 404."}}"#),
        );

        assert_eq!(message, "Bag endpoint returned HTTP 404.");
    }

    #[test]
    fn falls_back_to_plain_text_response_body() {
        let message = extract_service_error_message(StatusCode::NOT_FOUND, Some("Not Found"));

        assert_eq!(
            message,
            "ShipFlow Service returned HTTP 404 Not Found: Not Found"
        );
    }

    #[test]
    fn encodes_lookup_ids_when_building_service_endpoint() {
        let endpoint =
            build_service_lookup_endpoint("http://127.0.0.1:18422", "bag", "PID 123/456")
                .expect("endpoint should build");

        assert_eq!(endpoint, "http://127.0.0.1:18422/v1/bag/PID%20123%2F456");
    }

    #[test]
    fn builds_status_endpoint_from_custom_base_url() {
        let endpoint = build_service_status_endpoint("http://127.0.0.1:18423/api")
            .expect("status endpoint should build");

        assert_eq!(endpoint, "http://127.0.0.1:18423/api/v1/status");
    }

    #[test]
    fn custom_lookup_requires_status_verification_before_lookup() {
        let custom_config = sample_custom_service_config("http://127.0.0.1:18423".into());
        let managed_config = ApiServiceConfig {
            desktop_connection_mode: DesktopServiceConnectionMode::ManagedLocal,
            ..sample_custom_service_config("http://127.0.0.1:18423".into())
        };

        assert!(should_verify_service_before_lookup(&custom_config));
        assert!(!should_verify_service_before_lookup(&managed_config));
    }

    #[test]
    fn validates_shipflow_status_identity_payload() {
        verify_service_status_payload(
            r#"{"data":{"service":"running","product":"shipflow-service","mode":"local"}}"#,
        )
        .expect("valid ShipFlow Service status should pass");

        let error =
            verify_service_status_payload(r#"{"data":{"service":"running","product":"other"}}"#)
                .expect_err("wrong product marker should fail");
        assert!(error.contains("not a ShipFlow Service"));

        let error = verify_service_status_payload(
            r#"{"data":{"service":"stopped","product":"shipflow-service"}}"#,
        )
        .expect_err("non-running service should fail");
        assert!(error.contains("not reporting a running status"));
    }
}
