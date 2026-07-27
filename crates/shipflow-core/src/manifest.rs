use scraper::{Html as ScraperHtml, Selector};

use crate::model::{ManifestItem, ManifestResponse};

fn normalize_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalize_label(value: &str) -> String {
    normalize_text(value).to_uppercase().replace(['.', ':'], "")
}

fn is_manifest_header(labels: &[String]) -> bool {
    let required_fragments: &[&[&str]] =
        &[&["NO"], &["KANTUNG"], &["LAYANAN"], &["BERAT"], &["STATUS"]];

    required_fragments.iter().all(|parts| {
        labels
            .iter()
            .any(|label| parts.iter().all(|part| label.contains(part)))
    })
}

pub fn parse_manifest_html(html: &str, url: &str) -> Result<ManifestResponse, String> {
    let document = ScraperHtml::parse_document(html);

    let table_selector = Selector::parse("table").expect("valid selector");
    let tr_selector = Selector::parse("tr").expect("valid selector");
    let cell_selector = Selector::parse("td, th").expect("valid selector");
    let a_selector = Selector::parse("a").expect("valid selector");

    let mut total_berat = None;
    for text in document.root_element().text() {
        let normalized = normalize_text(text);
        if normalized.to_uppercase().contains("TOTAL BERAT") {
            if let Some((_, value)) = normalized.split_once(':') {
                let value = value.trim();
                if !value.is_empty() {
                    total_berat = Some(value.to_string());
                    break;
                }
            }
        }
    }

    let mut items = Vec::new();
    let mut found_expected_table = false;

    'tables: for table in document.select(&table_selector) {
        let rows: Vec<_> = table.select(&tr_selector).collect();
        if rows.is_empty() {
            continue;
        }

        let header_index = rows.iter().position(|row| {
            let labels: Vec<String> = row
                .select(&cell_selector)
                .map(|cell| normalize_label(&cell.text().collect::<String>()))
                .collect();

            labels.len() >= 5 && is_manifest_header(&labels)
        });

        let Some(header_index) = header_index else {
            continue;
        };
        found_expected_table = true;

        for row in rows.iter().skip(header_index + 1) {
            let cells: Vec<_> = row.select(&cell_selector).collect();
            if cells.len() < 7 {
                continue;
            }

            let get_text = |index: usize| -> Option<String> {
                let text = normalize_text(&cells[index].text().collect::<String>());
                if text.is_empty() {
                    None
                } else {
                    Some(text)
                }
            };

            let (nomor_kantung, nomor_kantung_url) =
                if let Some(anchor) = cells[1].select(&a_selector).next() {
                    let text = normalize_text(&anchor.text().collect::<String>());
                    (
                        if text.is_empty() { None } else { Some(text) },
                        anchor.value().attr("href").map(str::to_string),
                    )
                } else {
                    (get_text(1), None)
                };

            let item = ManifestItem {
                no: get_text(0),
                nomor_kantung,
                nomor_kantung_url,
                jenis_layanan: get_text(2),
                berat: get_text(3),
                status: get_text(4),
                lokasi_akhir: get_text(5),
                tanggal: get_text(6),
            };

            if item.no.is_none()
                && item.nomor_kantung.is_none()
                && item.jenis_layanan.is_none()
                && item.berat.is_none()
                && item.status.is_none()
            {
                continue;
            }

            items.push(item);
        }

        break 'tables;
    }

    if !found_expected_table {
        return Err(
            "Manifest response does not contain the expected tracking table. The upstream session may have expired or its schema may have changed."
                .into(),
        );
    }

    Ok(ManifestResponse {
        url: url.to_string(),
        total_berat,
        items,
    })
}

#[cfg(test)]
mod tests {
    use super::parse_manifest_html;

    #[test]
    fn parse_simple_manifest_table() {
        let html = r##"
        <html><body>
        <div>Total Berat : 10 Kg</div>
        <table>
          <tr>
            <th>No</th><th>Nomor Kantung</th><th>Jenis Layanan</th>
            <th>Berat</th><th>Status</th><th>Lokasi Akhir</th><th>Tanggal</th>
          </tr>
          <tr>
            <td>1</td>
            <td><a href="/bag/BAG-001">BAG-001</a></td>
            <td>PKH</td>
            <td>1</td>
            <td>inBag</td>
            <td>DC JAYAPURA 9910A</td>
            <td>2025-11-29 11:23:42</td>
          </tr>
        </table>
        </body></html>
        "##;

        let response = parse_manifest_html(html, "https://example.test/manifest/MAN-001")
            .expect("valid manifest response");
        assert_eq!(response.total_berat.as_deref(), Some("10 Kg"));
        assert_eq!(response.items.len(), 1);
        assert_eq!(response.items[0].nomor_kantung.as_deref(), Some("BAG-001"));
        assert_eq!(response.items[0].status.as_deref(), Some("inBag"));
    }

    #[test]
    fn rejects_login_or_unrecognized_html() {
        let html = r#"<html><body><form><input name="password"></form></body></html>"#;
        let error = parse_manifest_html(html, "https://example.test/login")
            .expect_err("login HTML must not be treated as an empty manifest");

        assert!(error.contains("expected tracking table"));
    }

    #[test]
    fn accepts_expected_table_without_items() {
        let html = r#"
        <table>
          <tr>
            <th>No</th><th>Nomor Kantung</th><th>Jenis Layanan</th>
            <th>Berat</th><th>Status</th><th>Lokasi Akhir</th><th>Tanggal</th>
          </tr>
        </table>
        "#;

        let response = parse_manifest_html(html, "https://example.test/manifest/EMPTY")
            .expect("an expected empty table is valid");
        assert!(response.items.is_empty());
    }
}
