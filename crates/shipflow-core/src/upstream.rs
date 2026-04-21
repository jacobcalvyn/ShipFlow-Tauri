use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use reqwest::{Client, Response, StatusCode, Url};
use serde::Deserialize;

use crate::model::{TrackResponse, TrackingError, TrackingSource, TrackingSourceConfig};
use crate::parser::parse_tracking_html;

pub const POS_TRACKING_ENDPOINT: &str =
    "https://pid.posindonesia.co.id/lacak/admin/detail_lacak_banyak.php";
pub const POS_TRACKING_BASE_URL: &str = "https://pid.posindonesia.co.id/lacak/admin/";
const TRACKING_MAX_ATTEMPTS: u32 = 3;
const TRACKING_RETRY_BASE_DELAY_MS: u64 = 250;
pub const MAX_SHIPMENT_ID_LENGTH: usize = 64;

#[derive(Debug, Deserialize)]
struct ExternalApiErrorResponse {
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExternalApiStatusResponse {
    service: Option<String>,
    mode: Option<String>,
    bind_address: Option<String>,
    port: Option<u16>,
}

pub fn sanitize_shipment_id(value: &str) -> String {
    value
        .chars()
        .filter_map(|ch| {
            if ch.is_ascii_alphanumeric() {
                Some(ch.to_ascii_uppercase())
            } else if ch == '-' {
                Some(ch)
            } else {
                None
            }
        })
        .collect()
}

pub fn normalize_and_validate_shipment_id(input: &str) -> Result<String, TrackingError> {
    let normalized = sanitize_shipment_id(input.trim());

    if normalized.is_empty() {
        return Err(TrackingError::BadRequest("Shipment ID is required.".into()));
    }

    if normalized.len() > MAX_SHIPMENT_ID_LENGTH {
        return Err(TrackingError::BadRequest(format!(
            "Shipment ID exceeds {MAX_SHIPMENT_ID_LENGTH} characters."
        )));
    }

    Ok(normalized)
}

pub async fn scrape_pos_tracking(
    client: &Client,
    shipment_id: &str,
) -> Result<TrackResponse, TrackingError> {
    let normalized_shipment_id = normalize_and_validate_shipment_id(shipment_id)?;

    let request_url = build_tracking_url(POS_TRACKING_ENDPOINT, &normalized_shipment_id);
    let response = fetch_tracking_response(client, &request_url).await?;

    if !response.status().is_success() {
        return Err(TrackingError::Upstream(format!(
            "Tracking endpoint returned HTTP {}.",
            response.status()
        )));
    }

    let html = response.text().await.map_err(|error| {
        TrackingError::Upstream(format!("Tracking response could not be read: {error}"))
    })?;

    parse_tracking_html(&request_url, &html)
}

pub fn validate_tracking_source_config(
    source_config: &TrackingSourceConfig,
) -> Result<(), TrackingError> {
    if source_config.tracking_source != TrackingSource::ExternalApi {
        return Ok(());
    }

    parse_external_api_base_url(
        &source_config.external_api_base_url,
        source_config.allow_insecure_external_api_http,
    )?;

    if source_config.external_api_auth_token.trim().is_empty() {
        return Err(TrackingError::BadRequest(
            "External API bearer token is required.".into(),
        ));
    }

    Ok(())
}

pub async fn resolve_tracking_request(
    client: &Client,
    source_config: &TrackingSourceConfig,
    shipment_id: &str,
) -> Result<TrackResponse, TrackingError> {
    match source_config.tracking_source {
        TrackingSource::Default => scrape_pos_tracking(client, shipment_id).await,
        TrackingSource::ExternalApi => {
            fetch_external_api_tracking(
                client,
                &source_config.external_api_base_url,
                &source_config.external_api_auth_token,
                source_config.allow_insecure_external_api_http,
                shipment_id,
            )
            .await
        }
    }
}

pub async fn fetch_external_api_tracking(
    client: &Client,
    base_url: &str,
    auth_token: &str,
    allow_insecure_http: bool,
    shipment_id: &str,
) -> Result<TrackResponse, TrackingError> {
    let normalized_shipment_id = normalize_and_validate_shipment_id(shipment_id)?;
    let parsed_base_url = parse_external_api_base_url(base_url, allow_insecure_http)?;
    let trimmed_auth_token = auth_token.trim();

    if trimmed_auth_token.is_empty() {
        return Err(TrackingError::BadRequest(
            "External API bearer token is required.".into(),
        ));
    }

    let request_url = parsed_base_url
        .join(&format!("track/{normalized_shipment_id}"))
        .map_err(|error| {
            TrackingError::BadRequest(format!("External API tracking URL is invalid: {error}"))
        })?;

    let response = client
        .get(request_url.clone())
        .bearer_auth(trimmed_auth_token)
        .send()
        .await
        .map_err(|error| {
            if error.is_connect() {
                TrackingError::Upstream(format!("External API connection failed: {error}"))
            } else if error.is_timeout() {
                TrackingError::Upstream(format!("External API request timed out: {error}"))
            } else {
                TrackingError::Upstream(format!("External API request failed: {error}"))
            }
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let message = read_external_api_error_message(response).await;

        return Err(match status {
            StatusCode::BAD_REQUEST => TrackingError::BadRequest(message),
            StatusCode::NOT_FOUND => TrackingError::NotFound(message),
            _ => TrackingError::Upstream(format!("External API returned HTTP {status}: {message}")),
        });
    }

    let body = response.text().await.map_err(|error| {
        TrackingError::Upstream(format!("External API response could not be read: {error}"))
    })?;

    serde_json::from_str::<TrackResponse>(&body).map_err(|error| {
        TrackingError::Upstream(format!(
            "External API response could not be parsed: {error}"
        ))
    })
}

pub async fn probe_external_api_status(
    client: &Client,
    source_config: &TrackingSourceConfig,
) -> Result<String, TrackingError> {
    validate_tracking_source_config(source_config)?;

    if source_config.tracking_source != TrackingSource::ExternalApi {
        return Err(TrackingError::BadRequest(
            "Sumber tracking belum diatur ke API eksternal.".into(),
        ));
    }

    let parsed_base_url = parse_external_api_base_url(
        &source_config.external_api_base_url,
        source_config.allow_insecure_external_api_http,
    )?;
    let request_url = parsed_base_url.join("status").map_err(|error| {
        TrackingError::BadRequest(format!("External API status URL is invalid: {error}"))
    })?;

    let response = client
        .get(request_url.clone())
        .bearer_auth(source_config.external_api_auth_token.trim())
        .send()
        .await
        .map_err(|error| {
            if error.is_connect() {
                TrackingError::Upstream(format!("External API connection failed: {error}"))
            } else if error.is_timeout() {
                TrackingError::Upstream(format!("External API request timed out: {error}"))
            } else {
                TrackingError::Upstream(format!("External API request failed: {error}"))
            }
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let message = read_external_api_error_message(response).await;

        return Err(match status {
            StatusCode::BAD_REQUEST => TrackingError::BadRequest(message),
            StatusCode::NOT_FOUND => TrackingError::NotFound(message),
            _ => TrackingError::Upstream(format!("External API returned HTTP {status}: {message}")),
        });
    }

    let body = response.text().await.map_err(|error| {
        TrackingError::Upstream(format!(
            "External API status response could not be read: {error}"
        ))
    })?;

    let status_payload =
        serde_json::from_str::<ExternalApiStatusResponse>(&body).map_err(|error| {
            TrackingError::Upstream(format!(
                "External API status response could not be parsed: {error}"
            ))
        })?;

    if status_payload.service.as_deref() != Some("running") {
        return Err(TrackingError::Upstream(
            "External API status is not running.".into(),
        ));
    }

    let endpoint = match (status_payload.bind_address.as_deref(), status_payload.port) {
        (Some(bind_address), Some(port)) => format!("{bind_address}:{port}"),
        _ => request_url
            .host_str()
            .map(|host| host.to_string())
            .unwrap_or_else(|| request_url.to_string()),
    };
    let mode = status_payload.mode.unwrap_or_else(|| "unknown".into());

    Ok(format!(
        "Koneksi berhasil. Akses API aktif via {mode} ({endpoint})."
    ))
}

pub async fn fetch_tracking_response(
    client: &Client,
    request_url: &str,
) -> Result<Response, TrackingError> {
    for attempt in 1..=TRACKING_MAX_ATTEMPTS {
        match client.get(request_url).send().await {
            Ok(response) => {
                if response.status().is_success() {
                    return Ok(response);
                }

                if attempt == TRACKING_MAX_ATTEMPTS || !is_retryable_status(response.status()) {
                    return Ok(response);
                }
            }
            Err(error) => {
                if attempt == TRACKING_MAX_ATTEMPTS {
                    let message = if error.is_connect() {
                        format!("Tracking request failed during connection phase: {error}")
                    } else if error.is_timeout() {
                        format!(
                            "Tracking request timed out while waiting for POS response: {error}"
                        )
                    } else {
                        format!("Tracking request failed: {error}")
                    };
                    return Err(TrackingError::Upstream(message));
                }
            }
        }

        tokio::time::sleep(Duration::from_millis(
            TRACKING_RETRY_BASE_DELAY_MS * u64::from(attempt),
        ))
        .await;
    }

    Err(TrackingError::Upstream(
        "Tracking request exhausted retries.".into(),
    ))
}

pub fn is_retryable_status(status: StatusCode) -> bool {
    status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

pub fn build_tracking_url(base_url: &str, shipment_id: &str) -> String {
    let encoded_id = STANDARD
        .encode(shipment_id)
        .replace('+', "%2B")
        .replace('/', "%2F")
        .replace('=', "%3D");

    format!("{base_url}?id={encoded_id}")
}

pub fn resolve_pos_href(href: &str) -> String {
    let href = href.trim();
    if href.starts_with("https://") || href.starts_with("http://") {
        href.to_string()
    } else if href.starts_with('/') {
        format!("https://pid.posindonesia.co.id{href}")
    } else {
        format!("{POS_TRACKING_BASE_URL}{href}")
    }
}

fn parse_external_api_base_url(
    base_url: &str,
    allow_insecure_http: bool,
) -> Result<Url, TrackingError> {
    let trimmed = base_url.trim();
    if trimmed.is_empty() {
        return Err(TrackingError::BadRequest(
            "External API base URL is required.".into(),
        ));
    }

    let normalized = if trimmed.ends_with('/') {
        trimmed.to_string()
    } else {
        format!("{trimmed}/")
    };

    let parsed = Url::parse(&normalized).map_err(|error| {
        TrackingError::BadRequest(format!("External API base URL is invalid: {error}"))
    })?;

    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(TrackingError::BadRequest(
            "External API base URL must use HTTP or HTTPS.".into(),
        ));
    }

    if parsed.scheme() == "http" && !allow_insecure_http {
        return Err(TrackingError::BadRequest(
            "External API base URL must use HTTPS unless insecure HTTP is explicitly allowed."
                .into(),
        ));
    }

    Ok(parsed)
}

async fn read_external_api_error_message(response: Response) -> String {
    let status = response.status();

    match response.text().await {
        Ok(body) => {
            if let Ok(parsed) = serde_json::from_str::<ExternalApiErrorResponse>(&body) {
                if let Some(error) = parsed.error {
                    let trimmed = error.trim();
                    if !trimmed.is_empty() {
                        return trimmed.to_string();
                    }
                }
            }

            let trimmed_body = body.trim();
            if trimmed_body.is_empty() {
                format!("External API returned HTTP {status}.")
            } else {
                trimmed_body.to_string()
            }
        }
        Err(_) => format!("External API returned HTTP {status}."),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_tracking_url, normalize_and_validate_shipment_id, validate_tracking_source_config,
        POS_TRACKING_ENDPOINT,
    };
    use crate::model::{TrackingError, TrackingSource, TrackingSourceConfig};

    #[test]
    fn build_tracking_url_percent_encodes_base64_payload() {
        let url = build_tracking_url(POS_TRACKING_ENDPOINT, "P2603310114291");

        assert_eq!(
            url,
            "https://pid.posindonesia.co.id/lacak/admin/detail_lacak_banyak.php?id=UDI2MDMzMTAxMTQyOTE%3D"
        );
    }

    #[test]
    fn normalize_and_validate_shipment_id_matches_frontend_constraints() {
        assert_eq!(
            normalize_and_validate_shipment_id(" p2603310114291 ")
                .expect("valid shipment id should normalize"),
            "P2603310114291"
        );
        assert!(matches!(
            normalize_and_validate_shipment_id("   "),
            Err(TrackingError::BadRequest(_))
        ));
        assert!(matches!(
            normalize_and_validate_shipment_id(&format!("P{}", "1".repeat(80))),
            Err(TrackingError::BadRequest(_))
        ));
    }

    #[test]
    fn rejects_insecure_external_api_base_url_without_opt_in() {
        let error = validate_tracking_source_config(&TrackingSourceConfig {
            tracking_source: TrackingSource::ExternalApi,
            external_api_base_url: "http://shipflow.internal".into(),
            external_api_auth_token: "sf_token".into(),
            allow_insecure_external_api_http: false,
        })
        .expect_err("http external API should be rejected by default");

        assert!(matches!(error, TrackingError::BadRequest(message) if message.contains("HTTPS")));
    }

    #[test]
    fn allows_insecure_external_api_base_url_only_with_explicit_opt_in() {
        validate_tracking_source_config(&TrackingSourceConfig {
            tracking_source: TrackingSource::ExternalApi,
            external_api_base_url: "http://shipflow.internal".into(),
            external_api_auth_token: "sf_token".into(),
            allow_insecure_external_api_http: true,
        })
        .expect("http external API should be allowed only with explicit opt-in");
    }
}
