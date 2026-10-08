use std::collections::{HashMap, HashSet};

use reqwest::{Client, Url};
use scraper::{ElementRef, Html, Selector};
use serde::Deserialize;

use crate::model::{
    ManifestDetail, ManifestItem, ManifestProductSummary, ManifestResponse, TrackingError,
};
use crate::upstream::{normalize_and_validate_bag_id, read_response_text_limited};

pub const MILE_MANIFEST_FILTER_ENDPOINT: &str = "https://posindo.mile.app/api/manifestR7-filter";
const MILE_BASE_URL: &str = "https://posindo.mile.app/";
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_BAGS: usize = 10_000;

#[derive(Deserialize)]
struct ManifestList {
    data: Vec<Vec<serde_json::Value>>,
}

fn text(cell: ElementRef<'_>) -> String {
    cell.text()
        .collect::<Vec<_>>()
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn optional(value: &str) -> Option<String> {
    let value = value.trim().trim_start_matches(':').trim();
    (!value.is_empty()
        && !matches!(
            value.to_ascii_lowercase().as_str(),
            "-" | "null" | "undefined"
        ))
    .then(|| value.to_owned())
}

fn invalid(message: &str) -> TrackingError {
    TrackingError::Upstream(format!("Mile manifest: {message}"))
}

pub fn resolve_manifest_print_link(
    json: &str,
    manifest_id: &str,
) -> Result<(Url, usize), TrackingError> {
    let list: ManifestList =
        serde_json::from_str(json).map_err(|_| invalid("invalid manifest list response"))?;
    let matches: Vec<_> = list
        .data
        .iter()
        .filter(|row| {
            row.get(1)
                .and_then(|v| v.as_str())
                .is_some_and(|id| id.eq_ignore_ascii_case(manifest_id))
        })
        .collect();
    if matches.len() != 1 {
        return Err(invalid("expected exactly one matching R7 record"));
    }
    let row = matches[0];
    let count = row
        .get(5)
        .and_then(|v| v.as_u64().or_else(|| v.as_str()?.parse().ok()))
        .filter(|count| *count <= MAX_BAGS as u64)
        .ok_or_else(|| invalid("invalid bag count"))? as usize;
    let links = row
        .get(12)
        .and_then(|v| v.as_str())
        .ok_or_else(|| invalid("missing Print link"))?;
    let document = Html::parse_fragment(links);
    let anchors = Selector::parse("a[href]").expect("valid selector");
    let base = Url::parse(MILE_BASE_URL).expect("valid URL");
    let url = document
        .select(&anchors)
        .filter_map(|anchor| base.join(anchor.value().attr("href")?).ok())
        .find(|url| {
            url.origin() == base.origin()
                && url.username().is_empty()
                && url.password().is_none()
                && url.path() == "/manifestR7/print"
                && valid_task_id(url).is_some()
        })
        .ok_or_else(|| invalid("missing valid same-origin Print link"))?;
    Ok((url, count))
}

fn valid_task_id(url: &Url) -> Option<String> {
    let ids: Vec<_> = url
        .query_pairs()
        .filter(|(key, _)| key == "taskId")
        .map(|(_, value)| value.into_owned())
        .collect();
    (ids.len() == 1).then(|| ids[0].clone()).filter(|id| {
        !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric())
    })
}

fn weight(value: &str) -> Result<f64, TrackingError> {
    let value = value.trim();
    if value.is_empty()
        || !value
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '.' | ','))
    {
        return Err(invalid("invalid bag weight"));
    }
    value
        .replace(',', ".")
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or_else(|| invalid("invalid bag weight"))
}

