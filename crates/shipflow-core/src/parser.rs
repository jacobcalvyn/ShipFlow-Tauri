use std::collections::{BTreeMap, HashMap};

use scraper::{Html as ScraperHtml, Selector};

use crate::model::{
    Actors, BaggingUnbaggingEvent, BaggingUnbaggingSummary, BillingDetail, ContactDetail,
    ContactEnrichment, DeliveryRunsheetSummary, DeliveryRunsheetUpdate, HistorySummary,
    IrregularitySummary, KoliStatusSummary, ManifestR7Summary, MultiKoliSummary, OriginDetail,
    PackageDetail, PerformanceDetail, ShipmentHeader, ShipmentIdentity, StatusAkhirParts,
    TrackCodDetail, TrackDetail, TrackHistoryEntry, TrackPod, TrackResponse, TrackStatusAkhir,
    TrackingError,
};
use crate::upstream::resolve_pos_href;

const MAX_TRACKING_TABLE_ROWS: usize = 10_000;

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

    if document
        .select(&tr_selector)
        .take(MAX_TRACKING_TABLE_ROWS + 1)
        .count()
        > MAX_TRACKING_TABLE_ROWS
    {
        return Err(TrackingError::Upstream(format!(
            "Tracking response exceeds {MAX_TRACKING_TABLE_ROWS} table rows."
        )));
    }

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
                let (status, location, officer_name, officer_id, datetime, date, time) =
                    parse_status_akhir(&value);
                status_akhir.status = status;
                status_akhir.location = location;
                status_akhir.officer_name = officer_name;
                status_akhir.officer_id = officer_id;
                status_akhir.datetime = datetime;
                status_akhir.date = date;
                status_akhir.time = time;
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

                            return resolve_pod_href(&src);
                        }
                    }

                    cell.select(&a_selector)
                        .next()
                        .and_then(|link| link.value().attr("href"))
                        .and_then(resolve_pod_href)
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

    if let Some(entry) = history.iter().find(|item| {
        item.detail_history
            .to_lowercase()
            .contains("connote telah dibuat oleh")
    }) {
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

    let requested_id = detail.header.nomor_kiriman.clone().unwrap_or_default();
    let mut response = TrackResponse {
        url: request_url.into(),
        detail,
        status_akhir,
        pod,
        history,
        history_summary,
        shipment_identity: ShipmentIdentity::default(),
        multi_koli: MultiKoliSummary::default(),
        contact_enrichment: None,
    };
    populate_shipment_structure(&mut response, &requested_id);
    Ok(response)
}

pub fn populate_shipment_structure(response: &mut TrackResponse, requested_id: &str) {
    let requested_id = requested_id.trim();
    let effective_requested_id = if requested_id.is_empty() {
        response
            .detail
            .header
            .nomor_kiriman
            .as_deref()
            .unwrap_or_default()
            .trim()
    } else {
        requested_id
    };

    let (parent_shipment_id, requested_koli_number) = split_koli_id(effective_requested_id)
        .map(|(parent, number)| (parent.to_string(), Some(number)))
        .unwrap_or_else(|| (effective_requested_id.to_string(), None));

    response.shipment_identity = ShipmentIdentity {
        requested_id: non_empty_string(effective_requested_id),
        parent_shipment_id: non_empty_string(&parent_shipment_id),
        is_koli: requested_koli_number.is_some(),
        koli_number: requested_koli_number,
    };

    if parent_shipment_id.is_empty() {
        response.multi_koli = MultiKoliSummary::default();
        return;
    }

    let mut known_koli = BTreeMap::<(u32, String), String>::new();
    if let Some(number) = requested_koli_number {
        known_koli.insert(
            (number, effective_requested_id.to_ascii_uppercase()),
            effective_requested_id.to_string(),
        );
    }
    for history_entry in &response.history {
        collect_koli_ids(
            &history_entry.detail_history,
            &parent_shipment_id,
            &mut known_koli,
        );
    }

    if known_koli.is_empty() {
        response.multi_koli = MultiKoliSummary::default();
        return;
    }

    let mut koli = Vec::with_capacity(known_koli.len());
    for ((number, _), nomor_koli) in &known_koli {
        let latest_status = response
            .history
            .iter()
            .filter(|entry| history_mentions_koli(entry, nomor_koli))
            .filter_map(|entry| {
                infer_koli_status(&entry.detail_history).map(|status| (entry, status))
            })
            .max_by(|(left, _), (right, _)| left.tanggal_update.cmp(&right.tanggal_update));
        let (bukti_status, status_akhir) = latest_status
            .map(|(entry, status)| (Some(entry.clone()), Some(status)))
            .unwrap_or((None, None));
        let has_delivery_proof = status_akhir.as_deref() == Some("DELIVERED");
        let lokasi_akhir = bukti_status
            .as_ref()
            .and_then(|entry| infer_history_location(&entry.detail_history))
            .or_else(|| {
                has_delivery_proof
                    .then(|| response.status_akhir.location.clone())
                    .flatten()
            });
        let waktu_status_akhir = bukti_status
            .as_ref()
            .map(|entry| entry.tanggal_update.clone());

        koli.push(KoliStatusSummary {
            nomor_koli: nomor_koli.clone(),
            urutan_koli: *number,
            status_akhir,
            lokasi_akhir,
            waktu_status_akhir,
            has_delivery_proof,
            bukti_status,
        });
    }

    let is_multi_koli = koli.len() > 1;
    let status_agregat = aggregate_koli_status(is_multi_koli, &koli);
    response.multi_koli = MultiKoliSummary {
        is_multi_koli,
        jumlah_koli: koli.len(),
        nomor_koli: koli.iter().map(|item| item.nomor_koli.clone()).collect(),
        status_agregat,
        koli,
    };
}

