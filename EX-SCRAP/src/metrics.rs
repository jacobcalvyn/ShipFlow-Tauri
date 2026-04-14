use std::{
    collections::BTreeMap,
    fmt::Write as _,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, MutexGuard,
    },
};

const HTTP_REQUEST_DURATION_BUCKETS_MS: &[u64] =
    &[5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000];
const UPSTREAM_ATTEMPT_DURATION_BUCKETS_MS: &[u64] = &[
    10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000,
];

pub struct Metrics {
    http_requests_total: AtomicU64,
    http_unauthorized_total: AtomicU64,
    http_token_revoked_total: AtomicU64,
    admin_token_state_persist_total: AtomicU64,
    admin_token_state_persist_error_total: AtomicU64,
    http_forbidden_total: AtomicU64,
    http_rate_limited_total: AtomicU64,
    upstream_attempt_total: AtomicU64,
    upstream_retry_total: AtomicU64,
    upstream_server_busy_total: AtomicU64,
    cache_hit_total: AtomicU64,
    cache_miss_total: AtomicU64,
    stale_served_total: AtomicU64,
    batch_items_total: AtomicU64,
    batch_errors_total: AtomicU64,
    jobs_created_total: AtomicU64,
    jobs_completed_total: AtomicU64,
    jobs_failed_total: AtomicU64,
    webhook_attempt_total: AtomicU64,
    webhook_success_total: AtomicU64,
    webhook_failure_total: AtomicU64,
    parser_drift_total: AtomicU64,
    l2_cache_hit_total: AtomicU64,
    l2_cache_miss_total: AtomicU64,
    http_request_duration_ms: HistogramMetric,
    upstream_attempt_duration_ms: HistogramMetric,
}

impl Default for Metrics {
    fn default() -> Self {
        Self {
            http_requests_total: AtomicU64::new(0),
            http_unauthorized_total: AtomicU64::new(0),
            http_token_revoked_total: AtomicU64::new(0),
            admin_token_state_persist_total: AtomicU64::new(0),
            admin_token_state_persist_error_total: AtomicU64::new(0),
            http_forbidden_total: AtomicU64::new(0),
            http_rate_limited_total: AtomicU64::new(0),
            upstream_attempt_total: AtomicU64::new(0),
            upstream_retry_total: AtomicU64::new(0),
            upstream_server_busy_total: AtomicU64::new(0),
            cache_hit_total: AtomicU64::new(0),
            cache_miss_total: AtomicU64::new(0),
            stale_served_total: AtomicU64::new(0),
            batch_items_total: AtomicU64::new(0),
            batch_errors_total: AtomicU64::new(0),
            jobs_created_total: AtomicU64::new(0),
            jobs_completed_total: AtomicU64::new(0),
            jobs_failed_total: AtomicU64::new(0),
            webhook_attempt_total: AtomicU64::new(0),
            webhook_success_total: AtomicU64::new(0),
            webhook_failure_total: AtomicU64::new(0),
            parser_drift_total: AtomicU64::new(0),
            l2_cache_hit_total: AtomicU64::new(0),
            l2_cache_miss_total: AtomicU64::new(0),
            http_request_duration_ms: HistogramMetric::new(HTTP_REQUEST_DURATION_BUCKETS_MS),
            upstream_attempt_duration_ms: HistogramMetric::new(
                UPSTREAM_ATTEMPT_DURATION_BUCKETS_MS,
            ),
        }
    }
}

