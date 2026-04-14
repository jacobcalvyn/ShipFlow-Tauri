pub mod bag;
pub mod manifest;
pub mod track;

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

fn is_track_bag_header(headers: &[String]) -> bool {
    if headers.len() < 9 {
        return false;
    }

    let h0 = &headers[0];
    let h1 = &headers[1];
    let h2 = &headers[2];
    let h3 = &headers[3];

    h0.contains("NO")
        && h1.contains("NO")
        && h1.contains("RESI")
        && h2.contains("KANTOR")
        && h2.contains("KIRIM")
        && h3.contains("TANGGAL")
        && h3.contains("KIRIM")
}

fn is_track_manifest_header(headers: &[String]) -> bool {
    if headers.len() < 7 {
        return false;
    }

    let h0 = &headers[0];
    let h1 = &headers[1];
    let h2 = &headers[2];
    let h3 = &headers[3];
    let h4 = &headers[4];
    let h5 = &headers[5];
    let h6 = &headers[6];

    h0.contains("NO")
        && h1.contains("NOMOR")
        && h1.contains("KANTUNG")
        && h2.contains("JENIS")
        && h2.contains("LAYANAN")
        && h3.contains("BERAT")
        && h4.contains("STATUS")
        && h5.contains("LOKASI")
        && h5.contains("AKHIR")
        && h6.contains("TANGGAL")
}
