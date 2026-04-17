mod service;
mod tracking;

use std::collections::HashSet;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use reqwest::header::CONTENT_TYPE;
use scraper::{Html as ScraperHtml, Selector};
use service::{ApiServiceConfig, ApiServiceController, ApiServiceStatus};
use tauri::plugin::Builder as PluginBuilder;
use tauri::webview::PageLoadEvent;
use tracking::model::TrackingClientState;
use tracking::upstream::{resolve_pos_href, scrape_pos_tracking};

#[tauri::command]
async fn track_shipment(
    shipment_id: String,
    sheet_id: Option<String>,
    row_key: Option<String>,
    client_state: tauri::State<'_, TrackingClientState>,
) -> Result<tracking::model::TrackResponse, String> {
    let context = format!(
        "[sheetId={}, rowKey={}, shipmentId={}]",
        sheet_id.as_deref().unwrap_or("-"),
        row_key.as_deref().unwrap_or("-"),
        shipment_id.trim()
    );

    scrape_pos_tracking(&client_state.client, shipment_id.trim())
        .await
        .map_err(|error| match error {
            tracking::model::TrackingError::BadRequest(message)
            | tracking::model::TrackingError::NotFound(message)
            | tracking::model::TrackingError::Upstream(message) => {
                eprintln!("[ShipFlowBackend] {context} {message}");
                format!("{context} {message}")
            }
        })
}

#[tauri::command]
async fn resolve_pod_image(
    image_source: String,
    client_state: tauri::State<'_, TrackingClientState>,
) -> Result<String, String> {
    resolve_pod_image_source(&client_state.client, image_source.trim(), 0).await
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("External URL is required.".into());
    }

    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Err("Only HTTP(S) URLs can be opened.".into());
    }

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(trimmed);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", "", trimmed]);
        command
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(trimmed);
        command
    };

    command
        .spawn()
        .map_err(|error| format!("Unable to open external URL: {error}"))?;

    Ok(())
}

#[tauri::command]
async fn configure_api_service(
    config: ApiServiceConfig,
    client_state: tauri::State<'_, TrackingClientState>,
    service_controller: tauri::State<'_, ApiServiceController>,
) -> Result<ApiServiceStatus, String> {
    service_controller
        .configure(config, client_state.client.clone())
        .await
}

#[tauri::command]
fn get_api_service_status(
    service_controller: tauri::State<'_, ApiServiceController>,
) -> ApiServiceStatus {
    service_controller.status()
}

#[tauri::command]
fn log_frontend_runtime_event(level: String, message: String) {
    let normalized_level = level.trim().to_lowercase();
    let trimmed_message = message.trim();

    if trimmed_message.is_empty() {
        return;
    }

    eprintln!(
        "[ShipFlowFrontend][{}] {}",
        if normalized_level.is_empty() {
            "info"
        } else {
            &normalized_level
        },
        trimmed_message
    );
}

async fn resolve_pod_image_source(
    client: &reqwest::Client,
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
        return Ok(trimmed.to_string());
    }

    if let Some(normalized) = normalize_base64_image(trimmed) {
        return Ok(base64_to_data_url(&normalized));
    }

    let response = client
        .get(trimmed)
        .send()
        .await
        .map_err(|error| format!("Unable to fetch POD image source: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "POD image source returned HTTP {}.",
            response.status()
        ));
    }

    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Unable to read POD image source response: {error}"))?;

    if let Some(content_type) = content_type {
        if content_type.starts_with("image/") {
            return Ok(format!(
                "data:{content_type};base64,{}",
                STANDARD.encode(&bytes)
            ));
        }
    }

    let body_text = String::from_utf8_lossy(&bytes).trim().to_string();
    if body_text.starts_with("data:image/") {
        return Ok(body_text);
    }

    if let Some(data_image) = extract_data_image_from_text(&body_text) {
        return Ok(data_image);
    }

    if let Some(normalized) = normalize_base64_image(&body_text) {
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

        return Box::pin(resolve_pod_image_source(client, &resolved_source, depth + 1)).await;
    }

    Err("POD image source did not resolve to a valid image payload.".into())
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

