use std::collections::HashMap;

use scraper::{Html as ScraperHtml, Selector};

use super::model::{
    Actors, BaggingUnbaggingEvent, BaggingUnbaggingSummary, BillingDetail, ContactDetail,
    DeliveryRunsheetSummary, DeliveryRunsheetUpdate, HistorySummary, IrregularitySummary,
    ManifestR7Summary, OriginDetail, PackageDetail, PerformanceDetail, ShipmentHeader,
    StatusAkhirParts, TrackCodDetail, TrackDetail, TrackHistoryEntry, TrackPod, TrackResponse,
    TrackStatusAkhir, TrackingError,
};
use super::upstream::resolve_pos_href;

#[derive(Default)]
struct ProsesAntaranDetail {
    petugas: Option<String>,
    status: Option<String>,
    keterangan_status: Option<String>,
}

pub fn parse_tracking_html(request_url: &str, html: &str) -> Result<TrackResponse, TrackingError> {
    let document = ScraperHtml::parse_document(html);
    let document_text = normalize_text(&document.root_element().text().collect::<String>());
    let tr_selector = Selector::parse("tr").expect("valid selector");
    let cell_selector = Selector::parse("td, th").expect("valid selector");
    let table_selector = Selector::parse("table").expect("valid selector");
    let img_selector = Selector::parse("img").expect("valid selector");
    let a_selector = Selector::parse("a").expect("valid selector");

    let mut header = ShipmentHeader::default();
    let mut origin = OriginDetail::default();
    let mut package = PackageDetail::default();
    let mut billing = BillingDetail::default();
    let mut actors = Actors::default();
    let mut performance = PerformanceDetail::default();
    let mut status_akhir = TrackStatusAkhir::default();
    let mut pod = TrackPod::default();
    let mut history = Vec::new();

    for tr in document.select(&tr_selector) {
        let cells: Vec<String> = tr
            .select(&cell_selector)
            .map(|cell| normalize_text(&cell.text().collect::<String>()))
            .filter(|text| !text.is_empty())
            .collect();

        if cells.len() < 2 {
            continue;
        }

        let label = normalize_label(&cells[0]);
        let value = cells[1].clone();

        match label.as_str() {
            "NOMOR KIRIMAN" => {
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
            "JENIS LAYANAN" => package.jenis_layanan = Some(value),
            "COD/NON COD" => billing.cod = parse_cod_non_cod(&value)?,
            "ISI KIRIMAN" => package.isi_kiriman = Some(value),
            "BERAT KIRIMAN" => {
                let (act, vol) = parse_weight(&value)?;
                package.berat_actual = act;
                package.berat_volumetric = vol;
            }
            "KRITERIA KIRIMAN" => package.kriteria_kiriman = Some(value),
            "BEA DASAR" => billing.bea_dasar = parse_currency(&value)?,
            "NILAI BARANG" => billing.nilai_barang = parse_currency(&value)?,
            "HTNB" => billing.htnb = parse_currency(&value)?,
            "PENGIRIM" => actors.pengirim = parse_pengirim(&value),
            "PENERIMA" => actors.penerima = parse_penerima(&value),
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

    for table in document.select(&table_selector) {
        let mut rows = table.select(&tr_selector);
        let Some(header_row) = rows.next() else {
            continue;
        };

        let headers: Vec<String> = header_row
            .select(&cell_selector)
            .map(|cell| normalize_label(&normalize_text(&cell.text().collect::<String>())))
            .collect();

        if headers.is_empty() {
            continue;
        }

        let idx_photo1 = headers
            .iter()
            .position(|header| header.contains("PHOTO") && !header.contains("PHOTO2"));
        let idx_photo2 = headers.iter().position(|header| header.contains("PHOTO2"));
        let mut idx_signature = headers
            .iter()
            .position(|header| header.contains("SIGNATURE") || header.contains("TANDA TANGAN"));
        let mut idx_coordinate = headers
            .iter()
            .position(|header| header.contains("COORDINATE") || header.contains("KOORDINAT"));

        if let Some(photo2_index) = idx_photo2 {
            if photo2_index == 2 {
                if idx_signature.is_none() && headers.len() > 3 {
                    idx_signature = Some(3);
                }
                if idx_coordinate.is_none() && headers.len() > 4 {
                    idx_coordinate = Some(4);
                }
            }
        }

        if idx_photo1.is_some()
            || idx_photo2.is_some()
            || idx_signature.is_some()
            || idx_coordinate.is_some()
        {
            if let Some(data_row) = rows.next() {
                let cells: Vec<_> = data_row.select(&cell_selector).collect();
                let has_pod_header = headers
                    .first()
                    .map(|header| header.contains("POD"))
                    .unwrap_or(false);
                let row_offset = if has_pod_header && cells.len() == headers.len() - 1 {
                    1
                } else {
                    0
                };

                let extract_img = |idx: Option<usize>| -> Option<String> {
                    let index = idx?;
                    let target_index = if index >= row_offset {
                        index - row_offset
                    } else {
                        index
                    };
                    let cell = cells.get(target_index)?;
                    if let Some(img) = cell.select(&img_selector).next() {
                        let get_valid_src = |attr_name: &str| -> Option<String> {
                            let value = img.value().attr(attr_name)?.trim().to_string();
                            if value.is_empty()
                                || (value.starts_with("data:image") && value.len() < 50)
                            {
                                return None;
                            }
                            Some(value)
                        };

                        if let Some(src) =
                            get_valid_src("src").or_else(|| get_valid_src("data-src"))
                        {
                            if src.starts_with("data:image/") {
                                return Some(src);
                            }

                            return Some(resolve_pos_href(&src));
                        }
                    }

                    cell.select(&a_selector)
                        .next()
                        .and_then(|link| link.value().attr("href"))
                        .map(resolve_pos_href)
                };

                pod.photo1_url = extract_img(idx_photo1);
                pod.photo2_url = extract_img(idx_photo2);
                pod.signature_url = extract_img(idx_signature);

                if let Some(index) = idx_coordinate {
                    let target_index = if index >= row_offset {
                        index - row_offset
                    } else {
                        index
                    };

                    if let Some(cell) = cells.get(target_index) {
                        let raw_text = normalize_text(&cell.text().collect::<String>());
                        let coordinate = raw_text
                            .replace("View Map", "")
                            .replace("Lihat Peta", "")
                            .replace("View Photo", "")
                            .trim()
                            .to_string();

                        if !coordinate.is_empty() {
                            pod.coordinate = Some(coordinate);
                        }

                        if let Some(link) = cell.select(&a_selector).next() {
                            if let Some(href) = link.value().attr("href") {
                                pod.coordinate_map_url = Some(resolve_pos_href(href));
                            }
                        }
                    }
                }
            }
        }

        if headers.len() >= 2
            && headers[0].contains("TANGGAL UPDATE")
            && headers[1].contains("DETAIL HISTORY")
        {
            for row in rows {
                let cells: Vec<String> = row
                    .select(&cell_selector)
                    .map(|cell| normalize_text(&cell.text().collect::<String>()))
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

    if header.nomor_kiriman.is_none() && status_akhir.status.is_none() {
        let lower = document_text.to_lowercase();
        if lower.contains("tidak ditemukan")
            || lower.contains("data tidak ditemukan")
            || lower.contains("shipment was not found")
            || lower.contains("not found")
        {
            return Err(TrackingError::NotFound(
                "Shipment was not found on POS tracking.".into(),
            ));
        }

        return Err(TrackingError::Upstream(
            "Tracking HTML was returned, but expected shipment detail fields were missing.".into(),
        ));
    }

    if let Some(entry) = history
        .iter()
        .find(|item| item.detail_history.to_lowercase().contains("connote telah dibuat oleh"))
    {
        origin = parse_kantor_kiriman_detail(entry);
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

    Ok(TrackResponse {
        url: request_url.into(),
        detail,
        status_akhir,
        pod,
        history,
        history_summary,
    })
}

fn normalize_text(input: &str) -> String {
    let mut result = String::new();
    let mut prev_is_space = false;

    for ch in input.chars() {
        let is_space = ch.is_whitespace();
        if is_space {
            if !prev_is_space {
                result.push(' ');
            }
        } else {
            result.push(ch);
        }
        prev_is_space = is_space;
    }

    result.trim().to_string()
}

fn normalize_label(input: &str) -> String {
    normalize_text(input).to_uppercase()
}

fn parse_currency(value: &str) -> Result<Option<f64>, TrackingError> {
    let normalized = value
        .replace("Rp", "")
        .replace("RP", "")
        .replace('.', "")
        .replace(',', ".")
        .trim()
        .to_string();

    if normalized.is_empty() || normalized == "-" {
        return Ok(None);
    }

    normalized
        .parse::<f64>()
        .map(Some)
        .map_err(|_| {
            TrackingError::Upstream(format!(
                "Unable to parse currency value from upstream HTML: {value}"
            ))
        })
}

fn parse_weight(value: &str) -> Result<(Option<f64>, Option<f64>), TrackingError> {
    let mut actual = None;
    let mut volumetric = None;

    for part in value.split(',') {
        let lower = part.to_lowercase();
        if lower.contains("aktual") {
            if let Some((_, raw)) = lower.split_once(':') {
                actual = parse_weight_value(raw)?;
            }
        } else if lower.contains("volumetrik") {
            if let Some((_, raw)) = lower.split_once(':') {
                volumetric = parse_weight_value(raw)?;
            }
        }
    }

    Ok((actual, volumetric))
}

fn parse_weight_value(value: &str) -> Result<Option<f64>, TrackingError> {
    let normalized = value
        .replace("kg", "")
        .replace("KG", "")
        .trim()
        .to_string();

    if normalized.is_empty() || normalized == "-" {
        return Ok(None);
    }

    normalized
        .parse::<f64>()
        .map(Some)
        .map_err(|_| {
            TrackingError::Upstream(format!(
                "Unable to parse weight value from upstream HTML: {value}"
            ))
        })
}

fn parse_cod_non_cod(raw: &str) -> Result<TrackCodDetail, TrackingError> {
    let upper = raw.to_uppercase();
    let is_cod = upper.trim_start().starts_with("#COD") || upper.trim_start().starts_with("#CCOD");

    if !is_cod {
        return Ok(TrackCodDetail {
            is_cod: false,
            virtual_account: None,
            total_cod: None,
            status: None,
            tanggal: None,
        });
    }

    fn clean_segment(segment: &str) -> String {
        segment
            .trim()
            .trim_matches(|ch: char| ch == ',' || ch == ':')
            .trim()
            .to_string()
    }

    fn segment_between(value: &str, start: &str, end: &str) -> Option<String> {
        let (_, rest) = value.split_once(start)?;
        let (segment, _) = rest.split_once(end)?;
        Some(clean_segment(segment))
    }

    fn segment_after(value: &str, start: &str) -> Option<String> {
        let (_, rest) = value.split_once(start)?;
        Some(clean_segment(rest))
    }

    fn extract_amount_prefix(value: &str) -> Option<String> {
        let mut started = false;
        let mut output = String::new();

        for ch in value.chars() {
            if ch.is_ascii_digit() || ch == '.' || ch == ',' {
                started = true;
                output.push(ch);
            } else if !started || ch.is_whitespace() {
                continue;
            } else {
                break;
            }
        }

        let output = output.trim().to_string();
        if output.is_empty() {
            None
        } else {
            Some(output)
        }
    }

    let virtual_account = segment_between(raw, "Virtual Account :", "Type Rekening")
        .or_else(|| segment_between(raw, "Virtual Account :", "Tipe Rekening"))
        .or_else(|| segment_after(raw, "Virtual Account :"));

    let total_cod_raw = segment_between(raw, "Total COD :", "Status COD/CCOD")
        .or_else(|| segment_between(raw, "Total COD :", "Non COD"))
        .or_else(|| segment_between(raw, "Total COD :", "COD Retur"))
        .or_else(|| segment_between(raw, "Total COD :", "COD Return"))
        .or_else(|| segment_after(raw, "Total COD :"))
        .unwrap_or_default();

    let total_cod = extract_amount_prefix(&total_cod_raw)
        .map(|value| parse_currency(&value))
        .transpose()?
        .unwrap_or(parse_currency(&total_cod_raw)?);

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

    Ok(TrackCodDetail {
        is_cod: true,
        virtual_account,
        total_cod,
        status,
        tanggal,
    })
}

fn parse_sla_from_nomor_kiriman(raw: &str) -> PerformanceDetail {
    let trimmed = raw.trim();
    let Some(start) = trimmed.find('[') else {
        return PerformanceDetail::default();
    };
    let Some(end) = trimmed.rfind(']') else {
        return PerformanceDetail::default();
    };

    if end <= start {
        return PerformanceDetail::default();
    }

    let inside = &trimmed[start + 1..end];
    let upper = inside.to_uppercase();
    let Some(sla_pos) = upper.find("SLA :") else {
        return PerformanceDetail::default();
    };

    let after = &inside[sla_pos + "SLA :".len()..];
    let segments: Vec<String> = after
        .split(',')
        .map(normalize_text)
        .filter(|segment| !segment.is_empty())
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

fn split_semicolon_segments(raw: &str) -> Vec<String> {
    raw.split(';')
        .map(normalize_text)
        .filter(|value| !value.is_empty())
        .collect()
}

fn parse_pengirim(raw: &str) -> ContactDetail {
    parse_contact(raw)
}

fn parse_penerima(raw: &str) -> ContactDetail {
    parse_contact(raw)
}

fn parse_contact(raw: &str) -> ContactDetail {
    let parts = split_semicolon_segments(raw);
    if parts.len() < 2 {
        return ContactDetail::default();
    }

    let nama = Some(parts[0].clone());
    let telepon = parts.get(1).cloned();

    let (alamat, kode_pos) = if parts.len() >= 4 {
        let kode_pos = parts.last().cloned();
        let alamat = if parts.len() > 3 {
            Some(parts[2..parts.len() - 1].join("; "))
        } else {
            None
        };
        (alamat, kode_pos)
    } else {
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
    let mut detail = OriginDetail::default();
    let (tanggal, waktu) = split_datetime(&entry.tanggal_update);
    detail.tanggal = tanggal;
    detail.waktu = waktu;

    let raw = &entry.detail_history;
    if !raw.to_lowercase().starts_with("connote telah dibuat oleh") {
        return detail;
    }

    let after_prefix = raw
        .trim()
        .strip_prefix("Connote telah dibuat oleh ")
        .or_else(|| raw.trim().strip_prefix("Connote telah dibuat oleh"))
        .unwrap_or(raw)
        .trim();

    let (petugas_part, lokasi_part) = after_prefix.split_once(" di lokasi ").unwrap_or((after_prefix, ""));

    if let Some(idx_open) = petugas_part.find('(') {
        if let Some(idx_close) = petugas_part.find(')') {
            if idx_close > idx_open {
                detail.nama_petugas = Some(petugas_part[..idx_open].trim().to_string());
                detail.id_petugas = Some(petugas_part[idx_open + 1..idx_close].trim().to_string());
            } else {
                detail.nama_petugas = Some(petugas_part.trim().to_string());
            }
        } else {
            detail.nama_petugas = Some(petugas_part.trim().to_string());
        }
    } else {
        detail.nama_petugas = Some(petugas_part.trim().to_string());
    }

    if !lokasi_part.is_empty() {
        let parts: Vec<&str> = lokasi_part.split_whitespace().collect();
        if let Some(last) = parts.last() {
            if last.len() < 10 && last.chars().any(|ch| ch.is_ascii_digit()) {
                detail.nama_kantor = Some(parts[..parts.len() - 1].join(" "));
                detail.id_kantor = Some(last.to_string());
            } else {
                detail.nama_kantor = Some(lokasi_part.trim().to_string());
            }
        }
    }

    detail
}

fn parse_status_akhir(raw: &str) -> StatusAkhirParts {
    let text = raw.trim();
    let (status, rem_after_di) = if let Some(idx) = text.find(" di ") {
        (
            Some(text[..idx].trim().to_string()),
            &text[idx + " di ".len()..],
        )
    } else {
        return (Some(text.to_string()), None, None, None, None);
    };

    let mut location = None;
    let rem_after_di = rem_after_di.trim_start();
    let rem_lower = rem_after_di.to_lowercase();

    let mut after_location = if rem_lower.starts_with("oleh ") {
        &rem_after_di["oleh ".len()..]
    } else if let Some(idx_oleh) = rem_lower.find(" oleh ") {
        let loc = rem_after_di[..idx_oleh].trim();
        if !loc.is_empty() {
            location = Some(loc.to_string());
        }
        &rem_after_di[idx_oleh + " oleh ".len()..]
    } else if let Some(idx_oleh) = rem_lower.find(" oleh(") {
        let loc = rem_after_di[..idx_oleh].trim();
        if !loc.is_empty() {
            location = Some(loc.to_string());
        }
        &rem_after_di[idx_oleh + " oleh".len()..]
    } else {
        rem_after_di
    };

    let mut officer_name = None;
    let mut officer_id = None;
    let mut datetime = None;

    if let Some(start_paren) = after_location.find('(') {
        if let Some(end_paren) = after_location.rfind(')') {
            if end_paren > start_paren {
                let inside = &after_location[start_paren + 1..end_paren];
                let parts: Vec<String> = inside.split('/').map(normalize_text).collect();
                if let Some(first) = parts.first().filter(|part| !part.is_empty()) {
                    officer_name = Some(first.clone());
                }
                if parts.len() > 1 && !parts[1].is_empty() {
                    officer_id = Some(parts[1].clone());
                }
                after_location = &after_location[end_paren + 1..];
            }
        }
    }

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
    let mut bag_order = Vec::new();
    let mut manifest_r7 = Vec::new();
    let mut delivery_runsheet = Vec::new();
    let mut current_delivery_idx = None;

    for entry in history {
        let lower = entry.detail_history.to_lowercase();
        let mut matched_any = false;
        let (tanggal, waktu) = split_datetime(&entry.tanggal_update);

        if lower.contains("proses irregularity") {
            let (status, petugas, lokasi, koordinat) =
                parse_irregularity_detail(&entry.detail_history);
            irregularity.push(IrregularitySummary {
                status,
                petugas,
                lokasi,
                koordinat,
                tanggal: tanggal.clone(),
                waktu: waktu.clone(),
            });
            matched_any = true;
        }

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
                let bag_entry = bag_map.entry(nomor_kantung.clone()).or_insert(
                    BaggingUnbaggingSummary {
                        nomor_kantung,
                        bagging: None,
                        unbagging: None,
                    },
                );
                bag_entry.bagging = Some(event);
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
                let bag_entry = bag_map.entry(nomor_kantung.clone()).or_insert(
                    BaggingUnbaggingSummary {
                        nomor_kantung,
                        bagging: None,
                        unbagging: None,
                    },
                );
                bag_entry.unbagging = Some(event);
                matched_any = true;
            }
        }

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

        if lower.contains("proses deliveryrunsheet") {
            let (petugas_mandor, lokasi) = parse_oleh_di(&entry.detail_history);
            let petugas_kurir = extract_diterima_oleh(&entry.detail_history);
            let koordinat = extract_coordinate(&entry.detail_history);

            delivery_runsheet.push(DeliveryRunsheetSummary {
                petugas_mandor,
                petugas_kurir,
                lokasi,
                tanggal: tanggal.clone(),
                waktu: waktu.clone(),
                koordinat,
                updates: Vec::new(),
            });
            current_delivery_idx = Some(delivery_runsheet.len() - 1);
            continue;
        }

        if lower.contains("proses antaran") {
            let antaran_detail = parse_proses_antaran_status(&entry.detail_history);
            let inferred_status = infer_delivery_update_status(status_akhir, &antaran_detail);
            let koordinat = extract_coordinate(&entry.detail_history);
            let update = DeliveryRunsheetUpdate {
                petugas: antaran_detail.petugas,
                status: antaran_detail.status.or(inferred_status),
                keterangan_status: antaran_detail.keterangan_status,
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

            delivery_runsheet.push(DeliveryRunsheetSummary {
                petugas_mandor: None,
                petugas_kurir: None,
                lokasi: None,
                tanggal: None,
                waktu: None,
                koordinat: None,
                updates: vec![update],
            });
            current_delivery_idx = Some(delivery_runsheet.len() - 1);
            matched_any = true;
        } else if lower.contains("delivered") {
            let update = DeliveryRunsheetUpdate {
                petugas: None,
                status: Some(normalize_text(&entry.detail_history)),
                keterangan_status: None,
                tanggal: tanggal.clone(),
                waktu: waktu.clone(),
                koordinat: extract_coordinate(&entry.detail_history),
            };

            if let Some(idx) = current_delivery_idx {
                if let Some(summary) = delivery_runsheet.get_mut(idx) {
                    summary.updates.push(update);
                    continue;
                }
            }

            matched_any = true;
        }

        if !matched_any && lower.contains("proses") {
            let _ = matched_any;
        }
    }

    if let Some(final_status) = &status_akhir.status {
        if final_status.eq_ignore_ascii_case("DELIVERED") {
            if let Some(last_sheet) = delivery_runsheet.last_mut() {
                let has_delivered = last_sheet.updates.iter().any(|update| {
                    update
                        .status
                        .as_deref()
                        .unwrap_or("")
                        .to_lowercase()
                        .contains("delivered")
                });

                if !has_delivered {
                    let (tanggal, waktu) =
                        split_datetime(status_akhir.datetime.as_deref().unwrap_or(""));
                    let petugas = match (&status_akhir.officer_name, &status_akhir.officer_id) {
                        (Some(name), Some(id)) => Some(format!("{name} ({id})")),
                        (Some(name), None) => Some(name.clone()),
                        _ => None,
                    };

                    last_sheet.updates.push(DeliveryRunsheetUpdate {
                        petugas,
                        status: Some(final_status.clone()),
                        keterangan_status: None,
                        tanggal,
                        waktu,
                        koordinat: pod.coordinate.clone(),
                    });
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

    let mut status = None;
    if let Some(idx) = lower.find("dengan status (") {
        let start = idx + "dengan status (".len();
        if let Some(end_rel) = text[start..].find(')') {
            let value = text[start..start + end_rel].trim();
            if !value.is_empty() {
                status = Some(value.to_string());
            }
        }
    }

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

            let value = after_di[..end_loc].trim();
            if !value.is_empty() {
                lokasi = Some(value.to_string());
            }
        }
    }

    (status, petugas, lokasi, extract_coordinate(text))
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

            let value = after_di[..end_loc].trim();
            if !value.is_empty() {
                lokasi = Some(value.to_string());
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
        .trim_matches(|ch: char| ch == ',' || ch == '.' || ch == ';')
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

    let coordinate = after_colon[..end].trim();
    if coordinate.is_empty() {
        None
    } else {
        Some(coordinate.to_string())
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

    let value = after[..end].trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
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

    let mut nomor_r7 = None;
    if let Some(idx) = lower.find("nomor r7") {
        let start = idx + "nomor r7".len();
        let rest = text[start..].trim_start();
        if let Some(first) = rest.split_whitespace().next() {
            let value = first
                .trim()
                .trim_matches(|ch: char| ch == ',' || ch == '.' || ch == ';')
                .to_string();
            if !value.is_empty() {
                nomor_r7 = Some(value);
            }
        }
    }

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

            let value = after_di[..end_loc].trim();
            if !value.is_empty() {
                lokasi = Some(value.to_string());
            }
        }
    }

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

        let value = after[..end].trim();
        if !value.is_empty() {
            tujuan = Some(value.to_string());
        }
    }

    (nomor_r7, petugas, lokasi, tujuan)
}

fn infer_delivery_update_status(
    status_akhir: &TrackStatusAkhir,
    antaran_detail: &ProsesAntaranDetail,
) -> Option<String> {
    if antaran_detail.status.is_some() {
        return None;
    }

    if antaran_detail.keterangan_status.is_some() {
        return status_akhir.status.clone();
    }

    None
}

fn parse_proses_antaran_status(raw: &str) -> ProsesAntaranDetail {
    let text = raw.trim();
    let lower = text.to_lowercase();

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

        let value = rest[..end].trim();
        if !value.is_empty() {
            petugas = Some(value.to_string());
        }
    }

    if let Some(idx) = lower.find("dengan keterangan (") {
        let start = idx + "dengan keterangan (".len();
        if let Some(end_rel) = text[start..].find(')') {
            let value = text[start..start + end_rel].trim();
            if !value.is_empty() {
                return ProsesAntaranDetail {
                    petugas,
                    status: None,
                    keterangan_status: Some(value.to_string()),
                };
            }
        }
    }

    if let Some(idx) = lower.find("status") {
        let start = idx + "status".len();
        let rest = text[start..].trim_start();
        let mut end = rest.len();
        if let Some(idx_time) = rest.find(|ch: char| ch.is_ascii_digit()) {
            end = idx_time;
        } else if let Some(idx_comma) = rest.find(',') {
            end = idx_comma;
        } else if let Some(idx_bracket) = rest.find('[') {
            end = idx_bracket;
        }
        let value = rest[..end].trim();
        if !value.is_empty() {
            return ProsesAntaranDetail {
                petugas,
                status: Some(value.to_string()),
                keterangan_status: None,
            };
        }
    }

    ProsesAntaranDetail {
        petugas,
        status: None,
        keterangan_status: None,
    }
}