pub fn parse_manifest_print_html(
    html: &str,
    url: &str,
    manifest_id: &str,
    expected_bags: usize,
) -> Result<ManifestResponse, TrackingError> {
    let document = Html::parse_document(html);
    let tables = Selector::parse("table").expect("valid selector");
    let rows = Selector::parse("tr").expect("valid selector");
    let cells = Selector::parse("th, td").expect("valid selector");
    let headings = Selector::parse("h3").expect("valid selector");
    let parsed_url = Url::parse(url).map_err(|_| invalid("invalid Print URL"))?;
    let task_id = valid_task_id(&parsed_url).ok_or_else(|| invalid("missing taskId"))?;
    let table_data: Vec<Vec<Vec<String>>> = document
        .select(&tables)
        .map(|table| {
            table
                .select(&rows)
                .map(|row| row.select(&cells).map(text).collect())
                .collect()
        })
        .collect();
    let labels_index = table_data
        .iter()
        .position(|table| {
            table
                .first()
                .is_some_and(|row| row.len() == 1 && row[0] == "Manifest Kantong")
        })
        .ok_or_else(|| invalid("missing Print metadata"))?;
    let labels = &table_data[labels_index];
    let values = table_data
        .get(labels_index + 1)
        .filter(|values| values.len() == labels.len())
        .ok_or_else(|| invalid("incomplete Print metadata"))?;
    let metadata: HashMap<_, _> = labels
        .iter()
        .zip(values)
        .filter_map(|(label, value)| Some((label.first()?.as_str(), optional(value.first()?))))
        .collect();
    let number = metadata
        .get("No")
        .and_then(|value| value.as_deref())
        .ok_or_else(|| invalid("missing R7 number"))?;
    if !number.eq_ignore_ascii_case(manifest_id) {
        return Err(invalid("Print R7 does not match the requested manifest"));
    }
    let route = document
        .select(&headings)
        .map(text)
        .find_map(|heading| {
            heading
                .strip_prefix("Dari ")?
                .split_once(" Tujuan ")
                .map(|(origin, target)| (optional(origin), optional(target)))
        })
        .ok_or_else(|| invalid("missing manifest route"))?;
    let bag_table = table_data
        .iter()
        .find(|table| {
            table.first().is_some_and(|row| {
                row == &[
                    "No",
                    "No Kantong",
                    "Produk",
                    "Berat (kg)",
                    "Asal Bag",
                    "Tujuan Bag",
                ]
            })
        })
        .ok_or_else(|| invalid("missing Print bag table"))?;
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    let mut products: HashMap<Option<String>, (usize, f64)> = HashMap::new();
    for row in bag_table.iter().skip(1) {
        if row.len() != 6 {
            return Err(invalid("incomplete bag row"));
        }
        let bag_id = normalize_and_validate_bag_id(&row[1])
            .map_err(|_| invalid("invalid bag identifier"))?;
        if !seen.insert(bag_id.clone()) {
            return Err(invalid("duplicate bag identifier"));
        }
        if items.len() >= MAX_BAGS {
            return Err(invalid("bag count exceeds the response limit"));
        }
        let bag_weight = weight(&row[3])?;
        let product = optional(&row[2]);
        let tally = products.entry(product.clone()).or_default();
        tally.0 += 1;
        tally.1 += bag_weight;
        items.push(ManifestItem {
            no: optional(&row[0]),
            nomor_kantung: Some(bag_id),
            jenis_layanan: product,
            berat: Some(row[3].clone()),
            lokasi_asal: optional(&row[4]),
            tujuan: optional(&row[5]),
            ..ManifestItem::default()
        });
    }
    if items.len() != expected_bags {
        return Err(invalid("Print bag count does not match the manifest list"));
    }
    let recap = table_data
        .iter()
        .find(|table| {
            table
                .first()
                .is_some_and(|row| row == &["Produk", "Jumlah", "Berat (Kg)"])
        })
        .ok_or_else(|| invalid("missing Print totals"))?;
    let mut summaries = Vec::new();
    let mut recap_seen = HashSet::new();
    let mut total = None;
    for row in recap.iter().skip(1) {
        if row.len() != 3 {
            return Err(invalid("incomplete totals row"));
        }
        let count = row[1]
            .parse::<usize>()
            .map_err(|_| invalid("invalid totals count"))?;
        let kg = weight(&row[2])?;
        if row[0].eq_ignore_ascii_case("Total") {
            if total.replace((count, kg)).is_some() {
                return Err(invalid("duplicate total row"));
            }
        } else {
            let product = optional(&row[0]);
            if !recap_seen.insert(product.clone()) {
                return Err(invalid("duplicate product summary"));
            }
            let actual = products.get(&product).copied().unwrap_or_default();
            if count != actual.0 || (kg - actual.1).abs() > 0.000001 {
                return Err(invalid("product totals do not match the bag rows"));
            }
            summaries.push(ManifestProductSummary {
                jenis_layanan: product,
                jumlah_kantung: count,
                berat_kg: kg,
            });
        }
    }
    if products.keys().any(|product| !recap_seen.contains(product)) {
        return Err(invalid("missing product summary"));
    }
    let total = total.ok_or_else(|| invalid("missing total row"))?;
    if total.0 != items.len()
        || (total.1 - products.values().map(|value| value.1).sum::<f64>()).abs() > 0.000001
    {
        return Err(invalid("manifest totals do not match the bag rows"));
    }
    let get = |key| metadata.get(key).cloned().flatten();
    Ok(ManifestResponse {
        url: url.to_owned(),
        total_berat: Some(format!("{} Kg", total.1)),
        items,
        manifest_detail: Some(ManifestDetail {
            nomor_manifest: manifest_id.to_owned(),
            task_id,
            lokasi_asal: route.0,
            tujuan: route.1,
            nomor_smu: get("Nomor SMU"),
            angkutan: get("Angkutan"),
            mode: get("Mode"),
            tanggal: get("Tanggal"),
            jumlah_kantung: total.0,
            total_berat_kg: total.1,
            rekap_layanan: summaries,
            source_url: url.to_owned(),
            fetched_at: String::new(),
            cache_status: "fetched".into(),
            status_source: "unavailable".into(),
        }),
    })
}

