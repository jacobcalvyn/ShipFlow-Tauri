use std::time::{SystemTime, UNIX_EPOCH};

use axum::{
    http::{HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;

use crate::{request_context::RequestContext, upstream::FetchMeta};

pub const API_VERSION_V1: &str = "v1";
pub const HEADER_SCHEMA_VERSION: &str = "X-Schema-Version";
pub const SOURCE_SYSTEM: &str = "shipflow";

#[derive(Debug, Serialize)]
pub struct ApiEnvelope<T> {
    pub meta: ResponseMeta,
    pub data: T,
}

#[derive(Debug, Serialize)]
pub struct ResponseMeta {
    pub request_id: String,
    pub api_version: &'static str,
    pub schema_version: &'static str,
    pub generated_at_ms: u64,
    pub source: &'static str,
    pub cached: bool,
    pub cache_status: Option<&'static str>,
    pub cache_age_ms: Option<u64>,
    pub source_latency_ms: Option<u64>,
    pub latency_ms: u64,
    pub partial: bool,
    pub degraded: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Default)]
pub struct ResponseMetaOptions {
    pub partial: bool,
    pub warnings: Vec<String>,
    pub degraded_override: Option<bool>,
}

pub fn v1_json_response<T: Serialize>(
    status: StatusCode,
    schema_version: &'static str,
    context: &RequestContext,
    fetch_meta: Option<&FetchMeta>,
    partial: bool,
    warnings: Vec<String>,
    data: T,
) -> Response {
    v1_json_response_with_degraded(
        status,
        schema_version,
        context,
        fetch_meta,
        ResponseMetaOptions {
            partial,
            warnings,
            degraded_override: None,
        },
        data,
    )
}

pub fn v1_json_response_with_degraded<T: Serialize>(
    status: StatusCode,
    schema_version: &'static str,
    context: &RequestContext,
    fetch_meta: Option<&FetchMeta>,
    mut options: ResponseMetaOptions,
    data: T,
) -> Response {
    if let Some(meta) = fetch_meta {
        if meta.cache_status.degraded()
            && !options.warnings.iter().any(|v| v == "served_stale_cache")
        {
            options.warnings.push("served_stale_cache".to_string());
        }
    }

    let body = ApiEnvelope {
        meta: ResponseMeta {
            request_id: context.request_id.clone(),
            api_version: API_VERSION_V1,
            schema_version,
            generated_at_ms: now_ms(),
            source: SOURCE_SYSTEM,
            cached: fetch_meta.map(FetchMeta::cached).unwrap_or(false),
            cache_status: fetch_meta.map(|meta| meta.cache_status.as_str()),
            cache_age_ms: fetch_meta.and_then(|meta| meta.cache_age_ms),
            source_latency_ms: fetch_meta.and_then(|meta| meta.source_latency_ms),
            latency_ms: context.elapsed_ms(),
            partial: options.partial,
            degraded: options
                .degraded_override
                .unwrap_or_else(|| fetch_meta.map(FetchMeta::degraded).unwrap_or(false)),
            warnings: options.warnings,
        },
        data,
    };

    let mut response = (status, Json(body)).into_response();
    response.headers_mut().insert(
        HEADER_SCHEMA_VERSION,
        HeaderValue::from_static(schema_version),
    );
    response
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
