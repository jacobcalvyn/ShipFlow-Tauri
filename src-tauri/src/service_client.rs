use serde::de::DeserializeOwned;

use crate::service::{ApiServiceConfig, SERVICE_STATUS_PRODUCT};
use crate::tracking;
use crate::tracking::model::{BagResponse, ManifestResponse, TrackResponse};

pub(crate) use shipflow_service_runtime::FORCE_REFRESH_HEADER_NAME;

fn extract_service_error_message(status: reqwest::StatusCode, raw_body: Option<&str>) -> String {
    if let Some(body) = raw_body.map(str::trim).filter(|value| !value.is_empty()) {
        if let Ok(payload) = serde_json::from_str::<serde_json::Value>(body) {
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
    let mut endpoint = reqwest::Url::parse(base_url)
        .map_err(|error| format!("ShipFlow Service URL is invalid: {error}"))?;
    endpoint
        .path_segments_mut()
        .map_err(|_| "ShipFlow Service URL cannot be used as an HTTP base URL.".to_string())?
        .push("status");
    Ok(endpoint.into())
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
        .push(route)
        .push(lookup_id.trim());
    Ok(endpoint.into())
}

pub(crate) async fn track_shipment_via_service(
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

pub(crate) async fn track_bag_via_service(
    client: &reqwest::Client,
    config: &ApiServiceConfig,
    bag_id: &str,
    force_refresh: bool,
) -> Result<BagResponse, tracking::model::TrackingError> {
    fetch_lookup_via_service(client, config, "bag", bag_id, "bag", force_refresh).await
}

pub(crate) async fn track_manifest_via_service(
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

async fn fetch_lookup_via_service<T: DeserializeOwned>(
    client: &reqwest::Client,
    config: &ApiServiceConfig,
    route: &str,
    lookup_id: &str,
    label: &str,
    force_refresh: bool,
) -> Result<T, tracking::model::TrackingError> {
    let auth_token = config.service_client_auth_token();
    if auth_token.is_empty() {
        return Err(tracking::model::TrackingError::BadRequest(
            "ShipFlow Service token is required.".into(),
        ));
    }

    if config.uses_custom_desktop_service_connection() {
        verify_api_service_connection(client, config)
            .await
            .map_err(tracking::model::TrackingError::Upstream)?;
    }

    let endpoint =
        build_service_lookup_endpoint(&config.service_client_base_url(), route, lookup_id)?;
    let mut request = client.get(endpoint).bearer_auth(auth_token);
    if force_refresh {
        request = request.header(FORCE_REFRESH_HEADER_NAME, "true");
    }
    let response = request.send().await.map_err(|error| {
        tracking::model::TrackingError::Upstream(format!(
            "Unable to reach ShipFlow Service: {error}"
        ))
    })?;

    if response.status().is_success() {
        let raw_body = response.text().await.map_err(|error| {
            tracking::model::TrackingError::Upstream(format!(
                "Unable to read ShipFlow Service {label} response: {error}"
            ))
        })?;

        return serde_json::from_str::<T>(&raw_body).map_err(|error| {
            tracking::model::TrackingError::Upstream(format!(
                "ShipFlow Service returned an invalid {label} response: {error}"
            ))
        });
    }

    let status = response.status();
    let raw_body = response.text().await.ok();
    let message = extract_service_error_message(status, raw_body.as_deref());

    match status.as_u16() {
        400 => Err(tracking::model::TrackingError::BadRequest(message)),
        404 => Err(tracking::model::TrackingError::NotFound(message)),
        _ => Err(tracking::model::TrackingError::Upstream(message)),
    }
}

pub(crate) async fn test_api_service_connection(
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

    let payload = serde_json::from_str::<serde_json::Value>(&raw_body).map_err(|error| {
        format!("ShipFlow Service returned an invalid status response: {error}")
    })?;
    let product = payload
        .get("product")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    if product != SERVICE_STATUS_PRODUCT {
        return Err("The configured endpoint is not a ShipFlow Service instance.".into());
    }

    let service = payload
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

    use super::{
        build_service_lookup_endpoint, build_service_status_endpoint, extract_service_error_message,
    };

    #[test]
    fn prefers_json_error_payload_message() {
        let message = extract_service_error_message(
            StatusCode::BAD_GATEWAY,
            Some(r#"{"error":"Bag endpoint returned HTTP 404."}"#),
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

        assert_eq!(endpoint, "http://127.0.0.1:18422/bag/PID%20123%2F456");
    }

    #[test]
    fn builds_status_endpoint_from_custom_base_url() {
        let endpoint = build_service_status_endpoint("http://127.0.0.1:18423/api")
            .expect("status endpoint should build");

        assert_eq!(endpoint, "http://127.0.0.1:18423/api/status");
    }
}
