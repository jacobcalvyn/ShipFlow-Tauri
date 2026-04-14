use std::time::Instant;

use axum::{
    extract::Request,
    http::{HeaderMap, HeaderValue},
    middleware::Next,
    response::Response,
};
use rand::Rng;
use tokio::task_local;

pub const HEADER_REQUEST_ID: &str = "X-Request-Id";

task_local! {
    static CURRENT_REQUEST_CONTEXT: RequestContext;
}

#[derive(Debug, Clone)]
pub struct RequestContext {
    pub request_id: String,
    pub path: String,
    started_at: Instant,
}

impl RequestContext {
    pub fn new(request_id: String, path: String) -> Self {
        Self {
            request_id,
            path,
            started_at: Instant::now(),
        }
    }

    pub fn elapsed_ms(&self) -> u64 {
        self.started_at.elapsed().as_millis() as u64
    }
}

pub fn current_request_context() -> Option<RequestContext> {
    CURRENT_REQUEST_CONTEXT.try_with(Clone::clone).ok()
}

pub async fn request_context_middleware(mut request: Request, next: Next) -> Response {
    let request_id = extract_request_id(request.headers()).unwrap_or_else(generate_request_id);
    let path = request.uri().path().to_string();
    let context = RequestContext::new(request_id, path);
    request.extensions_mut().insert(context.clone());

    let mut response = CURRENT_REQUEST_CONTEXT
        .scope(context.clone(), async move { next.run(request).await })
        .await;

    if let Ok(value) = HeaderValue::from_str(&context.request_id) {
        response.headers_mut().insert(HEADER_REQUEST_ID, value);
    }

    response
}

fn extract_request_id(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(HEADER_REQUEST_ID)?.to_str().ok()?.trim();
    if raw.is_empty() || raw.len() > 128 {
        return None;
    }
    if !raw
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return None;
    }
    Some(raw.to_string())
}

fn generate_request_id() -> String {
    format!("req_{:016x}", rand::rng().random::<u64>())
}
