use std::{
    fmt::Write as _,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, bail, Result};
use hmac::{Hmac, Mac};
use rand::Rng;
use reqwest::{Client, Url};
use serde::Serialize;
use sha2::Sha256;
use tracing::warn;

use crate::{
    config::AppConfig,
    incidents::{IncidentSeverity, IncidentStore, ServiceIncidentEvent},
    metrics::Metrics,
    request_context::current_request_context,
};

type HmacSha256 = Hmac<Sha256>;

const HEADER_WEBHOOK_LEGACY_SECRET: &str = "X-Scrap-Webhook-Secret";
const HEADER_WEBHOOK_ID: &str = "X-Scrap-Webhook-Id";
const HEADER_WEBHOOK_EVENT: &str = "X-Scrap-Webhook-Event";
const HEADER_WEBHOOK_TIMESTAMP: &str = "X-Scrap-Webhook-Timestamp";
const HEADER_WEBHOOK_ATTEMPT: &str = "X-Scrap-Webhook-Attempt";
const HEADER_WEBHOOK_SIGNATURE: &str = "X-Scrap-Webhook-Signature";

#[derive(Clone, Copy)]
pub struct WebhookDelivery<'a> {
    pub event: &'a str,
    pub incident_store: Option<&'a IncidentStore>,
    pub incident_path: Option<&'a str>,
}

pub async fn validate_webhook_url_submission(config: &AppConfig, raw_url: &str) -> Result<Url> {
    let url = parse_webhook_url(raw_url)?;
    validate_webhook_url(config, &url, false).await?;
    Ok(url)
}

async fn validate_webhook_url_delivery(config: &AppConfig, raw_url: &str) -> Result<Url> {
    let url = parse_webhook_url(raw_url)?;
    validate_webhook_url(config, &url, true).await?;
    Ok(url)
}

pub async fn deliver_json_webhook<T: Serialize>(
    client: &Client,
    config: &AppConfig,
    metrics: &Metrics,
    delivery: WebhookDelivery<'_>,
    url: &str,
    payload: &T,
) -> bool {
    let validated_url = match validate_webhook_url_delivery(config, url).await {
        Ok(url) => url,
        Err(err) => {
            warn!(error = %err, url, "webhook target rejected by SSRF guard");
            metrics.inc_webhook_failure();
            record_webhook_incident(
                delivery.incident_store,
                IncidentSeverity::Warning,
                "WEBHOOK_TARGET_REJECTED",
                "webhook target rejected by delivery guard".to_string(),
                delivery.incident_path,
            );
            return false;
        }
    };

    let attempts = config.webhook_max_attempts.max(1);
    let timeout_secs = config.webhook_timeout_secs.max(1);
    let payload_bytes = match serde_json::to_vec(payload) {
        Ok(bytes) => bytes,
        Err(err) => {
            warn!(error = %err, "failed to serialize webhook payload");
            metrics.inc_webhook_failure();
            record_webhook_incident(
                delivery.incident_store,
                IncidentSeverity::Critical,
                "WEBHOOK_PAYLOAD_SERIALIZATION",
                "failed to serialize webhook payload".to_string(),
                delivery.incident_path,
            );
            return false;
        }
    };

    let secret = config
        .webhook_secret
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string);
    let delivery_id = generate_webhook_delivery_id();

    for attempt in 1..=attempts {
        metrics.inc_webhook_attempt();
        let timestamp_secs = current_unix_timestamp_secs();

        let mut req = client
            .post(validated_url.clone())
            .timeout(Duration::from_secs(timeout_secs))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(HEADER_WEBHOOK_ID, delivery_id.as_str())
            .header(HEADER_WEBHOOK_EVENT, delivery.event)
            .header(HEADER_WEBHOOK_TIMESTAMP, timestamp_secs.to_string())
            .header(HEADER_WEBHOOK_ATTEMPT, attempt.to_string())
            .body(payload_bytes.clone());

        if let Some(secret) = &secret {
            req = req.header(
                HEADER_WEBHOOK_SIGNATURE,
                build_webhook_signature(
                    secret,
                    delivery.event,
                    &delivery_id,
                    attempt,
                    timestamp_secs,
                    &payload_bytes,
                ),
            );
            if config.webhook_include_legacy_secret_header {
                req = req.header(HEADER_WEBHOOK_LEGACY_SECRET, secret);
            }
        }

        match req.send().await {
            Ok(resp) if resp.status().is_success() => {
                metrics.inc_webhook_success();
                return true;
            }
            Ok(resp) => {
                warn!(
                    status = %resp.status(),
                    attempt,
                    attempts,
                    url = %validated_url,
                    "webhook returned non-success status"
                );
            }
            Err(err) => {
                warn!(error = %err, attempt, attempts, url = %validated_url, "webhook request failed");
            }
        }

        if attempt < attempts {
            let base_delay = config
                .webhook_base_delay_ms
                .saturating_mul(2u64.pow(attempt - 1));
            let jitter = rand::rng().random_range(0..100);
            tokio::time::sleep(Duration::from_millis(base_delay + jitter)).await;
        }
    }

    metrics.inc_webhook_failure();
    record_webhook_incident(
        delivery.incident_store,
        IncidentSeverity::Warning,
        "WEBHOOK_DELIVERY_FAILED",
        "webhook delivery failed after retry attempts".to_string(),
        delivery.incident_path,
    );
    false
}