fn split_koli_id(value: &str) -> Option<(&str, u32)> {
    let (parent, suffix) = value.rsplit_once('.')?;
    if parent.is_empty() || suffix.is_empty() || !suffix.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }

    let number = suffix.parse::<u32>().ok()?;
    (number > 0).then_some((parent, number))
}

fn collect_koli_ids(detail: &str, parent_id: &str, output: &mut BTreeMap<(u32, String), String>) {
    let normalized_detail = detail.to_ascii_uppercase();
    let normalized_parent = parent_id.to_ascii_uppercase();
    let needle = format!("{normalized_parent}.");

    for (start, _) in normalized_detail.match_indices(&needle) {
        if start > 0
            && normalized_detail[..start]
                .bytes()
                .next_back()
                .is_some_and(|byte| byte.is_ascii_alphanumeric() || byte == b'.')
        {
            continue;
        }

        let suffix_start = start + needle.len();
        let suffix = normalized_detail[suffix_start..]
            .bytes()
            .take_while(|byte| byte.is_ascii_digit())
            .collect::<Vec<_>>();
        if suffix.is_empty() {
            continue;
        }

        let suffix_end = suffix_start + suffix.len();
        if normalized_detail[suffix_end..]
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || byte == b'.')
        {
            continue;
        }

        let Ok(number) = std::str::from_utf8(&suffix)
            .unwrap_or_default()
            .parse::<u32>()
        else {
            continue;
        };
        if number == 0 {
            continue;
        }

        let suffix = &detail[suffix_start..suffix_end];
        let exact_id = format!("{parent_id}.{suffix}");
        output
            .entry((number, exact_id.to_ascii_uppercase()))
            .or_insert(exact_id);
    }
}

fn history_mentions_koli(entry: &TrackHistoryEntry, nomor_koli: &str) -> bool {
    let mut found = BTreeMap::new();
    let Some((parent_id, _)) = split_koli_id(nomor_koli) else {
        return false;
    };
    collect_koli_ids(&entry.detail_history, parent_id, &mut found);
    found
        .values()
        .any(|value| value.eq_ignore_ascii_case(nomor_koli))
}

fn infer_koli_status(detail: &str) -> Option<String> {
    let normalized = detail.to_ascii_lowercase();
    let status = if normalized.contains("failedtodelivered")
        || normalized.contains("gagal antar")
        || normalized.contains("gagal diantar")
    {
        "FAILEDTODELIVERED"
    } else if normalized.contains("telah diantar") || normalized.contains("status delivered") {
        "DELIVERED"
    } else if normalized.contains("deliveryrunsheet") {
        "DELIVERYRUNSHEET"
    } else if normalized.contains("manifest r7") || normalized.contains("manifestr7") {
        "MANIFEST_R7"
    } else if normalized.contains("unbagging") {
        "UNBAGGING"
    } else if normalized.contains("bagging") {
        "BAGGING"
    } else if normalized.contains("receiving") {
        "RECEIVING"
    } else {
        return None;
    };

    Some(status.into())
}

fn infer_history_location(detail: &str) -> Option<String> {
    let normalized = detail.to_ascii_lowercase();
    let start = normalized.rfind(" di ")? + 4;
    let mut location = detail[start..].trim();

    for delimiter in [
        " dengan tujuan ",
        " dan nomor ",
        ", [coordinate",
        " [coordinate",
    ] {
        if let Some(index) = location.to_ascii_lowercase().find(delimiter) {
            location = location[..index].trim();
        }
    }

    if let Some((prefix, suffix)) = location.rsplit_once(' ') {
        if suffix.len() == 5
            && suffix.as_bytes()[2] == b':'
            && suffix
                .bytes()
                .enumerate()
                .all(|(index, byte)| index == 2 || byte.is_ascii_digit())
        {
            location = prefix.trim();
        }
    }

    non_empty_string(location)
}

fn aggregate_koli_status(is_multi_koli: bool, koli: &[KoliStatusSummary]) -> Option<String> {
    if !is_multi_koli {
        return None;
    }

    let delivered_count = koli.iter().filter(|item| item.has_delivery_proof).count();
    if delivered_count == koli.len() {
        return Some("DELIVERED".into());
    }
    if delivered_count > 0 {
        return Some("PARTIALLY_DELIVERED".into());
    }

    let first_status = koli.first()?.status_akhir.as_deref();
    if koli.iter().all(|item| item.status_akhir.is_none()) {
        return None;
    }
    if first_status.is_some()
        && koli
            .iter()
            .all(|item| item.status_akhir.as_deref() == first_status)
    {
        return first_status.map(str::to_string);
    }

    Some("IN_PROGRESS".into())
}

