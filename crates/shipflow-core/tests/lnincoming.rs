use base64::{engine::general_purpose::STANDARD, Engine as _};
use shipflow_core::parser::parse_tracking_html;

const LNINCOMING_HTML: &str = include_str!("fixtures/pos_tracking_lnincoming.html");

#[test]
fn lnincoming_contacts_preserve_labeled_fields_and_exact_shipment_identity() {
    for id in ["RY000000001IL", "RY000000001ILX13"] {
        let html = LNINCOMING_HTML.replace("RY000000001ILX13", id);
        let url = format!("https://example.test/detail?id={}", STANDARD.encode(id));
        let response = parse_tracking_html(&url, &html).unwrap();
        let actors = &response.detail.actors;
        assert_eq!(actors.pengirim.nama.as_deref(), Some("İlhan Example"));
        assert_eq!(actors.pengirim.telepon, None);
        assert_eq!(
            actors.pengirim.alamat.as_deref(),
            Some("Example Road, TEL AVIV YAFO IL")
        );
        assert_eq!(actors.penerima.nama.as_deref(), Some("Recipient Example"));
        assert_eq!(actors.penerima.telepon.as_deref(), Some("081234567890"));
        assert_eq!(
            actors.penerima.alamat.as_deref(),
            Some("JL. EXAMPLE NO 15; RT 1 RW 1 JAYAPURA PAPUA 99113")
        );
        assert_eq!(actors.penerima.kode_pos, None);
        assert_eq!(
            response.detail.package.jenis_layanan.as_deref(),
            Some("LNINCOMING")
        );
        assert!(response.detail.billing.cod.is_cod);
        assert_eq!(response.detail.header.nomor_kiriman.as_deref(), Some(id));
        assert_eq!(response.shipment_identity.requested_id.as_deref(), Some(id));
        assert_eq!(
            response.shipment_identity.parent_shipment_id.as_deref(),
            Some(id)
        );
        assert!(!response.shipment_identity.is_koli);
    }
}

#[test]
fn lnincoming_missing_delivery_time_and_pod_stay_missing() {
    let response = parse_tracking_html("https://example.test", LNINCOMING_HTML).unwrap();
    assert_eq!(response.status_akhir.status.as_deref(), Some("DELIVERED"));
    assert_eq!(
        response.status_akhir.location.as_deref(),
        Some("DC JAYAPURA 9910A")
    );
    assert_eq!(
        response.status_akhir.officer_name.as_deref(),
        Some("Courier Example")
    );
    assert_eq!(
        response.status_akhir.officer_id.as_deref(),
        Some("123456789")
    );
    assert_eq!(response.status_akhir.datetime, None);
    assert_eq!(response.status_akhir.date, None);
    assert_eq!(response.status_akhir.time, None);
    assert_eq!(response.pod.photo1_url, None);
    assert_eq!(response.pod.photo2_url, None);
    assert_eq!(response.pod.signature_url, None);
    assert_eq!(response.pod.coordinate, None);
    assert_eq!(response.history.len(), 3);
    assert!(response.history_summary.delivery_runsheet.is_empty());
}

#[test]
fn lnincoming_zero_recipient_phone_is_missing() {
    let html = LNINCOMING_HTML.replace("081234567890", "0");
    let response = parse_tracking_html("https://example.test", &html).unwrap();
    assert_eq!(
        response.detail.actors.penerima.nama.as_deref(),
        Some("Recipient Example")
    );
    assert_eq!(response.detail.actors.penerima.telepon, None);
}

#[test]
fn lnincoming_valid_delivery_time_and_pod_are_preserved() {
    let html = LNINCOMING_HTML
        .replace(
            "Tanggal : diterima oleh",
            "Tanggal : 2026-10-02 15:30:45 diterima oleh Recipient Example",
        )
        .replacen(
            "data:image/jpeg;base64,",
            "https://example.test/photo.jpg",
            1,
        )
        .replacen(
            "data:image/jpeg;base64,",
            "https://example.test/photo2.jpg",
            1,
        )
        .replacen(
            "<th>-</th>",
            "<th><img src=\"https://example.test/photo3.jpg\"></th>",
            1,
        )
        .replacen(
            "data:image/jpeg;base64,",
            "https://example.test/signature.jpg",
            1,
        );
    let response = parse_tracking_html("https://example.test", &html).unwrap();
    assert_eq!(
        response.status_akhir.datetime.as_deref(),
        Some("2026-10-02 15:30:45")
    );
    assert_eq!(response.status_akhir.date.as_deref(), Some("2026-10-02"));
    assert_eq!(response.status_akhir.time.as_deref(), Some("15:30:45"));
    assert_eq!(
        response.pod.photo1_url.as_deref(),
        Some("https://example.test/photo.jpg")
    );
    assert_eq!(
        response.pod.photo2_url.as_deref(),
        Some("https://example.test/photo2.jpg")
    );
    assert_eq!(
        response.pod.signature_url.as_deref(),
        Some("https://example.test/signature.jpg")
    );
}

#[test]
fn lnincoming_label_spacing_and_inline_markup_do_not_merge_fields() {
    let html = r#"<table>
        <tr><td>Nomor Kiriman</td><td>RY000000001IL</td></tr>
        <tr><td>Pengirim</td><td>İlhan, aLaMaT: Example Road<br>TLP PENGIRIM: <b>+972 (50) 123-4567</b></td></tr>
        <tr><td>Penerima</td><td>Émile, Alamat: JL. Example, Papua<br>Tlp Penerima: <b>081234567890</b>Status Kiriman: <b>403 - Rilis Bebas Pajak</b></td></tr>
        </table>"#;
    let response = parse_tracking_html("https://example.test", html).unwrap();
    assert_eq!(
        response.detail.actors.pengirim.nama.as_deref(),
        Some("İlhan")
    );
    assert_eq!(
        response.detail.actors.pengirim.alamat.as_deref(),
        Some("Example Road")
    );
    assert_eq!(
        response.detail.actors.pengirim.telepon.as_deref(),
        Some("+972 (50) 123-4567")
    );
    assert_eq!(
        response.detail.actors.penerima.alamat.as_deref(),
        Some("JL. Example, Papua")
    );
    assert_eq!(
        response.detail.actors.penerima.telepon.as_deref(),
        Some("081234567890")
    );
}

#[test]
fn domestic_semicolon_contacts_remain_supported() {
    let html = r#"<table>
        <tr><td>Nomor Kiriman</td><td>P1</td></tr>
        <tr><td>Pengirim</td><td>Sender; 081234567890; JL. Example, Alamat: Office; Block A; 12345</td></tr>
        <tr><td>Penerima</td><td>Recipient; 081234567891; JL. Other; 99113</td></tr>
        </table>"#;
    let response = parse_tracking_html("https://example.test", html).unwrap();
    assert_eq!(
        response.detail.actors.pengirim.alamat.as_deref(),
        Some("JL. Example, Alamat: Office; Block A")
    );
    assert_eq!(
        response.detail.actors.pengirim.kode_pos.as_deref(),
        Some("12345")
    );
    assert_eq!(
        response.detail.actors.penerima.telepon.as_deref(),
        Some("081234567891")
    );
}