fn generate_webhook_delivery_id() -> String {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let random = rand::rng().random::<u64>();
    format!("wh_{now_ms:013x}_{random:016x}")
}

fn current_unix_timestamp_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn build_webhook_signature(
    secret: &str,
    event: &str,
    delivery_id: &str,
    attempt: u32,
    timestamp_secs: u64,
    payload_bytes: &[u8],
) -> String {
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC-SHA256 accepts any key size");
    mac.update(timestamp_secs.to_string().as_bytes());
    mac.update(b"\n");
    mac.update(delivery_id.as_bytes());
    mac.update(b"\n");
    mac.update(attempt.to_string().as_bytes());
    mac.update(b"\n");
    mac.update(event.as_bytes());
    mac.update(b"\n");
    mac.update(payload_bytes);
    let digest = mac.finalize().into_bytes();
    format!("v1={}", to_lower_hex(&digest))
}

fn to_lower_hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut output, "{byte:02x}").expect("writing to String should not fail");
    }
    output
}

fn record_webhook_incident(
    incident_store: Option<&IncidentStore>,
    severity: IncidentSeverity,
    code: &str,
    message: String,
    path: Option<&str>,
) {
    let Some(store) = incident_store else {
        return;
    };

    let request_context = current_request_context();
    store.record(ServiceIncidentEvent {
        kind: "webhook".to_string(),
        severity,
        code: code.to_string(),
        message,
        request_id: request_context
            .as_ref()
            .map(|context| context.request_id.clone()),
        path: path
            .map(ToString::to_string)
            .or_else(|| request_context.map(|context| context.path)),
    });
}

fn parse_webhook_url(raw_url: &str) -> Result<Url> {
    Url::parse(raw_url).map_err(|_| anyhow!("webhook_url is not a valid URL"))
}

async fn validate_webhook_url(config: &AppConfig, url: &Url, resolve_dns: bool) -> Result<()> {
    if !matches!(url.scheme(), "http" | "https") {
        bail!("webhook_url scheme must be http or https");
    }
    if !url.username().is_empty() || url.password().is_some() {
        bail!("webhook_url must not contain URL credentials");
    }
    if url.fragment().is_some() {
        bail!("webhook_url must not contain URL fragment");
    }

    let host = url
        .host_str()
        .map(|v| v.to_ascii_lowercase())
        .ok_or_else(|| anyhow!("webhook_url must include a host"))?;

    if is_allowlisted_host(config, &host) {
        return Ok(());
    }

    validate_public_host(&host)?;

    if resolve_dns && host.parse::<IpAddr>().is_err() {
        validate_public_dns_resolution(&host, url.port_or_known_default().unwrap_or(443)).await?;
    }

    Ok(())
}

fn is_allowlisted_host(config: &AppConfig, host: &str) -> bool {
    if config.webhook_allowed_hosts.is_empty() {
        return false;
    }

    config
        .webhook_allowed_hosts
        .iter()
        .any(|allowed| allowed == host)
}

