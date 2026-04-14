use std::time::Duration;

use axum::http::StatusCode;
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use reqwest::{Client, Response};

use super::model::{TrackResponse, TrackingError};
use super::parser::parse_tracking_html;

pub const POS_TRACKING_ENDPOINT: &str =
    "https://pid.posindonesia.co.id/lacak/admin/detail_lacak_banyak.php";
pub const POS_TRACKING_BASE_URL: &str = "https://pid.posindonesia.co.id/lacak/admin/";
const TRACKING_MAX_ATTEMPTS: u32 = 3;
const TRACKING_RETRY_BASE_DELAY_MS: u64 = 250;

pub async fn scrape_pos_tracking(
    client: &Client,
    shipment_id: &str,
) -> Result<TrackResponse, TrackingError> {
    if shipment_id.is_empty() {
        return Err(TrackingError::BadRequest(
            "Shipment ID is required.".into(),
        ));
    }

    let request_url = build_tracking_url(POS_TRACKING_ENDPOINT, shipment_id);
    let response = fetch_tracking_response(client, &request_url).await?;

    if !response.status().is_success() {
        return Err(TrackingError::Upstream(format!(
            "Tracking endpoint returned HTTP {}.",
            response.status()
        )));
    }

    let html = response.text().await.map_err(|error| {
        TrackingError::Upstream(format!(
            "Tracking response could not be read: {error}"
        ))
    })?;

    parse_tracking_html(&request_url, &html)
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
                    return Err(TrackingError::Upstream(format!(
                        "Tracking request failed: {error}"
                    )));
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
