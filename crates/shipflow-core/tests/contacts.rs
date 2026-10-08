use shipflow_core::parser::{normalize_contact_phone, parse_shipment_contact_html_checked};

fn page(id: &str, sender: &str, recipient: &str) -> String {
    format!("<table><tr><td>Nomor Kiriman</td><td>{id}</td></tr><tr><td>Pengirim</td><td>{sender}</td></tr><tr><td>Penerima</td><td>{recipient}</td></tr></table>")
}

#[test]
fn blank_phone_keeps_domestic_columns_in_place() {
    let result = parse_shipment_contact_html_checked(
        &page(
            "P1",
            "Sender;;1234567890 Street;99100;",
            "Recipient;081234567890;Address;99100;",
        ),
        "P1",
    )
    .unwrap();
    assert!(result.pengirim.telepon.is_none());
    assert_eq!(result.penerima.telepon.as_deref(), Some("081234567890"));
}

#[test]
fn rejects_placeholders_and_preserves_phone_format() {
    for value in [
        "0",
        "00000000",
        "-",
        "null",
        "Address 081234567890",
        "123456",
        "12345678901234567",
    ] {
        assert!(normalize_contact_phone(value).is_none(), "{value}");
    }
    assert_eq!(
        normalize_contact_phone(" +62 (812) 3456-7890 ").as_deref(),
        Some("+62 (812) 3456-7890")
    );
}

#[test]
fn validates_exact_shipment_identity_including_notice_and_koli_suffixes() {
    for id in ["RY507292681IL", "RY507292681ILX13", "P1.1"] {
        let html = page(
            id,
            "Sender;081234567890;Address;99100",
            "Recipient;081234567891;Address;99100",
        );
        assert!(parse_shipment_contact_html_checked(&html, id).is_ok());
        assert!(parse_shipment_contact_html_checked(&html, "P1").is_err());
    }
    assert!(parse_shipment_contact_html_checked(
        &page("RY507292681IL", "", ""),
        "RY507292681ILX13"
    )
    .is_err());
}

#[test]
fn labeled_contacts_keep_separation_between_inline_text_nodes() {
    let result = parse_shipment_contact_html_checked(&page("P1", "Sender, Alamat: Address, Tlp Pengirim: <b>081234567890</b>", "Recipient, Alamat: Address<br>Tlp Penerima: <b>081234567891</b><b>Status Kiriman:</b> 403"), "P1").unwrap();
    assert_eq!(result.pengirim.telepon.as_deref(), Some("081234567890"));
    assert_eq!(result.penerima.telepon.as_deref(), Some("081234567891"));
}
