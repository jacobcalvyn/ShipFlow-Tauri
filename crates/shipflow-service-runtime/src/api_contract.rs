use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::{http::StatusCode, Json};
use serde::Serialize;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

pub const API_VERSION: &str = "v1";
pub const REQUEST_ID_HEADER_NAME: &str = "x-shipflow-request-id";

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiResponseMeta {
    pub api_version: &'static str,
    pub schema_version: &'static str,
    pub request_id: String,
    pub generated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiEnvelope<T: Serialize> {
    pub meta: ApiResponseMeta,
    pub data: T,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiErrorEnvelope {
    pub meta: ApiResponseMeta,
    pub error: ApiErrorBody,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiErrorBody {
    pub message: String,
}

pub fn generated_at_iso8601() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}

pub fn generate_request_id() -> String {
    let counter = REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed);
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("sf_req_{millis:x}_{counter:x}")
}

pub fn response_meta(schema_version: &'static str, request_id: String) -> ApiResponseMeta {
    ApiResponseMeta {
        api_version: API_VERSION,
        schema_version,
        request_id,
        generated_at: generated_at_iso8601(),
    }
}

pub fn envelope<T: Serialize>(
    schema_version: &'static str,
    request_id: String,
    data: T,
) -> Json<ApiEnvelope<T>> {
    Json(ApiEnvelope {
        meta: response_meta(schema_version, request_id),
        data,
        warnings: Vec::new(),
    })
}

pub fn error_response_v1(
    status: StatusCode,
    schema_version: &'static str,
    request_id: String,
    message: &str,
) -> (StatusCode, Json<ApiErrorEnvelope>) {
    (
        status,
        Json(ApiErrorEnvelope {
            meta: response_meta(schema_version, request_id),
            error: ApiErrorBody {
                message: message.to_string(),
            },
            warnings: Vec::new(),
        }),
    )
}

#[cfg(test)]
mod tests {
    use time::{format_description::well_known::Rfc3339, OffsetDateTime};

    use super::{envelope, generated_at_iso8601, API_VERSION};

    #[test]
    fn builds_v1_envelope_with_stable_meta() {
        let payload = envelope("test.v1", "req-1".into(), serde_json::json!({"ok": true}));

        assert_eq!(payload.meta.api_version, API_VERSION);
        assert_eq!(payload.meta.schema_version, "test.v1");
        assert_eq!(payload.meta.request_id, "req-1");
        assert!(payload.warnings.is_empty());
    }

    #[test]
    fn generated_at_uses_rfc3339_timestamp() {
        let generated_at = generated_at_iso8601();

        OffsetDateTime::parse(&generated_at, &Rfc3339).expect("generatedAt should be RFC3339");
    }
}
