mod tracking;

use tracking::server::{get_tracking_server_config, start_tracking_server};

pub fn run() {
    let tracking_server = start_tracking_server().expect("failed to start tracking server");

    tauri::Builder::default()
        .manage(tracking_server)
        .invoke_handler(tauri::generate_handler![get_tracking_server_config])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::tracking::model::TrackingError;
    use super::tracking::parser::parse_tracking_html;
    use super::tracking::upstream::{build_tracking_url, POS_TRACKING_ENDPOINT};

    const SAMPLE_HTML: &str = include_str!("fixtures/pos_tracking_sample.html");

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
        let error = parse_tracking_html("https://example.test", "<html></html>")
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
}
