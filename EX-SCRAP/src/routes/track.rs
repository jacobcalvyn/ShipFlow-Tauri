use axum::{
    extract::{Json as AxumJson, Path, Query, State},
    http::StatusCode,
    response::{Html, IntoResponse},
    routing::{get, post},
    Json, Router,
};
use tokio::task::JoinSet;
use tracing::{instrument, warn};
use validator::Validate;

use crate::{
    app_state::AppState,
    error::AppError,
    jobs::{JobStatus, JOB_KIND_TRACK_LITE_BATCH},
    parse::track::{scrape_track, TrackLiteResponse},
    track_batch::{TrackLiteBatchError, TrackLiteBatchItem, TrackLiteBatchResponse},
    upstream::fetch_track_html,
    webhook::{deliver_json_webhook, validate_webhook_url_submission, WebhookDelivery},
};

#[derive(Debug, Clone, serde::Deserialize, Validate)]
pub struct TrackQuery {
    #[validate(length(min = 1, max = 50))]
    pub id: String,
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/trackHtml", get(handle_track_html))
        .route("/track", get(handle_track))
        .route("/trackLite", get(handle_track_lite))
        .route("/trackLiteBatch", get(handle_track_lite_batch))
        .route(
            "/jobs/trackLiteBatch",
            post(handle_create_track_lite_batch_job),
        )
        .route(
            "/jobs/trackLiteBatch/:job_id",
            get(handle_get_track_lite_batch_job),
        )
        .route(
            "/jobs/trackLiteBatch/:job_id/result",
            get(handle_get_track_lite_batch_job_result),
        )
}

#[instrument(skip(state), fields(id = %params.id))]
async fn handle_track_html(
    State(state): State<AppState>,
    Query(params): Query<TrackQuery>,
) -> Result<Html<String>, AppError> {
    params.validate()?;

    let (url, body) = fetch_track_html(&state, &params.id).await?;

    // Untuk HTML endpoint, kita tidak perlu URL, hanya body.
    let _ = url;

    Ok(Html(body.to_string()))
}

#[instrument(skip(state), fields(id = %params.id))]
async fn handle_track(
    State(state): State<AppState>,
    Query(params): Query<TrackQuery>,
) -> Result<impl IntoResponse, AppError> {
    params.validate()?;

    let (url, body) = fetch_track_html(&state, &params.id).await?;

    // CPU-bound task: parsing HTML yang besar.
    // Kita pindahkan ke locking thread pool agar tidak memblokir async runtime.
    let response = tokio::task::spawn_blocking(move || scrape_track(&body, &url))
        .await
        .map_err(|e| AppError::internal(format!("spawn_blocking failed: {}", e)))?;

    response.log_sanity();
    let drift_events = state.drift_guard.analyze_track(&params.id, &response);
    if drift_events > 0 {
        state.metrics.inc_parser_drift(drift_events as u64);
    }
    Ok(Json(response))
}

#[instrument(skip(state), fields(id = %params.id))]
async fn handle_track_lite(
    State(state): State<AppState>,
    Query(params): Query<TrackQuery>,
) -> Result<impl IntoResponse, AppError> {
    params.validate()?;

    let lite = build_track_lite_response(&state, &params.id).await?;
    Ok(Json(lite))
}

#[derive(Debug, Clone, serde::Deserialize, Validate)]
pub struct TrackLiteBatchQuery {
    #[validate(length(min = 1, max = 20000))]
    pub ids: String,
}

#[derive(Debug, Clone, serde::Deserialize, Validate)]
pub struct TrackLiteBatchJobCreateRequest {
    #[validate(length(min = 1, max = 1000))]
    pub ids: Vec<String>,
    pub webhook_url: Option<String>,
}

#[instrument(skip(state), fields(batch = true))]
async fn handle_track_lite_batch(
    State(state): State<AppState>,
    Query(params): Query<TrackLiteBatchQuery>,
) -> Result<impl IntoResponse, AppError> {
    params.validate()?;

    let ids = parse_batch_ids(&params.ids);
    validate_batch_ids(&state, &ids)?;
    let response = process_track_lite_batch(&state, &ids).await?;
    Ok(Json(response))
}

fn parse_batch_ids(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string)
        .collect()
}

#[instrument(skip(state, payload), fields(batch_job = true))]
async fn handle_create_track_lite_batch_job(
    State(state): State<AppState>,
    AxumJson(payload): AxumJson<TrackLiteBatchJobCreateRequest>,
) -> Result<impl IntoResponse, AppError> {
    payload.validate()?;
    validate_batch_ids(&state, &payload.ids)?;

    let webhook_url = payload
        .webhook_url
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string);
    if let Some(url) = webhook_url.as_deref() {
        validate_webhook_url_submission(&state.config, url)
            .await
            .map_err(|err| AppError::new(StatusCode::BAD_REQUEST, "VALIDATION_ERROR", err))?;
    }

    let summary = state
        .job_store
        .create(JOB_KIND_TRACK_LITE_BATCH, payload.ids.len());
    state.metrics.inc_job_created();

    let job_id = summary.job_id.clone();
    let ids = payload.ids.clone();
    let state_clone = state.clone();
    tokio::spawn(async move {
        state_clone.job_store.mark_running(&job_id);

        let done = match process_track_lite_batch(&state_clone, &ids).await {
            Ok(batch_response) => {
                state_clone.metrics.inc_job_completed();
                state_clone.job_store.mark_completed(
                    &job_id,
                    batch_response.success,
                    batch_response.failed,
                    &batch_response,
                )
            }
            Err(err) => {
                state_clone.metrics.inc_job_failed();
                state_clone
                    .job_store
                    .mark_failed(&job_id, format!("{}: {}", err.code, err.safe_message()))
            }
        };

        if !done {
            warn!(job_id, "job result dropped before completion update");
            return;
        }

        if let Some(url) = webhook_url {
            if let Some(snapshot) = state_clone
                .job_store
                .get_result(&job_id, JOB_KIND_TRACK_LITE_BATCH)
            {
                let ok = deliver_json_webhook(
                    &state_clone.client,
                    &state_clone.config,
                    &state_clone.metrics,
                    WebhookDelivery {
                        event: "track_lite_batch.completed",
                        incident_store: Some(state_clone.incident_store.as_ref()),
                        incident_path: Some("/jobs/trackLiteBatch"),
                    },
                    &url,
                    &snapshot,
                )
                .await;
                if !ok {
                    warn!(job_id, webhook_url = %url, "webhook delivery failed");
                }
            }
        }
    });

    Ok((StatusCode::ACCEPTED, Json(summary)))
}

