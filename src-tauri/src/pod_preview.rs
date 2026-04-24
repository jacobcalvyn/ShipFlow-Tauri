use std::net::IpAddr;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use reqwest::{
    header::{CONTENT_TYPE, LOCATION},
    redirect::Policy,
    Url,
};
use scraper::{Html as ScraperHtml, Selector};

use crate::tracking::upstream::resolve_pos_href;

const MAX_POD_IMAGE_BYTES: usize = 5 * 1024 * 1024;

fn build_pod_preview_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .read_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(15))
        .redirect(Policy::none())
        .user_agent("ShipFlow Desktop POD Preview/0.1")
        .build()
        .map_err(|error| format!("Unable to create restricted POD client: {error}"))
}

fn is_forbidden_remote_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ipv4) => {
            ipv4.is_private()
                || ipv4.is_loopback()
                || ipv4.is_link_local()
                || ipv4.is_multicast()
                || ipv4.is_unspecified()
        }
        IpAddr::V6(ipv6) => {
            ipv6.is_loopback()
                || ipv6.is_multicast()
                || ipv6.is_unspecified()
                || ipv6.is_unique_local()
                || ipv6.is_unicast_link_local()
        }
    }
}

pub(crate) async fn validate_remote_pod_url(url: &Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("POD image source must use HTTP(S).".into());
    }

    let Some(host) = url.host_str() else {
        return Err("POD image source host is missing.".into());
    };

    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".local") {
        return Err("POD image source host is not allowed.".into());
    }

    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_forbidden_remote_ip(ip) {
            return Err("POD image source host is not allowed.".into());
        }
        return Ok(());
    }

    let port = url.port_or_known_default().unwrap_or(443);
    let mut resolved_any = false;
    let resolved_hosts = tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| format!("Unable to resolve POD image host: {error}"))?;

    for socket_addr in resolved_hosts {
        resolved_any = true;
        if is_forbidden_remote_ip(socket_addr.ip()) {
            return Err("POD image source host is not allowed.".into());
        }
    }

    if !resolved_any {
        return Err("POD image source host did not resolve.".into());
    }

    Ok(())
}

fn normalize_remote_pod_url(image_source: &str) -> Result<Url, String> {
    let normalized = if image_source.starts_with("http://") || image_source.starts_with("https://")
    {
        image_source.to_string()
    } else {
        resolve_pos_href(image_source)
    };

    Url::parse(&normalized).map_err(|error| format!("POD image source is invalid: {error}"))
}

async fn fetch_remote_pod_payload(
    client: &reqwest::Client,
    url: &Url,
    depth: u8,
) -> Result<(Option<String>, Vec<u8>), String> {
    if depth > 3 {
        return Err("POD image source redirected too many times.".into());
    }

    validate_remote_pod_url(url).await?;

    let response = client
        .get(url.clone())
        .send()
        .await
        .map_err(|error| format!("Unable to fetch POD image source: {error}"))?;

    if response.status().is_redirection() {
        let location = response
            .headers()
            .get(LOCATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| "POD image redirect is missing location header.".to_string())?;
        let next_url = url
            .join(location)
            .map_err(|error| format!("POD image redirect URL is invalid: {error}"))?;

        return Box::pin(fetch_remote_pod_payload(client, &next_url, depth + 1)).await;
    }

    if !response.status().is_success() {
        return Err(format!(
            "POD image source returned HTTP {}.",
            response.status()
        ));
    }

    if let Some(content_length) = response.content_length() {
        if content_length > MAX_POD_IMAGE_BYTES as u64 {
            return Err("POD image source is too large to preview safely.".into());
        }
    }

    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    let mut bytes = Vec::new();
    let mut response = response;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Unable to read POD image source response: {error}"))?
    {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > MAX_POD_IMAGE_BYTES {
            return Err("POD image source is too large to preview safely.".into());
        }
    }

    Ok((content_type, bytes))
}

pub(crate) async fn resolve_pod_image_source(
    image_source: &str,
    depth: u8,
) -> Result<String, String> {
    if depth > 3 {
        return Err("POD image source redirected too many times.".into());
    }

    let trimmed = image_source.trim();
    if trimmed.is_empty() {
        return Err("Image source is required.".into());
    }

    if trimmed.starts_with("data:image/") {
        return validate_data_image_url(trimmed);
    }

    if let Some(normalized) = normalize_base64_image(trimmed) {
        validate_base64_image_payload(&normalized)?;
        return Ok(base64_to_data_url(&normalized));
    }

    let url = normalize_remote_pod_url(trimmed)?;
    let client = build_pod_preview_client()?;
    let (content_type, bytes) = fetch_remote_pod_payload(&client, &url, depth).await?;

    if let Some(content_type) = content_type {
        let normalized_content_type = content_type.to_ascii_lowercase();
        if normalized_content_type.starts_with("image/svg+xml") {
            return Err("SVG POD images are not supported.".into());
        }

        if normalized_content_type.starts_with("image/") {
            return Ok(format!(
                "data:{content_type};base64,{}",
                STANDARD.encode(&bytes)
            ));
        }
    }

    let body_text = String::from_utf8_lossy(&bytes).trim().to_string();
    if body_text.starts_with("data:image/") {
        return validate_data_image_url(&body_text);
    }

    if let Some(data_image) = extract_data_image_from_text(&body_text) {
        return validate_data_image_url(&data_image);
    }

    if let Some(normalized) = normalize_base64_image(&body_text) {
        validate_base64_image_payload(&normalized)?;
        return Ok(base64_to_data_url(&normalized));
    }

    if let Some(next_source) = extract_image_source_from_html(&body_text) {
        let resolved_source = if next_source.starts_with("http://")
            || next_source.starts_with("https://")
            || next_source.starts_with("data:image/")
        {
            next_source
        } else {
            resolve_pos_href(&next_source)
        };

        return Box::pin(resolve_pod_image_source(&resolved_source, depth + 1)).await;
    }

    Err("POD image source did not resolve to a valid image payload.".into())
}