pub async fn fetch_manifest_print(
    client: &Client,
    manifest_id: &str,
) -> Result<ManifestResponse, TrackingError> {
    // The list endpoint requires a date range even for an exact R7 number.
    let date = manifest_date_from_id(manifest_id)
        .ok_or_else(|| invalid("R7 number has no valid encoded date for the list filter"))?;
    let response = client
        .post(MILE_MANIFEST_FILTER_ENDPOINT)
        .header("X-Requested-With", "XMLHttpRequest")
        .form(&[
            ("numberR7", manifest_id),
            ("date_from", date.as_str()),
            ("date_to", date.as_str()),
            ("origin", ""),
            ("inisiasi", "notinisiasi"),
            ("start", "0"),
            ("length", "100"),
            ("draw", "1"),
        ])
        .send()
        .await
        .map_err(|error| invalid(&format!("list request failed: {error}")))?;
    if !response.status().is_success() {
        return Err(invalid(&format!(
            "list returned HTTP {}",
            response.status()
        )));
    }
    let json =
        read_response_text_limited(response, MAX_RESPONSE_BYTES, "Mile manifest list").await?;
    let (url, count) = resolve_manifest_print_link(&json, manifest_id)?;
    let response = client
        .get(url.clone())
        .send()
        .await
        .map_err(|error| invalid(&format!("Print request failed: {error}")))?;
    if !response.status().is_success() {
        return Err(invalid(&format!(
            "Print returned HTTP {}",
            response.status()
        )));
    }
    let html =
        read_response_text_limited(response, MAX_RESPONSE_BYTES, "Mile manifest Print").await?;
    parse_manifest_print_html(&html, url.as_str(), manifest_id, count)
}

