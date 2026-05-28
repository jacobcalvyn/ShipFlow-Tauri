use std::{
    error::Error as StdError,
    time::{Duration, Instant},
};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use reqwest::{header::ACCEPT, Client, Response, StatusCode, Url};
use serde::{de::DeserializeOwned, Deserialize};

use crate::bag::parse_bag_html;
use crate::manifest::parse_manifest_html;
use crate::model::{
    BagResponse, LookupKind, ManifestResponse, TrackResponse, TrackingError, TrackingSource,
    TrackingSourceConfig,
};
use crate::parser::parse_tracking_html;

pub const POS_TRACKING_ENDPOINT: &str = "https://lacak-mitra.posindonesia.co.id/lacak_barcode.php";
pub const POS_TRACKING_BASE_URL: &str = "https://lacak-mitra.posindonesia.co.id/";
pub const POS_BAG_ENDPOINT: &str =
    "https://pid.posindonesia.co.id/lacak/admin/detail_lacak_banyak_bag.php";
pub const POS_MANIFEST_ENDPOINT: &str =
    "https://pid.posindonesia.co.id/lacak/admin/GetManifestR7_detil.php";
const TRACKING_MAX_ATTEMPTS: u32 = 3;
const TRACKING_RETRY_BASE_DELAY_MS: u64 = 250;
const EXTERNAL_API_HEDGE_DELAY_MS: u64 = 2_500;
pub const MAX_LOOKUP_ID_LENGTH: usize = 64;

