mod tracking;

use std::time::Duration;

use tracking::model::TrackingClientState;
use tracking::upstream::scrape_pos_tracking;

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

pub fn run() {
    let tracking_client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(6))
        .read_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(25))
        .user_agent("ShipFlow Desktop/0.1")
        .build()
        .expect("failed to create tracking client");

    tauri::Builder::default()
        .manage(TrackingClientState {
            client: tracking_client,
        })
        .invoke_handler(tauri::generate_handler![track_shipment])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::tracking::model::TrackingError;
    use super::tracking::parser::parse_tracking_html;
    use super::tracking::upstream::{build_tracking_url, POS_TRACKING_ENDPOINT};

    const SAMPLE_HTML: &str = include_str!("fixtures/pos_tracking_sample.html");
    const NULLABLE_NUMERIC_HTML: &str =
        include_str!("fixtures/pos_tracking_nullable_numeric.html");
    const REORDERED_TABLES_HTML: &str =
        include_str!("fixtures/pos_tracking_reordered_tables.html");

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
}