impl Metrics {
    pub fn inc_http_requests(&self) {
        self.http_requests_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_http_unauthorized(&self) {
        self.http_unauthorized_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_http_token_revoked(&self) {
        self.http_token_revoked_total
            .fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_admin_token_state_persist(&self) {
        self.admin_token_state_persist_total
            .fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_admin_token_state_persist_error(&self) {
        self.admin_token_state_persist_error_total
            .fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_http_forbidden(&self) {
        self.http_forbidden_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_http_rate_limited(&self) {
        self.http_rate_limited_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_upstream_attempt(&self) {
        self.upstream_attempt_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_upstream_retry(&self) {
        self.upstream_retry_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_upstream_server_busy(&self) {
        self.upstream_server_busy_total
            .fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_cache_hit(&self) {
        self.cache_hit_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_cache_miss(&self) {
        self.cache_miss_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_stale_served(&self) {
        self.stale_served_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_batch_item(&self) {
        self.batch_items_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_batch_error(&self) {
        self.batch_errors_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_job_created(&self) {
        self.jobs_created_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_job_completed(&self) {
        self.jobs_completed_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_job_failed(&self) {
        self.jobs_failed_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_webhook_attempt(&self) {
        self.webhook_attempt_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_webhook_success(&self) {
        self.webhook_success_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_webhook_failure(&self) {
        self.webhook_failure_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_parser_drift(&self, delta: u64) {
        self.parser_drift_total.fetch_add(delta, Ordering::Relaxed);
    }

    pub fn inc_l2_cache_hit(&self) {
        self.l2_cache_hit_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_l2_cache_miss(&self) {
        self.l2_cache_miss_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn observe_http_request_duration(
        &self,
        endpoint: &str,
        method: &str,
        status_class: &str,
        latency_ms: u64,
    ) {
        self.http_request_duration_ms.observe(
            &[
                ("endpoint", endpoint),
                ("method", method),
                ("status_class", status_class),
            ],
            latency_ms,
        );
    }

    pub fn observe_upstream_attempt_duration(&self, kind: &str, outcome: &str, latency_ms: u64) {
        self.upstream_attempt_duration_ms
            .observe(&[("kind", kind), ("outcome", outcome)], latency_ms);
    }

    pub fn render_prometheus(&self, upstream_available_permits: usize) -> String {
        let mut output = String::new();

        render_counter(
            &mut output,
            "scrap_http_requests_total",
            self.http_requests_total.load(Ordering::Relaxed),
        );
        render_counter(
            &mut output,
            "scrap_http_unauthorized_total",
            self.http_unauthorized_total.load(Ordering::Relaxed),
        );
        render_counter(
            &mut output,
            "scrap_http_token_revoked_total",
            self.http_token_revoked_total.load(Ordering::Relaxed),
        );
        render_counter(
            &mut output,
            "scrap_admin_token_state_persist_total",
            self.admin_token_state_persist_total.load(Ordering::Relaxed),
        );
        render_counter(
            &mut output,
            "scrap_admin_token_state_persist_error_total",
            self.admin_token_state_persist_error_total
                .load(Ordering::Relaxed),
        );
        render_counter(
            &mut output,
            "scrap_http_forbidden_total",
            self.http_forbidden_total.load(Ordering::Relaxed),
        );
        render_counter(
            &mut output,
            "scrap_http_rate_limited_total",
            self.http_rate_limited_total.load(Ordering::Relaxed),
        );
        render_counter(
            &mut output,
            "scrap_upstream_attempt_total",
            self.upstream_attempt_total.load(Ordering::Relaxed),
        );
        render_counter(
            &mut output,
            "scrap_upstream_retry_total",
            self.upstream_retry_total.load(Ordering::Relaxed),
        );
        render_counter(
            &mut output,
            "scrap_upstream_server_busy_total",
            self.upstream_server_busy_total.load(Ordering::Relaxed),
        );
        render_counter(
            &mut output,
            "scrap_cache_hit_total",
            self.cache_hit_total.load(Ordering::Relaxed),
        );
        render_counter(
            &mut output,
            "scrap_cache_miss_total",
            self.cache_miss_total.load(Ordering::Relaxed),
        );
        render_counter(
            &mut output,
            "scrap_stale_served_total",
            self.stale_served_total.load(Ordering::Relaxed),
        );
        render_counter(
            &mut output,
            "scrap_batch_items_total",
            self.batch_items_total.load(Ordering::Relaxed),
        );
        render_counter(
            &mut output,
            "scrap_batch_errors_total",
            self.batch_errors_total.load(Ordering::Relaxed),
        );
        render_counter(
            &mut output,
            "scrap_jobs_created_total",
            self.jobs_created_total.load(Ordering::Relaxed),
        );
        render_counter(
            &mut output,
            "scrap_jobs_completed_total",
            self.jobs_completed_total.load(Ordering::Relaxed),
        );
        render_counter(
            &mut output,
            "scrap_jobs_failed_total",
            self.jobs_failed_total.load(Ordering::Relaxed),
        );
        render_counter(
            &mut output,
            "scrap_webhook_attempt_total",
            self.webhook_attempt_total.load(Ordering::Relaxed),
        );
        render_counter(
            &mut output,
            "scrap_webhook_success_total",
            self.webhook_success_total.load(Ordering::Relaxed),
        );
        render_counter(
            &mut output,
            "scrap_webhook_failure_total",
            self.webhook_failure_total.load(Ordering::Relaxed),
        );
        render_counter(
            &mut output,
            "scrap_parser_drift_total",
            self.parser_drift_total.load(Ordering::Relaxed),
        );
        render_counter(
            &mut output,
            "scrap_l2_cache_hit_total",
            self.l2_cache_hit_total.load(Ordering::Relaxed),
        );
        render_counter(
            &mut output,
            "scrap_l2_cache_miss_total",
            self.l2_cache_miss_total.load(Ordering::Relaxed),
        );
        render_gauge(
            &mut output,
            "scrap_upstream_available_permits",
            upstream_available_permits as u64,
        );
        self.http_request_duration_ms
            .render_prometheus(&mut output, "scrap_http_request_duration_ms");
        self.upstream_attempt_duration_ms
            .render_prometheus(&mut output, "scrap_upstream_attempt_duration_ms");

        output
    }
}

fn render_counter(output: &mut String, name: &str, value: u64) {
    writeln!(output, "# TYPE {name} counter").expect("writing metric should not fail");
    writeln!(output, "{name} {value}").expect("writing metric should not fail");
}

fn render_gauge(output: &mut String, name: &str, value: u64) {
    writeln!(output, "# TYPE {name} gauge").expect("writing metric should not fail");
    writeln!(output, "{name} {value}").expect("writing metric should not fail");
}

struct HistogramMetric {
    buckets_ms: &'static [u64],
    series: Mutex<BTreeMap<String, HistogramSeries>>,
}

impl HistogramMetric {
    fn new(buckets_ms: &'static [u64]) -> Self {
        Self {
            buckets_ms,
            series: Mutex::new(BTreeMap::new()),
        }
    }

    fn observe(&self, labels: &[(&'static str, &str)], value_ms: u64) {
        let mut series = recover_lock(&self.series);
        let key = histogram_series_key(labels);
        let entry = series
            .entry(key)
            .or_insert_with(|| HistogramSeries::new(labels, self.buckets_ms.len()));
        entry.observe(self.buckets_ms, value_ms);
    }

    fn render_prometheus(&self, output: &mut String, metric_name: &str) {
        writeln!(output, "# TYPE {metric_name} histogram").expect("writing metric should not fail");
        for series in recover_lock(&self.series).values() {
            for (bucket_index, bucket_upper) in self.buckets_ms.iter().enumerate() {
                let labels =
                    format_metric_labels(&series.labels, Some(("le", bucket_upper.to_string())));
                writeln!(
                    output,
                    "{metric_name}_bucket{labels} {}",
                    series.bucket_counts[bucket_index]
                )
                .expect("writing metric should not fail");
            }

            let inf_labels = format_metric_labels(&series.labels, Some(("le", "+Inf".to_string())));
            writeln!(output, "{metric_name}_bucket{inf_labels} {}", series.count)
                .expect("writing metric should not fail");

            let labels = format_metric_labels(&series.labels, None);
            writeln!(output, "{metric_name}_sum{labels} {}", series.sum_ms)
                .expect("writing metric should not fail");
            writeln!(output, "{metric_name}_count{labels} {}", series.count)
                .expect("writing metric should not fail");
        }
    }
}

struct HistogramSeries {
    labels: Vec<MetricLabel>,
    bucket_counts: Vec<u64>,
    count: u64,
    sum_ms: u64,
}

impl HistogramSeries {
    fn new(labels: &[(&'static str, &str)], bucket_len: usize) -> Self {
        Self {
            labels: labels
                .iter()
                .map(|(name, value)| MetricLabel::new(name, value))
                .collect(),
            bucket_counts: vec![0; bucket_len],
            count: 0,
            sum_ms: 0,
        }
    }

    fn observe(&mut self, buckets_ms: &[u64], value_ms: u64) {
        for (index, bucket_upper) in buckets_ms.iter().enumerate() {
            if value_ms <= *bucket_upper {
                self.bucket_counts[index] += 1;
            }
        }
        self.count += 1;
        self.sum_ms = self.sum_ms.saturating_add(value_ms);
    }
}

struct MetricLabel {
    name: &'static str,
    value: String,
}

impl MetricLabel {
    fn new(name: &'static str, value: &str) -> Self {
        Self {
            name,
            value: value.to_string(),
        }
    }
}

fn histogram_series_key(labels: &[(&'static str, &str)]) -> String {
    let mut key = String::new();
    for (name, value) in labels {
        key.push_str(name);
        key.push('=');
        key.push_str(value);
        key.push('\u{1f}');
    }
    key
}

fn format_metric_labels(labels: &[MetricLabel], extra: Option<(&str, String)>) -> String {
    let mut rendered = String::from("{");
    for (index, label) in labels.iter().enumerate() {
        if index > 0 {
            rendered.push(',');
        }
        write!(
            rendered,
            "{}=\"{}\"",
            label.name,
            escape_metric_label_value(&label.value)
        )
        .expect("writing metric labels should not fail");
    }
    if let Some((name, value)) = extra {
        if !labels.is_empty() {
            rendered.push(',');
        }
        write!(
            rendered,
            "{}=\"{}\"",
            name,
            escape_metric_label_value(&value)
        )
        .expect("writing metric labels should not fail");
    }
    rendered.push('}');
    rendered
}

fn escape_metric_label_value(raw: &str) -> String {
    raw.replace('\\', "\\\\")
        .replace('\n', "\\n")
        .replace('"', "\\\"")
}

fn recover_lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::Metrics;

    #[test]
    fn render_prometheus_includes_http_request_histogram_series() {
        let metrics = Metrics::default();
        metrics.observe_http_request_duration("v1_status", "GET", "2xx", 42);
        metrics.observe_http_request_duration("v1_status", "GET", "2xx", 240);

        let rendered = metrics.render_prometheus(3);

        assert!(rendered.contains("# TYPE scrap_http_request_duration_ms histogram"));
        assert!(rendered.contains(
            "scrap_http_request_duration_ms_bucket{endpoint=\"v1_status\",method=\"GET\",status_class=\"2xx\",le=\"50\"} 1"
        ));
        assert!(rendered.contains(
            "scrap_http_request_duration_ms_bucket{endpoint=\"v1_status\",method=\"GET\",status_class=\"2xx\",le=\"250\"} 2"
        ));
        assert!(rendered.contains(
            "scrap_http_request_duration_ms_sum{endpoint=\"v1_status\",method=\"GET\",status_class=\"2xx\"} 282"
        ));
        assert!(rendered.contains(
            "scrap_http_request_duration_ms_count{endpoint=\"v1_status\",method=\"GET\",status_class=\"2xx\"} 2"
        ));
    }

    #[test]
    fn render_prometheus_includes_upstream_attempt_histogram_series() {
        let metrics = Metrics::default();
        metrics.observe_upstream_attempt_duration("track", "success", 87);
        metrics.observe_upstream_attempt_duration("track", "request_error", 1300);

        let rendered = metrics.render_prometheus(1);

        assert!(rendered.contains("# TYPE scrap_upstream_attempt_duration_ms histogram"));
        assert!(rendered.contains(
            "scrap_upstream_attempt_duration_ms_bucket{kind=\"track\",outcome=\"success\",le=\"100\"} 1"
        ));
        assert!(rendered.contains(
            "scrap_upstream_attempt_duration_ms_bucket{kind=\"track\",outcome=\"request_error\",le=\"2500\"} 1"
        ));
        assert!(rendered.contains(
            "scrap_upstream_attempt_duration_ms_count{kind=\"track\",outcome=\"request_error\"} 1"
        ));
    }
}