#[derive(Debug, Deserialize)]
struct ExternalApiErrorResponse {
    error: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct ExternalApiDataEnvelope<T> {
    data: T,
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

fn format_request_error_details(error: &reqwest::Error) -> String {
    let mut message = error.to_string();
    let mut source = error.source();

    while let Some(cause) = source {
        let cause_message = cause.to_string();
        if !cause_message.trim().is_empty() {
            message.push_str(": ");
            message.push_str(&cause_message);
        }
        source = cause.source();
    }

    message
}

pub fn normalize_and_validate_shipment_id(input: &str) -> Result<String, TrackingError> {
    let normalized = sanitize_shipment_id(input.trim());

    if normalized.is_empty() {
        return Err(TrackingError::BadRequest("Shipment ID is required.".into()));
    }

    if normalized.len() > MAX_LOOKUP_ID_LENGTH {
        return Err(TrackingError::BadRequest(format!(
            "Shipment ID exceeds {MAX_LOOKUP_ID_LENGTH} characters."
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
    let response = fetch_lookup_response(client, &request_url).await?;

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

pub async fn scrape_pos_bag(client: &Client, bag_id: &str) -> Result<BagResponse, TrackingError> {
    let normalized_bag_id = normalize_and_validate_bag_id(bag_id)?;
    let request_url = build_encoded_pos_lookup_url(POS_BAG_ENDPOINT, &normalized_bag_id);
    let response = fetch_lookup_response(client, &request_url).await?;

    if !response.status().is_success() {
        return Err(TrackingError::Upstream(format!(
            "Bag endpoint returned HTTP {}.",
            response.status()
        )));
    }

    let html = response.text().await.map_err(|error| {
        TrackingError::Upstream(format!("Bag response could not be read: {error}"))
    })?;

    Ok(parse_bag_html(&html, &request_url))
}

pub async fn scrape_pos_manifest(
    client: &Client,
    manifest_id: &str,
) -> Result<ManifestResponse, TrackingError> {
    let normalized_manifest_id = normalize_and_validate_manifest_id(manifest_id)?;
    let request_url = build_encoded_pos_lookup_url(POS_MANIFEST_ENDPOINT, &normalized_manifest_id);
    let response = fetch_lookup_response(client, &request_url).await?;

    if !response.status().is_success() {
        return Err(TrackingError::Upstream(format!(
            "Manifest endpoint returned HTTP {}.",
            response.status()
        )));
    }

    let html = response.text().await.map_err(|error| {
        TrackingError::Upstream(format!("Manifest response could not be read: {error}"))
    })?;

    Ok(parse_manifest_html(&html, &request_url))
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

pub async fn resolve_bag_request(
    client: &Client,
    source_config: &TrackingSourceConfig,
    bag_id: &str,
) -> Result<BagResponse, TrackingError> {
    match source_config.tracking_source {
        TrackingSource::Default => scrape_pos_bag(client, bag_id).await,
        TrackingSource::ExternalApi => {
            fetch_external_api_bag(
                client,
                &source_config.external_api_base_url,
                &source_config.external_api_auth_token,
                source_config.allow_insecure_external_api_http,
                bag_id,
            )
            .await
        }
    }
}

pub async fn resolve_manifest_request(
    client: &Client,
    source_config: &TrackingSourceConfig,
    manifest_id: &str,
) -> Result<ManifestResponse, TrackingError> {
    match source_config.tracking_source {
        TrackingSource::Default => scrape_pos_manifest(client, manifest_id).await,
        TrackingSource::ExternalApi => {
            fetch_external_api_manifest(
                client,
                &source_config.external_api_base_url,
                &source_config.external_api_auth_token,
                source_config.allow_insecure_external_api_http,
                manifest_id,
            )
            .await
        }
    }
}

pub fn normalize_and_validate_bag_id(input: &str) -> Result<String, TrackingError> {
    normalize_lookup_id(input, LookupKind::Bag)
}

pub fn normalize_and_validate_manifest_id(input: &str) -> Result<String, TrackingError> {
    normalize_lookup_id(input, LookupKind::Manifest)
}

pub async fn fetch_external_api_tracking(
    client: &Client,
    base_url: &str,
    auth_token: &str,
    allow_insecure_http: bool,
    shipment_id: &str,
) -> Result<TrackResponse, TrackingError> {
    let total_started_at = Instant::now();
    let normalized_shipment_id = normalize_and_validate_shipment_id(shipment_id)?;
    let parsed_base_url = parse_external_api_base_url(base_url, allow_insecure_http)?;
    let prefer_v1_contract = external_api_base_url_prefers_v1_contract(base_url);
    let trimmed_auth_token = auth_token.trim();

    if trimmed_auth_token.is_empty() {
        return Err(TrackingError::BadRequest(
            "External API bearer token is required.".into(),
        ));
    }

    let request_url = parsed_base_url
        .join(&format!("v1/track/{normalized_shipment_id}"))
        .map_err(|error| {
            TrackingError::BadRequest(format!("External API tracking URL is invalid: {error}"))
        })?;

    let http_started_at = Instant::now();
    let response =
        fetch_external_api_response(client, request_url.clone(), trimmed_auth_token).await?;
    log_external_api_tracking_timing(
        &normalized_shipment_id,
        "http",
        http_started_at,
        format!("route=v1 status={}", response.status()),
    );

    if response.status() == StatusCode::NOT_FOUND && !prefer_v1_contract {
        log_external_api_tracking_timing(
            &normalized_shipment_id,
            "fallback",
            total_started_at,
            "route=legacy reason=v1_not_found",
        );
        let legacy_request_url = parsed_base_url
            .join(&format!("track/{normalized_shipment_id}"))
            .map_err(|error| {
                TrackingError::BadRequest(format!("External API tracking URL is invalid: {error}"))
            })?;
        let legacy_http_started_at = Instant::now();
        let legacy_response =
            fetch_external_api_response(client, legacy_request_url, trimmed_auth_token).await?;
        log_external_api_tracking_timing(
            &normalized_shipment_id,
            "http",
            legacy_http_started_at,
            format!("route=legacy status={}", legacy_response.status()),
        );
        let result =
            read_external_api_tracking_response(legacy_response, &normalized_shipment_id, "legacy")
                .await;
        log_external_api_tracking_result(&normalized_shipment_id, total_started_at, &result);
        return result;
    }

    let result = read_external_api_tracking_response(response, &normalized_shipment_id, "v1").await;
    log_external_api_tracking_result(&normalized_shipment_id, total_started_at, &result);
    result
}

pub async fn fetch_external_api_bag(
    client: &Client,
    base_url: &str,
    auth_token: &str,
    allow_insecure_http: bool,
    bag_id: &str,
) -> Result<BagResponse, TrackingError> {
    let normalized_bag_id = normalize_and_validate_bag_id(bag_id)?;
    fetch_external_api_lookup(
        client,
        base_url,
        auth_token,
        allow_insecure_http,
        LookupKind::Bag,
        &normalized_bag_id,
        parse_external_api_bag_response,
    )
    .await
}

pub async fn fetch_external_api_manifest(
    client: &Client,
    base_url: &str,
    auth_token: &str,
    allow_insecure_http: bool,
    manifest_id: &str,
) -> Result<ManifestResponse, TrackingError> {
    let normalized_manifest_id = normalize_and_validate_manifest_id(manifest_id)?;
    fetch_external_api_lookup(
        client,
        base_url,
        auth_token,
        allow_insecure_http,
        LookupKind::Manifest,
        &normalized_manifest_id,
        parse_external_api_manifest_response,
    )
    .await
}

async fn fetch_external_api_lookup<T>(
    client: &Client,
    base_url: &str,
    auth_token: &str,
    allow_insecure_http: bool,
    kind: LookupKind,
    lookup_id: &str,
    parser: fn(&str) -> Result<T, TrackingError>,
) -> Result<T, TrackingError> {
    let parsed_base_url = parse_external_api_base_url(base_url, allow_insecure_http)?;
    let prefer_v1_contract = external_api_base_url_prefers_v1_contract(base_url);
    let trimmed_auth_token = auth_token.trim();

    if trimmed_auth_token.is_empty() {
        return Err(TrackingError::BadRequest(
            "External API bearer token is required.".into(),
        ));
    }

    let request_url = build_external_api_lookup_url(&parsed_base_url, kind, lookup_id, true)?;

    let response =
        fetch_external_api_response(client, request_url.clone(), trimmed_auth_token).await?;

    if response.status() == StatusCode::NOT_FOUND && !prefer_v1_contract {
        let legacy_request_url =
            build_external_api_lookup_url(&parsed_base_url, kind, lookup_id, false)?;
        let legacy_response =
            fetch_external_api_response(client, legacy_request_url, trimmed_auth_token).await?;
        return read_external_api_json_response(legacy_response, parser).await;
    }

    read_external_api_json_response(response, parser).await
}

async fn read_external_api_tracking_response(
    response: Response,
    shipment_id: &str,
    route_label: &str,
) -> Result<TrackResponse, TrackingError> {
    if !response.status().is_success() {
        let status = response.status();
        let error_read_started_at = Instant::now();
        let message = read_external_api_error_message(response).await;
        log_external_api_tracking_timing(
            shipment_id,
            "error_body_read",
            error_read_started_at,
            format!("route={route_label} status={status}"),
        );

        return Err(match status {
            StatusCode::BAD_REQUEST => TrackingError::BadRequest(message),
            StatusCode::NOT_FOUND => TrackingError::NotFound(message),
            _ => TrackingError::Upstream(format!("External API returned HTTP {status}: {message}")),
        });
    }

    let body_read_started_at = Instant::now();
    let body = response.text().await.map_err(|error| {
        TrackingError::Upstream(format!("External API response could not be read: {error}"))
    })?;
    log_external_api_tracking_timing(
        shipment_id,
        "body_read",
        body_read_started_at,
        format!("route={route_label} bytes={}", body.len()),
    );

    let parse_started_at = Instant::now();
    let result = parse_external_api_track_response(&body);
    log_external_api_tracking_timing(
        shipment_id,
        "parse",
        parse_started_at,
        format!(
            "route={route_label} result={}",
            if result.is_ok() { "ok" } else { "error" }
        ),
    );
    result
}

async fn read_external_api_json_response<T>(
    response: Response,
    parser: fn(&str) -> Result<T, TrackingError>,
) -> Result<T, TrackingError> {
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

    parser(&body)
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
    let prefer_v1_contract =
        external_api_base_url_prefers_v1_contract(&source_config.external_api_base_url);
    let request_url = parsed_base_url.join("v1/status").map_err(|error| {
        TrackingError::BadRequest(format!("External API status URL is invalid: {error}"))
    })?;

    let response = fetch_external_api_response(
        client,
        request_url.clone(),
        source_config.external_api_auth_token.trim(),
    )
    .await?;

    if response.status() == StatusCode::NOT_FOUND && !prefer_v1_contract {
        let legacy_request_url = parsed_base_url.join("status").map_err(|error| {
            TrackingError::BadRequest(format!("External API status URL is invalid: {error}"))
        })?;
        let legacy_response = fetch_external_api_response(
            client,
            legacy_request_url,
            source_config.external_api_auth_token.trim(),
        )
        .await?;
        return read_external_api_status_response(legacy_response).await;
    }

    read_external_api_status_response(response).await
}

async fn read_external_api_status_response(response: Response) -> Result<String, TrackingError> {
    if !response.status().is_success() {
        let status = response.status();
        let message = read_external_api_error_message(response).await;

        return Err(match status {
            StatusCode::BAD_REQUEST => TrackingError::BadRequest(message),
            StatusCode::NOT_FOUND => TrackingError::NotFound(message),
            _ => TrackingError::Upstream(format!("External API returned HTTP {status}: {message}")),
        });
    }

    let response_url = response.url().clone();
    let body = response.text().await.map_err(|error| {
        TrackingError::Upstream(format!(
            "External API status response could not be read: {error}"
        ))
    })?;

    let status_payload = parse_external_api_status_response(&body)?;

    if status_payload.service.as_deref() != Some("running") {
        return Err(TrackingError::Upstream(
            "External API status is not running.".into(),
        ));
    }

    let endpoint = match (status_payload.bind_address.as_deref(), status_payload.port) {
        (Some(bind_address), Some(port)) => format!("{bind_address}:{port}"),
        _ => response_url
            .host_str()
            .map(|host| host.to_string())
            .unwrap_or_else(|| response_url.to_string()),
    };
    let mode = status_payload.mode.unwrap_or_else(|| "unknown".into());

    Ok(format!(
        "Koneksi berhasil. Akses API aktif via {mode} ({endpoint})."
    ))
}

async fn fetch_external_api_response(
    client: &Client,
    request_url: Url,
    bearer_token: &str,
) -> Result<Response, TrackingError> {
    for attempt in 1..=TRACKING_MAX_ATTEMPTS {
        match send_external_api_request_with_hedge(client, request_url.clone(), bearer_token).await
        {
            Ok(response) => {
                if response.status().is_success()
                    || attempt == TRACKING_MAX_ATTEMPTS
                    || !is_retryable_status(response.status())
                {
                    return Ok(response);
                }
            }
            Err(error) => {
                if attempt == TRACKING_MAX_ATTEMPTS {
                    let details = format_request_error_details(&error);
                    let message = if error.is_connect() {
                        format!("External API connection failed. Details: {details}")
                    } else if error.is_timeout() {
                        format!("External API request timed out. Details: {details}")
                    } else {
                        format!("External API request failed. Details: {details}")
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
        "External API request exhausted retries.".into(),
    ))
}

async fn send_external_api_request(
    client: &Client,
    request_url: Url,
    bearer_token: String,
) -> Result<Response, reqwest::Error> {
    client
        .get(request_url)
        .bearer_auth(bearer_token)
        .header(ACCEPT, "application/json")
        .send()
        .await
}

async fn send_external_api_request_with_hedge(
    client: &Client,
    request_url: Url,
    bearer_token: &str,
) -> Result<Response, reqwest::Error> {
    let primary = send_external_api_request(client, request_url.clone(), bearer_token.to_string());
    tokio::pin!(primary);

    tokio::select! {
        result = &mut primary => result,
        _ = tokio::time::sleep(Duration::from_millis(EXTERNAL_API_HEDGE_DELAY_MS)) => {
            eprintln!(
                "[ShipFlowPerf] external_api_request stage=hedge_start path={} delayMs={}",
                request_url.path(),
                EXTERNAL_API_HEDGE_DELAY_MS
            );
            let secondary = send_external_api_request(
                client,
                request_url,
                bearer_token.to_string(),
            );
            tokio::pin!(secondary);

            tokio::select! {
                result = &mut primary => {
                    eprintln!("[ShipFlowPerf] external_api_request stage=hedge_result winner=primary");
                    result
                }
                result = &mut secondary => {
                    eprintln!("[ShipFlowPerf] external_api_request stage=hedge_result winner=secondary");
                    result
                }
            }
        }
    }
}

pub async fn fetch_lookup_response(
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
                    let details = format_request_error_details(&error);
                    let message = if error.is_connect() {
                        format!(
                            "POS tracking upstream connection failed. Check DNS or internet access from ShipFlow Service. Details: {details}"
                        )
                    } else if error.is_timeout() {
                        format!(
                            "POS tracking upstream timed out while waiting for a response. Details: {details}"
                        )
                    } else {
                        format!("POS tracking upstream request failed. Details: {details}")
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
        "Lookup request exhausted retries.".into(),
    ))
}

fn normalize_lookup_id(input: &str, kind: LookupKind) -> Result<String, TrackingError> {
    let normalized = sanitize_shipment_id(input.trim());
    let label = match kind {
        LookupKind::Track => "Shipment ID",
        LookupKind::Bag => "Bag ID",
        LookupKind::Manifest => "Manifest ID",
    };

    if normalized.is_empty() {
        return Err(TrackingError::BadRequest(format!("{label} is required.")));
    }

    if normalized.len() > MAX_LOOKUP_ID_LENGTH {
        return Err(TrackingError::BadRequest(format!(
            "{label} exceeds {MAX_LOOKUP_ID_LENGTH} characters."
        )));
    }

    Ok(normalized)
}

pub fn is_retryable_status(status: StatusCode) -> bool {
    status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

pub fn build_tracking_url(base_url: &str, shipment_id: &str) -> String {
    format!("{base_url}?id={shipment_id}")
}

fn build_encoded_pos_lookup_url(base_url: &str, lookup_id: &str) -> String {
    let encoded_id = STANDARD
        .encode(lookup_id)
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
        format!("https://lacak-mitra.posindonesia.co.id{href}")
    } else {
        format!("{POS_TRACKING_BASE_URL}{href}")
    }
}

pub fn parse_external_api_base_url(
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

    let mut parsed = Url::parse(&normalized).map_err(|error| {
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

    let mut path_segments = parsed
        .path_segments()
        .map(|segments| {
            segments
                .filter(|segment| !segment.is_empty())
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    if path_segments
        .windows(2)
        .last()
        .is_some_and(|segments| segments == ["v1", "openapi.json"])
    {
        path_segments.truncate(path_segments.len().saturating_sub(2));
    } else if path_segments.last().is_some_and(|segment| segment == "v1") {
        path_segments.truncate(path_segments.len().saturating_sub(1));
    }

    let normalized_path = if path_segments.is_empty() {
        "/".to_string()
    } else {
        format!("/{}/", path_segments.join("/"))
    };
    parsed.set_path(&normalized_path);
    parsed.set_query(None);
    parsed.set_fragment(None);

    Ok(parsed)
}

fn external_api_base_url_prefers_v1_contract(base_url: &str) -> bool {
    let Ok(url) = Url::parse(base_url.trim()) else {
        return false;
    };

    url.path_segments().is_some_and(|segments| {
        segments
            .filter(|segment| !segment.trim().is_empty())
            .any(|segment| {
                let normalized = segment.trim().to_ascii_lowercase();
                normalized == "v1" || normalized == "openapi.json"
            })
    })
}

fn log_external_api_tracking_timing(
    shipment_id: &str,
    stage: &str,
    started_at: Instant,
    detail: impl AsRef<str>,
) {
    eprintln!(
        "[ShipFlowPerf] external_api_tracking id={} stage={} durationMs={} {}",
        shipment_id,
        stage,
        started_at.elapsed().as_millis(),
        detail.as_ref()
    );
}

fn log_external_api_tracking_result(
    shipment_id: &str,
    started_at: Instant,
    result: &Result<TrackResponse, TrackingError>,
) {
    log_external_api_tracking_timing(
        shipment_id,
        "total",
        started_at,
        format!("result={}", if result.is_ok() { "ok" } else { "error" }),
    );
}

fn parse_external_api_track_response(body: &str) -> Result<TrackResponse, TrackingError> {
    parse_external_api_data_or_plain(body).map_err(|error| {
        TrackingError::Upstream(format!(
            "External API response could not be parsed: {error}"
        ))
    })
}

fn parse_external_api_bag_response(body: &str) -> Result<BagResponse, TrackingError> {
    parse_external_api_data_or_plain(body).map_err(|error| {
        TrackingError::Upstream(format!(
            "External API bag response could not be parsed: {error}"
        ))
    })
}

fn parse_external_api_manifest_response(body: &str) -> Result<ManifestResponse, TrackingError> {
    parse_external_api_data_or_plain(body).map_err(|error| {
        TrackingError::Upstream(format!(
            "External API manifest response could not be parsed: {error}"
        ))
    })
}

fn parse_external_api_status_response(
    body: &str,
) -> Result<ExternalApiStatusResponse, TrackingError> {
    parse_external_api_data_or_plain(body).map_err(|error| {
        TrackingError::Upstream(format!(
            "External API status response could not be parsed: {error}"
        ))
    })
}

fn parse_external_api_data_or_plain<T>(body: &str) -> Result<T, serde_json::Error>
where
    T: DeserializeOwned,
{
    serde_json::from_str::<ExternalApiDataEnvelope<T>>(body)
        .map(|envelope| envelope.data)
        .or_else(|_| serde_json::from_str::<T>(body))
}

fn external_api_lookup_route(kind: LookupKind) -> &'static str {
    match kind {
        LookupKind::Track => "track",
        LookupKind::Bag => "bag",
        LookupKind::Manifest => "manifest",
    }
}

fn build_external_api_lookup_url(
    base_url: &Url,
    kind: LookupKind,
    lookup_id: &str,
    use_v1_contract: bool,
) -> Result<Url, TrackingError> {
    let route_name = external_api_lookup_route(kind);
    let route = if use_v1_contract {
        format!("v1/{route_name}/{lookup_id}")
    } else {
        format!("{route_name}/{lookup_id}")
    };

    base_url.join(&route).map_err(|error| {
        TrackingError::BadRequest(format!("External API {route_name} URL is invalid: {error}"))
    })
}

async fn read_external_api_error_message(response: Response) -> String {
    let status = response.status();

    match response.text().await {
        Ok(body) => {
            if let Ok(parsed) = serde_json::from_str::<ExternalApiErrorResponse>(&body) {
                if let Some(error) = parsed.error {
                    if let Some(message) = error.as_str() {
                        let trimmed = message.trim();
                        if !trimmed.is_empty() {
                            return trimmed.to_string();
                        }
                    }

                    if let Some(message) = error
                        .get("message")
                        .and_then(|value| value.as_str())
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                    {
                        return message.to_string();
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
        build_external_api_lookup_url, build_tracking_url,
        external_api_base_url_prefers_v1_contract, normalize_and_validate_bag_id,
        normalize_and_validate_manifest_id, normalize_and_validate_shipment_id,
        parse_external_api_bag_response, parse_external_api_base_url,
        parse_external_api_manifest_response, parse_external_api_status_response,
        parse_external_api_track_response, validate_tracking_source_config, POS_TRACKING_ENDPOINT,
    };
    use crate::model::{LookupKind, TrackingError, TrackingSource, TrackingSourceConfig};

    #[test]
    fn build_tracking_url_uses_raw_lacak_mitra_id() {
        let url = build_tracking_url(POS_TRACKING_ENDPOINT, "BAC19052633D04464929");

        assert_eq!(
            url,
            "https://lacak-mitra.posindonesia.co.id/lacak_barcode.php?id=BAC19052633D04464929"
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
    fn normalize_and_validate_bag_and_manifest_ids_reuse_lookup_guardrails() {
        assert_eq!(
            normalize_and_validate_bag_id(" bag-001 ").expect("valid bag id should normalize"),
            "BAG-001"
        );
        assert_eq!(
            normalize_and_validate_manifest_id(" r7-001 ")
                .expect("valid manifest id should normalize"),
            "R7-001"
        );
        assert!(matches!(
            normalize_and_validate_bag_id("   "),
            Err(TrackingError::BadRequest(_))
        ));
        assert!(matches!(
            normalize_and_validate_manifest_id(&format!("M{}", "1".repeat(80))),
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

    #[test]
    fn normalizes_external_api_openapi_and_v1_urls_to_service_root() {
        let root =
            parse_external_api_base_url("https://scrappid3.example.test/v1/openapi.json", false)
                .expect("OpenAPI URL should normalize");
        assert_eq!(root.as_str(), "https://scrappid3.example.test/");

        let nested_root = parse_external_api_base_url(
            "https://scrappid3.example.test/proxy/v1/openapi.json",
            false,
        )
        .expect("nested OpenAPI URL should normalize");
        assert_eq!(
            nested_root.as_str(),
            "https://scrappid3.example.test/proxy/"
        );

        let v1_root = parse_external_api_base_url("https://scrappid3.example.test/v1", false)
            .expect("v1 URL should normalize");
        assert_eq!(v1_root.as_str(), "https://scrappid3.example.test/");
    }

    #[test]
    fn treats_explicit_v1_external_api_urls_as_authoritative() {
        assert!(external_api_base_url_prefers_v1_contract(
            "https://scrappid3.example.test/v1/openapi.json"
        ));
        assert!(external_api_base_url_prefers_v1_contract(
            "https://scrappid3.example.test/proxy/v1"
        ));
        assert!(!external_api_base_url_prefers_v1_contract(
            "https://scrappid3.example.test"
        ));
    }

    #[test]
    fn parses_external_api_v1_tracking_envelope() {
        let body = r#"{
          "meta": {
            "apiVersion": "v1",
            "schemaVersion": "shipflow.tracking.detail.v1",
            "requestId": "req-1",
            "generatedAt": "2026-05-06T00:00:00Z"
          },
          "data": {
            "url": "https://example.test/track/P1",
            "detail": {
              "shipment_header": {"nomor_kiriman": "P1"},
              "origin_detail": {},
              "package_detail": {},
              "billing_detail": {"cod_info": {"is_cod": false}},
              "actors": {"pengirim": {}, "penerima": {}},
              "performance_detail": {}
            },
            "status_akhir": {},
            "pod": {},
            "history": [],
            "history_summary": {
              "irregularity": [],
              "bagging_unbagging": [],
              "manifest_r7": [],
              "delivery_runsheet": []
            }
          },
          "warnings": []
        }"#;

        let parsed = parse_external_api_track_response(body)
            .expect("v1 envelope should parse into TrackResponse");

        assert_eq!(parsed.detail.header.nomor_kiriman.as_deref(), Some("P1"));
    }

    #[test]
    fn parses_external_api_v1_bag_envelope() {
        let body = r#"{
          "meta": {
            "apiVersion": "v1",
            "schemaVersion": "shipflow.bag.v1",
            "requestId": "req-1",
            "generatedAt": "2026-05-06T00:00:00Z"
          },
          "data": {
            "url": "https://example.test/v1/bag/PID1",
            "nomor_kantung": "PID1",
            "items": [
              {"no_resi": "P2601", "status": "UNBAGGING"}
            ]
          },
          "warnings": []
        }"#;

        let parsed = parse_external_api_bag_response(body).expect("v1 bag envelope should parse");

        assert_eq!(parsed.nomor_kantung.as_deref(), Some("PID1"));
        assert_eq!(parsed.items[0].no_resi.as_deref(), Some("P2601"));
    }

    #[test]
    fn builds_external_api_bag_v1_endpoint_from_openapi_url() {
        let base_url =
            parse_external_api_base_url("https://scrappid3.example.test/v1/openapi.json", false)
                .expect("OpenAPI URL should normalize");
        let request_url = build_external_api_lookup_url(&base_url, LookupKind::Bag, "PID1", true)
            .expect("bag URL should build");

        assert_eq!(
            request_url.as_str(),
            "https://scrappid3.example.test/v1/bag/PID1"
        );
    }

    #[test]
    fn parses_external_api_v1_manifest_envelope() {
        let body = r#"{
          "meta": {
            "apiVersion": "v1",
            "schemaVersion": "shipflow.manifest.v1",
            "requestId": "req-1",
            "generatedAt": "2026-05-06T00:00:00Z"
          },
          "data": {
            "url": "https://example.test/v1/manifest/MAN1",
            "total_berat": "1200",
            "items": [
              {"nomor_kantung": "PID1", "status": "BAGGING"}
            ]
          },
          "warnings": []
        }"#;

        let parsed =
            parse_external_api_manifest_response(body).expect("v1 manifest envelope should parse");

        assert_eq!(parsed.total_berat.as_deref(), Some("1200"));
        assert_eq!(parsed.items[0].nomor_kantung.as_deref(), Some("PID1"));
    }

    #[test]
    fn parses_external_api_v1_status_envelope() {
        let body = r#"{
          "meta": {
            "apiVersion": "v1",
            "schemaVersion": "shipflow.service.status.v1",
            "requestId": "req-1",
            "generatedAt": "2026-05-06T00:00:00Z"
          },
          "data": {
            "service": "running",
            "mode": "lan",
            "bindAddress": "0.0.0.0",
            "port": 18422
          },
          "warnings": []
        }"#;

        let parsed =
            parse_external_api_status_response(body).expect("v1 status envelope should parse");

        assert_eq!(parsed.service.as_deref(), Some("running"));
        assert_eq!(parsed.mode.as_deref(), Some("lan"));
        assert_eq!(parsed.bind_address.as_deref(), Some("0.0.0.0"));
        assert_eq!(parsed.port, Some(18422));
    }
}
