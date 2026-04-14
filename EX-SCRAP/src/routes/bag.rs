use axum::{
    extract::{Query, State},
    response::{Html, IntoResponse},
    routing::get,
    Json, Router,
};
use tracing::instrument;
use validator::Validate;

use crate::{
    app_state::AppState, error::AppError, parse::bag::scrape_track_bag, upstream::fetch_bag_html,
};

#[derive(Debug, Clone, serde::Deserialize, Validate)]
pub struct TrackBagQuery {
    #[validate(length(min = 1, max = 50))]
    pub id: String,
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/trackBagHtml", get(handle_track_bag_html))
        .route("/trackBag", get(handle_track_bag))
}

#[instrument(skip(state), fields(id = %params.id))]
async fn handle_track_bag_html(
    State(state): State<AppState>,
    Query(params): Query<TrackBagQuery>,
) -> Result<Html<String>, AppError> {
    params.validate()?;
    let (url, body) = fetch_bag_html(&state, &params.id).await?;
    let _ = url;
    Ok(Html(body.to_string()))
}

#[instrument(skip(state), fields(id = %params.id))]
async fn handle_track_bag(
    State(state): State<AppState>,
    Query(params): Query<TrackBagQuery>,
) -> Result<impl IntoResponse, AppError> {
    params.validate()?;
    let (url, body) = fetch_bag_html(&state, &params.id).await?;

    let response = tokio::task::spawn_blocking(move || scrape_track_bag(&body, &url))
        .await
        .map_err(|e| AppError::internal(format!("spawn_blocking failed: {}", e)))?;

    response.log_sanity();
    let drift_events = state.drift_guard.analyze_bag(&params.id, &response);
    if drift_events > 0 {
        state.metrics.inc_parser_drift(drift_events as u64);
    }
    Ok(Json(response))
}