fn normalize_base64_image(value: &str) -> Option<String> {
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

fn base64_to_data_url(normalized: &str) -> String {
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

#[derive(Clone, Default)]
struct MainWebviewNavigationGuard {
    initial_load_finished_for_labels: Arc<Mutex<HashSet<String>>>,
}

impl MainWebviewNavigationGuard {
    fn observe_navigation(&self, label: &str, url: &str) {
        if label != "main" {
            return;
        }

        let state = self
            .initial_load_finished_for_labels
            .lock()
            .expect("main webview navigation guard lock poisoned");

        if state.contains(label) {
            eprintln!(
                "[ShipFlowTauri] observed top-level navigation for webview '{label}' to {url}"
            );
        }
    }

    fn mark_initial_load_finished(&self, label: &str, url: &str) {
        if label != "main" {
            return;
        }

        let mut state = self
            .initial_load_finished_for_labels
            .lock()
            .expect("main webview navigation guard lock poisoned");

        if state.insert(label.to_string()) {
            eprintln!(
                "[ShipFlowTauri] recorded initial page load finish for webview '{label}' at {url}"
            );
        }
    }
}

pub fn run() {
    let tracking_client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(6))
        .read_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(25))
        .user_agent("ShipFlow Desktop/0.1")
        .build()
        .expect("failed to create tracking client");
    let navigation_guard = MainWebviewNavigationGuard::default();
    let navigation_guard_plugin = navigation_guard.clone();
    let page_load_guard_plugin = navigation_guard.clone();

    tauri::Builder::default()
        .manage(TrackingClientState {
            client: tracking_client,
        })
        .manage(ApiServiceController::default())
        .plugin(
            PluginBuilder::<tauri::Wry>::new("main-webview-navigation-guard")
                .on_navigation(move |webview, url| {
                    let label = webview.label().to_string();
                    navigation_guard_plugin.observe_navigation(&label, url.as_str());
                    true
                })
                .on_page_load(move |webview, payload| {
                    let label = webview.label().to_string();
                    let url = payload.url().to_string();

                    match payload.event() {
                        PageLoadEvent::Started => {
                            eprintln!(
                                "[ShipFlowTauri] page load started for webview '{label}' at {url}"
                            );
                        }
                        PageLoadEvent::Finished => {
                            page_load_guard_plugin.mark_initial_load_finished(&label, &url);
                        }
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            track_shipment,
            resolve_pod_image,
            open_external_url,
            log_frontend_runtime_event,
            configure_api_service,
            get_api_service_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{base64_to_data_url, normalize_base64_image};
    use super::tracking::model::TrackingError;
    use super::tracking::parser::parse_tracking_html;
    use super::tracking::upstream::{
        build_tracking_url, normalize_and_validate_shipment_id, POS_TRACKING_ENDPOINT,
    };

    const SAMPLE_HTML: &str = include_str!("fixtures/pos_tracking_sample.html");
    const NULLABLE_NUMERIC_HTML: &str =
        include_str!("fixtures/pos_tracking_nullable_numeric.html");
    const REORDERED_TABLES_HTML: &str =
        include_str!("fixtures/pos_tracking_reordered_tables.html");
    const RUNSHEET_FAILEDTODELIVERED_HTML: &str =
        include_str!("fixtures/pos_tracking_runsheet_failedtoddelivered.html");

    #[test]
    fn build_tracking_url_percent_encodes_base64_payload() {
        let url = build_tracking_url(POS_TRACKING_ENDPOINT, "P2603310114291");

        assert_eq!(
            url,
            "https://pid.posindonesia.co.id/lacak/admin/detail_lacak_banyak.php?id=UDI2MDMzMTAxMTQyOTE%3D"
        );
    }

    #[test]
    fn parse_tracking_html_matches_track_response_shape() {
        let response = parse_tracking_html(
            "https://pid.posindonesia.co.id/lacak/admin/detail_lacak_banyak.php?id=UDI2MDMzMTAxMTQyOTE%3D",
            SAMPLE_HTML,
        )
        .expect("sample should parse");

        assert_eq!(
            response.detail.header.nomor_kiriman.as_deref(),
            Some("P2603310114291")
        );
        assert_eq!(
            response.detail.package.jenis_layanan.as_deref(),
            Some("PKH")
        );
        assert_eq!(response.status_akhir.status.as_deref(), Some("INVEHICLE"));
        assert_eq!(
            response.pod.photo1_url.as_deref(),
            Some("https://apistorage.mile.app/v2-public/prod/pos/2026/04/13/sample-photo.jpg")
        );
        assert_eq!(
            response.pod.coordinate_map_url.as_deref(),
            Some(
                "https://pid.posindonesia.co.id/lacak/admin/mapnya.php?id=LTIuNTQyNTU2NiwxNDAuNzA3MDQwNQ%3D%3D"
            )
        );
        assert_eq!(response.history.len(), 2);
        assert_eq!(response.history[0].tanggal_update, "2026-04-13 11:01:13");
        assert_eq!(response.history_summary.delivery_runsheet.len(), 1);
        assert_eq!(response.history_summary.delivery_runsheet[0].updates.len(), 1);
    }

    #[test]
    fn parse_tracking_html_returns_not_found_when_shipment_header_missing() {
        let html = r#"
            <html>
              <body>
                <div>Data tidak ditemukan untuk kiriman ini.</div>
              </body>
            </html>
        "#;

        let error = parse_tracking_html("https://example.test", html)
            .expect_err("missing details should fail");

        assert!(matches!(error, TrackingError::NotFound(_)));
    }

    #[test]
    fn parse_tracking_html_returns_upstream_error_for_invalid_numeric_fields() {
        let html = r#"
            <table>
              <tr><td>Nomor Kiriman</td><td>P2603310114291</td></tr>
              <tr><td>Bea Dasar</td><td>Rp not-a-number</td></tr>
            </table>
        "#;

        let error = parse_tracking_html("https://example.test", html)
            .expect_err("invalid numeric values should fail loudly");

        assert!(matches!(error, TrackingError::Upstream(_)));
    }

    #[test]
    fn parse_tracking_html_keeps_nullable_numeric_fields_as_none() {
        let response = parse_tracking_html("https://example.test", NULLABLE_NUMERIC_HTML)
            .expect("nullable numeric sample should parse");

        assert_eq!(response.detail.package.berat_actual, None);
        assert_eq!(response.detail.package.berat_volumetric, None);
        assert_eq!(response.detail.billing.bea_dasar, None);
        assert_eq!(response.detail.billing.nilai_barang, None);
        assert_eq!(response.detail.billing.htnb, None);
        assert_eq!(response.detail.billing.cod.total_cod, None);
    }

    #[test]
    fn parse_tracking_html_survives_reordered_tables() {
        let response = parse_tracking_html("https://example.test", REORDERED_TABLES_HTML)
            .expect("reordered tables sample should parse");

        assert_eq!(
            response.detail.header.nomor_kiriman.as_deref(),
            Some("P2603310116000")
        );
        assert_eq!(response.history.len(), 2);
        assert_eq!(
            response.pod.photo1_url.as_deref(),
            Some("https://apistorage.mile.app/v2-public/prod/pos/2026/04/14/sample-photo.jpg")
        );
    }

    #[test]
    fn parse_tracking_html_selected_fields_match_snapshot() {
        let response = parse_tracking_html("https://example.test", SAMPLE_HTML)
            .expect("sample should parse");

        let snapshot = json!({
            "nomor_kiriman": response.detail.header.nomor_kiriman,
            "jenis_layanan": response.detail.package.jenis_layanan,
            "status_akhir": response.status_akhir.status,
            "history_count": response.history.len(),
            "delivery_runsheet_count": response.history_summary.delivery_runsheet.len(),
        });

        assert_eq!(
            snapshot,
            json!({
                "nomor_kiriman": "P2603310114291",
                "jenis_layanan": "PKH",
                "status_akhir": "INVEHICLE",
                "history_count": 2,
                "delivery_runsheet_count": 1
            })
        );
    }

    #[test]
    fn parse_tracking_html_distinguishes_partial_upstream_from_not_found() {
        let html = r#"
            <html>
              <body>
                <div>Halaman tracking POS aktif tetapi struktur detail berubah total.</div>
              </body>
            </html>
        "#;

        let error = parse_tracking_html("https://example.test", html)
            .expect_err("partial upstream html should not be treated as not found");

        assert!(matches!(error, TrackingError::Upstream(_)));
    }

    #[test]
    fn parse_tracking_html_maps_failedtoddelivered_as_single_runsheet_update() {
        let response = parse_tracking_html("https://example.test", RUNSHEET_FAILEDTODELIVERED_HTML)
            .expect("failedtoddelivered runsheet sample should parse");

        let runsheet = &response.history_summary.delivery_runsheet[0];
        assert_eq!(runsheet.updates.len(), 1);
        assert_eq!(
            runsheet.updates[0].status.as_deref(),
            Some("FAILEDTODELIVERED")
        );
        assert_eq!(
            runsheet.updates[0].keterangan_status.as_deref(),
            Some("YANG BERSANGKUTAN TIDAK DITEMPAT")
        );
    }

    #[test]
    fn parse_tracking_html_keeps_synthetic_delivered_for_exact_delivered_status() {
        let html = r#"
            <table>
              <tr><td>Nomor Kiriman</td><td>P2603310999999</td></tr>
              <tr><td>Status Akhir</td><td>DELIVERED di DC JAYAPURA 9910A [Kurir/9910bkurir] [2026-04-15 11:51:34]</td></tr>
            </table>
            <table>
              <tr><td>TANGGAL UPDATE</td><td>DETAIL HISTORY</td></tr>
              <tr>
                <td>2026-04-15 11:40:47</td>
                <td>Barang P2603310999999 anda telah melewati proses DeliveryRunsheet oleh Akbar di DC JAYAPURA 9910A diterima oleh Kurir</td>
              </tr>
            </table>
        "#;

        let response = parse_tracking_html("https://example.test", html)
            .expect("synthetic delivered sample should parse");

        let runsheet = &response.history_summary.delivery_runsheet[0];
        assert_eq!(runsheet.updates.len(), 1);
        assert_eq!(runsheet.updates[0].status.as_deref(), Some("DELIVERED"));
        assert_eq!(runsheet.updates[0].keterangan_status, None);
    }

    #[test]
    fn parse_tracking_html_keeps_only_latest_effective_update_per_runsheet() {
        let html = r#"
            <table>
              <tr><td>Nomor Kiriman</td><td>P2603310888888</td></tr>
              <tr><td>Status Akhir</td><td>FAILEDTODELIVERED di DC JAYAPURA 9910A [Kurir/9910bkurir] [2026-04-15 14:50:02]</td></tr>
            </table>
            <table>
              <tr><td>TANGGAL UPDATE</td><td>DETAIL HISTORY</td></tr>
              <tr>
                <td>2026-04-15 11:40:47</td>
                <td>Barang P2603310888888 anda telah melewati proses DeliveryRunsheet oleh Akbar di DC JAYAPURA 9910A diterima oleh Kurir</td>
              </tr>
              <tr>
                <td>2026-04-15 14:00:00</td>
                <td>Barang P2603310888888 anda telah melewati proses antaran oleh Gabriel Erick Taurui dengan keterangan (ALAMAT TIDAK DITEMUKAN)</td>
              </tr>
              <tr>
                <td>2026-04-15 14:50:02</td>
                <td>Barang P2603310888888 anda telah melewati proses antaran oleh Gabriel Erick Taurui dengan keterangan (YANG BERSANGKUTAN TIDAK DITEMPAT)</td>
              </tr>
            </table>
        "#;

        let response = parse_tracking_html("https://example.test", html)
            .expect("multi-update runsheet sample should parse");

        let runsheet = &response.history_summary.delivery_runsheet[0];
        assert_eq!(runsheet.updates.len(), 1);
        assert_eq!(
            runsheet.updates[0].status.as_deref(),
            Some("FAILEDTODELIVERED")
        );
        assert_eq!(
            runsheet.updates[0].keterangan_status.as_deref(),
            Some("YANG BERSANGKUTAN TIDAK DITEMPAT")
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
    fn parse_tracking_html_keeps_data_image_pod_src_as_is() {
        let html = r#"
            <table>
              <tr><td>Nomor Kiriman</td><td>P2603310114291</td></tr>
              <tr><td>Status Akhir</td><td>DELIVERED - DC JAYAPURA [Kurir/9910bkurir] [2026-04-15 11:51:34]</td></tr>
            </table>
            <table>
              <tr>
                <th>POD</th>
                <th>Photo</th>
                <th>Photo2</th>
                <th>signature</th>
                <th>coordinate</th>
              </tr>
              <tr>
                <td></td>
                <td><img src="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD" /></td>
                <td><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" /></td>
                <td></td>
                <td>-2.5,140.7</td>
              </tr>
            </table>
        "#;

        let response = parse_tracking_html("https://example.test", html)
            .expect("data image pod sample should parse");

        assert_eq!(
            response.pod.photo1_url.as_deref(),
            Some("data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD")
        );
        assert_eq!(
            response.pod.photo2_url.as_deref(),
            Some("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB")
        );
    }

    #[test]
    fn resolve_pod_base64_into_data_url() {
        let base64_png =
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z1xQAAAAASUVORK5CYII=";

        assert_eq!(
            base64_to_data_url(base64_png),
            format!("data:image/png;base64,{base64_png}")
        );
        assert_eq!(normalize_base64_image(base64_png), Some(base64_png.to_string()));
    }
}
