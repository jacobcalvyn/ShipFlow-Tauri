pub fn normalize_iso_datetime(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Some((date_raw, time_raw)) = split_date_time(trimmed) {
        let date = normalize_iso_date(date_raw)?;
        let (hour, minute, second) = parse_time(time_raw)?;
        return Some(format!("{date}T{hour:02}:{minute:02}:{second:02}"));
    }

    normalize_iso_date(trimmed)
}

pub fn normalize_iso_date(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let mut parts = trimmed.split('-');

    let year = parts.next()?.parse::<u32>().ok()?;
    let month = parts.next()?.parse::<u32>().ok()?;
    let day = parts.next()?.parse::<u32>().ok()?;

    if parts.next().is_some() || !valid_date(year, month, day) {
        return None;
    }

    Some(format!("{year:04}-{month:02}-{day:02}"))
}

fn split_date_time(raw: &str) -> Option<(&str, &str)> {
    if let Some((date_raw, time_raw)) = raw.split_once('T') {
        return Some((date_raw.trim(), time_raw.trim()));
    }

    let mut parts = raw.split_whitespace();
    let date_raw = parts.next()?;
    let time_raw = parts.next()?;
    if parts.next().is_some() {
        return None;
    }

    Some((date_raw.trim(), time_raw.trim()))
}

fn parse_time(raw: &str) -> Option<(u32, u32, u32)> {
    let mut parts = raw.split(':');
    let hour = parts.next()?.parse::<u32>().ok()?;
    let minute = parts.next()?.parse::<u32>().ok()?;
    let second = match parts.next() {
        Some(value) => value.parse::<u32>().ok()?,
        None => 0,
    };

    if parts.next().is_some() || hour > 23 || minute > 59 || second > 59 {
        return None;
    }

    Some((hour, minute, second))
}

fn valid_date(year: u32, month: u32, day: u32) -> bool {
    if month == 0 || month > 12 || day == 0 {
        return false;
    }

    day <= days_in_month(year, month)
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn is_leap_year(year: u32) -> bool {
    (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400)
}

#[cfg(test)]
mod tests {
    use super::{normalize_iso_date, normalize_iso_datetime};

    #[test]
    fn normalize_iso_datetime_converts_pid_datetime_to_iso_local() {
        assert_eq!(
            normalize_iso_datetime("2026-03-07 10:00:00"),
            Some("2026-03-07T10:00:00".to_string())
        );
    }

    #[test]
    fn normalize_iso_datetime_accepts_minute_precision() {
        assert_eq!(
            normalize_iso_datetime("2026-03-07 10:00"),
            Some("2026-03-07T10:00:00".to_string())
        );
    }

    #[test]
    fn normalize_iso_datetime_accepts_iso_date() {
        assert_eq!(
            normalize_iso_datetime("2026-03-07"),
            Some("2026-03-07".to_string())
        );
    }

    #[test]
    fn normalize_iso_datetime_rejects_invalid_date() {
        assert_eq!(normalize_iso_datetime("2026-02-31 10:00:00"), None);
        assert_eq!(normalize_iso_date("2026-13-01"), None);
    }
}
