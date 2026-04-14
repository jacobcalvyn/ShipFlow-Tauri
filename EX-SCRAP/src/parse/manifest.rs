use scraper::{Html as ScraperHtml, Selector};
use serde::{Deserialize, Serialize};
use tracing::warn;

use super::{is_track_manifest_header, normalize_label, normalize_text};

#[derive(Serialize, Deserialize)]
pub struct TrackManifestItem {
    pub no: Option<String>,
    pub nomor_kantung: Option<String>,
    pub nomor_kantung_url: Option<String>,
    pub jenis_layanan: Option<String>,
    pub berat: Option<String>,
    pub status: Option<String>,
    pub lokasi_akhir: Option<String>,
    pub tanggal: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct TrackManifestResponse {
    pub url: String,
    pub total_berat: Option<String>,
    pub items: Vec<TrackManifestItem>,
}

impl TrackManifestResponse {
    pub fn log_sanity(&self) {
        if self.items.is_empty() {
            warn!(
                "scrape_track_manifest: no items parsed for url={}",
                self.url
            );
        }
    }
}

pub fn scrape_track_manifest(html: &str, url: &str) -> TrackManifestResponse {
    let document = ScraperHtml::parse_document(html);

    let table_selector = Selector::parse("table").unwrap();
    let tr_selector = Selector::parse("tr").unwrap();
    let cell_selector = Selector::parse("td, th").unwrap();
    let a_selector = Selector::parse("a").unwrap();

    // Cari "Total Berat : xxx"
    let mut total_berat: Option<String> = None;
    for text in document.root_element().text() {
        let t = normalize_text(text);
        let upper = t.to_uppercase();
        if upper.contains("TOTAL BERAT") {
            if let Some(pos) = t.find(':') {
                let value = t[pos + 1..].trim();
                if !value.is_empty() {
                    total_berat = Some(value.to_string());
                    break;
                }
            }
        }
    }

    let mut items = Vec::new();

    // Cari tabel utama manifest
    'tables: for table in document.select(&table_selector) {
        let rows: Vec<scraper::ElementRef> = table.select(&tr_selector).collect();
        if rows.is_empty() {
            continue;
        }

        // Cari baris header
        let mut header_index: Option<usize> = None;

        for (idx, row) in rows.iter().enumerate() {
            let labels: Vec<String> = row
                .select(&cell_selector)
                .map(|c| normalize_label(&normalize_text(&c.text().collect::<String>())))
                .collect();

            if labels.len() >= 7 && is_track_manifest_header(&labels) {
                header_index = Some(idx);
                break;
            }
        }

        let Some(header_idx) = header_index else {
            continue;
        };

        // Baris setelah header = data
        for row in rows.iter().skip(header_idx + 1) {
            let cells: Vec<scraper::ElementRef> = row.select(&cell_selector).collect();
            if cells.len() < 7 {
                continue;
            }

            let get_text = |idx: usize| -> Option<String> {
                let txt = normalize_text(&cells[idx].text().collect::<String>());
                if txt.is_empty() {
                    None
                } else {
                    Some(txt)
                }
            };

            let no = get_text(0);

            // Nomor Kantung & URL
            let mut nomor_kantung: Option<String> = None;
            let mut nomor_kantung_url: Option<String> = None;
            if let Some(a) = cells[1].select(&a_selector).next() {
                let txt = normalize_text(&a.text().collect::<String>());
                if !txt.is_empty() {
                    nomor_kantung = Some(txt);
                }
                if let Some(href) = a.value().attr("href") {
                    nomor_kantung_url = Some(href.to_string());
                }
            } else {
                nomor_kantung = get_text(1);
            }

            let jenis_layanan = get_text(2);
            let berat = get_text(3);
            let status = get_text(4);
            let lokasi_akhir = get_text(5);
            let tanggal = get_text(6);

            if no.is_none()
                && nomor_kantung.is_none()
                && jenis_layanan.is_none()
                && berat.is_none()
                && status.is_none()
            {
                continue;
            }

            items.push(TrackManifestItem {
                no,
                nomor_kantung,
                nomor_kantung_url,
                jenis_layanan,
                berat,
                status,
                lokasi_akhir,
                tanggal,
            });
        }

        break 'tables;
    }

    TrackManifestResponse {
        url: url.to_string(),
        total_berat,
        items,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
            <td><a href="#">PID123</a></td>
            <td>PKH</td>
            <td>1</td>
            <td>inBag</td>
            <td>DC JAYAPURA 9910A</td>
            <td>2025-11-29 11:23:42</td>
          </tr>
        </table>
        </body></html>
        "##;

        let resp = scrape_track_manifest(html, "http://example");
        assert_eq!(resp.total_berat.as_deref(), Some("10 Kg"));
        assert_eq!(resp.items.len(), 1);
        let item = &resp.items[0];
        assert_eq!(item.nomor_kantung.as_deref(), Some("PID123"));
        assert_eq!(item.status.as_deref(), Some("inBag"));
    }
}
