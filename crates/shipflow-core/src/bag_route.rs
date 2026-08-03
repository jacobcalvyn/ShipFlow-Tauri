use scraper::{Html as ScraperHtml, Selector};

use crate::model::BagRoute;

fn normalize_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn parse_bag_route_html(html: &str, bag_id: &str, url: &str) -> Result<BagRoute, String> {
    let document = ScraperHtml::parse_document(html);
    let block_selector = Selector::parse("b").expect("valid selector");
    let label_selector = Selector::parse("i").expect("valid selector");

    let mut lokasi_asal = None;
    let mut tujuan = None;

    for block in document.select(&block_selector) {
        let Some(label) = block.select(&label_selector).next() else {
            continue;
        };
        let label = normalize_text(&label.text().collect::<String>())
            .trim_end_matches(':')
            .to_ascii_lowercase();
        let text = normalize_text(&block.text().collect::<String>());
        let value = text
            .split_once(':')
            .map(|(_, value)| value.trim())
            .filter(|value| !value.is_empty())
            .map(str::to_string);

        match label.as_str() {
            "from" => lokasi_asal = value,
            "to" => tujuan = value,
            _ => {}
        }
    }

    if lokasi_asal.is_none() && tujuan.is_none() {
        return Err("Bag label response does not contain From or To route fields.".into());
    }

    Ok(BagRoute {
        nomor_kantung: bag_id.to_string(),
        lokasi_asal,
        tujuan,
        url: url.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::parse_bag_route_html;

    #[test]
    fn parses_origin_and_destination_from_pos_bag_label() {
        let html = r#"
            <div><b><i>From:</i> <br>KCU JAYAPURA 99000</b></div>
            <div><b><i>To:</i> <br>DC JAYAPURA 9910A</b></div>
        "#;

        let route = parse_bag_route_html(html, "PID96722106", "https://example.test/print-bag")
            .expect("route should parse");

        assert_eq!(route.nomor_kantung, "PID96722106");
        assert_eq!(route.lokasi_asal.as_deref(), Some("KCU JAYAPURA 99000"));
        assert_eq!(route.tujuan.as_deref(), Some("DC JAYAPURA 9910A"));
    }

    #[test]
    fn rejects_unsuccessful_json_or_unrecognized_html() {
        let error = parse_bag_route_html(
            r#"{"status":false,"message":null}"#,
            "PID96722106",
            "https://example.test/print-bag",
        )
        .expect_err("non-label response should fail");

        assert!(error.contains("From or To"));
    }
}