fn non_empty_string(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_string())
}

pub fn parse_lacak_mitra_contact_html(html: &str) -> ContactEnrichment {
    parse_lacak_mitra_contact_html_checked(html).unwrap_or_default()
}

pub fn parse_lacak_mitra_contact_html_checked(
    html: &str,
) -> Result<ContactEnrichment, TrackingError> {
    let document = ScraperHtml::parse_document(html);
    let tr_selector = Selector::parse("tr").expect("valid selector");
    let cell_selector = Selector::parse("td, th").expect("valid selector");
    let mut enrichment = ContactEnrichment::default();
    let mut found_sender = false;
    let mut found_recipient = false;

    for tr in document.select(&tr_selector) {
        let cells: Vec<String> = tr
            .select(&cell_selector)
            .map(|cell| normalize_text(&cell.text().collect::<String>()))
            .filter(|text| !text.is_empty())
            .collect();

        if cells.len() < 2 {
            continue;
        }

        match normalize_label(&cells[0]).as_str() {
            "PENGIRIM" => {
                found_sender = true;
                enrichment.pengirim = parse_contact(&cells[1]);
            }
            "PENERIMA" => {
                found_recipient = true;
                enrichment.penerima = parse_contact(&cells[1]);
            }
            _ => {}
        }
    }

    if !found_sender || !found_recipient {
        return Err(TrackingError::Upstream(
            "Lacak Mitra returned HTML without the expected sender and recipient fields.".into(),
        ));
    }

    let valid_phone = |value: Option<String>| {
        value.filter(|phone| phone.chars().filter(char::is_ascii_digit).count() >= 6)
    };
    enrichment.pengirim.telepon = valid_phone(enrichment.pengirim.telepon);
    enrichment.penerima.telepon = valid_phone(enrichment.penerima.telepon);
    enrichment.pengirim.nama = None;
    enrichment.pengirim.alamat = None;
    enrichment.pengirim.kode_pos = None;
    enrichment.penerima.nama = None;
    enrichment.penerima.alamat = None;
    enrichment.penerima.kode_pos = None;

    Ok(enrichment)
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

    normalized.parse::<f64>().map(Some).map_err(|_| {
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
    let normalized = value.replace("kg", "").replace("KG", "").trim().to_string();

    if normalized.is_empty() || normalized == "-" {
        return Ok(None);
    }

    normalized.parse::<f64>().map(Some).map_err(|_| {
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
    let upper = inside.to_ascii_uppercase();
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

    let (petugas_part, lokasi_part) = after_prefix
        .split_once(" di lokasi ")
        .unwrap_or((after_prefix, ""));

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
        return (Some(text.to_string()), None, None, None, None, None, None);
    };

    let mut location = None;
    let rem_after_di = rem_after_di.trim_start();
    let rem_lower = rem_after_di.to_ascii_lowercase();

    let after_location = if rem_lower.starts_with("oleh ") {
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
    let mut date = None;
    let mut time = None;

    if let Some(start_paren) = after_location.find('(') {
        if let Some(relative_end_paren) = after_location[start_paren + 1..].find(')') {
            let end_paren = start_paren + 1 + relative_end_paren;
            if end_paren > start_paren {
                let inside = &after_location[start_paren + 1..end_paren];
                let parts: Vec<String> = inside.split('/').map(normalize_text).collect();
                if let Some(first) = parts.first().filter(|part| !part.is_empty()) {
                    officer_name = Some(first.clone());
                }
                if parts.len() > 1 && !parts[1].is_empty() {
                    officer_id = Some(parts[1].clone());
                }
            }
        }
    }

    let lower_after = after_location.to_ascii_lowercase();
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

        if let Some((parsed_date, parsed_time)) = extract_datetime_parts(&after_colon[..end_idx]) {
            datetime = Some(format!("{parsed_date} {parsed_time}"));
            date = Some(parsed_date);
            time = Some(parsed_time);
        } else {
            let dt = after_colon[..end_idx].trim();
            if !dt.is_empty() {
                datetime = Some(dt.to_string());
            }
        }
    }
    if datetime.is_none() {
        if let Some((parsed_date, parsed_time)) = extract_datetime_parts(after_location) {
            datetime = Some(format!("{parsed_date} {parsed_time}"));
            date = Some(parsed_date);
            time = Some(parsed_time);
        }
    }

    (
        status,
        location,
        officer_name,
        officer_id,
        datetime,
        date,
        time,
    )
}

fn resolve_pod_href(raw: &str) -> Option<String> {
    let href = raw.trim();
    let lower = href.to_ascii_lowercase();
    if href.is_empty()
        || lower.starts_with("target=")
        || lower.starts_with("javascript:")
        || href.chars().any(|ch| matches!(ch, '"' | '\'' | '<' | '>'))
    {
        return None;
    }

    Some(resolve_pos_href(href))
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

fn extract_datetime_parts(raw: &str) -> Option<(String, String)> {
    let trimmed = raw.trim();
    let bytes = trimmed.as_bytes();

    for start in 0..trimmed.len() {
        let end = start + 19;
        if end > trimmed.len() {
            break;
        }

        let candidate_bytes = &bytes[start..end];
        if candidate_bytes[4] == b'-'
            && candidate_bytes[7] == b'-'
            && candidate_bytes[10].is_ascii_whitespace()
            && candidate_bytes[13] == b':'
            && candidate_bytes[16] == b':'
            && candidate_bytes
                .iter()
                .enumerate()
                .all(|(index, ch)| matches!(index, 4 | 7 | 10 | 13 | 16) || ch.is_ascii_digit())
        {
            let candidate = std::str::from_utf8(candidate_bytes).ok()?;
            return Some((candidate[..10].to_string(), candidate[11..19].to_string()));
        }
    }

    None
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
                let bag_entry =
                    bag_map
                        .entry(nomor_kantung.clone())
                        .or_insert(BaggingUnbaggingSummary {
                            nomor_kantung,
                            bagging: None,
                            unbagging: None,
                        });
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
                let bag_entry =
                    bag_map
                        .entry(nomor_kantung.clone())
                        .or_insert(BaggingUnbaggingSummary {
                            nomor_kantung,
                            bagging: None,
                            unbagging: None,
                        });
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
                    summary.updates = vec![update];
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
                    summary.updates = vec![update];
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

                    last_sheet.updates = vec![DeliveryRunsheetUpdate {
                        petugas,
                        status: Some(final_status.clone()),
                        keterangan_status: None,
                        tanggal,
                        waktu,
                        koordinat: pod.coordinate.clone(),
                    }];
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

#[cfg(test)]
mod tests {
    use serde_json::json;
    use sha2::{Digest, Sha256};

    use super::{parse_tracking_html, MAX_TRACKING_TABLE_ROWS};
    use crate::model::TrackingError;

    const SAMPLE_HTML: &str = include_str!("../tests/fixtures/pos_tracking_sample.html");
    const NULLABLE_NUMERIC_HTML: &str =
        include_str!("../tests/fixtures/pos_tracking_nullable_numeric.html");
    const REORDERED_TABLES_HTML: &str =
        include_str!("../tests/fixtures/pos_tracking_reordered_tables.html");
    const RUNSHEET_FAILEDTODELIVERED_HTML: &str =
        include_str!("../tests/fixtures/pos_tracking_runsheet_failedtoddelivered.html");

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
        assert_eq!(
            response.history_summary.delivery_runsheet[0].updates.len(),
            1
        );
    }

    #[test]
    fn parse_lacak_mitra_contact_html_extracts_only_phone_numbers() {
        let html = r#"
            <table>
              <tr>
                <td class=brslap align=center>Pengirim</td>
                <td>&nbsp;<font size="2">YAYASAN LEMBAGA ALKITAB INDONESIA; 08111925400; JL SALEMBA RAYA NO 12 JAKARTA PUSAT; </font></td>
              </tr>
              <tr>
                <td class=brslap align=center>Penerima</td>
                <td>&nbsp;<font size="2">KA PERWAKILAN JAYAPURA; 0967535620; JL FRANS KAISEPO KOMPLEK RUKO PASIFIF PERMAI BLOK D1 JAYAPURA PAPUA; 99112</font></td>
              </tr>
            </table>
        "#;

        let contact = super::parse_lacak_mitra_contact_html(html);

        assert_eq!(contact.pengirim.telepon.as_deref(), Some("08111925400"));
        assert_eq!(contact.penerima.telepon.as_deref(), Some("0967535620"));
        assert!(contact.pengirim.nama.is_none());
        assert!(contact.penerima.alamat.is_none());
    }

    #[test]
    fn checked_lacak_mitra_contact_parser_accepts_valid_page_without_phone_numbers() {
        let html = r#"
            <table>
              <tr><td>Pengirim</td><td>SHIPPER; -; ADDRESS;</td></tr>
              <tr><td>Penerima</td><td>RECIPIENT; -; ADDRESS;</td></tr>
            </table>
        "#;

        let contact = super::parse_lacak_mitra_contact_html_checked(html)
            .expect("valid contact page should parse");

        assert!(contact.pengirim.telepon.is_none());
        assert!(contact.penerima.telepon.is_none());
    }

    #[test]
    fn checked_lacak_mitra_contact_parser_rejects_unexpected_html() {
        let error = super::parse_lacak_mitra_contact_html_checked(
            "<html><body>Maintenance in progress</body></html>",
        )
        .expect_err("unexpected HTML must not become a long-lived missing contact");

        assert!(matches!(error, TrackingError::Upstream(_)));
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
    fn parse_tracking_html_handles_unicode_before_ascii_markers_without_panicking() {
        let html = r#"
            <table>
              <tr><td>Nomor Kiriman</td><td>P1 [ΐ SLA :é]</td></tr>
              <tr><td>Status Akhir</td><td>DELIVERED di X İ oleh é</td></tr>
            </table>
        "#;

        let response = parse_tracking_html("https://example.test", html)
            .expect("unicode text must not invalidate byte offsets");

        assert_eq!(response.detail.header.nomor_kiriman.as_deref(), Some("P1"));
        assert_eq!(response.status_akhir.status.as_deref(), Some("DELIVERED"));
        assert_eq!(response.status_akhir.location.as_deref(), Some("X İ"));
        assert_eq!(response.status_akhir.officer_name.as_deref(), None);
    }

    #[test]
    fn parse_tracking_html_rejects_excessive_table_cardinality() {
        let mut html = String::from("<table>");
        for _ in 0..=MAX_TRACKING_TABLE_ROWS {
            html.push_str("<tr><td>A</td><td>B</td></tr>");
        }
        html.push_str("</table>");

        let error = parse_tracking_html("https://example.test", &html)
            .expect_err("oversized table cardinality must be rejected");

        assert!(
            matches!(error, TrackingError::Upstream(message) if message.contains("table rows"))
        );
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
        let response =
            parse_tracking_html("https://example.test", SAMPLE_HTML).expect("sample should parse");

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
    fn parse_tracking_html_full_payload_matches_golden_contract() {
        let response = parse_tracking_html(
            "https://pid.posindonesia.co.id/lacak/admin/detail_lacak_banyak.php?id=UDI2MDMzMTAxMTQyOTE%3D",
            SAMPLE_HTML,
        )
        .expect("sample should parse");
        let payload = serde_json::to_vec(&response).expect("response should serialize");
        let digest = format!("{:x}", Sha256::digest(payload));

        assert_eq!(
            digest,
            "c6496ef83cb7f3864709e0f2cc0178de410b2697c43b61b52d39538cdc2e95b0"
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

    #[test]
    fn parse_tracking_html_maps_failedtoddelivered_as_single_runsheet_update() {
        let response = parse_tracking_html("https://example.test", RUNSHEET_FAILEDTODELIVERED_HTML)
            .expect("failedtoddelivered runsheet sample should parse");

        let runsheet = &response.history_summary.delivery_runsheet[0];
        assert_eq!(runsheet.updates.len(), 1);
        assert_eq!(
            runsheet.updates[0].status.as_deref(),
            Some("FAILEDTODELIVERED")
        );
        assert_eq!(
            runsheet.updates[0].keterangan_status.as_deref(),
            Some("YANG BERSANGKUTAN TIDAK DITEMPAT")
        );
    }

    #[test]
    fn parse_tracking_html_keeps_synthetic_delivered_for_exact_delivered_status() {
        let html = r#"
            <table>
              <tr><td>Nomor Kiriman</td><td>P2603310999999</td></tr>
              <tr><td>Status Akhir</td><td>DELIVERED di DC JAYAPURA 9910A [Kurir/9910bkurir] [2026-04-15 11:51:34]</td></tr>
            </table>
            <table>
              <tr><td>TANGGAL UPDATE</td><td>DETAIL HISTORY</td></tr>
              <tr>
                <td>2026-04-15 11:40:47</td>
                <td>Barang P2603310999999 anda telah melewati proses DeliveryRunsheet oleh Akbar di DC JAYAPURA 9910A diterima oleh Kurir</td>
              </tr>
            </table>
        "#;

        let response = parse_tracking_html("https://example.test", html)
            .expect("synthetic delivered sample should parse");

        let runsheet = &response.history_summary.delivery_runsheet[0];
        assert_eq!(runsheet.updates.len(), 1);
        assert_eq!(runsheet.updates[0].status.as_deref(), Some("DELIVERED"));
        assert_eq!(runsheet.updates[0].keterangan_status, None);
    }

    #[test]
    fn parse_tracking_html_cleans_status_akhir_timestamp_suffix() {
        let html = r#"
            <table>
              <tr><td>Nomor Kiriman</td><td>P2606150000001</td></tr>
              <tr><td>Status Akhir</td><td>INLOCATION di DC JAYAPURA 9910A oleh SYSTEM tanggal : 2026-06-15 09:03:42 SYSTEM</td></tr>
            </table>
        "#;

        let response = parse_tracking_html("https://example.test", html)
            .expect("status akhir with system suffix should parse");

        assert_eq!(
            response.status_akhir.datetime.as_deref(),
            Some("2026-06-15 09:03:42")
        );
        assert_eq!(response.status_akhir.date.as_deref(), Some("2026-06-15"));
        assert_eq!(response.status_akhir.time.as_deref(), Some("09:03:42"));
    }

    #[test]
    fn parse_tracking_html_separates_officer_from_trailing_recipient_note() {
        let html = r#"
            <table>
              <tr><td>Nomor Kiriman</td><td>P2607160021748</td></tr>
              <tr><td>Status Akhir</td><td>DELIVERED (RETURN DELIVERY) di DC JAYAPURA 9910A oleh (Mikha Sandhy Tehuayo / ) Tanggal : 2026-07-27 08:44:49 kk kerja ( kk azalia )</td></tr>
            </table>
        "#;

        let response = parse_tracking_html("https://example.test", html)
            .expect("delivered return sample should parse");

        assert_eq!(
            response.status_akhir.status.as_deref(),
            Some("DELIVERED (RETURN DELIVERY)")
        );
        assert_eq!(
            response.status_akhir.location.as_deref(),
            Some("DC JAYAPURA 9910A")
        );
        assert_eq!(
            response.status_akhir.officer_name.as_deref(),
            Some("Mikha Sandhy Tehuayo")
        );
        assert_eq!(response.status_akhir.officer_id, None);
        assert_eq!(
            response.status_akhir.datetime.as_deref(),
            Some("2026-07-27 08:44:49")
        );
        assert_eq!(response.status_akhir.date.as_deref(), Some("2026-07-27"));
        assert_eq!(response.status_akhir.time.as_deref(), Some("08:44:49"));
    }

    #[test]
    fn parse_tracking_html_keeps_only_latest_effective_update_per_runsheet() {
        let html = r#"
            <table>
              <tr><td>Nomor Kiriman</td><td>P2603310888888</td></tr>
              <tr><td>Status Akhir</td><td>FAILEDTODELIVERED di DC JAYAPURA 9910A [Kurir/9910bkurir] [2026-04-15 14:50:02]</td></tr>
            </table>
            <table>
              <tr><td>TANGGAL UPDATE</td><td>DETAIL HISTORY</td></tr>
              <tr>
                <td>2026-04-15 11:40:47</td>
                <td>Barang P2603310888888 anda telah melewati proses DeliveryRunsheet oleh Akbar di DC JAYAPURA 9910A diterima oleh Kurir</td>
              </tr>
              <tr>
                <td>2026-04-15 14:00:00</td>
                <td>Barang P2603310888888 anda telah melewati proses antaran oleh Gabriel Erick Taurui dengan keterangan (ALAMAT TIDAK DITEMUKAN)</td>
              </tr>
              <tr>
                <td>2026-04-15 14:50:02</td>
                <td>Barang P2603310888888 anda telah melewati proses antaran oleh Gabriel Erick Taurui dengan keterangan (YANG BERSANGKUTAN TIDAK DITEMPAT)</td>
              </tr>
            </table>
        "#;

        let response = parse_tracking_html("https://example.test", html)
            .expect("multi-update runsheet sample should parse");

        let runsheet = &response.history_summary.delivery_runsheet[0];
        assert_eq!(runsheet.updates.len(), 1);
        assert_eq!(
            runsheet.updates[0].status.as_deref(),
            Some("FAILEDTODELIVERED")
        );
        assert_eq!(
            runsheet.updates[0].keterangan_status.as_deref(),
            Some("YANG BERSANGKUTAN TIDAK DITEMPAT")
        );
    }

    #[test]
    fn parse_tracking_html_keeps_data_image_pod_src_as_is() {
        let html = r#"
            <table>
              <tr><td>Nomor Kiriman</td><td>P2603310114291</td></tr>
              <tr><td>Status Akhir</td><td>DELIVERED - DC JAYAPURA [Kurir/9910bkurir] [2026-04-15 11:51:34]</td></tr>
            </table>
            <table>
              <tr>
                <th>POD</th>
                <th>Photo</th>
                <th>Photo2</th>
                <th>signature</th>
                <th>coordinate</th>
              </tr>
              <tr>
                <td></td>
                <td><img src="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD" /></td>
                <td><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" /></td>
                <td></td>
                <td>-2.5,140.7</td>
              </tr>
            </table>
        "#;

        let response = parse_tracking_html("https://example.test", html)
            .expect("data image pod sample should parse");

        assert_eq!(
            response.pod.photo1_url.as_deref(),
            Some("data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD")
        );
        assert_eq!(
            response.pod.photo2_url.as_deref(),
            Some("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB")
        );
    }

    #[test]
    fn parse_tracking_html_rejects_malformed_empty_pod_href() {
        let html = r#"
            <table>
              <tr><td>Nomor Kiriman</td><td>P2607160021748</td></tr>
              <tr><td>Status Akhir</td><td>DELIVERED di DC JAYAPURA 9910A oleh (Kurir / 9910bkurir) Tanggal : 2026-07-27 08:44:49</td></tr>
            </table>
            <table>
              <tr>
                <th>POD</th>
                <th>Photo</th>
                <th>Photo2</th>
                <th>signature</th>
                <th>coordinate</th>
              </tr>
              <tr>
                <td></td>
                <td><a href="/photo/valid.jpg">View Photo</a></td>
                <td><a href= target="_blank">View Photo</a></td>
                <td></td>
                <td>-2.5,140.7</td>
              </tr>
            </table>
        "#;

        let response = parse_tracking_html("https://example.test", html)
            .expect("malformed optional photo link should not fail tracking");

        assert_eq!(
            response.pod.photo1_url.as_deref(),
            Some("https://pid.posindonesia.co.id/photo/valid.jpg")
        );
        assert_eq!(response.pod.photo2_url, None);
    }

    #[test]
    fn parse_tracking_html_adds_single_shipment_identity_without_changing_legacy_fields() {
        let html = r#"
            <table>
              <tr><td>Nomor Kiriman</td><td>P2606130056480</td></tr>
              <tr><td>Status Akhir</td><td>INLOCATION di DC JAYAPURA 9910A Tanggal : 2026-07-27 08:44:49</td></tr>
            </table>
            <table>
              <tr><th>Tanggal Update</th><th>Detail History</th></tr>
              <tr>
                <td>2026-07-27 08:44:49</td>
                <td>Paket P2606130056480 telah melewati proses Receiving oleh Akbar di DC JAYAPURA 9910A</td>
              </tr>
            </table>
        "#;

        let response = parse_tracking_html("https://example.test", html)
            .expect("single shipment should parse");
        let serialized = serde_json::to_value(&response).expect("response should serialize");

        assert_eq!(
            response.shipment_identity.requested_id.as_deref(),
            Some("P2606130056480")
        );
        assert_eq!(
            response.shipment_identity.parent_shipment_id.as_deref(),
            Some("P2606130056480")
        );
        assert!(!response.shipment_identity.is_koli);
        assert_eq!(response.shipment_identity.koli_number, None);
        assert!(!response.multi_koli.is_multi_koli);
        assert_eq!(response.multi_koli.jumlah_koli, 1);
        assert!(response.multi_koli.nomor_koli.is_empty());
        assert!(response.multi_koli.koli.is_empty());
        assert_eq!(
            serialized["status_akhir"]["status"], "INLOCATION",
            "legacy status must remain unchanged"
        );
        assert!(serialized["shipment_identity"].is_object());
        assert!(serialized["multi_koli"].is_object());
    }

    #[test]
    fn parse_tracking_html_derives_independent_status_for_each_koli() {
        let html = r#"
            <table>
              <tr><td>Nomor Kiriman</td><td>P2603020015760</td></tr>
              <tr><td>Status Akhir</td><td>DELIVERED di DC JAYAPURA 9910A oleh (Saiful / 560013748) Tanggal : 2026-07-29 12:10:18</td></tr>
            </table>
            <table>
              <tr><th>Tanggal Update</th><th>Detail History</th></tr>
              <tr>
                <td>2026-03-10 09:55:21</td>
                <td>Barang anda P2603020015760.1,P2603020015760.2 telah melewati proses bagging dengan nomor bag PID92446731 oleh Rikson Miosido di SPP JAYAPURA 99100</td>
              </tr>
              <tr>
                <td>2026-07-29 12:10:34</td>
                <td>Barang anda P2603020015760.1 telah diantar oleh Saiful Kemal Junaidi Jamaludin dan diterima oleh amanda</td>
              </tr>
            </table>
        "#;

        let response =
            parse_tracking_html("https://example.test", html).expect("multi koli should parse");

        assert!(response.multi_koli.is_multi_koli);
        assert_eq!(response.multi_koli.jumlah_koli, 2);
        assert_eq!(
            response.multi_koli.nomor_koli,
            ["P2603020015760.1", "P2603020015760.2"]
        );
        assert_eq!(
            response.multi_koli.status_agregat.as_deref(),
            Some("PARTIALLY_DELIVERED")
        );

        let koli_one = &response.multi_koli.koli[0];
        assert_eq!(koli_one.status_akhir.as_deref(), Some("DELIVERED"));
        assert!(koli_one.has_delivery_proof);
        assert_eq!(koli_one.lokasi_akhir.as_deref(), Some("DC JAYAPURA 9910A"));

        let koli_two = &response.multi_koli.koli[1];
        assert_eq!(koli_two.status_akhir.as_deref(), Some("BAGGING"));
        assert!(!koli_two.has_delivery_proof);
        assert_eq!(
            koli_two.waktu_status_akhir.as_deref(),
            Some("2026-03-10 09:55:21")
        );
        assert_eq!(koli_two.lokasi_akhir.as_deref(), Some("SPP JAYAPURA 99100"));
        assert_eq!(
            response.status_akhir.status.as_deref(),
            Some("DELIVERED"),
            "legacy source status must remain unchanged"
        );
    }

    #[test]
    fn populate_shipment_structure_recognizes_direct_koli_request() {
        let html = r#"
            <table>
              <tr><td>Nomor Kiriman</td><td>P2603020015760.2</td></tr>
              <tr><td>Status Akhir</td><td>DELIVERED di DC JAYAPURA 9910A oleh (Saiful / 560013748) Tanggal : 2026-07-29 12:10:18</td></tr>
            </table>
            <table>
              <tr><th>Tanggal Update</th><th>Detail History</th></tr>
              <tr>
                <td>2026-03-10 09:55:21</td>
                <td>Barang anda P2603020015760.1,P2603020015760.2 telah melewati proses bagging dengan nomor bag PID92446731 oleh Rikson Miosido di SPP JAYAPURA 99100</td>
              </tr>
              <tr>
                <td>2026-07-29 12:10:34</td>
                <td>Barang anda P2603020015760.1 telah diantar oleh Saiful Kemal Junaidi Jamaludin dan diterima oleh amanda</td>
              </tr>
            </table>
        "#;

        let response =
            parse_tracking_html("https://example.test", html).expect("direct koli should parse");

        assert_eq!(
            response.shipment_identity.requested_id.as_deref(),
            Some("P2603020015760.2")
        );
        assert_eq!(
            response.shipment_identity.parent_shipment_id.as_deref(),
            Some("P2603020015760")
        );
        assert!(response.shipment_identity.is_koli);
        assert_eq!(response.shipment_identity.koli_number, Some(2));
        assert_eq!(
            response.multi_koli.koli[1].status_akhir.as_deref(),
            Some("BAGGING")
        );
        assert!(!response.multi_koli.koli[1].has_delivery_proof);
    }

    #[test]
    fn multi_koli_keeps_the_latest_recognized_status_event() {
        let html = r#"
            <table>
              <tr><td>Nomor Kiriman</td><td>P2603020015760</td></tr>
            </table>
            <table>
              <tr><th>Tanggal Update</th><th>Detail History</th></tr>
              <tr>
                <td>2026-03-10 09:55:21</td>
                <td>Barang anda P2603020015760.1,P2603020015760.2 telah melewati proses bagging dengan nomor bag PID92446731 di SPP JAYAPURA 99100</td>
              </tr>
              <tr>
                <td>2026-03-11 10:00:00</td>
                <td>Irregularity Retur Barang untuk P2603020015760.1 telah dicatat</td>
              </tr>
            </table>
        "#;

        let response =
            parse_tracking_html("https://example.test", html).expect("multi koli should parse");
        let koli_one = &response.multi_koli.koli[0];

        assert_eq!(koli_one.status_akhir.as_deref(), Some("BAGGING"));
        assert_eq!(
            koli_one.waktu_status_akhir.as_deref(),
            Some("2026-03-10 09:55:21")
        );
        assert_eq!(
            koli_one
                .bukti_status
                .as_ref()
                .map(|entry| entry.tanggal_update.as_str()),
            Some("2026-03-10 09:55:21")
        );
    }

    #[test]
    fn multi_koli_prioritizes_failed_delivery_evidence_over_delivered_words() {
        let html = r#"
            <table>
              <tr><td>Nomor Kiriman</td><td>P2603020015760</td></tr>
            </table>
            <table>
              <tr><th>Tanggal Update</th><th>Detail History</th></tr>
              <tr>
                <td>2026-07-29 12:10:34</td>
                <td>Barang P2603020015760.1 telah diantar tetapi gagal antar karena penerima tidak dikenal</td>
              </tr>
              <tr>
                <td>2026-03-10 09:55:21</td>
                <td>Barang P2603020015760.2 telah melewati proses bagging di SPP JAYAPURA 99100</td>
              </tr>
            </table>
        "#;

        let response =
            parse_tracking_html("https://example.test", html).expect("multi koli should parse");
        let koli_one = &response.multi_koli.koli[0];

        assert_eq!(koli_one.status_akhir.as_deref(), Some("FAILEDTODELIVERED"));
        assert!(!koli_one.has_delivery_proof);
    }

    #[test]
    fn multi_koli_preserves_the_exact_dotted_suffix() {
        let html = r#"
            <table>
              <tr><td>Nomor Kiriman</td><td>P2603020015760.01</td></tr>
            </table>
            <table>
              <tr><th>Tanggal Update</th><th>Detail History</th></tr>
              <tr>
                <td>2026-03-10 09:55:21</td>
                <td>Barang P2603020015760.01,P2603020015760.2 telah melewati proses bagging di SPP JAYAPURA 99100</td>
              </tr>
            </table>
        "#;

        let response =
            parse_tracking_html("https://example.test", html).expect("multi koli should parse");

        assert_eq!(
            response.shipment_identity.requested_id.as_deref(),
            Some("P2603020015760.01")
        );
        assert_eq!(
            response.multi_koli.nomor_koli,
            ["P2603020015760.01", "P2603020015760.2"]
        );
        assert_eq!(response.multi_koli.koli[0].urutan_koli, 1);
    }

    #[test]
    fn multi_koli_does_not_invent_an_aggregate_without_status_evidence() {
        let html = r#"
            <table>
              <tr><td>Nomor Kiriman</td><td>P2603020015760</td></tr>
            </table>
            <table>
              <tr><th>Tanggal Update</th><th>Detail History</th></tr>
              <tr>
                <td>2026-03-10 09:55:21</td>
                <td>Catatan operasional untuk P2603020015760.1 dan P2603020015760.2</td>
              </tr>
            </table>
        "#;

        let response =
            parse_tracking_html("https://example.test", html).expect("multi koli should parse");

        assert!(response.multi_koli.is_multi_koli);
        assert!(response
            .multi_koli
            .koli
            .iter()
            .all(|item| item.status_akhir.is_none()));
        assert_eq!(response.multi_koli.status_agregat, None);
    }
}