fn validate_data_image_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    let Some((metadata, payload)) = trimmed.split_once(',') else {
        return Err("POD data image payload is invalid.".into());
    };
    let normalized_metadata = metadata.to_ascii_lowercase();

    if !normalized_metadata.starts_with("data:image/") {
        return Err("POD data image must use an image media type.".into());
    }

    if normalized_metadata.starts_with("data:image/svg+xml") {
        return Err("SVG POD images are not supported.".into());
    }

    if !normalized_metadata.contains(";base64") {
        return Err("POD data image must be base64 encoded.".into());
    }

    let normalized_payload = normalize_base64_image(payload)
        .ok_or_else(|| "POD data image payload is invalid.".to_string())?;
    validate_base64_image_payload(&normalized_payload)?;

    Ok(format!("{metadata},{normalized_payload}"))
}

fn validate_base64_image_payload(normalized: &str) -> Result<(), String> {
    if normalized.starts_with("PHN2Zy") {
        return Err("SVG POD images are not supported.".into());
    }

    let decoded = STANDARD
        .decode(normalized)
        .map_err(|error| format!("POD image payload is invalid base64: {error}"))?;

    if decoded.len() > MAX_POD_IMAGE_BYTES {
        return Err("POD image source is too large to preview safely.".into());
    }

    Ok(())
}

fn extract_image_source_from_html(html: &str) -> Option<String> {
    let document = ScraperHtml::parse_document(html);
    let img_selector = Selector::parse("img").expect("valid selector");

    document.select(&img_selector).find_map(|img| {
        img.value()
            .attr("src")
            .or_else(|| img.value().attr("data-src"))
            .or_else(|| img.value().attr("data-original"))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn extract_data_image_from_text(value: &str) -> Option<String> {
    let start = value.find("data:image/")?;
    let remainder = &value[start..];
    let end = remainder
        .find(|ch: char| ch == '"' || ch == '\'' || ch.is_whitespace())
        .unwrap_or(remainder.len());
    let candidate = remainder[..end].trim().trim_end_matches(',').to_string();
    if candidate.starts_with("data:image/") {
        Some(candidate)
    } else {
        None
    }
}

pub(crate) fn normalize_base64_image(value: &str) -> Option<String> {
    let mut normalized = value.trim().to_string();

    if normalized.len() > 3 && normalized.starts_with("b\"") && normalized.ends_with('"') {
        normalized = normalized[2..normalized.len() - 1].to_string();
    } else if normalized.len() > 3 && normalized.starts_with("b'") && normalized.ends_with('\'') {
        normalized = normalized[2..normalized.len() - 1].to_string();
    }

    normalized = normalized
        .replace(['\r', '\n', '\t', ' '], "")
        .replace("base64,", "");

    if let Some((_, rest)) = normalized.split_once("data:image/") {
        if let Some((_, payload)) = rest.split_once(',') {
            normalized = payload.to_string();
        }
    }

    normalized = normalized.replace('-', "+").replace('_', "/");
    normalized = normalized.trim_matches('"').trim_matches('\'').to_string();

    if normalized.is_empty() {
        return None;
    }

    if !normalized
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '/' | '='))
    {
        return None;
    }

    let padding_length = normalized.len() % 4;
    if padding_length != 0 {
        normalized.push_str(&"=".repeat(4 - padding_length));
    }

    Some(normalized)
}

pub(crate) fn base64_to_data_url(normalized: &str) -> String {
    let mime_type = if normalized.starts_with("iVBOR") {
        "image/png"
    } else if normalized.starts_with("R0lGOD") {
        "image/gif"
    } else if normalized.starts_with("UklGR") {
        "image/webp"
    } else if normalized.starts_with("PHN2Zy") {
        "image/svg+xml"
    } else {
        "image/jpeg"
    };

    format!("data:{mime_type};base64,{normalized}")
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use reqwest::Url;

    use super::{
        base64_to_data_url, normalize_base64_image, validate_data_image_url,
        validate_remote_pod_url, MAX_POD_IMAGE_BYTES,
    };

    #[test]
    fn resolve_pod_base64_into_data_url() {
        let base64_png =
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z1xQAAAAASUVORK5CYII=";

        assert_eq!(
            base64_to_data_url(base64_png),
            format!("data:image/png;base64,{base64_png}")
        );
        assert_eq!(
            normalize_base64_image(base64_png),
            Some(base64_png.to_string())
        );
    }

    #[tokio::test]
    async fn rejects_private_loopback_pod_url() {
        let error = validate_remote_pod_url(
            &Url::parse("http://127.0.0.1/internal-preview.jpg").expect("url should parse"),
        )
        .await
        .expect_err("private loopback POD URL should be rejected");

        assert!(error.contains("not allowed"));
    }

    #[test]
    fn rejects_oversized_data_image_payload() {
        let oversized_payload =
            base64::engine::general_purpose::STANDARD.encode(vec![0; MAX_POD_IMAGE_BYTES + 1]);
        let error = validate_data_image_url(&format!("data:image/png;base64,{oversized_payload}"))
            .expect_err("oversized data image should be rejected");

        assert!(error.contains("too large"));
    }

    #[test]
    fn rejects_svg_data_image_payload() {
        let error = validate_data_image_url("data:image/svg+xml;base64,PHN2Zy8+")
            .expect_err("svg data image should be rejected");

        assert!(error.contains("SVG"));
    }
}
