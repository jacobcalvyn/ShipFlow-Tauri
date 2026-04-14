use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use serde_json::json;
use tracing::error;

use crate::request_context::current_request_context;

#[derive(Debug, Serialize)]
struct ErrorPayload<'a> {
    code: &'a str,
    message: String,
    retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
}

/// Error aplikasi dengan status HTTP, kode, dan error asli (anyhow).
#[derive(Debug)]
pub struct AppError {
    pub status: StatusCode,
    pub code: &'static str,
    pub error: anyhow::Error,
}

impl AppError {
    pub fn new(status: StatusCode, code: &'static str, error: impl Into<anyhow::Error>) -> Self {
        Self {
            status,
            code,
            error: error.into(),
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "INTERNAL",
            anyhow::anyhow!(message.into()),
        )
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "UNAUTHORIZED",
            anyhow::anyhow!(message.into()),
        )
    }

    pub fn token_expired(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "TOKEN_EXPIRED",
            anyhow::anyhow!(message.into()),
        )
    }

    pub fn token_revoked(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "TOKEN_REVOKED",
            anyhow::anyhow!(message.into()),
        )
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
            anyhow::anyhow!(message.into()),
        )
    }

    pub fn ip_not_allowed(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::FORBIDDEN,
            "IP_NOT_ALLOWED",
            anyhow::anyhow!(message.into()),
        )
    }

    pub fn rate_limited(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::TOO_MANY_REQUESTS,
            "RATE_LIMITED",
            anyhow::anyhow!(message.into()),
        )
    }

    pub fn upstream_request(err: impl std::error::Error + Send + Sync + 'static) -> Self {
        Self::new(
            StatusCode::BAD_GATEWAY,
            "UPSTREAM_REQUEST",
            anyhow::Error::from(err),
        )
    }

    pub fn upstream_status(status: StatusCode) -> Self {
        Self::new(
            StatusCode::BAD_GATEWAY,
            "UPSTREAM_STATUS",
            anyhow::anyhow!("upstream returned status {}", status),
        )
    }

    pub fn upstream_body(err: impl std::error::Error + Send + Sync + 'static) -> Self {
        Self::new(
            StatusCode::BAD_GATEWAY,
            "UPSTREAM_BODY",
            anyhow::Error::from(err),
        )
    }

    pub fn safe_message(&self) -> String {
        if self.status.is_server_error() {
            "Internal Server Error / Upstream Unavailable".to_string()
        } else {
            self.error.to_string()
        }
    }

    pub fn retryable(&self) -> bool {
        matches!(
            self.status,
            StatusCode::TOO_MANY_REQUESTS
                | StatusCode::BAD_GATEWAY
                | StatusCode::SERVICE_UNAVAILABLE
                | StatusCode::GATEWAY_TIMEOUT
        )
    }
}

// Memungkinkan penggunaan `?` pada tipe anyhow::Error di handler
impl From<anyhow::Error> for AppError {
    fn from(err: anyhow::Error) -> Self {
        // Cek apakah error ini adalah ValidationErrors
        if let Some(validation_errors) = err.downcast_ref::<validator::ValidationErrors>() {
            return Self::new(
                StatusCode::BAD_REQUEST,
                "VALIDATION_ERROR",
                anyhow::anyhow!(validation_errors.to_string()),
            );
        }

        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", err)
    }
}

// Memungkinkan penggunaan `?` langsung pada validator::ValidationErrors
impl From<validator::ValidationErrors> for AppError {
    fn from(err: validator::ValidationErrors) -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            "VALIDATION_ERROR",
            anyhow::Error::from(err),
        )
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let request_id = current_request_context().map(|ctx| ctx.request_id);

        // Log full error chain
        error!(
            status = %self.status,
            code = self.code,
            request_id = request_id.as_deref().unwrap_or("n/a"),
            error = ?self.error,
            "request failed",
        );

        let payload = ErrorPayload {
            code: self.code,
            // SECURITY: Mask internal errors.
            message: self.safe_message(),
            retryable: self.retryable(),
            request_id,
        };

        let body = json!({ "error": payload });

        (self.status, Json(body)).into_response()
    }
}