fn manifest_date_from_id(id: &str) -> Option<String> {
    let bytes = id.as_bytes();
    if bytes.len() < 9
        || !bytes[0].is_ascii_alphabetic()
        || !bytes[1..9].iter().all(u8::is_ascii_digit)
    {
        return None;
    }
    let year = id[1..5].parse::<u32>().ok()?;
    let month = id[5..7].parse::<u32>().ok()?;
    let day = id[7..9].parse::<u32>().ok()?;
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => return None,
    };
    (year >= 1900 && (1..=max_day).contains(&day)).then(|| format!("{year:04}-{month:02}-{day:02}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    const HTML: &str = include_str!("../tests/fixtures/mile_manifest_print.html");
    const ID: &str = "P20260929082013165";
    const URL: &str = "https://posindo.mile.app/manifestR7/print?taskId=8932c2f5a5706c9c8224";

    #[test]
    fn parses_print_metadata_and_every_bag_route() {
        let result = parse_manifest_print_html(HTML, URL, ID, 10).unwrap();
        assert_eq!(result.items.len(), 10);
        let detail = result.manifest_detail.unwrap();
        assert_eq!(detail.task_id, "8932c2f5a5706c9c8224");
        assert_eq!(detail.lokasi_asal.as_deref(), Some("SPP JAYAPURA 99100"));
        assert_eq!(detail.tujuan.as_deref(), Some("DC JAYAPURA 9910A"));
        assert_eq!(detail.mode.as_deref(), Some("DARAT"));
        assert_eq!(detail.total_berat_kg, 12.92);
        assert_eq!(
            result.items[1].tujuan.as_deref(),
            Some("LE MUARA TAMI 99351D1")
        );
        assert!(result
            .items
            .iter()
            .all(|item| item.status.is_none() && item.tanggal.is_none()));
    }

    #[test]
    fn rejects_mismatched_incomplete_or_corrupt_print_snapshots() {
        assert!(parse_manifest_print_html(HTML, URL, "P20260929082013166", 10).is_err());
        assert!(parse_manifest_print_html(HTML, URL, ID, 11).is_err());
        assert!(parse_manifest_print_html(
            &HTML.replace("PID108157373", "PID108132707"),
            URL,
            ID,
            10
        )
        .is_err());
        assert!(parse_manifest_print_html(
            &HTML.replace("<b>12.92</b>", "<b>13.92</b>"),
            URL,
            ID,
            10
        )
        .is_err());
        assert!(parse_manifest_print_html(
            &HTML.replace("<td>2.25</td>", "<td>-</td>"),
            URL,
            ID,
            10
        )
        .is_err());
        assert!(parse_manifest_print_html("<form>Login</form>", URL, ID, 0).is_err());
    }

    #[test]
    fn resolves_only_exact_r7_and_trusted_print_links() {
        let list = |id: &str, link: &str| {
            serde_json::json!({"data": [[1,id,"DARAT","","",10,"","","","","","",link]]})
                .to_string()
        };
        let good = list(
            ID,
            "<a href='/manifestR7/print?taskId=8932c2f5a5706c9c8224'>Print</a>",
        );
        let (url, count) = resolve_manifest_print_link(&good, ID).unwrap();
        assert_eq!(url.as_str(), URL);
        assert_eq!(count, 10);
        assert!(resolve_manifest_print_link(&good, "P20260929082013166").is_err());
        assert!(resolve_manifest_print_link(
            &list(
                ID,
                "<a href='https://other.example/manifestR7/print?taskId=123'>Print</a>"
            ),
            ID
        )
        .is_err());
        assert!(resolve_manifest_print_link(
            &list(ID, "<a href='/manifestR7/edit?taskId=123'>Edit</a>"),
            ID
        )
        .is_err());
    }

    #[test]
    fn validates_the_encoded_date_before_searching() {
        assert_eq!(manifest_date_from_id(ID).as_deref(), Some("2026-09-29"));
        assert_eq!(
            manifest_date_from_id("L202402291234").as_deref(),
            Some("2024-02-29")
        );
        assert!(manifest_date_from_id("P202602301234").is_none());
        assert!(manifest_date_from_id("P202613011234").is_none());
        assert!(manifest_date_from_id("MAN1").is_none());
    }
}
