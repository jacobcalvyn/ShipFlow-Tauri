use std::collections::HashMap;
use std::sync::OnceLock;

use scraper::{Html as ScraperHtml, Selector};
use serde::{Deserialize, Serialize};
use tracing::warn;

use super::{normalize_label, normalize_text};

static TR_SELECTOR: OnceLock<Selector> = OnceLock::new();
static CELL_SELECTOR: OnceLock<Selector> = OnceLock::new();
static TABLE_SELECTOR: OnceLock<Selector> = OnceLock::new();
static IMG_SELECTOR: OnceLock<Selector> = OnceLock::new();
static A_SELECTOR: OnceLock<Selector> = OnceLock::new();

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct TrackDetail {
    #[serde(rename = "shipment_header")]
    pub header: ShipmentHeader,

    #[serde(rename = "origin_detail")]
    pub origin: OriginDetail,

    #[serde(rename = "package_detail")]
    pub package: PackageDetail,

    #[serde(rename = "billing_detail")]
    pub billing: BillingDetail,

    #[serde(rename = "actors")]
    pub actors: Actors,

    #[serde(rename = "performance_detail")]
    pub performance: PerformanceDetail,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct ShipmentHeader {
    pub nomor_kiriman: Option<String>,
    pub booking_code: Option<String>,
    pub id_pelanggan_korporat: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct OriginDetail {
    pub nama_kantor: Option<String>,
    pub id_kantor: Option<String>,
    pub nama_petugas: Option<String>,
    pub id_petugas: Option<String>,
    #[serde(rename = "tanggal_input")]
    pub tanggal: Option<String>,
    #[serde(rename = "waktu_input")]
    pub waktu: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct PackageDetail {
    pub jenis_layanan: Option<String>,
    pub kriteria_kiriman: Option<String>,
    pub isi_kiriman: Option<String>,

    // New fields
    pub berat_actual: f64,
    pub berat_volumetric: f64,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct BillingDetail {
    pub type_pembayaran: Option<String>,
    pub bea_dasar: f64,
    pub nilai_barang: f64,
    pub htnb: f64,
    #[serde(rename = "cod_info")]
    pub cod: TrackCodDetail,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Actors {
    pub pengirim: ContactDetail,
    pub penerima: ContactDetail,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct PerformanceDetail {
    #[serde(rename = "sla_target")]
    pub sla: Option<String>,
    pub sla_category: Option<String>,
    #[serde(rename = "sla_days_diff")]
    pub sla_days: Option<i32>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct TrackCodDetail {
    pub is_cod: bool,
    pub virtual_account: Option<String>,
    pub total_cod: f64,
    pub status: Option<String>, // Renamed from status_cod_ccod
    pub tanggal: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct TrackStatusAkhir {
    pub status: Option<String>,
    pub location: Option<String>,
    pub officer_name: Option<String>,
    pub officer_id: Option<String>,
    pub datetime: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct TrackPod {
    pub photo1_url: Option<String>,
    pub photo2_url: Option<String>,
    pub signature_url: Option<String>,
    pub coordinate: Option<String>,
    pub coordinate_map_url: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct TrackHistoryEntry {
    pub tanggal_update: String,
    pub detail_history: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct HistorySummary {
    pub irregularity: Vec<IrregularitySummary>,
    pub bagging_unbagging: Vec<BaggingUnbaggingSummary>,
    pub manifest_r7: Vec<ManifestR7Summary>,
    pub delivery_runsheet: Vec<DeliveryRunsheetSummary>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct IrregularitySummary {
    pub status: Option<String>,
    pub petugas: Option<String>,
    pub lokasi: Option<String>,
    pub koordinat: Option<String>,
    pub tanggal: Option<String>,
    pub waktu: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct BaggingUnbaggingEvent {
    pub petugas: Option<String>,
    pub lokasi: Option<String>,
    pub tanggal: Option<String>,
    pub waktu: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct BaggingUnbaggingSummary {
    pub nomor_kantung: String,
    pub bagging: Option<BaggingUnbaggingEvent>,
    pub unbagging: Option<BaggingUnbaggingEvent>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ManifestR7Summary {
    pub nomor_r7: Option<String>,
    pub petugas: Option<String>,
    pub lokasi: Option<String>,
    pub tujuan: Option<String>,
    pub tanggal: Option<String>,
    pub waktu: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct DeliveryRunsheetUpdate {
    pub petugas: Option<String>,
    pub status: Option<String>,
    pub tanggal: Option<String>,
    pub waktu: Option<String>,
    pub koordinat: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct DeliveryRunsheetSummary {
    pub petugas_mandor: Option<String>,
    pub petugas_kurir: Option<String>,
    pub lokasi: Option<String>,
    pub tanggal: Option<String>,
    pub waktu: Option<String>,
    pub koordinat: Option<String>,
    pub updates: Vec<DeliveryRunsheetUpdate>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct TrackResponse {
    pub url: String,
    pub detail: TrackDetail,
    pub status_akhir: TrackStatusAkhir,
    pub pod: TrackPod,
    pub history: Vec<TrackHistoryEntry>,
    pub history_summary: HistorySummary,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct TrackLiteResponse {
    pub url: String,
    pub detail: TrackDetail,
    pub status_akhir: TrackStatusAkhir,
    pub history_summary: HistorySummary,
}

impl From<TrackResponse> for TrackLiteResponse {
    fn from(value: TrackResponse) -> Self {
        Self {
            url: value.url,
            detail: value.detail,
            status_akhir: value.status_akhir,
            history_summary: value.history_summary,
        }
    }
}

type StatusAkhirParts = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

impl TrackResponse {
    pub fn log_sanity(&self) {
        let nomor_missing = self.detail.header.nomor_kiriman.is_none();

        if nomor_missing && !self.history.is_empty() {
            warn!(
                "scrape_track: nomor_kiriman missing while history is present for url={}",
                self.url
            );
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct ContactDetail {
    pub nama: Option<String>,
    pub telepon: Option<String>,
    pub alamat: Option<String>,
    pub kode_pos: Option<String>,
}

fn parse_currency(s: &str) -> f64 {
    let cleaned = s
        .replace("Rp", "")
        .replace("RP", "")
        .replace(".", "") // Remove thousands separator
        .replace(",", ".") // Replace decimal separator if applicable (though usually IDR doesn't use decimals in this context, standardizing to dot just in case)
        .trim()
        .to_string();
    cleaned.parse::<f64>().unwrap_or(0.0)
}

fn parse_weight(s: &str) -> (f64, f64) {
    // Format: "Aktual : 1 Kg, Volumetrik : 0.851 Kg"
    let mut actual = 0.0;
    let mut volumetric = 0.0;

    let parts: Vec<&str> = s.split(',').collect();
    for part in parts {
        let lower = part.to_lowercase();
        // Check for "aktual" keyword
        if lower.contains("aktual") {
            if let Some((_, val_part)) = lower.split_once(':') {
                let clean = val_part.replace("kg", "").trim().to_string();
                actual = clean.parse::<f64>().unwrap_or(0.0);
            }
        }
        // Check for "volumetrik" keyword
        else if lower.contains("volumetrik") {
            if let Some((_, val_part)) = lower.split_once(':') {
                let clean = val_part.replace("kg", "").trim().to_string();
                volumetric = clean.parse::<f64>().unwrap_or(0.0);
            }
        }
    }

    (actual, volumetric)
}

pub fn scrape_track(html: &str, url: &str) -> TrackResponse {
    let document = ScraperHtml::parse_document(html);

    let mut header = ShipmentHeader::default();
    let mut origin = OriginDetail::default();
    let mut package = PackageDetail::default();
    let mut billing = BillingDetail::default();
    let mut actors = Actors::default();
    let mut performance = PerformanceDetail::default();

    let mut status_akhir = TrackStatusAkhir::default();
    let mut pod = TrackPod::default();
    let mut history = Vec::new();

    let tr_selector = TR_SELECTOR.get_or_init(|| Selector::parse("tr").expect("valid selector"));
    let cell_selector =
        CELL_SELECTOR.get_or_init(|| Selector::parse("td, th").expect("valid selector"));
    let table_selector =
        TABLE_SELECTOR.get_or_init(|| Selector::parse("table").expect("valid selector"));
    let img_selector = IMG_SELECTOR.get_or_init(|| Selector::parse("img").expect("valid selector"));
    let a_selector = A_SELECTOR.get_or_init(|| Selector::parse("a").expect("valid selector"));

    // 1) Ambil pasangan label -> value dari seluruh baris tabel
    for tr in document.select(tr_selector) {
        let cells: Vec<String> = tr
            .select(cell_selector)
            .map(|c| normalize_text(&c.text().collect::<String>()))
            .filter(|s| !s.is_empty())
            .collect();

        if cells.len() < 2 {
            continue;
        }

        let label = normalize_label(&cells[0]);
        let value = cells[1].clone();

        match label.as_str() {
            "NOMOR KIRIMAN" => {
                // Bersihkan nomor kiriman dari informasi SLA (misal: "P123 [ SLA... ]")
                let clean_nomor = value.split('[').next().unwrap_or(&value).trim().to_string();
                header.nomor_kiriman = Some(clean_nomor);

                let sla_detail = parse_sla_from_nomor_kiriman(&value);
                performance.sla = sla_detail.sla;
                performance.sla_category = sla_detail.sla_category;
                performance.sla_days = sla_detail.sla_days;
            }
            "BOOKING CODE" => header.booking_code = Some(value),
            "IDPELANGGAN KORPORAT" => header.id_pelanggan_korporat = Some(value),
            "TYPE PEMBAYARAN" => billing.type_pembayaran = Some(value),
            "KANTOR KIRIMAN" => {
                // Skiping raw kantor_kiriman field as requested
            }
            "JENIS LAYANAN" => package.jenis_layanan = Some(value),
            "COD/NON COD" => {
                billing.cod = parse_cod_non_cod(&value);
            }
            "TANGGAL KIRIM" => {
                // Deleted fields logic
            }
            "ISI KIRIMAN" => package.isi_kiriman = Some(value),
            "BERAT KIRIMAN" => {
                let (act, vol) = parse_weight(&value);
                package.berat_actual = act;
                package.berat_volumetric = vol;
            }
            "KRITERIA KIRIMAN" => package.kriteria_kiriman = Some(value),
            "BEA DASAR" => billing.bea_dasar = parse_currency(&value),
            "NILAI BARANG" => billing.nilai_barang = parse_currency(&value),
            "HTNB" => billing.htnb = parse_currency(&value),
            "PENGIRIM" => {
                actors.pengirim = parse_pengirim(&value);
            }
            "PENERIMA" => {
                actors.penerima = parse_penerima(&value);
            }
            "STATUS AKHIR" => {
                let (status, location, officer_name, officer_id, datetime) =
                    parse_status_akhir(&value);
                status_akhir.status = status;
                status_akhir.location = location;
                status_akhir.officer_name = officer_name;
                status_akhir.officer_id = officer_id;
                status_akhir.datetime = datetime;
            }
            _ => {}
        }
    }

    // 2) Cari tabel POD (Photo, Photo2, signature, coordinate)

    // 2) Cari tabel POD (Photo, Photo2, signature, coordinate)
    for table in document.select(table_selector) {
        let mut rows = table.select(tr_selector);
        let Some(header_row) = rows.next() else {
            continue;
        };

        let headers: Vec<String> = header_row
            .select(cell_selector)
            .map(|c| normalize_label(&normalize_text(&c.text().collect::<String>())))
            .collect();

        if headers.is_empty() {
            continue;
        }

        // Cari index kolom secara dinamis
        let idx_photo1 = headers
            .iter()
            .position(|h| h.contains("PHOTO") && !h.contains("PHOTO2"));
        let idx_photo2 = headers.iter().position(|h| h.contains("PHOTO2"));
        let mut idx_signature = headers
            .iter()
            .position(|h| h.contains("SIGNATURE") || h.contains("TANDA TANGAN"));
        let mut idx_coordinate = headers
            .iter()
            .position(|h| h.contains("COORDINATE") || h.contains("KOORDINAT"));

        // Fallback: Jika Signature/Coordinate tidak ketemu tapi Photo2 ada di index 2,
        // asumsikan struktur standar (0:POD, 1:Photo, 2:Photo2, 3:Sig, 4:Coord)
        if let Some(i2) = idx_photo2 {
            if i2 == 2 {
                if idx_signature.is_none() && headers.len() > 3 {
                    idx_signature = Some(3);
                }
                if idx_coordinate.is_none() && headers.len() > 4 {
                    idx_coordinate = Some(4);
                }
            }
        }

        // Minimal harus ada salah satu kolom yang dikenali agar dianggap tabel POD
        if idx_photo1.is_some()
            || idx_photo2.is_some()
            || idx_signature.is_some()
            || idx_coordinate.is_some()
        {
            if let Some(data_row) = rows.next() {
                let cells: Vec<_> = data_row.select(cell_selector).collect();

                // Deteksi offset kolom.
                // Jika header pertama adalah "POD" (spanning row) dan jumlah sel data < jumlah header,
                // maka kemungkinan ada rowspan="2" di kolom POD, sehingga index data bergeser -1.
                let has_pod_header = headers.first().map(|h| h.contains("POD")).unwrap_or(false);
                let row_offset = if has_pod_header && cells.len() == headers.len() - 1 {
                    1
                } else {
                    0
                };

                // Helper untuk ekstrak image src dari cell index tertentu
                let extract_img = |idx: Option<usize>| -> Option<String> {
                    let i = idx?;
                    // Apply offset
                    let target_i = if i >= row_offset { i - row_offset } else { i };

                    if target_i >= cells.len() {
                        return None;
                    }
                    let cell = &cells[target_i];
                    let img = cell.select(img_selector).next()?;

                    // Coba ambil src, jika tidak valid cek data-src
                    let get_valid_src = |attr_name: &str| -> Option<String> {
                        let val = img.value().attr(attr_name)?.to_string();
                        // Ignore small tracking pixels or placeholders often found in base64
                        if val.starts_with("data:image") && val.len() < 50 {
                            return None;
                        }
                        if val.trim().is_empty() {
                            return None;
                        }
                        Some(val)
                    };

                    get_valid_src("src").or_else(|| get_valid_src("data-src"))
                };

                pod.photo1_url = extract_img(idx_photo1);
                pod.photo2_url = extract_img(idx_photo2);
                pod.signature_url = extract_img(idx_signature);

                // Ekstrak koordinat
                if let Some(i) = idx_coordinate {
                    let target_i = if i >= row_offset { i - row_offset } else { i };

                    if target_i < cells.len() {
                        let cell = &cells[target_i];
                        let raw_text = normalize_text(&cell.text().collect::<String>());

                        // Bersihkan teks umum link peta agar hanya tersisa koordinat
                        let coord_text = raw_text
                            .replace("View Map", "")
                            .replace("Lihat Peta", "")
                            .replace("View Photo", "") // Jaga-jaga
                            .trim()
                            .to_string();

                        if !coord_text.is_empty() {
                            pod.coordinate = Some(coord_text);
                        }

                        if let Some(a) = cell.select(a_selector).next() {
                            if let Some(href) = a.value().attr("href") {
                                pod.coordinate_map_url = Some(href.to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    // 3) Cari tabel history (TANGGAL UPDATE / DETAIL HISTORY)
    for table in document.select(table_selector) {
        let mut rows = table.select(tr_selector);
        let Some(header_row) = rows.next() else {
            continue;
        };

        let headers: Vec<String> = header_row
            .select(cell_selector)
            .map(|c| normalize_label(&normalize_text(&c.text().collect::<String>())))
            .collect();

        if headers.len() < 2 {
            continue;
        }

        if headers[0].contains("TANGGAL UPDATE") && headers[1].contains("DETAIL HISTORY") {
            for row in rows {
                let cells: Vec<String> = row
                    .select(cell_selector)
                    .map(|c| normalize_text(&c.text().collect::<String>()))
                    .collect();

                if cells.len() < 2 {
                    continue;
                }

                let tanggal_update = cells[0].clone();
                let detail_history = cells[1].clone();

                if tanggal_update.is_empty() && detail_history.is_empty() {
                    continue;
                }

                history.push(TrackHistoryEntry {
                    tanggal_update,
                    detail_history,
                });
            }
        }
    }

    // 4) Ekstrak detail kantor kiriman dari history pertama (jika ada)
    // Biasanya history paling awal (creation) atau history dengan format "Connote telah dibuat oleh..."
    if !history.is_empty() {
        // Note: History di-push berurutan dari atas ke bawah tabel.
        // Biasanya tabel history diurutkan dari terbaru (atas) ke terlama (bawah) atau sebaliknya?
        // Mari kita asumsikan perlu mencari entry yang mengandung "Connote telah dibuat".
        // Atau jika user bilang "JSON.history[0]", berarti entry paling awal di array history kita.
        // Jika scraping kita push dari atas ke bawah, history[0] adalah baris pertama tabel (terbaru).
        // Jika history[last] adalah terlama. "Connote telah dibuat" biasanya kejadian awal (terlama).
        // Mari kita cari entry yang pas.
        let creation_entry = history.iter().find(|h| {
            h.detail_history
                .to_lowercase()
                .contains("connote telah dibuat oleh")
        });

        if let Some(h) = creation_entry {
            origin = parse_kantor_kiriman_detail(h);
        }
    }

    let history_summary = build_history_summary(&history, &status_akhir, &pod);

    let detail = TrackDetail {
        header,
        origin,
        package,
        billing,
        actors,
        performance,
    };

    TrackResponse {
        url: url.to_string(),
        detail,
        status_akhir,
        pod,
        history,
        history_summary,
    }
}

fn parse_cod_non_cod(raw: &str) -> TrackCodDetail {
    let upper = raw.to_uppercase();
    let is_cod = upper.trim_start().starts_with("#COD") || upper.trim_start().starts_with("#CCOD");

    if !is_cod {
        return TrackCodDetail {
            is_cod: false,
            virtual_account: None,
            total_cod: 0.0,
            status: None,
            tanggal: None,
        };
    }

    fn clean_segment(segment: &str) -> String {
        segment
            .trim()
            .trim_matches(|c: char| c == ',' || c == ':')
            .trim()
            .to_string()
    }

    fn segment_between(s: &str, start: &str, end: &str) -> Option<String> {
        let (_, rest) = s.split_once(start)?;
        let (segment, _) = rest.split_once(end)?;
        Some(clean_segment(segment))
    }

    fn segment_after(s: &str, start: &str) -> Option<String> {
        let (_, rest) = s.split_once(start)?;
        Some(clean_segment(rest))
    }

    fn extract_amount_prefix(s: &str) -> Option<String> {
        let mut started = false;
        let mut out = String::new();

        for ch in s.chars() {
            if ch.is_ascii_digit() || ch == '.' || ch == ',' {
                started = true;
                out.push(ch);
            } else if !started || ch.is_whitespace() {
                continue;
            } else {
                break;
            }
        }

        let out = out.trim().to_string();
        if out.is_empty() {
            None
        } else {
            Some(out)
        }
    }

    let virtual_account = segment_between(raw, "Virtual Account :", "Type Rekening")
        .or_else(|| segment_between(raw, "Virtual Account :", "Tipe Rekening"))
        .or_else(|| {
            // fallback kalau tidak ada "Type/Tipe Rekening"
            segment_after(raw, "Virtual Account :")
        });

    let total_cod_str = segment_between(raw, "Total COD :", "Status COD/CCOD")
        .or_else(|| segment_between(raw, "Total COD :", "Non COD"))
        .or_else(|| segment_between(raw, "Total COD :", "COD Retur"))
        .or_else(|| segment_between(raw, "Total COD :", "COD Return"))
        .or_else(|| segment_after(raw, "Total COD :"));

    let total_cod_raw = total_cod_str.unwrap_or_default();
    let total_cod = extract_amount_prefix(&total_cod_raw)
        .map(|v| parse_currency(&v))
        .unwrap_or_else(|| parse_currency(&total_cod_raw));

    let status = if upper.contains("STATUS COD/CCOD") {
        if upper.contains("TANGGAL") {
            segment_between(raw, "Status COD/CCOD :", "Tanggal")
        } else {
            segment_after(raw, "Status COD/CCOD :")
        }
    } else if upper.contains("COD RETUR") {
        Some("COD Retur".to_string())
    } else if upper.contains("COD RETURN") {
        Some("COD Return".to_string())
    } else {
        None
    };

    let tanggal = if upper.contains("TANGGAL") {
        segment_after(raw, "Tanggal :")
    } else {
        None
    };

    TrackCodDetail {
        is_cod: true,
        virtual_account,
        total_cod,
        status,
        tanggal,
    }
}

fn parse_sla_from_nomor_kiriman(raw: &str) -> PerformanceDetail {
    let trimmed = raw.trim();
    let start = match trimmed.find('[') {
        Some(idx) => idx,
        None => return PerformanceDetail::default(),
    };
    let end = match trimmed.rfind(']') {
        Some(idx) if idx > start => idx,
        _ => return PerformanceDetail::default(),
    };

    let inside = &trimmed[start + 1..end];
    // Contoh inside: " SLA : 6 hari, OnTime "

    let upper = inside.to_uppercase();
    let sla_pos = match upper.find("SLA :") {
        Some(idx) => idx,
        None => return PerformanceDetail::default(),
    };

    let after = &inside[sla_pos + "SLA :".len()..];

    let segments: Vec<String> = after
        .split(',')
        .map(normalize_text)
        .filter(|s| !s.is_empty())
        .collect();

    if segments.is_empty() {
        return PerformanceDetail::default();
    }

    let sla = Some(segments[0].clone());

    let raw_status = if segments.len() > 1 {
        Some(segments[1..].join(", "))
    } else {
        None
    };

    let (sla_category, sla_days) = parse_sla_status(raw_status.as_deref().unwrap_or_default());

    PerformanceDetail {
        sla,
        sla_category,
        sla_days,
    }
}

fn split_semicolon_segments(raw: &str) -> Vec<String> {
    raw.split(';')
        .map(normalize_text)
        .filter(|s| !s.is_empty())
        .collect()
}

fn parse_pengirim(raw: &str) -> ContactDetail {
    let parts = split_semicolon_segments(raw);
    if parts.len() < 2 {
        return ContactDetail::default();
    }

    let nama = Some(parts[0].clone());
    let telepon = parts.get(1).cloned();

    let (alamat, kode_pos) = if parts.len() >= 4 {
        // name; phone; address; kode_pos
        let kode_pos = parts.last().cloned();
        let alamat = if parts.len() > 3 {
            Some(parts[2..parts.len() - 1].join("; "))
        } else {
            None
        };
        (alamat, kode_pos)
    } else {
        // Tanpa kode pos terpisah
        let alamat = if parts.len() >= 3 {
            Some(parts[2..].join("; "))
        } else {
            None
        };
        (alamat, None)
    };

    ContactDetail {
        nama,
        telepon,
        alamat,
        kode_pos,
    }
}

fn parse_kantor_kiriman_detail(entry: &TrackHistoryEntry) -> OriginDetail {
    // Format: "Connote telah dibuat oleh [NAMA] ([ID]) di lokasi [LOKASI]"
    // Tanggal dan waktu diambil dari entry.tanggal_update

    let mut detail = OriginDetail {
        tanggal: None,
        waktu: None,
        nama_kantor: None,
        id_kantor: None,
        nama_petugas: None,
        id_petugas: None,
    };

    // Parse datetime
    let (t, w) = split_datetime(&entry.tanggal_update);
    detail.tanggal = t;
    detail.waktu = w;

    let raw = &entry.detail_history;
    let lower = raw.to_lowercase();

    if !lower.starts_with("connote telah dibuat oleh") {
        return detail; // Return default if prefix doesn't match
    }

    // 1. Potong prefix "Connote telah dibuat oleh "
    let after_prefix = raw
        .trim()
        .strip_prefix("Connote telah dibuat oleh ")
        .or_else(|| raw.trim().strip_prefix("Connote telah dibuat oleh"))
        .unwrap_or(raw) // Should not happen if starts_with check passed
        .trim();

    // 2. Cari " di lokasi " untuk memisahkan (Petugas + ID) dan (Lokasi)
    let (petugas_part, lokasi_part) = after_prefix
        .split_once(" di lokasi ")
        .unwrap_or((after_prefix, ""));

    // 2a. Parse Petugas -> "Nama (ID)"
    if let Some(idx_open) = petugas_part.find('(') {
        if let Some(idx_close) = petugas_part.find(')') {
            if idx_close > idx_open {
                let nama = petugas_part[..idx_open].trim().to_string();
                let id = petugas_part[idx_open + 1..idx_close].trim().to_string();
                detail.nama_petugas = Some(nama);
                detail.id_petugas = Some(id);
            } else {
                detail.nama_petugas = Some(petugas_part.trim().to_string());
            }
        } else {
            detail.nama_petugas = Some(petugas_part.trim().to_string());
        }
    } else {
        detail.nama_petugas = Some(petugas_part.trim().to_string());
    };

    // 2b. Parse Lokasi -> "NamaKantor IDKantor" (biasanya ID di akhir)
    // 2b. Parse Lokasi -> "NamaKantor IDKantor" (biasanya ID di akhir)
    if !lokasi_part.is_empty() {
        let parts: Vec<&str> = lokasi_part.split_whitespace().collect();
        if let Some(last) = parts.last() {
            // Cek apakah token terakhir terlihat seperti ID (misal: 17113A, 99100)
            // Kriteria sederhana: kombinasi angka/huruf, len < 10
            if last.len() < 10 && last.chars().any(|c| c.is_ascii_digit()) {
                let nama = parts[..parts.len() - 1].join(" ");
                detail.nama_kantor = Some(nama);
                detail.id_kantor = Some(last.to_string());
            } else {
                detail.nama_kantor = Some(lokasi_part.trim().to_string());
            }
        } else {
            detail.nama_kantor = Some(lokasi_part.trim().to_string());
        }
    } else {
        // Do nothing, defaults are None
    };

    detail
}

fn parse_penerima(raw: &str) -> ContactDetail {
    let parts = split_semicolon_segments(raw);
    if parts.len() < 2 {
        return ContactDetail::default();
    }

    let nama = Some(parts[0].clone());
    let telepon = parts.get(1).cloned();

    let (alamat, kode_pos) = if parts.len() >= 4 {
        // name; phone; address; kode_pos
        let kode_pos = parts.last().cloned();
        let alamat = if parts.len() > 3 {
            Some(parts[2..parts.len() - 1].join("; "))
        } else {
            None
        };
        (alamat, kode_pos)
    } else {
        // Tanpa kode pos terpisah
        let alamat = if parts.len() >= 3 {
            Some(parts[2..].join("; "))
        } else {
            None
        };
        (alamat, None)
    };

    ContactDetail {
        nama,
        telepon,
        alamat,
        kode_pos,
    }
}

fn parse_sla_status(raw: &str) -> (Option<String>, Option<i32>) {
    let text = raw.trim();
    if text.is_empty() {
        return (None, None);
    }

    let upper = text.to_uppercase();

    let category = if upper.contains("ONTIME") {
        Some("OnTime".to_string())
    } else if upper.contains("OVER SLA") || upper.contains("OVERSLA") {
        Some("OverSLA".to_string())
    } else if upper.contains("JATUH TEMPO") {
        Some("JatuhTempo".to_string())
    } else {
        None
    };

    // cari angka pertama (jumlah hari)
    let mut num_str = String::new();
    for ch in text.chars() {
        if ch.is_ascii_digit() {
            num_str.push(ch);
        } else if !num_str.is_empty() {
            break;
        }
    }

    let days = if num_str.is_empty() {
        None
    } else {
        num_str.parse::<i32>().ok()
    };

    (category, days)
}

fn parse_status_akhir(raw: &str) -> StatusAkhirParts {
    let text = raw.trim();

    // 1. Status: sebelum " di " pertama
    let (status, mut rem_after_di) = if let Some(idx) = text.find(" di ") {
        (
            Some(text[..idx].trim().to_string()),
            &text[idx + " di ".len()..],
        )
    } else {
        return (Some(text.to_string()), None, None, None, None);
    };

    // 2. Lokasi: antara "di" pertama dan "oleh" pertama
    let mut location: Option<String> = None;

    // buang spasi depan setelah "di"
    rem_after_di = rem_after_di.trim_start();
    let rem_lower = rem_after_di.to_lowercase();

    // Jika langsung "oleh ..." → tidak ada lokasi
    let mut after_location = if rem_lower.starts_with("oleh ") {
        &rem_after_di["oleh ".len()..]
    } else if let Some(idx_oleh) = rem_lower.find(" oleh ") {
        // Lokasi di antara "di" dan " oleh "
        let loc = rem_after_di[..idx_oleh].trim();
        if !loc.is_empty() {
            location = Some(loc.to_string());
        }
        &rem_after_di[idx_oleh + " oleh ".len()..]
    } else if let Some(idx_oleh) = rem_lower.find(" oleh(") {
        // Kasus tanpa spasi sebelum '('
        let loc = rem_after_di[..idx_oleh].trim();
        if !loc.is_empty() {
            location = Some(loc.to_string());
        }
        &rem_after_di[idx_oleh + " oleh".len()..]
    } else {
        rem_after_di
    };

    let mut officer_name: Option<String> = None;
    let mut officer_id: Option<String> = None;
    let mut datetime: Option<String> = None;

    // 3. Officer: cari "(...)" setelah "oleh "
    if let Some(start_paren) = after_location.find('(') {
        if let Some(end_paren) = after_location.rfind(')') {
            if end_paren > start_paren {
                let inside = &after_location[start_paren + 1..end_paren];
                let parts: Vec<String> = inside.split('/').map(normalize_text).collect();

                if !parts.is_empty() && !parts[0].is_empty() {
                    officer_name = Some(parts[0].clone());
                }
                if parts.len() > 1 && !parts[1].is_empty() {
                    officer_id = Some(parts[1].clone());
                }

                after_location = &after_location[end_paren + 1..];
            }
        }
    }

    // 4. Datetime: setelah "Tanggal :" hingga sebelum " diterima oleh" atau " -"
    let lower_after = after_location.to_lowercase();
    if let Some(idx_tanggal) = lower_after.find("tanggal") {
        let after = &after_location[idx_tanggal..];
        let (_, after_colon) = after.split_once(':').unwrap_or(("", ""));
        let after_colon = after_colon.trim_start();

        let mut end_idx = after_colon.len();
        if let Some(idx) = after_colon.find(" diterima oleh") {
            end_idx = idx;
        } else if let Some(idx) = after_colon.find(" -") {
            end_idx = idx;
        }

        let dt = after_colon[..end_idx].trim();
        if !dt.is_empty() {
            datetime = Some(dt.to_string());
        }
    }

    (status, location, officer_name, officer_id, datetime)
}

fn split_datetime(raw: &str) -> (Option<String>, Option<String>) {
    let parts: Vec<&str> = raw.split_whitespace().collect();
    if parts.is_empty() {
        return (None, None);
    }
    let date = Some(parts[0].to_string());
    let time = if parts.len() > 1 {
        Some(parts[1].to_string())
    } else {
        None
    };
    (date, time)
}

fn build_history_summary(
    history: &[TrackHistoryEntry],
    status_akhir: &TrackStatusAkhir,
    pod: &TrackPod,
) -> HistorySummary {
    let mut irregularity = Vec::new();
    let mut bag_map: HashMap<String, BaggingUnbaggingSummary> = HashMap::new();
    let mut bag_order: Vec<String> = Vec::new();
    let mut manifest_r7 = Vec::new();
    let mut delivery_runsheet: Vec<DeliveryRunsheetSummary> = Vec::new();
    let mut current_delivery_idx: Option<usize> = None;

    for entry in history {
        let lower = entry.detail_history.to_lowercase();
        let mut matched_any = false;

        // Irregularity
        if lower.contains("proses irregularity") {
            let (tanggal, waktu) = split_datetime(&entry.tanggal_update);
            let (status, petugas, lokasi, koordinat) =
                parse_irregularity_detail(&entry.detail_history);

            irregularity.push(IrregularitySummary {
                status,
                petugas,
                lokasi,
                koordinat,
                tanggal,
                waktu,
            });
            matched_any = true;
        }

        // Bagging / Unbagging
        let (tanggal, waktu) = split_datetime(&entry.tanggal_update);

        if lower.contains("proses bagging") && lower.contains("nomor bag") {
            if let Some(nomor_kantung) = extract_bag_id(&entry.detail_history, "nomor bag") {
                let (petugas, lokasi) = parse_oleh_di(&entry.detail_history);
                let event = BaggingUnbaggingEvent {
                    petugas,
                    lokasi,
                    tanggal: tanggal.clone(),
                    waktu: waktu.clone(),
                };

                if !bag_map.contains_key(&nomor_kantung) {
                    bag_order.push(nomor_kantung.clone());
                }
                let entry =
                    bag_map
                        .entry(nomor_kantung.clone())
                        .or_insert(BaggingUnbaggingSummary {
                            nomor_kantung,
                            bagging: None,
                            unbagging: None,
                        });
                entry.bagging = Some(event);
                matched_any = true;
            }
        } else if lower.contains("proses unbagging") && lower.contains("dari bag") {
            if let Some(nomor_kantung) = extract_bag_id(&entry.detail_history, "dari bag") {
                let (petugas, lokasi) = parse_oleh_di(&entry.detail_history);
                let event = BaggingUnbaggingEvent {
                    petugas,
                    lokasi,
                    tanggal: tanggal.clone(),
                    waktu: waktu.clone(),
                };

                if !bag_map.contains_key(&nomor_kantung) {
                    bag_order.push(nomor_kantung.clone());
                }
                let entry =
                    bag_map
                        .entry(nomor_kantung.clone())
                        .or_insert(BaggingUnbaggingSummary {
                            nomor_kantung,
                            bagging: None,
                            unbagging: None,
                        });
                entry.unbagging = Some(event);
                matched_any = true;
            }
        }

        // ManifestR7
        if lower.contains("proses manifestr7") {
            let (nomor_r7, petugas, lokasi, tujuan) =
                parse_manifest_r7_detail(&entry.detail_history);
            manifest_r7.push(ManifestR7Summary {
                nomor_r7,
                petugas,
                lokasi,
                tujuan,
                tanggal: tanggal.clone(),
                waktu: waktu.clone(),
            });
            matched_any = true;
        }

        // DeliveryRunsheet (awal antar)
        if lower.contains("proses deliveryrunsheet") {
            let (petugas_mandor, lokasi) = parse_oleh_di(&entry.detail_history);
            let petugas_kurir = extract_diterima_oleh(&entry.detail_history);
            let koordinat = extract_coordinate(&entry.detail_history);

            let summary = DeliveryRunsheetSummary {
                petugas_mandor,
                petugas_kurir,
                lokasi,
                tanggal: tanggal.clone(),
                waktu: waktu.clone(),
                koordinat,
                updates: Vec::new(),
            };
            delivery_runsheet.push(summary);
            current_delivery_idx = Some(delivery_runsheet.len() - 1);
            continue;
        }

        // Proses antaran (update setelah DeliveryRunsheet)
        if lower.contains("proses antaran") {
            let (petugas, status) = parse_proses_antaran_status(&entry.detail_history);
            let koordinat = extract_coordinate(&entry.detail_history);

            let update = DeliveryRunsheetUpdate {
                petugas,
                status,
                tanggal: tanggal.clone(),
                waktu: waktu.clone(),
                koordinat,
            };

            if let Some(idx) = current_delivery_idx {
                if let Some(summary) = delivery_runsheet.get_mut(idx) {
                    summary.updates.push(update);
                    continue;
                }
            }

            // Jika tidak ada DeliveryRunsheet sebelumnya, buat summary baru dengan update saja
            warn!(
                "build_history_summary: got 'proses antaran' without previous DeliveryRunsheet: {}",
                entry.detail_history
            );
            let summary = DeliveryRunsheetSummary {
                petugas_mandor: None,
                petugas_kurir: None,
                lokasi: None,
                tanggal: None,
                waktu: None,
                koordinat: None,
                updates: vec![update],
            };
            delivery_runsheet.push(summary);
            current_delivery_idx = Some(delivery_runsheet.len() - 1);
            matched_any = true;
        } else if lower.contains("delivered") {
            // Handle final delivery status being part of the runsheet updates
            let koordinat = extract_coordinate(&entry.detail_history);

            // For DELIVERED, usually the whole text is the status info
            // e.g. "DELIVERED [ YOSEF ] [ YBS ]"
            let status = Some(normalize_text(&entry.detail_history));

            let update = DeliveryRunsheetUpdate {
                petugas: None, // Usually receiver info, not courier
                status,
                tanggal: tanggal.clone(),
                waktu: waktu.clone(),
                koordinat,
            };

            if let Some(idx) = current_delivery_idx {
                if let Some(summary) = delivery_runsheet.get_mut(idx) {
                    summary.updates.push(update);

                    // Usually this closes the runsheet, but we just leave the index as is
                    // in case there are subsequent cosmetic updates?
                    // Or maybe we should allow subsequent updates to append too.
                    continue;
                }
            }

            // If no runsheet active, technically this is a standalone event or data missing.
            // But user specifically asked for runsheet updates.
            // We'll treat it as a matched event so it doesn't trigger "unrecognized" warning if it has "proses" (unlikely for DELIVERED).
            matched_any = true;
        }

        // Jika mengandung kata "proses" tapi tidak cocok dengan pola mana pun di atas,
        // log sebagai pola history yang belum dikenali.
        if !matched_any && lower.contains("proses") {
            warn!(
                "build_history_summary: unrecognized history pattern: {}",
                entry.detail_history
            );
        }
    }

    // Synthesis: If status_akhir is DELIVERED but we didn't find it in history (empty updates on last runsheet),
    // inject it effectively.
    if let Some(final_status) = &status_akhir.status {
        if final_status.to_lowercase().contains("delivered") {
            if let Some(last_sheet) = delivery_runsheet.last_mut() {
                // Check if last sheet already has a delivered update
                let has_delivered = last_sheet.updates.iter().any(|u| {
                    u.status
                        .as_deref()
                        .unwrap_or("")
                        .to_lowercase()
                        .contains("delivered")
                });

                if !has_delivered {
                    // Create synthetic update from status_akhir
                    let (sa_date, sa_time) =
                        split_datetime(status_akhir.datetime.as_deref().unwrap_or(""));

                    // We might want to construct a status string similar to history text
                    // e.g. "DELIVERED" or "DELIVERED [Nama]"?
                    // status_akhir.status usually is just "DELIVERED".
                    let synthetic_status = Some(final_status.clone());

                    let petugas = match (&status_akhir.officer_name, &status_akhir.officer_id) {
                        (Some(n), Some(id)) => Some(format!("{} ({})", n, id)),
                        (Some(n), None) => Some(n.clone()),
                        _ => None,
                    };

                    let synth_coord = pod.coordinate.clone();

                    let update = DeliveryRunsheetUpdate {
                        petugas,
                        status: synthetic_status,
                        tanggal: sa_date,
                        waktu: sa_time,
                        koordinat: synth_coord,
                    };

                    last_sheet.updates.push(update);
                }
            }
        }
    }

    let bagging_unbagging = bag_order
        .into_iter()
        .filter_map(|id| bag_map.remove(&id))
        .collect();

    HistorySummary {
        irregularity,
        bagging_unbagging,
        manifest_r7,
        delivery_runsheet,
    }
}

fn parse_irregularity_detail(
    raw: &str,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    let text = raw.trim();
    let lower = text.to_lowercase();

    // status: di dalam "dengan status (...)" jika ada
    let mut status = None;
    if let Some(idx) = lower.find("dengan status (") {
        let start = idx + "dengan status (".len();
        if let Some(end_rel) = text[start..].find(')') {
            let s = text[start..start + end_rel].trim();
            if !s.is_empty() {
                status = Some(s.to_string());
            }
        }
    }

    // petugas dan lokasi: setelah "oleh" dan " di "
    let mut petugas = None;
    let mut lokasi = None;

    if let Some(idx_oleh) = lower.find(" oleh ") {
        let start_oleh = idx_oleh + " oleh ".len();
        let after_oleh = &text[start_oleh..];
        let after_oleh_lower = &lower[start_oleh..];

        if let Some(idx_di) = after_oleh_lower.find(" di ") {
            let nama = after_oleh[..idx_di].trim();
            if !nama.is_empty() {
                petugas = Some(nama.to_string());
            }

            let start_di = start_oleh + idx_di + " di ".len();
            let after_di = &text[start_di..];

            let mut end_loc = after_di.len();
            if let Some(idx_comma) = after_di.find(',') {
                end_loc = idx_comma;
            } else if let Some(idx_bracket) = after_di.find('[') {
                end_loc = idx_bracket;
            }

            let loc = after_di[..end_loc].trim();
            if !loc.is_empty() {
                lokasi = Some(loc.to_string());
            }
        }
    }

    // koordinat: di dalam "[coordinate : ... ]"
    let koordinat = extract_coordinate(text);

    (status, petugas, lokasi, koordinat)
}

fn parse_oleh_di(raw: &str) -> (Option<String>, Option<String>) {
    let lower = raw.to_lowercase();
    let mut petugas = None;
    let mut lokasi = None;

    if let Some(idx_oleh) = lower.find(" oleh ") {
        let start_oleh = idx_oleh + " oleh ".len();
        let after_oleh = &raw[start_oleh..];
        let after_oleh_lower = &lower[start_oleh..];

        if let Some(idx_di) = after_oleh_lower.find(" di ") {
            let nama = after_oleh[..idx_di].trim();
            if !nama.is_empty() {
                petugas = Some(nama.to_string());
            }

            let start_di = start_oleh + idx_di + " di ".len();
            let after_di = &raw[start_di..];
            let after_di_lower = &lower[start_di..];

            let mut end_loc = after_di.len();
            if let Some(idx_stop) = after_di_lower.find(" dan diterima oleh ") {
                end_loc = idx_stop;
            } else if let Some(idx_comma) = after_di.find(',') {
                end_loc = idx_comma;
            } else if let Some(idx_bracket) = after_di.find('[') {
                end_loc = idx_bracket;
            }

            let loc = after_di[..end_loc].trim();
            if !loc.is_empty() {
                lokasi = Some(loc.to_string());
            }
        }
    }

    (petugas, lokasi)
}

fn extract_bag_id(raw: &str, key: &str) -> Option<String> {
    let lower = raw.to_lowercase();
    let key_lower = key.to_lowercase();
    let idx = lower.find(&key_lower)?;
    let start = idx + key_lower.len();
    let rest = raw[start..].trim_start();
    let first = rest.split_whitespace().next()?;
    let id = first
        .trim()
        .trim_matches(|c: char| c == ',' || c == '.' || c == ';')
        .to_string();
    if id.is_empty() {
        None
    } else {
        Some(id)
    }
}

fn extract_coordinate(raw: &str) -> Option<String> {
    let text = raw.trim();
    let lower = text.to_lowercase();
    let idx_coord = lower.find("[coordinate")?;
    let idx_colon = lower[idx_coord..].find(':')?;
    let start = idx_coord + idx_colon + 1;
    let after_colon = text[start..].trim_start();

    let mut end = after_colon.len();
    if let Some(idx_end) = after_colon.find(']') {
        end = idx_end;
    } else if let Some(idx_end) = after_colon.find("Lihat") {
        end = idx_end;
    }

    let coord = after_colon[..end].trim();
    if coord.is_empty() {
        None
    } else {
        Some(coord.to_string())
    }
}

fn extract_diterima_oleh(raw: &str) -> Option<String> {
    let text = raw.trim();
    let lower = text.to_lowercase();
    let key = " dan diterima oleh ";
    let idx = lower.find(key)?;
    let start = idx + key.len();
    let after = &text[start..];

    let mut end = after.len();
    if let Some(idx_comma) = after.find(',') {
        end = idx_comma;
    } else if let Some(idx_bracket) = after.find('[') {
        end = idx_bracket;
    }

    let name = after[..end].trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

fn parse_manifest_r7_detail(
    raw: &str,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    let text = raw.trim();
    let lower = text.to_lowercase();

    // nomor R7: setelah "nomor R7"
    let mut nomor_r7 = None;
    if let Some(idx) = lower.find("nomor r7") {
        let start = idx + "nomor r7".len();
        let rest = text[start..].trim_start();
        if let Some(first) = rest.split_whitespace().next() {
            let id = first
                .trim()
                .trim_matches(|c: char| c == ',' || c == '.' || c == ';')
                .to_string();
            if !id.is_empty() {
                nomor_r7 = Some(id);
            }
        }
    }

    // petugas & lokasi: setelah "oleh" dan " di "
    let mut petugas = None;
    let mut lokasi = None;
    let mut tujuan = None;

    if let Some(idx_oleh) = lower.find(" oleh ") {
        let start_oleh = idx_oleh + " oleh ".len();
        let after_oleh = &text[start_oleh..];
        let after_oleh_lower = &lower[start_oleh..];

        if let Some(idx_di) = after_oleh_lower.find(" di ") {
            let nama = after_oleh[..idx_di].trim();
            if !nama.is_empty() {
                petugas = Some(nama.to_string());
            }

            let start_di = start_oleh + idx_di + " di ".len();
            let after_di = &text[start_di..];
            let after_di_lower = &lower[start_di..];

            let mut end_loc = after_di.len();
            if let Some(idx_tujuan) = after_di_lower.find(" dengan tujuan ") {
                end_loc = idx_tujuan;
            } else if let Some(idx_comma) = after_di.find(',') {
                end_loc = idx_comma;
            } else if let Some(idx_bracket) = after_di.find('[') {
                end_loc = idx_bracket;
            }

            let loc = after_di[..end_loc].trim();
            if !loc.is_empty() {
                lokasi = Some(loc.to_string());
            }
        }
    }

    // tujuan: setelah "dengan tujuan"
    if let Some(idx_tujuan) = lower.find("dengan tujuan ") {
        let start = idx_tujuan + "dengan tujuan ".len();
        let after = &text[start..];
        let after_lower = &lower[start..];

        let mut end = after.len();
        if let Some(idx_nomor) = after_lower.find(" dan nomor r7") {
            end = idx_nomor;
        } else if let Some(idx_comma) = after.find(',') {
            end = idx_comma;
        } else if let Some(idx_bracket) = after.find('[') {
            end = idx_bracket;
        }

        let dest = after[..end].trim();
        if !dest.is_empty() {
            tujuan = Some(dest.to_string());
        }
    }

    (nomor_r7, petugas, lokasi, tujuan)
}

fn parse_proses_antaran_status(raw: &str) -> (Option<String>, Option<String>) {
    let text = raw.trim();
    let lower = text.to_lowercase();

    // petugas: setelah "oleh"
    let mut petugas = None;
    if let Some(idx_oleh) = lower.find(" oleh ") {
        let start = idx_oleh + " oleh ".len();
        let rest = &text[start..];
        let rest_lower = &lower[start..];

        let mut end = rest.len();
        if let Some(idx_dengan) = rest_lower.find(" dengan") {
            end = idx_dengan;
        } else if let Some(idx_comma) = rest.find(',') {
            end = idx_comma;
        } else if let Some(idx_bracket) = rest.find('[') {
            end = idx_bracket;
        }

        let nama = rest[..end].trim();
        if !nama.is_empty() {
            petugas = Some(nama.to_string());
        }
    }

    // status utama:
    // 1) "dengan keterangan ( ... )"
    if let Some(idx) = lower.find("dengan keterangan (") {
        let start = idx + "dengan keterangan (".len();
        if let Some(end_rel) = text[start..].find(')') {
            let s = text[start..start + end_rel].trim();
            if !s.is_empty() {
                return (petugas, Some(s.to_string()));
            }
        }
    }

    // 2) "status failed by system ..."
    if let Some(idx) = lower.find("status") {
        let start = idx + "status".len();
        let rest = text[start..].trim_start();
        let mut end = rest.len();
        if let Some(idx_time) = rest.find(|c: char| c.is_ascii_digit()) {
            end = idx_time;
        } else if let Some(idx_comma) = rest.find(',') {
            end = idx_comma;
        } else if let Some(idx_bracket) = rest.find('[') {
            end = idx_bracket;
        }
        let s = rest[..end].trim();
        if !s.is_empty() {
            return (petugas, Some(s.to_string()));
        }
    }

    (petugas, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_sla_and_status_from_nomor_kiriman() {
        let raw = "P2510250040597 [ SLA : 6 hari, Status kiriman OverSLA 31 hari ]";
        let detail = parse_sla_from_nomor_kiriman(raw);

        assert_eq!(detail.sla.as_deref(), Some("6 hari"));
        assert_eq!(detail.sla_category.as_deref(), Some("OverSLA"));
        assert_eq!(detail.sla_days, Some(31));
    }

    #[test]
    fn parse_cod_detail_from_string() {
        let raw = "#COD, Virtual Account : 23221763 Type Rekening : Total COD : 110.000 Status COD/CCOD : Sudah dilakukan pembayaran , Tanggal : 2025-12-01 10:12:05";
        let cod = parse_cod_non_cod(raw);

        assert!(cod.is_cod);
        assert_eq!(cod.virtual_account.as_deref(), Some("23221763"));
        assert_eq!(cod.total_cod, 110000.0);
        assert_eq!(cod.status.as_deref(), Some("Sudah dilakukan pembayaran"));
        assert_eq!(cod.tanggal.as_deref(), Some("2025-12-01 10:12:05"));
    }

    #[test]
    fn parse_cod_detail_alternate_delimiters() {
        // Case where "Tipe Rekening" is used instead of "Type Rekening"
        // Also checks if total_cod logic falls back correctly if "Status COD/CCOD" is missing (simulated by skipping it in test string if needed,
        // but here we test the virtual account fallback specifically).
        let raw = "#COD, Virtual Account : 999111 Tipe Rekening : BNI Total COD : 50000";
        let cod = parse_cod_non_cod(raw);

        assert!(cod.is_cod);
        // The fallback logic:
        // 1. segment_between(..., "Type Rekening") -> fails (end not found)
        // 2. or_else(..., "Tipe Rekening") -> succeeds
        assert_eq!(cod.virtual_account.as_deref(), Some("999111"));
        assert_eq!(cod.total_cod, 50000.0);
    }

    #[test]
    fn parse_cod_detail_retur_without_status_label() {
        let raw =
            "#COD, Virtual Account : 13594991689 Type Rekening : Total COD : 190.000 COD Retur";
        let cod = parse_cod_non_cod(raw);

        assert!(cod.is_cod);
        assert_eq!(cod.virtual_account.as_deref(), Some("13594991689"));
        assert_eq!(cod.total_cod, 190000.0);
        assert_eq!(cod.status.as_deref(), Some("COD Retur"));
        assert_eq!(cod.tanggal, None);
    }

    #[test]
    fn parse_ccod_detail_as_cod() {
        let raw = "#CCOD, Virtual Account : 25176303 Type Rekening : Total COD : 3.783.486 Status COD/CCOD : Belum dilakukan pembayaran";
        let cod = parse_cod_non_cod(raw);

        assert!(cod.is_cod);
        assert_eq!(cod.virtual_account.as_deref(), Some("25176303"));
        assert_eq!(cod.total_cod, 3783486.0);
        assert_eq!(cod.status.as_deref(), Some("Belum dilakukan pembayaran"));
        assert_eq!(cod.tanggal, None);
    }

    #[test]
    fn parse_status_akhir_complex() {
        let text = "INVEHICLE di SPP SURABAYA 60400 oleh (Arwindo Okta Darmawan (Distribusi C) / 975371320) Tanggal : 2025-12-01 12:35:35 -";
        let (status, location, officer_name, officer_id, datetime) = parse_status_akhir(text);

        assert_eq!(status.as_deref(), Some("INVEHICLE"));
        assert_eq!(location.as_deref(), Some("SPP SURABAYA 60400"));
        assert_eq!(
            officer_name.as_deref(),
            Some("Arwindo Okta Darmawan (Distribusi C)")
        );
        assert_eq!(officer_id.as_deref(), Some("975371320"));
        assert_eq!(datetime.as_deref(), Some("2025-12-01 12:35:35"));
    }

    #[test]
    fn parse_sla_status_ontime_no_days() {
        let (category, days) = parse_sla_status("OnTime");
        assert_eq!(category.as_deref(), Some("OnTime"));
        assert_eq!(days, None);
    }

    #[test]
    fn parse_sla_status_jatuh_tempo() {
        let (category, days) = parse_sla_status("Kiriman akan jatuh tempo => 17 hari lagi");
        assert_eq!(category.as_deref(), Some("JatuhTempo"));
        assert_eq!(days, Some(17));
    }

    #[test]
    fn parse_irregularity_detail_basic() {
        let text = "Barang Anda Telah Melewati Proses Irregularity dengan status (Retur Barang) oleh Rohman Hadi di KCP DEPAPRE 99353, [coordinate : -2.4640683,140.3651933 Lihat photo Irregularity -> Photo Irregularity";
        let (status, petugas, lokasi, koordinat) = parse_irregularity_detail(text);

        assert_eq!(status.as_deref(), Some("Retur Barang"));
        assert_eq!(petugas.as_deref(), Some("Rohman Hadi"));
        assert_eq!(lokasi.as_deref(), Some("KCP DEPAPRE 99353"));
        assert_eq!(koordinat.as_deref(), Some("-2.4640683,140.3651933"));
    }

    #[test]
    fn parse_manifest_r7_detail_basic() {
        let text = "Barang anda P2511030028976 telah melewati proses ManifestR7 oleh Joko Sulistiyono di SPP JAYAPURA 99100 dengan tujuan DC JAYAPURA 9910A dan nomor R7 L20251108000231 09:40";
        let (nomor_r7, petugas, lokasi, tujuan) = parse_manifest_r7_detail(text);

        assert_eq!(nomor_r7.as_deref(), Some("L20251108000231"));
        assert_eq!(petugas.as_deref(), Some("Joko Sulistiyono"));
        assert_eq!(lokasi.as_deref(), Some("SPP JAYAPURA 99100"));
        assert_eq!(tujuan.as_deref(), Some("DC JAYAPURA 9910A"));
    }

    #[test]
    fn parse_pod_dynamic_columns_and_empty_image() {
        let html = r#"
        <html>
        <body>
            <table>
                <tr>
                    <td>POD</td>
                    <td>coordinate</td>
                    <td>Photo2</td>
                    <td>signature</td>
                    <td>Photo</td>
                </tr>
                <tr>
                    <td>(ignored)</td>
                    <td>
                        -2.5,140.7
                        <a href="https://maps.google.com">View Map</a>
                    </td>
                    <td>
                        <!-- Invalid short base64 -->
                        <img src="data:image/jpeg;base64," />
                    </td>
                    <td>
                        <!-- Valid signature -->
                        <img src="data:image/png;base64,VALID_SIGNATURE_DATA_ABCDEF123456" />
                    </td>
                    <td>
                        <!-- Valid photo -->
                        <img src="https://example.com/photo.jpg" />
                    </td>
                </tr>
            </table>
        </body>
        </html>
        "#;

        let response = scrape_track(html, "http://dummy");
        let pod = response.pod;

        // Coordinate should be extracted (column index 1 in mock)
        assert_eq!(pod.coordinate.as_deref(), Some("-2.5,140.7"));
        assert_eq!(
            pod.coordinate_map_url.as_deref(),
            Some("https://maps.google.com")
        );

        // Photo2 is invalid base64 -> should be None
        assert_eq!(pod.photo2_url, None);

        // Signature is valid -> should be Some
        assert_eq!(
            pod.signature_url.as_deref(),
            Some("data:image/png;base64,VALID_SIGNATURE_DATA_ABCDEF123456")
        );

        // Photo1 is valid -> should be Some
        assert_eq!(
            pod.photo1_url.as_deref(),
            Some("https://example.com/photo.jpg")
        );
    }

    #[test]
    fn parse_pod_with_rowspan() {
        // HTML structure similar to the real failure case with rowspan="2" on POD
        // Header row has 5 columns: POD, Photo, Photo2, signature, coordinate
        // Data row has 4 columns because POD is spanned
        let html = r#"
        <html>
        <body>
            <table>
                <tr>
                    <th rowspan="2">POD</th>
                    <th>Photo</th>
                    <th>Photo2</th>
                    <th>signature</th>
                    <th>coordinate</th>
                </tr>
                <tr>
                    <!-- no POD cell here due to rowspan -->
                    <td>
                        <img src="data:image/jpeg;base64,PHOTO_DATA_123_LONGER_THAN_50_CHARS_TO_PASS_VALIDATION_CHECK" />
                    </td>
                    <td>
                        <!-- Photo2 is just text/link -->
                        <a href="..."/>
                    </td>
                    <td>
                        <img src="data:image/png;base64,SIG_DATA_456_LONGER_THAN_50_CHARS_TO_PASS_VALIDATION_CHECK" />
                    </td>
                    <td>
                        -2.5,140.7
                    </td>
                </tr>
            </table>
        </body>
        </html>
        "#;

        let response = scrape_track(html, "http://dummy");
        let pod = response.pod;

        // Photo (index 1 in header -> index 0 in data)
        assert_eq!(
            pod.photo1_url.as_deref(),
            Some("data:image/jpeg;base64,PHOTO_DATA_123_LONGER_THAN_50_CHARS_TO_PASS_VALIDATION_CHECK")
        );

        // Signature (index 3 in header -> index 2 in data)
        assert_eq!(
            pod.signature_url.as_deref(),
            Some(
                "data:image/png;base64,SIG_DATA_456_LONGER_THAN_50_CHARS_TO_PASS_VALIDATION_CHECK"
            )
        );

        // Coordinate (index 4 in header -> index 3 in data)
        assert_eq!(pod.coordinate.as_deref(), Some("-2.5,140.7"));
    }

    #[test]
    fn parse_nomor_kiriman_with_sla() {
        let html = r#"
        <html>
        <body>
            <table>
                <tr>
                    <td>Nomor Kiriman</td>
                    <td>P2511270014402 [ SLA : 4 hari, Status kiriman OverSLA 1 hari ]</td>
                </tr>
            </table>
        </body>
        </html>
        "#;

        let response = scrape_track(html, "http://dummy");

        // Nomor kiriman di header
        let header = response.detail.header;
        assert_eq!(header.nomor_kiriman.as_deref(), Some("P2511270014402"));

        // SLA info di performance
        let perf = response.detail.performance;
        assert_eq!(perf.sla.as_deref(), Some("4 hari"));
        assert_eq!(perf.sla_category.as_deref(), Some("OverSLA"));
    }

    #[test]
    fn parse_kantor_kiriman_detail_basic() {
        let entry = TrackHistoryEntry {
            tanggal_update: "2025-11-27 08:41:59".to_string(),
            detail_history: "Connote telah dibuat oleh Titin Supriatin (971344759) di lokasi KCP BEKASIPASARLAMA 17113A".to_string(),
        };

        let detail = parse_kantor_kiriman_detail(&entry);

        assert_eq!(detail.nama_kantor.as_deref(), Some("KCP BEKASIPASARLAMA"));
        assert_eq!(detail.id_kantor.as_deref(), Some("17113A"));
        assert_eq!(detail.nama_petugas.as_deref(), Some("Titin Supriatin"));
        assert_eq!(detail.id_petugas.as_deref(), Some("971344759"));
        assert_eq!(detail.tanggal.as_deref(), Some("2025-11-27"));
        assert_eq!(detail.waktu.as_deref(), Some("08:41:59"));
    }

    #[test]
    fn parse_weight_basic() {
        let input = "Aktual : 1 Kg, Volumetrik : 0.851 Kg";
        let (actual, volumetric) = parse_weight(input);
        assert_eq!(actual, 1.0);
        assert_eq!(volumetric, 0.851);
    }

    #[test]
    fn parse_weight_variants() {
        // Case insensitive, spaces
        let input = "aktual:5kg,volumetrik:2.5KG";
        let (actual, volumetric) = parse_weight(input);
        assert_eq!(actual, 5.0);
        assert_eq!(volumetric, 2.5);

        // Missing one
        let input = "Aktual : 10 Kg";
        let (actual, volumetric) = parse_weight(input);
        assert_eq!(actual, 10.0);
        assert_eq!(volumetric, 0.0);
    }

    #[test]
    fn parse_pengirim_with_kodepos() {
        let raw = "PENGADILAN NEGERI BEKASI; 02188955971; JL P JAYAKARTA RT 004/002 HARAPAN MULYA BEKASI 17143; 17143";
        let contact = parse_pengirim(raw);
        assert_eq!(contact.nama.as_deref(), Some("PENGADILAN NEGERI BEKASI"));
        assert_eq!(contact.telepon.as_deref(), Some("02188955971"));
        assert_eq!(
            contact.alamat.as_deref(),
            Some("JL P JAYAKARTA RT 004/002 HARAPAN MULYA BEKASI 17143")
        );
        assert_eq!(contact.kode_pos.as_deref(), Some("17143"));
    }

    #[test]
    fn parse_history_runsheet_with_delivered() {
        // 1. Normal DELIVERED present in history
        let history = vec![
            TrackHistoryEntry {
                tanggal_update: "2025-12-01 10:00:00".to_string(),
                detail_history: "Proses DeliveryRunsheet oleh Mandor [MANDOR] di lokasi [LOKASI] dan diterima oleh Kurir (KURIR)".to_string(),
            },
            TrackHistoryEntry {
                tanggal_update: "2025-12-01 11:00:00".to_string(),
                detail_history: "Proses Antaran oleh Kurir (KURIR) dengan status Sedang Diantar".to_string(),
            },
            TrackHistoryEntry {
                tanggal_update: "2025-12-01 12:00:00".to_string(),
                detail_history: "DELIVERED [ PENERIMA ] [ YBS ]".to_string(),
            }
        ];
        let status_default = TrackStatusAkhir::default();
        let pod_default = TrackPod::default();
        let summary = build_history_summary(&history, &status_default, &pod_default);
        let runsheets = summary.delivery_runsheet;

        assert_eq!(runsheets.len(), 1);
        let sheet = &runsheets[0];
        assert_eq!(sheet.updates.len(), 2);
        assert_eq!(sheet.updates[0].status.as_deref(), Some("Sedang Diantar"));
        assert!(sheet.updates[1]
            .status
            .as_deref()
            .unwrap()
            .contains("DELIVERED"));

        // 2. Return Delivery
        let history_return = vec![
            TrackHistoryEntry {
                tanggal_update: "2025-12-05 10:00:00".to_string(),
                detail_history: "Proses DeliveryRunsheet oleh Mandor [MANDOR] di lokasi [LOKASI] dan diterima oleh Kurir (KURIR)".to_string(),
            },
            TrackHistoryEntry {
                tanggal_update: "2025-12-05 14:00:00".to_string(),
                detail_history: "DELIVERED (Return Delivery) [ PENERIMA ]".to_string(),
            }
        ];
        let summary_return = build_history_summary(&history_return, &status_default, &pod_default);
        assert_eq!(summary_return.delivery_runsheet.len(), 1);
        assert_eq!(summary_return.delivery_runsheet[0].updates.len(), 1);
        assert!(summary_return.delivery_runsheet[0].updates[0]
            .status
            .as_deref()
            .unwrap()
            .contains("Return Delivery"));

        // 3. Missing DELIVERED in history (Synthesis Case)
        let history_missing = vec![
            TrackHistoryEntry {
                tanggal_update: "2025-12-10 09:00:00".to_string(),
                detail_history: "Proses DeliveryRunsheet oleh Mandor [MANDOR] di lokasi [LOKASI] dan diterima oleh Kurir (KURIR)".to_string(),
            },
            TrackHistoryEntry {
                tanggal_update: "2025-12-10 09:15:00".to_string(),
                detail_history: "Proses Antaran oleh Kurir (KURIR) dengan status Sedang Diantar".to_string(),
            }
            // No DELIVERED row here
        ];
        let status_delivered = TrackStatusAkhir {
            status: Some("DELIVERED".to_string()),
            officer_name: Some("Courier Name".to_string()),
            datetime: Some("2025-12-10 14:00:00".to_string()),
            ..Default::default()
        };

        let mock_pod = TrackPod {
            coordinate: Some("-2.5,140.7".to_string()),
            ..Default::default()
        };

        let summary_synth = build_history_summary(&history_missing, &status_delivered, &mock_pod);
        let sheet_synth = &summary_synth.delivery_runsheet[0];

        assert_eq!(
            sheet_synth.updates.len(),
            2,
            "Should have synthesized update"
        );
        let last_update = &sheet_synth.updates[1];
        assert_eq!(last_update.status.as_deref(), Some("DELIVERED"));
        assert_eq!(last_update.waktu.as_deref(), Some("14:00:00"));
        assert_eq!(last_update.petugas.as_deref(), Some("Courier Name"));
        assert_eq!(last_update.koordinat.as_deref(), Some("-2.5,140.7"));
    }
}