fn validate_public_host(host: &str) -> Result<()> {
    if host == "localhost" || host.ends_with(".localhost") {
        bail!("webhook_url must not target localhost");
    }

    if let Ok(ip) = host.parse::<IpAddr>() {
        if !is_public_ip(ip) {
            bail!("webhook_url must not target a private or reserved IP");
        }
        return Ok(());
    }

    if !host.contains('.') {
        bail!("webhook_url host must be a public hostname or an allowlisted internal host");
    }

    Ok(())
}

async fn validate_public_dns_resolution(host: &str, port: u16) -> Result<()> {
    let mut resolved_any = false;
    for resolved in tokio::net::lookup_host((host, port)).await? {
        resolved_any = true;
        if !is_public_ip(resolved.ip()) {
            bail!("webhook_url resolves to a private or reserved IP");
        }
    }

    if !resolved_any {
        bail!("webhook_url host did not resolve");
    }

    Ok(())
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_ipv4(v4),
        IpAddr::V6(v6) => is_public_ipv6(v6),
    }
}

fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    if ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_unspecified()
        || ip.is_multicast()
    {
        return false;
    }

    let [a, b, c, d] = ip.octets();
    let shared = a == 100 && (64..=127).contains(&b);
    let future_reserved = a >= 240;
    let protocol_assignments = a == 192 && b == 0 && c == 0;
    let benchmarking = a == 198 && (b == 18 || b == 19);
    let six_to_four_relay = a == 192 && b == 88 && c == 99;
    let old_reserved = a == 0;
    let dummy = a == 192 && b == 0 && c == 2 && d == 0;

    !(shared
        || future_reserved
        || protocol_assignments
        || benchmarking
        || six_to_four_relay
        || old_reserved
        || dummy)
}