#[instrument(skip(state), fields(job_id = %job_id))]
async fn handle_get_track_lite_batch_job(
    State(state): State<AppState>,
    Path(job_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let Some(summary) = state
        .job_store
        .get_summary(&job_id, JOB_KIND_TRACK_LITE_BATCH)
    else {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "NOT_FOUND",
            anyhow::anyhow!("job not found"),
        ));
    };
    Ok(Json(summary))
}

#[instrument(skip(state), fields(job_id = %job_id))]
async fn handle_get_track_lite_batch_job_result(
    State(state): State<AppState>,
    Path(job_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let Some(snapshot) = state
        .job_store
        .get_result(&job_id, JOB_KIND_TRACK_LITE_BATCH)
    else {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "NOT_FOUND",
            anyhow::anyhow!("job not found"),
        ));
    };

    let status = match snapshot.summary.status {
        JobStatus::Queued | JobStatus::Running => StatusCode::ACCEPTED,
        JobStatus::Completed | JobStatus::Failed => StatusCode::OK,
    };
    Ok((status, Json(snapshot)))
}

fn validate_batch_ids(state: &AppState, ids: &[String]) -> Result<(), AppError> {
    if ids.is_empty() {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "VALIDATION_ERROR",
            anyhow::anyhow!("ids must contain at least one value"),
        ));
    }

    for id in ids {
        TrackQuery { id: id.clone() }.validate()?;
    }

    if ids.len() > state.config.batch_max_items {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "VALIDATION_ERROR",
            anyhow::anyhow!(format!(
                "too many ids: {} (max {})",
                ids.len(),
                state.config.batch_max_items
            )),
        ));
    }

    Ok(())
}

async fn process_track_lite_batch(
    state: &AppState,
    ids: &[String],
) -> Result<TrackLiteBatchResponse, AppError> {
    let mut join_set = JoinSet::new();
    let max_concurrency = state.config.batch_concurrency.max(1);
    let mut next_index = 0usize;
    let mut ordered: Vec<(usize, TrackLiteBatchItem)> = Vec::with_capacity(ids.len());

    while next_index < ids.len() && join_set.len() < max_concurrency {
        let idx = next_index;
        next_index += 1;
        let id = ids[idx].clone();
        let state_clone = state.clone();
        join_set.spawn(async move {
            let result = build_track_lite_response(&state_clone, &id).await;
            (idx, id, result)
        });
    }

    while let Some(joined) = join_set.join_next().await {
        let (idx, id, result) = joined
            .map_err(|e| AppError::internal(format!("trackLiteBatch worker failed: {}", e)))?;

        state.metrics.inc_batch_item();
        let item = match result {
            Ok(data) => TrackLiteBatchItem {
                id,
                ok: true,
                data: Some(data),
                error: None,
            },
            Err(err) => {
                state.metrics.inc_batch_error();
                TrackLiteBatchItem {
                    id,
                    ok: false,
                    data: None,
                    error: Some(TrackLiteBatchError {
                        code: err.code.to_string(),
                        message: err.safe_message(),
                    }),
                }
            }
        };
        ordered.push((idx, item));

        while next_index < ids.len() && join_set.len() < max_concurrency {
            let idx = next_index;
            next_index += 1;
            let id = ids[idx].clone();
            let state_clone = state.clone();
            join_set.spawn(async move {
                let result = build_track_lite_response(&state_clone, &id).await;
                (idx, id, result)
            });
        }
    }

    ordered.sort_by_key(|(idx, _)| *idx);
    let results: Vec<TrackLiteBatchItem> = ordered.into_iter().map(|(_, item)| item).collect();
    let success = results.iter().filter(|item| item.ok).count();
    let failed = results.len().saturating_sub(success);

    Ok(TrackLiteBatchResponse {
        total: results.len(),
        success,
        failed,
        results,
    })
}

async fn build_track_lite_response(
    state: &AppState,
    id: &str,
) -> Result<TrackLiteResponse, AppError> {
    let (url, body) = fetch_track_html(state, id).await?;
    let response = tokio::task::spawn_blocking(move || scrape_track(&body, &url))
        .await
        .map_err(|e| AppError::internal(format!("spawn_blocking failed: {}", e)))?;
    response.log_sanity();
    let drift_events = state.drift_guard.analyze_track(id, &response);
    if drift_events > 0 {
        state.metrics.inc_parser_drift(drift_events as u64);
    }
    Ok(TrackLiteResponse::from(response))
}
