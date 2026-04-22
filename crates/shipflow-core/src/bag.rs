use scraper::{Html as ScraperHtml, Selector};
use std::collections::HashMap;

use crate::model::{BagItem, BagResponse};

fn normalize_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalize_label(value: &str) -> String {
    normalize_text(value)
        .to_uppercase()
        .replace('.', "")
        .replace(':', "")
}

fn is_bag_header(labels: &[String]) -> bool {
    let required_fragments: &[&[&str]] = &[
        &["NO"],
        &["RESI"],
        &["KANTOR", "KIRIM"],
        &["TANGGAL", "KIRIM"],
        &["STATUS"],
    ];

    required_fragments.iter().all(|parts| {
        labels
            .iter()
            .any(|label| parts.iter().all(|part| label.contains(part)))
    })
}

pub fn parse_bag_html(html: &str, url: &str) -> BagResponse {
    let document = ScraperHtml::parse_document(html);

    let table_selector = Selector::parse("table").expect("valid selector");
    let tr_selector = Selector::parse("tr").expect("valid selector");
    let cell_selector = Selector::parse("td, th").expect("valid selector");
    let a_selector = Selector::parse("a").expect("valid selector");

    let mut nomor_kantung = None;
    for text in document.root_element().text() {
        let normalized = normalize_text(text);
        if normalized.to_uppercase().contains("NOMOR KANTUNG") {
            if let Some((_, value)) = normalized.split_once(':') {
                let value = value.trim();
                if !value.is_empty() {
                    nomor_kantung = Some(value.to_string());
                    break;
                }
            }
        }
    }

    let mut items = Vec::new();

    'tables: for table in document.select(&table_selector) {
        let rows: Vec<_> = table.select(&tr_selector).collect();
        if rows.is_empty() {
            continue;
        }

        let mut header_index = None;
        let mut header_map = HashMap::new();

        for (index, row) in rows.iter().enumerate() {
            let labels: Vec<String> = row
                .select(&cell_selector)
                .map(|cell| normalize_label(&cell.text().collect::<String>()))
                .collect();

            if labels.len() >= 5 && is_bag_header(&labels) {
                header_index = Some(index);
                for (column_index, label) in labels.into_iter().enumerate() {
                    header_map.insert(label, column_index);
                }
                break;
            }
        }

        let Some(header_index) = header_index else {
            continue;
        };

        for row in rows.iter().skip(header_index + 1) {
            let cells: Vec<_> = row.select(&cell_selector).collect();
            if cells.len() < 5 {
                continue;
            }

            let find_col_contains_all = |parts: &[&str]| -> Option<usize> {
                header_map
                    .iter()
                    .filter(|(label, _)| parts.iter().all(|part| label.contains(part)))
                    .map(|(_, index)| *index)
                    .min()
            };

            let get_text_at = |index: Option<usize>| -> Option<String> {
                let index = index?;
                if index >= cells.len() {
                    return None;
                }

                let text = normalize_text(&cells[index].text().collect::<String>());
                if text.is_empty() {
                    None
                } else {
                    Some(text)
                }
            };

            let get_link_text_at =
                |index: Option<usize>| -> (Option<String>, Option<String>) {
                    let Some(index) = index else {
                        return (None, None);
                    };
                    if index >= cells.len() {
                        return (None, None);
                    }

                    let cell = &cells[index];
                    if let Some(anchor) = cell.select(&a_selector).next() {
                        let text = normalize_text(&anchor.text().collect::<String>());
                        let href = anchor.value().attr("href").map(str::to_string);
                        (
                            if text.is_empty() { None } else { Some(text) },
                            href,
                        )
                    } else {
                        let text = normalize_text(&cell.text().collect::<String>());
                        (if text.is_empty() { None } else { Some(text) }, None)
                    }
                };

            let item = BagItem {
                no: get_text_at(header_map.get("NO").copied()),
                no_resi: get_link_text_at(find_col_contains_all(&["RESI"])).0,
                no_resi_url: get_link_text_at(find_col_contains_all(&["RESI"])).1,
                kantor_kirim: get_text_at(find_col_contains_all(&["KANTOR", "KIRIM"])),
                tanggal_kirim: get_text_at(find_col_contains_all(&["TANGGAL", "KIRIM"])),
                posisi_akhir: get_text_at(
                    find_col_contains_all(&["POSISI"]).or_else(|| find_col_contains_all(&["LOKASI"])),
                ),
                status: get_text_at(
                    header_map
                        .get("STATUS")
                        .copied()
                        .or_else(|| find_col_contains_all(&["STATUS"])),
                ),
                tanggal_update: get_text_at(find_col_contains_all(&["TANGGAL", "UPDATE"])),
                jatuh_tempo: get_text_at(
                    find_col_contains_all(&["JATUH"]).or_else(|| find_col_contains_all(&["TEMPO"])),
                ),
                petugas_update: get_text_at(find_col_contains_all(&["PETUGAS"])),
            };

            if item.no.is_none()
                && item.no_resi.is_none()
                && item.tanggal_kirim.is_none()
                && item.posisi_akhir.is_none()
                && item.status.is_none()
            {
                continue;
            }

            items.push(item);
        }

        break 'tables;
    }

    BagResponse {
        url: url.to_string(),
        nomor_kantung,
        items,
    }
}

#[cfg(test)]
mod tests {
    use super::parse_bag_html;

    #[test]
    fn parse_simple_bag_table() {
        let html = r##"
        <html><body>
        <div>Nomor Kantung : BAG-001</div>
        <table>
          <tr>
            <th>No</th><th>No.Resi</th><th>Kantor Kirim</th><th>Tanggal Kirim</th>
            <th>Posisi Akhir</th><th>Status</th><th>Tanggal Update</th><th>Jatuh Tempo</th><th>Petugas Update</th>
          </tr>
          <tr>
            <td>1</td>
            <td><a href="/track/P123">P123</a></td>
            <td>SPP JAYAPURA</td>
            <td>2025-11-25 12:39:48</td>
            <td>DC JAYAPURA</td>
            <td>DELIVERED</td>
            <td>2025-11-26 10:00:00</td>
            <td>2025-11-30</td>
            <td>Kurir A</td>
          </tr>
        </table>
        </body></html>
        "##;

        let response = parse_bag_html(html, "https://example.test/bag/BAG-001");
        assert_eq!(response.nomor_kantung.as_deref(), Some("BAG-001"));
        assert_eq!(response.items.len(), 1);
        assert_eq!(response.items[0].no_resi.as_deref(), Some("P123"));
        assert_eq!(response.items[0].status.as_deref(), Some("DELIVERED"));
    }
}