fn is_public_ipv6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    let documentation = segments[0] == 0x2001 && segments[1] == 0x0db8;

    if ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_unique_local()
        || ip.is_unicast_link_local()
        || documentation
    {
        return false;
    }

    let ipv4_mapped = segments[0] == 0
        && segments[1] == 0
        && segments[2] == 0
        && segments[3] == 0
        && segments[4] == 0
        && segments[5] == 0xffff;

    if ipv4_mapped {
        let octets = ip.octets();
        return is_public_ipv4(Ipv4Addr::new(
            octets[12], octets[13], octets[14], octets[15],
        ));
    }

    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::oneshot;

    use crate::{incidents::IncidentStore, metrics::Metrics};

    fn test_config() -> AppConfig {
        AppConfig {
            port: 3000,
            track_url: "https://example.com/track?id=".to_string(),
            bag_url: "https://example.com/bag?id=".to_string(),
            manifest_url: "https://example.com/manifest?id=".to_string(),
            http_max_concurrency: 4,
            http_timeout_secs: 5,
            cache_max_entries: 100,
            track_cache_ttl_secs: 10,
            bag_cache_ttl_secs: 10,
            manifest_cache_ttl_secs: 10,
            upstream_queue_timeout_secs: 1,
            retry_max_attempts: 2,
            retry_base_delay_ms: 10,
            stale_if_error_ttl_secs: 60,
            rate_limit_per_minute: 60,
            rate_limit_burst_capacity: 10,
            rate_limit_burst_window_secs: 10,
            rate_limit_classes: std::collections::HashMap::new(),
            rate_limit_scope_class_defaults: Vec::new(),
            batch_concurrency: 4,
            batch_max_items: 100,
            job_result_ttl_secs: 300,
            job_store_max_entries: 100,
            webhook_timeout_secs: 5,
            webhook_max_attempts: 2,
            webhook_base_delay_ms: 100,
            webhook_secret: None,
            webhook_include_legacy_secret_header: false,
            webhook_allowed_hosts: Vec::new(),
            persistent_cache_dir: None,
            persistent_cache_max_entries: 1000,
            persistent_cache_sweep_interval_secs: 60,
            parser_guard_max_events: 100,
            incident_max_events: 100,
            upstream_canary_enabled: false,
            upstream_canary_id: "P0000000000000".to_string(),
            upstream_canary_timeout_secs: 5,
            upstream_canary_min_body_bytes: 200,
            upstream_canary_fail_threshold: 3,
            upstream_canary_grace_secs: 60,
            trust_proxy_headers_for_ip_allowlist: false,
            api_token_state_file: None,
            managed_api_token_store_file: None,
            api_tokens: vec![crate::auth::ApiTokenConfig::legacy_full_access(
                "secret",
                "legacy-default",
            )],
        }
    }

    #[tokio::test]
    async fn submission_rejects_localhost_target() {
        let err = validate_webhook_url_submission(&test_config(), "http://localhost/hook")
            .await
            .expect_err("localhost must be rejected");
        assert!(err.to_string().contains("localhost"));
    }

    #[tokio::test]
    async fn submission_rejects_private_ip_target() {
        let err = validate_webhook_url_submission(&test_config(), "http://127.0.0.1/hook")
            .await
            .expect_err("private ip must be rejected");
        assert!(err.to_string().contains("private or reserved IP"));
    }

    #[tokio::test]
    async fn submission_rejects_url_credentials() {
        let err =
            validate_webhook_url_submission(&test_config(), "https://user:pass@example.com/hook")
                .await
                .expect_err("credentials must be rejected");
        assert!(err.to_string().contains("credentials"));
    }

    #[tokio::test]
    async fn allowlist_permits_internal_host() {
        let mut config = test_config();
        config.webhook_allowed_hosts = vec!["internal-webhook".to_string()];

        let url = validate_webhook_url_submission(&config, "http://internal-webhook/hook")
            .await
            .expect("allowlisted host should be accepted");

        assert_eq!(url.host_str(), Some("internal-webhook"));
    }

    #[tokio::test]
    async fn delivery_records_incident_when_target_is_rejected() {
        let store = IncidentStore::new(20, 60_000);
        let client = Client::builder()
            .timeout(Duration::from_secs(1))
            .build()
            .expect("client should build");
        let metrics = Metrics::default();

        let ok = deliver_json_webhook(
            &client,
            &test_config(),
            &metrics,
            WebhookDelivery {
                event: "track.detail.completed",
                incident_store: Some(&store),
                incident_path: Some("/v1/track/detail"),
            },
            "http://localhost/hook",
            &serde_json::json!({ "ok": true }),
        )
        .await;

        assert!(!ok);
        let snapshot = store.snapshot();
        assert_eq!(snapshot.total_incidents, 1);
        assert_eq!(snapshot.recent[0].code, "WEBHOOK_TARGET_REJECTED");
        assert_eq!(snapshot.recent[0].path.as_deref(), Some("/v1/track/detail"));
    }

    #[tokio::test]
    async fn delivery_records_incident_when_all_attempts_fail() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener should bind");
        let addr = listener.local_addr().expect("listener should have address");
        let server_task = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.expect("accept should succeed");
                let mut buf = [0u8; 1024];
                let _ = socket.read(&mut buf).await;
                socket
                    .write_all(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n")
                    .await
                    .expect("response should be written");
            }
        });

        let mut config = test_config();
        config.webhook_allowed_hosts = vec!["localhost".to_string()];
        config.webhook_max_attempts = 2;
        config.webhook_base_delay_ms = 0;

        let store = IncidentStore::new(20, 60_000);
        let client = Client::builder()
            .timeout(Duration::from_secs(1))
            .build()
            .expect("client should build");
        let metrics = Metrics::default();

        let ok = deliver_json_webhook(
            &client,
            &config,
            &metrics,
            WebhookDelivery {
                event: "track_lite_batch.completed",
                incident_store: Some(&store),
                incident_path: Some("/jobs/trackLiteBatch"),
            },
            &format!("http://localhost:{}/hook", addr.port()),
            &serde_json::json!({ "ok": true }),
        )
        .await;

        assert!(!ok);
        let snapshot = store.snapshot();
        assert_eq!(snapshot.total_incidents, 1);
        assert_eq!(snapshot.recent[0].code, "WEBHOOK_DELIVERY_FAILED");
        assert_eq!(snapshot.recent[0].severity, IncidentSeverity::Warning);
        assert_eq!(
            snapshot.recent[0].path.as_deref(),
            Some("/jobs/trackLiteBatch")
        );

        server_task.abort();
    }

    #[tokio::test]
    async fn delivery_includes_signed_headers_when_secret_is_configured() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener should bind");
        let addr = listener.local_addr().expect("listener should have address");
        let (request_tx, request_rx) = oneshot::channel();
        let server_task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept should succeed");
            let mut buf = [0u8; 4096];
            let size = socket
                .read(&mut buf)
                .await
                .expect("request should be readable");
            request_tx
                .send(String::from_utf8_lossy(&buf[..size]).to_string())
                .ok();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                .await
                .expect("response should be written");
        });

        let mut config = test_config();
        config.webhook_allowed_hosts = vec!["localhost".to_string()];
        config.webhook_secret = Some("super-secret".to_string());

        let client = Client::builder()
            .timeout(Duration::from_secs(1))
            .build()
            .expect("client should build");
        let metrics = Metrics::default();
        let payload = serde_json::json!({ "ok": true });

        let ok = deliver_json_webhook(
            &client,
            &config,
            &metrics,
            WebhookDelivery {
                event: "track.detail.completed",
                incident_store: None,
                incident_path: Some("/v1/track/detail"),
            },
            &format!("http://localhost:{}/hook", addr.port()),
            &payload,
        )
        .await;

        assert!(ok);
        let raw_request = request_rx.await.expect("request should be captured");
        let timestamp = header_value(&raw_request, HEADER_WEBHOOK_TIMESTAMP)
            .expect("timestamp header should exist");
        let delivery_id =
            header_value(&raw_request, HEADER_WEBHOOK_ID).expect("delivery id should exist");
        let signature = header_value(&raw_request, HEADER_WEBHOOK_SIGNATURE)
            .expect("signature header should exist");
        assert_eq!(
            header_value(&raw_request, HEADER_WEBHOOK_EVENT),
            Some("track.detail.completed")
        );
        assert_eq!(
            header_value(&raw_request, HEADER_WEBHOOK_ATTEMPT),
            Some("1")
        );
        assert!(delivery_id.starts_with("wh_"));
        assert!(header_value(&raw_request, HEADER_WEBHOOK_LEGACY_SECRET).is_none());

        let expected_signature = build_webhook_signature(
            "super-secret",
            "track.detail.completed",
            delivery_id,
            1,
            timestamp.parse().expect("timestamp should be numeric"),
            br#"{"ok":true}"#,
        );
        assert_eq!(signature, expected_signature);

        server_task.abort();
    }

    #[tokio::test]
    async fn delivery_can_emit_legacy_plaintext_secret_header_when_enabled() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener should bind");
        let addr = listener.local_addr().expect("listener should have address");
        let (request_tx, request_rx) = oneshot::channel();
        let server_task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept should succeed");
            let mut buf = [0u8; 4096];
            let size = socket
                .read(&mut buf)
                .await
                .expect("request should be readable");
            request_tx
                .send(String::from_utf8_lossy(&buf[..size]).to_string())
                .ok();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                .await
                .expect("response should be written");
        });

        let mut config = test_config();
        config.webhook_allowed_hosts = vec!["localhost".to_string()];
        config.webhook_secret = Some("legacy-secret".to_string());
        config.webhook_include_legacy_secret_header = true;

        let client = Client::builder()
            .timeout(Duration::from_secs(1))
            .build()
            .expect("client should build");
        let metrics = Metrics::default();

        let ok = deliver_json_webhook(
            &client,
            &config,
            &metrics,
            WebhookDelivery {
                event: "track_lite_batch.completed",
                incident_store: None,
                incident_path: Some("/jobs/trackLiteBatch"),
            },
            &format!("http://localhost:{}/hook", addr.port()),
            &serde_json::json!({ "ok": true }),
        )
        .await;

        assert!(ok);
        let raw_request = request_rx.await.expect("request should be captured");
        assert_eq!(
            header_value(&raw_request, HEADER_WEBHOOK_LEGACY_SECRET),
            Some("legacy-secret")
        );
        assert!(header_value(&raw_request, HEADER_WEBHOOK_SIGNATURE).is_some());

        server_task.abort();
    }

    fn header_value<'a>(raw_request: &'a str, header_name: &str) -> Option<&'a str> {
        raw_request.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name.eq_ignore_ascii_case(header_name) {
                Some(value.trim())
            } else {
                None
            }
        })
    }
}
