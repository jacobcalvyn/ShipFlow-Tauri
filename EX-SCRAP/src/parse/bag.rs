use scraper::{Html as ScraperHtml, Selector};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tracing::warn;

use super::{is_track_bag_header, normalize_label, normalize_text};

#[derive(Serialize, Deserialize)]
pub struct TrackBagItem {
    pub no: Option<String>,
    pub no_resi: Option<String>,
    pub no_resi_url: Option<String>,
    pub kantor_kirim: Option<String>,
    pub tanggal_kirim: Option<String>,
    pub posisi_akhir: Option<String>,
    pub status: Option<String>,
    pub tanggal_update: Option<String>,
    pub jatuh_tempo: Option<String>,
    pub petugas_update: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct TrackBagResponse {
    pub url: String,
    pub nomor_kantung: Option<String>,
    pub items: Vec<TrackBagItem>,
}

pub fn scrape_track_bag(html: &str, url: &str) -> TrackBagResponse {
    let document = ScraperHtml::parse_document(html);

    let table_selector = Selector::parse("table").unwrap();
    let tr_selector = Selector::parse("tr").unwrap();
    let cell_selector = Selector::parse("td, th").unwrap();
    let a_selector = Selector::parse("a").unwrap();

    // Cari nomor kantung dari teks yang mengandung "Nomor Kantung"
    let mut nomor_kantung: Option<String> = None;
    for text in document.root_element().text() {
        let t = normalize_text(text);
        if t.to_uppercase().contains("NOMOR KANTUNG") {
            if let Some(pos) = t.find(':') {
                let value = t[pos + 1..].trim();
                if !value.is_empty() {
                    nomor_kantung = Some(value.to_string());
                    break;
                }
            }
        }
    }

    let mut items = Vec::new();

    // Cari tabel yang header-nya cocok dengan layout trackBag
    'tables: for table in document.select(&table_selector) {
        let rows: Vec<scraper::ElementRef> = table.select(&tr_selector).collect();
        if rows.is_empty() {
            continue;
        }

        // Cari baris yang benar-benar header (bisa jadi bukan baris pertama)
        let mut header_index: Option<usize> = None;
        let mut header_map: HashMap<String, usize> = HashMap::new();

        for (idx, row) in rows.iter().enumerate() {
            let labels: Vec<String> = row
                .select(&cell_selector)
                .map(|c| normalize_label(&normalize_text(&c.text().collect::<String>())))
                .collect();

            if labels.len() >= 9 && is_track_bag_header(&labels) {
                header_index = Some(idx);
                for (i, label) in labels.into_iter().enumerate() {
                    header_map.insert(label, i);
                }
                break;
            }
        }

        let Some(header_idx) = header_index else {
            continue;
        };

        // Semua baris setelah header dianggap data
        for row in rows.iter().skip(header_idx + 1) {
            let cells: Vec<scraper::ElementRef> = row.select(&cell_selector).collect();
            // Validasi longgar: minimal ada beberapa kolom, tidak perlu exact match jumlah header
            if cells.len() < 5 {
                continue;
            }

            // Pilih kolom paling kiri yang memenuhi semua fragmen label.
            // Ini membuat mapping stabil walau iterasi HashMap tidak berurutan.
            let find_col_contains_all = |parts: &[&str]| -> Option<usize> {
                header_map
                    .iter()
                    .filter(|(k, _)| parts.iter().all(|part| k.contains(part)))
                    .map(|(_, idx)| *idx)
                    .min()
            };

            let get_text_at = |idx: Option<usize>| -> Option<String> {
                let idx = idx?;
                if idx >= cells.len() {
                    return None;
                }
                let txt = normalize_text(&cells[idx].text().collect::<String>());
                if txt.is_empty() {
                    None
                } else {
                    Some(txt)
                }
            };

            // Helper khusus untuk No.Resi yang mungkin ada link.
            let get_resi_complex_at = |idx: Option<usize>| -> (Option<String>, Option<String>) {
                let Some(i) = idx else {
                    return (None, None);
                };
                if i >= cells.len() {
                    return (None, None);
                }

                let cell = &cells[i];
                let mut resi = None;
                let mut url = None;

                if let Some(a) = cell.select(&a_selector).next() {
                    let txt = normalize_text(&a.text().collect::<String>());
                    if !txt.is_empty() {
                        resi = Some(txt);
                    }
                    if let Some(href) = a.value().attr("href") {
                        url = Some(href.to_string());
                    }
                } else {
                    let txt = normalize_text(&cell.text().collect::<String>());
                    if !txt.is_empty() {
                        resi = Some(txt);
                    }
                }
                (resi, url)
            };

            let no_col = header_map
                .get("NO")
                .copied()
                .or_else(|| find_col_contains_all(&["NO"]));
            let resi_col = find_col_contains_all(&["RESI"]);
            let kantor_kirim_col = find_col_contains_all(&["KANTOR", "KIRIM"]);
            let tanggal_kirim_col = find_col_contains_all(&["TANGGAL", "KIRIM"]);
            let posisi_akhir_col =
                find_col_contains_all(&["POSISI"]).or_else(|| find_col_contains_all(&["LOKASI"]));
            let status_col = header_map
                .get("STATUS")
                .copied()
                .or_else(|| find_col_contains_all(&["STATUS"]));
            let tanggal_update_col = find_col_contains_all(&["TANGGAL", "UPDATE"]);
            let jatuh_tempo_col =
                find_col_contains_all(&["JATUH"]).or_else(|| find_col_contains_all(&["TEMPO"]));
            let petugas_update_col = find_col_contains_all(&["PETUGAS"]);

            // No
            let no = get_text_at(no_col);

            // No.Resi dan URL link-nya
            // Header biasanya "NO.RESI" atau "NO RESI" tergantung normalisasi
            // Kita cari yang mengandung "RESI" dan "NO"
            let (no_resi, no_resi_url) = get_resi_complex_at(resi_col);

            // Simplifikasi: cari substring unik
            let kantor_kirim = get_text_at(kantor_kirim_col);
            let tanggal_kirim = get_text_at(tanggal_kirim_col);
            let posisi_akhir = get_text_at(posisi_akhir_col);

            // Status bisa ambigu ("STATUS" vs "STATUS AKHIR"), biasanya "STATUS" saja di bag
            let status = get_text_at(status_col);
            let tanggal_update = get_text_at(tanggal_update_col);
            let jatuh_tempo = get_text_at(jatuh_tempo_col);
            let petugas_update = get_text_at(petugas_update_col);

            // Skip kalau semua kosong (minimal field penting)
            if no.is_none()
                && no_resi.is_none()
                && tanggal_kirim.is_none()
                && posisi_akhir.is_none()
                && status.is_none()
            {
                continue;
            }

            items.push(TrackBagItem {
                no,
                no_resi,
                no_resi_url,
                kantor_kirim,
                tanggal_kirim,
                posisi_akhir,
                status,
                tanggal_update,
                jatuh_tempo,
                petugas_update,
            });
        }

        // Kita sudah proses tabel yang cocok; keluar dari loop
        break 'tables;
    }

    TrackBagResponse {
        url: url.to_string(),
        nomor_kantung,
        items,
    }
}

impl TrackBagResponse {
    pub fn log_sanity(&self) {
        if self.nomor_kantung.is_none() && !self.items.is_empty() {
            warn!(
                "scrape_track_bag: nomor_kantung missing for url={}",
                self.url
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_simple_bag_table() {
        let html = r##"
        <html><body>
        <table>
          <tr>
            <th>No</th><th>No.Resi</th><th>Kantor Kirim</th><th>Tanggal Kirim</th>
            <th>Posisi Akhir</th><th>Status</th><th>Tanggal Update</th><th>Jatuh Tempo</th><th>Petugas Update</th>
          </tr>
          <tr>
            <td>1</td>
            <td><a href="#">P123</a></td>
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

        let resp = scrape_track_bag(html, "http://example");
        assert_eq!(resp.items.len(), 1);
        let item = &resp.items[0];
        assert_eq!(item.no.as_deref(), Some("1"));
        assert_eq!(item.no_resi.as_deref(), Some("P123"));
        assert_eq!(item.status.as_deref(), Some("DELIVERED"));
    }
}
