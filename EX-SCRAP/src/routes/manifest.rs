use axum::{
    extract::{Query, State},
    response::{Html, IntoResponse},
    routing::get,
    Json, Router,
};
use tracing::instrument;
use validator::Validate;

use crate::{
    app_state::AppState, error::AppError, parse::manifest::scrape_track_manifest,
    upstream::fetch_manifest_html,
};

#[derive(Debug, Clone, serde::Deserialize, Validate)]
pub struct TrackManifestQuery {
    #[validate(length(min = 1, max = 50))]
    pub id: String,
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/trackManifestHtml", get(handle_track_manifest_html))
        .route("/trackManifest", get(handle_track_manifest))
}

#[instrument(skip(state), fields(id = %params.id))]
async fn handle_track_manifest_html(
    State(state): State<AppState>,
    Query(params): Query<TrackManifestQuery>,
) -> Result<Html<String>, AppError> {
    params.validate()?;
    let (url, body) = fetch_manifest_html(&state, &params.id).await?;
    let _ = url;
    Ok(Html(body.to_string()))
}

#[instrument(skip(state), fields(id = %params.id))]
async fn handle_track_manifest(
    State(state): State<AppState>,
    Query(params): Query<TrackManifestQuery>,
) -> Result<impl IntoResponse, AppError> {
    params.validate()?;
    let (url, body) = fetch_manifest_html(&state, &params.id).await?;

    let response = tokio::task::spawn_blocking(move || scrape_track_manifest(&body, &url))
        .await
        .map_err(|e| AppError::internal(format!("spawn_blocking failed: {}", e)))?;

    response.log_sanity();
    let drift_events = state.drift_guard.analyze_manifest(&params.id, &response);
    if drift_events > 0 {
        state.metrics.inc_parser_drift(drift_events as u64);
    }
    Ok(Json(response))
}
