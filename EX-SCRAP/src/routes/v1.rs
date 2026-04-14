use std::{
    collections::BTreeSet,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{Extension, Json as AxumJson, Query, State},
    http::StatusCode,
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Serialize;
use serde_json::{json, Value};
use validator::Validate;

use crate::{
    api_contract::{v1_json_response, v1_json_response_with_degraded, ResponseMetaOptions},
    app_state::AppState,
    auth::{
        normalize_allowed_ip_rule, normalize_scopes, ApiTokenMetadata, AuthContext, TokenSource,
    },
    canary::{probe_upstream_canary, CanaryResponse},
    deprecation::{
        api_changelog_entries, legacy_deprecated_endpoints, legacy_endpoint_migrations,
        API_CHANGELOG_PATH, API_MIGRATION_REFERENCE_PATH, LEGACY_API_SUNSET_HTTP_DATE,
        LEGACY_SUCCESSOR_API_VERSION,
    },
    error::AppError,
    incidents::{IncidentSeverity, ServiceIncidentEvent, ServiceIncidentsSnapshot},
    managed_tokens::{ManagedTokenCreateSpec, ManagedTokenIssuedSecret},
    parse::{bag::TrackBagResponse, manifest::TrackManifestResponse, track::TrackResponse},
    request_context::{current_request_context, RequestContext},
    upstream::{
        fetch_bag_html_with_meta, fetch_manifest_html_with_meta, fetch_track_html_with_meta,
        FetchMeta,
    },
};

const BAG_DETAIL_SCHEMA_VERSION: &str = "bag-detail.v1";
const MANIFEST_DETAIL_SCHEMA_VERSION: &str = "manifest-detail.v1";
const TRACK_DETAIL_SCHEMA_VERSION: &str = "track-detail.v1";
const ADMIN_TOKENS_SCHEMA_VERSION: &str = "admin-tokens.v1";
const ADMIN_TOKEN_MUTATION_SCHEMA_VERSION: &str = "admin-token-mutation.v1";
const ADMIN_TOKEN_ROTATION_SCHEMA_VERSION: &str = "admin-token-rotation.v1";
const ADMIN_TOKEN_SECRET_SCHEMA_VERSION: &str = "admin-token-secret.v1";
const SERVICE_STATUS_SCHEMA_VERSION: &str = "service-status.v1";
const INCIDENTS_SCHEMA_VERSION: &str = "incidents.v1";
const CHANGELOG_SCHEMA_VERSION: &str = "changelog.v1";
const CAPABILITIES_SCHEMA_VERSION: &str = "capabilities.v1";
const WHOAMI_SCHEMA_VERSION: &str = "whoami.v1";
const MAX_TRACK_ID_LEN: usize = 50;

#[derive(Debug, Clone, serde::Deserialize, Validate)]
struct TrackSummaryQuery {
    #[validate(length(min = 1, max = 50))]
    id: String,
}

#[derive(Debug, Clone, serde::Deserialize, Validate)]
struct AdminTokenRevokeRequest {
    #[validate(length(min = 1, max = 100))]
    token_id: String,
    #[validate(length(max = 500))]
    reason: Option<String>,
    #[validate(length(max = 100))]
    successor_token_id: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize, Validate)]
struct AdminTokenRestoreRequest {
    #[validate(length(min = 1, max = 100))]
    token_id: String,
}

#[derive(Debug, Clone, serde::Deserialize, Validate)]
struct AdminTokenRotateRequest {
    #[validate(length(min = 1, max = 100))]
    from_token_id: String,
    #[validate(length(min = 1, max = 100))]
    to_token_id: String,
    #[validate(length(max = 500))]
    reason: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize, Validate)]
struct AdminManagedTokenCreateRequest {
    #[validate(length(min = 1, max = 100))]
    token_id: String,
    #[validate(length(max = 120))]
    label: Option<String>,
    #[validate(length(min = 1, max = 50))]
    scopes: Vec<String>,
    #[validate(length(max = 120))]
    created_by: Option<String>,
    expires_at_ms: Option<u64>,
    #[validate(length(max = 50))]
    allowed_ips: Option<Vec<String>>,
    #[validate(length(max = 64))]
    rate_limit_class: Option<String>,
    rate_limit_per_minute: Option<u32>,
    rate_limit_burst_capacity: Option<u32>,
    rate_limit_burst_window_secs: Option<u64>,
}

#[derive(Debug, Clone, serde::Deserialize, Validate)]
struct AdminManagedTokenRotateSecretRequest {
    #[validate(length(min = 1, max = 100))]
    token_id: String,
}

#[derive(Serialize)]
struct TrackDetailResponse {
    id: String,
    authoritative_entity: &'static str,
    record: TrackResponse,
}

#[derive(Debug, Serialize)]
struct CapabilitiesResponse {
    auth: CapabilitiesAuth,
    schemas: CapabilitiesSchemas,
    limits: CapabilitiesLimits,
    features: CapabilitiesFeatures,
    endpoints: CapabilitiesEndpoints,
}

#[derive(Debug, Serialize)]
struct CapabilitiesAuth {
    required_header: &'static str,
    token_introspection_endpoint: &'static str,
    supports_scopes: bool,
    supports_token_expiry: bool,
    supports_ip_allowlist: bool,
    tracks_last_used_at: bool,
    supports_managed_tokens: bool,
    trust_proxy_headers_for_ip_allowlist: bool,
}

#[derive(Debug, Serialize)]
struct CapabilitiesSchemas {
    admin_tokens: &'static str,
    admin_token_mutation: &'static str,
    admin_token_rotation: &'static str,
    admin_token_secret: &'static str,
    bag_detail: &'static str,
    changelog: &'static str,
    incidents: &'static str,
    manifest_detail: &'static str,
    service_status: &'static str,
    track_detail: &'static str,
    capabilities: &'static str,
    whoami: &'static str,
}

#[derive(Debug, Serialize)]
struct CapabilitiesLimits {
    id_max_length: usize,
    batch_max_items: usize,
    batch_concurrency: usize,
    rate_limit_per_minute: u32,
    rate_limit_burst_capacity: u32,
    rate_limit_burst_window_secs: u64,
    rate_limit_class_names: Vec<String>,
    http_timeout_secs: u64,
    upstream_queue_timeout_secs: u64,
}

#[derive(Debug, Serialize)]
struct CapabilitiesFeatures {
    admin_token_inventory: bool,
    admin_managed_tokens: bool,
    admin_token_persistent_state: bool,
    admin_token_runtime_restore: bool,
    admin_token_runtime_revoke: bool,
    admin_token_runtime_rotate: bool,
    admin_token_secret_rotation: bool,
    api_changelog: bool,
    incident_feed: bool,
    bag_detail: bool,
    deprecation_headers_enabled: bool,
    manifest_detail: bool,
    track_detail: bool,
    service_status: bool,
    async_track_lite_batch_job: bool,
    openapi_available: bool,
    stale_if_error_enabled: bool,
    persistent_cache_enabled: bool,
    parser_guard_enabled: bool,
    rate_limit_burst_policy: bool,
    rate_limit_scope_defaults: bool,
    rate_limit_token_classes: bool,
    rate_limit_headers: bool,
    webhook_signed_delivery: bool,
}

#[derive(Debug, Serialize)]
struct CapabilitiesEndpoints {
    public: Vec<&'static str>,
    protected: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
struct WhoAmIResponse {
    token_id: String,
    label: Option<String>,
    token_source: TokenSource,
    scopes: Vec<String>,
    created_by: Option<String>,
    created_at_ms: Option<u64>,
    expires_at_ms: Option<u64>,
    last_used_at_ms: Option<u64>,
    allowed_ips: Vec<String>,
    client_ip: Option<String>,
    rate_limit_class: String,
    rate_limit_per_minute: u32,
    rate_limit_burst_capacity: u32,
    rate_limit_burst_window_secs: u64,
}

#[derive(Debug, Serialize)]
struct ServiceStatusResponse {
    service: ServiceStatusInfo,
    upstream: CanaryResponse,
    deprecation: ServiceStatusDeprecation,
}

#[derive(Debug, Serialize)]
struct ServiceStatusInfo {
    name: &'static str,
    version: &'static str,
    status: &'static str,
    strict_canary_enabled: bool,
}

#[derive(Debug, Serialize)]
struct ServiceStatusDeprecation {
    legacy_endpoints_deprecated: bool,
    deprecation_headers_enabled: bool,
    sunset_at_http: &'static str,
    successor_api_version: &'static str,
    migration_reference: &'static str,
    changelog_path: &'static str,
    affected_endpoints: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
struct ChangelogResponse {
    current_api_version: &'static str,
    migration_reference: &'static str,
    deprecation: ChangelogDeprecation,
    entries: Vec<ChangelogEntry>,
}

#[derive(Debug, Serialize)]
struct IncidentsResponse {
    incidents: ServiceIncidentsSnapshot,
}

#[derive(Debug, Serialize)]
struct ChangelogDeprecation {
    legacy_endpoints_deprecated: bool,
    deprecation_headers_enabled: bool,
    sunset_at_http: &'static str,
    successor_api_version: &'static str,
    migration_reference: &'static str,
    affected_endpoints: Vec<ChangelogDeprecatedEndpoint>,
}

#[derive(Debug, Serialize)]
struct ChangelogDeprecatedEndpoint {
    legacy_path: &'static str,
    successor_path: &'static str,
    successor_kind: &'static str,
}

#[derive(Debug, Serialize)]
struct ChangelogEntry {
    id: &'static str,
    published_on: &'static str,
    summary: &'static str,
    change_type: &'static str,
    api_version: &'static str,
    breaking: bool,
    migration_reference: &'static str,
    endpoints_added: Vec<&'static str>,
    endpoints_deprecated: Vec<&'static str>,
    notes: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
struct AdminTokensResponse {
    summary: AdminTokensSummary,
    tokens: Vec<AdminTokenSummary>,
}

#[derive(Debug, Serialize)]
struct AdminTokensSummary {
    total: usize,
    active: usize,
    expired: usize,
    revoked: usize,
    ip_restricted: usize,
    legacy_full_access: usize,
    explicit: usize,
    managed: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum AdminTokenStatus {
    Active,
    Expired,
}

#[derive(Debug, Serialize)]
struct AdminTokenSummary {
    token_id: String,
    label: Option<String>,
    token_source: TokenSource,
    status: AdminTokenStatus,
    revoked: bool,
    revoked_at_ms: Option<u64>,
    revoked_by_token_id: Option<String>,
    revoke_reason: Option<String>,
    successor_token_id: Option<String>,
    scopes: Vec<String>,
    created_by: Option<String>,
    created_at_ms: Option<u64>,
    expires_at_ms: Option<u64>,
    last_used_at_ms: Option<u64>,
    allowed_ips: Vec<String>,
    rate_limit_class: String,
    rate_limit_per_minute: u32,
    rate_limit_burst_capacity: u32,
    rate_limit_burst_window_secs: u64,
}

#[derive(Debug, Serialize)]
struct AdminTokenSecretResponse {
    token: String,
    token_once: bool,
    token_info: AdminTokenSummary,
    operation: AdminTokenOperation,
}

#[derive(Debug, Serialize)]
struct AdminTokenMutationResponse {
    token: AdminTokenSummary,
    operation: AdminTokenOperation,
}

#[derive(Debug, Serialize)]
struct AdminTokenRotationResponse {
    source_token: AdminTokenSummary,
    successor_token: AdminTokenSummary,
    operation: AdminTokenOperation,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum AdminTokenOperationAction {
    Created,
    Revoked,
    Restored,
    Rotated,
    RotatedSecret,
}

#[derive(Debug, Serialize)]
struct AdminTokenOperation {
    action: AdminTokenOperationAction,
    runtime_only: bool,
    persisted: bool,
    effective_immediately: bool,
    performed_at_ms: u64,
    performed_by_token_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    restored_successor: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    invalidated_previous_secret: Option<bool>,
}

struct TrackDetailBuildResult {
    detail: TrackDetailResponse,
    fetch_meta: FetchMeta,
    warnings: Vec<String>,
    partial: bool,
}

struct BagDetailBuildResult {
    detail: BagDetailResponse,
    fetch_meta: FetchMeta,
    warnings: Vec<String>,
    partial: bool,
}

struct ManifestDetailBuildResult {
    detail: ManifestDetailResponse,
    fetch_meta: FetchMeta,
    warnings: Vec<String>,
    partial: bool,
}

#[derive(Serialize)]
struct BagDetailResponse {
    id: String,
    authoritative_entity: &'static str,
    record: TrackBagResponse,
}

#[derive(Serialize)]
struct ManifestDetailResponse {
    id: String,
    authoritative_entity: &'static str,
    record: TrackManifestResponse,
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/changelog", get(handle_changelog))
        .route("/v1/incidents", get(handle_incidents))
        .route("/v1/status", get(handle_service_status))
        .route("/v1/admin/tokens", get(handle_admin_tokens))
        .route(
            "/v1/admin/tokens/managed/create",
            post(handle_admin_managed_token_create),
        )
        .route("/v1/admin/tokens/revoke", post(handle_admin_token_revoke))
        .route("/v1/admin/tokens/restore", post(handle_admin_token_restore))
        .route("/v1/admin/tokens/rotate", post(handle_admin_token_rotate))
        .route(
            "/v1/admin/tokens/managed/rotate-secret",
            post(handle_admin_managed_token_rotate_secret),
        )
        .route("/v1/track/html", get(handle_track_html_v1))
        .route("/v1/track/detail", get(handle_track_detail))
        .route("/v1/bag/html", get(handle_bag_html_v1))
        .route("/v1/bag/detail", get(handle_bag_detail))
        .route("/v1/manifest/html", get(handle_manifest_html_v1))
        .route("/v1/manifest/detail", get(handle_manifest_detail))
        .route("/v1/whoami", get(handle_whoami))
        .route("/openapi.json", get(handle_openapi_json))
        .route("/v1/capabilities", get(handle_capabilities))
}

async fn handle_track_detail(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    Query(params): Query<TrackSummaryQuery>,
) -> Result<Response, AppError> {
    validate_v1(&params)?;

    let built = build_track_detail_result(&state, &params.id)
        .await
        .map_err(into_v1_error)?;

    Ok(v1_json_response(
        StatusCode::OK,
        TRACK_DETAIL_SCHEMA_VERSION,
        &context,
        Some(&built.fetch_meta),
        built.partial,
        built.warnings,
        built.detail,
    ))
}

async fn handle_track_html_v1(
    State(state): State<AppState>,
    Query(params): Query<TrackSummaryQuery>,
) -> Result<Html<String>, AppError> {
    validate_v1(&params)?;
    let fetched = fetch_track_html_with_meta(&state, &params.id)
        .await
        .map_err(into_v1_error)?;
    Ok(Html(fetched.body.to_string()))
}

async fn handle_admin_tokens(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
) -> Result<Response, AppError> {
    let response = build_admin_tokens_response(&state);

    Ok(v1_json_response(
        StatusCode::OK,
        ADMIN_TOKENS_SCHEMA_VERSION,
        &context,
        None,
        false,
        Vec::new(),
        response,
    ))
}

async fn handle_admin_managed_token_create(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    Extension(auth): Extension<AuthContext>,
    AxumJson(payload): AxumJson<AdminManagedTokenCreateRequest>,
) -> Result<Response, AppError> {
    validate_v1(&payload)?;
    let store = require_managed_token_store(&state)?;

    let token_id = payload.token_id.trim().to_string();
    if find_admin_token_record_by_id(&state, &token_id).is_some() {
        return Err(v1_validation_error(anyhow::anyhow!(
            "token_id already exists"
        )));
    }

    let scopes = normalize_scopes(payload.scopes.clone());
    if scopes.is_empty() {
        return Err(v1_validation_error(anyhow::anyhow!(
            "scopes must contain at least one value"
        )));
    }

    let allowed_ips = normalize_allowed_ips(payload.allowed_ips.clone())?;
    let metadata = build_admin_token_metadata(&state, &auth, &payload, allowed_ips)?;
    let now_ms = current_time_ms();
    let issued = store
        .create_token(
            ManagedTokenCreateSpec {
                token_id,
                label: normalize_optional_text(payload.label),
                scopes,
                metadata,
            },
            &state.allowed_tokens,
        )
        .map_err(|error| managed_token_store_error("MANAGED_TOKEN_STORE_PERSIST", error))?;

    Ok(v1_json_response(
        StatusCode::CREATED,
        ADMIN_TOKEN_SECRET_SCHEMA_VERSION,
        &context,
        None,
        false,
        Vec::new(),
        build_admin_token_secret_response(
            issued,
            now_ms,
            &state.config,
            AdminTokenOperation {
                action: AdminTokenOperationAction::Created,
                runtime_only: false,
                persisted: true,
                effective_immediately: true,
                performed_at_ms: now_ms,
                performed_by_token_id: auth.token_id,
                restored_successor: None,
                invalidated_previous_secret: None,
            },
        ),
    ))
}

async fn handle_admin_token_revoke(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    Extension(auth): Extension<AuthContext>,
    AxumJson(payload): AxumJson<AdminTokenRevokeRequest>,
) -> Result<Response, AppError> {
    validate_v1(&payload)?;

    let token_id = payload.token_id.trim().to_string();
    let reason = normalize_optional_text(payload.reason);
    let successor_token_id = normalize_optional_text(payload.successor_token_id);
    if successor_token_id.as_deref() == Some(token_id.as_str()) {
        return Err(v1_validation_error(anyhow::anyhow!(
            "successor_token_id must not be the same as token_id"
        )));
    }

    let Some(record) = find_admin_token_record_by_id(&state, &token_id) else {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "NOT_FOUND",
            anyhow::anyhow!("token_id not found"),
        ));
    };

    let now_ms = current_time_ms();
    let previous_state = record.revocation_state();
    record.revoke(
        now_ms,
        Some(auth.token_id.clone()),
        reason,
        successor_token_id,
    );
    let persisted = match persist_admin_token_state(&state, "/v1/admin/tokens/revoke", &record) {
        Ok(persisted) => persisted,
        Err(error) => {
            record.apply_revocation_state(&previous_state);
            return Err(error);
        }
    };

    Ok(v1_json_response(
        StatusCode::OK,
        ADMIN_TOKEN_MUTATION_SCHEMA_VERSION,
        &context,
        None,
        false,
        admin_token_operation_warnings(persisted),
        AdminTokenMutationResponse {
            token: build_admin_token_summary(&record, now_ms, &state.config),
            operation: AdminTokenOperation {
                action: AdminTokenOperationAction::Revoked,
                runtime_only: !persisted,
                persisted,
                effective_immediately: true,
                performed_at_ms: now_ms,
                performed_by_token_id: auth.token_id,
                restored_successor: None,
                invalidated_previous_secret: None,
            },
        },
    ))
}

async fn handle_admin_token_restore(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    Extension(auth): Extension<AuthContext>,
    AxumJson(payload): AxumJson<AdminTokenRestoreRequest>,
) -> Result<Response, AppError> {
    validate_v1(&payload)?;

    let token_id = payload.token_id.trim().to_string();
    let Some(record) = find_admin_token_record_by_id(&state, &token_id) else {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "NOT_FOUND",
            anyhow::anyhow!("token_id not found"),
        ));
    };

    let previous_state = record.revocation_state();
    record.restore();
    let now_ms = current_time_ms();
    let persisted = match persist_admin_token_state(&state, "/v1/admin/tokens/restore", &record) {
        Ok(persisted) => persisted,
        Err(error) => {
            record.apply_revocation_state(&previous_state);
            return Err(error);
        }
    };

    Ok(v1_json_response(
        StatusCode::OK,
        ADMIN_TOKEN_MUTATION_SCHEMA_VERSION,
        &context,
        None,
        false,
        admin_token_operation_warnings(persisted),
        AdminTokenMutationResponse {
            token: build_admin_token_summary(&record, now_ms, &state.config),
            operation: AdminTokenOperation {
                action: AdminTokenOperationAction::Restored,
                runtime_only: !persisted,
                persisted,
                effective_immediately: true,
                performed_at_ms: now_ms,
                performed_by_token_id: auth.token_id,
                restored_successor: None,
                invalidated_previous_secret: None,
            },
        },
    ))
}

async fn handle_admin_token_rotate(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    Extension(auth): Extension<AuthContext>,
    AxumJson(payload): AxumJson<AdminTokenRotateRequest>,
) -> Result<Response, AppError> {
    validate_v1(&payload)?;

    let from_token_id = payload.from_token_id.trim().to_string();
    let to_token_id = payload.to_token_id.trim().to_string();
    if from_token_id == to_token_id {
        return Err(v1_validation_error(anyhow::anyhow!(
            "from_token_id must not be the same as to_token_id"
        )));
    }

    let Some(source_record) = find_admin_token_record_by_id(&state, &from_token_id) else {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "NOT_FOUND",
            anyhow::anyhow!("from_token_id not found"),
        ));
    };
    let Some(successor_record) = find_admin_token_record_by_id(&state, &to_token_id) else {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "NOT_FOUND",
            anyhow::anyhow!("to_token_id not found"),
        ));
    };

    let now_ms = current_time_ms();
    if source_record.is_revoked() {
        return Err(v1_validation_error(anyhow::anyhow!(
            "from_token_id is already revoked"
        )));
    }
    if successor_record.is_expired(now_ms) {
        return Err(v1_validation_error(anyhow::anyhow!(
            "to_token_id is expired"
        )));
    }

    let reason = normalize_optional_text(payload.reason);
    let source_previous_state = source_record.revocation_state();
    let successor_previous_state = successor_record.revocation_state();
    let successor_was_revoked = successor_record.is_revoked();

    source_record.revoke(
        now_ms,
        Some(auth.token_id.clone()),
        reason,
        Some(to_token_id.clone()),
    );
    successor_record.restore();

    let persisted = match persist_dual_admin_token_state(
        &state,
        "/v1/admin/tokens/rotate",
        &source_record,
        &successor_record,
    ) {
        Ok(persisted) => persisted,
        Err(error) => {
            source_record.apply_revocation_state(&source_previous_state);
            successor_record.apply_revocation_state(&successor_previous_state);
            return Err(error);
        }
    };

    Ok(v1_json_response(
        StatusCode::OK,
        ADMIN_TOKEN_ROTATION_SCHEMA_VERSION,
        &context,
        None,
        false,
        admin_token_operation_warnings(persisted),
        AdminTokenRotationResponse {
            source_token: build_admin_token_summary(&source_record, now_ms, &state.config),
            successor_token: build_admin_token_summary(&successor_record, now_ms, &state.config),
            operation: AdminTokenOperation {
                action: AdminTokenOperationAction::Rotated,
                runtime_only: !persisted,
                persisted,
                effective_immediately: true,
                performed_at_ms: now_ms,
                performed_by_token_id: auth.token_id,
                restored_successor: Some(successor_was_revoked),
                invalidated_previous_secret: None,
            },
        },
    ))
}

async fn handle_admin_managed_token_rotate_secret(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    Extension(auth): Extension<AuthContext>,
    AxumJson(payload): AxumJson<AdminManagedTokenRotateSecretRequest>,
) -> Result<Response, AppError> {
    validate_v1(&payload)?;
    let store = require_managed_token_store(&state)?;
    let token_id = payload.token_id.trim().to_string();

    if state
        .allowed_tokens
        .values()
        .any(|record| record.token_id == token_id)
    {
        return Err(v1_validation_error(anyhow::anyhow!(
            "token_id belongs to a static token and cannot be secret-rotated by managed store"
        )));
    }
    if store.find_by_id(&token_id).is_none() {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "NOT_FOUND",
            anyhow::anyhow!("managed token_id not found"),
        ));
    }

    let now_ms = current_time_ms();
    let issued = store
        .rotate_token_secret(&token_id, &state.allowed_tokens)
        .map_err(|error| managed_token_store_error("MANAGED_TOKEN_STORE_PERSIST", error))?;

    Ok(v1_json_response(
        StatusCode::OK,
        ADMIN_TOKEN_SECRET_SCHEMA_VERSION,
        &context,
        None,
        false,
        Vec::new(),
        build_admin_token_secret_response(
            issued,
            now_ms,
            &state.config,
            AdminTokenOperation {
                action: AdminTokenOperationAction::RotatedSecret,
                runtime_only: false,
                persisted: true,
                effective_immediately: true,
                performed_at_ms: now_ms,
                performed_by_token_id: auth.token_id,
                restored_successor: None,
                invalidated_previous_secret: Some(true),
            },
        ),
    ))
}

async fn handle_service_status(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
) -> Result<Response, AppError> {
    let (_, upstream) = probe_upstream_canary(&state).await;
    let degraded = upstream.degraded;
    let mut warnings = Vec::new();
    if !state.config.upstream_canary_enabled {
        warnings.push("strict_canary_disabled".to_string());
    }
    if degraded {
        warnings.push("upstream_degraded".to_string());
    }

    let response = ServiceStatusResponse {
        service: ServiceStatusInfo {
            name: "scrap-pid-v3",
            version: env!("CARGO_PKG_VERSION"),
            status: if degraded { "degraded" } else { "operational" },
            strict_canary_enabled: state.config.upstream_canary_enabled,
        },
        upstream,
        deprecation: ServiceStatusDeprecation {
            legacy_endpoints_deprecated: false,
            deprecation_headers_enabled: true,
            sunset_at_http: LEGACY_API_SUNSET_HTTP_DATE,
            successor_api_version: LEGACY_SUCCESSOR_API_VERSION,
            migration_reference: API_MIGRATION_REFERENCE_PATH,
            changelog_path: API_CHANGELOG_PATH,
            affected_endpoints: legacy_deprecated_endpoints().to_vec(),
        },
    };

    Ok(v1_json_response_with_degraded(
        StatusCode::OK,
        SERVICE_STATUS_SCHEMA_VERSION,
        &context,
        None,
        ResponseMetaOptions {
            partial: false,
            warnings,
            degraded_override: Some(degraded),
        },
        response,
    ))
}

async fn handle_changelog(
    Extension(context): Extension<RequestContext>,
) -> Result<Response, AppError> {
    let response = ChangelogResponse {
        current_api_version: LEGACY_SUCCESSOR_API_VERSION,
        migration_reference: API_MIGRATION_REFERENCE_PATH,
        deprecation: ChangelogDeprecation {
            legacy_endpoints_deprecated: false,
            deprecation_headers_enabled: true,
            sunset_at_http: LEGACY_API_SUNSET_HTTP_DATE,
            successor_api_version: LEGACY_SUCCESSOR_API_VERSION,
            migration_reference: API_MIGRATION_REFERENCE_PATH,
            affected_endpoints: legacy_endpoint_migrations()
                .iter()
                .map(|migration| ChangelogDeprecatedEndpoint {
                    legacy_path: migration.legacy_path,
                    successor_path: migration.successor_path,
                    successor_kind: migration.successor_kind,
                })
                .collect(),
        },
        entries: api_changelog_entries()
            .iter()
            .map(|entry| ChangelogEntry {
                id: entry.id,
                published_on: entry.published_on,
                summary: entry.summary,
                change_type: entry.change_type,
                api_version: entry.api_version,
                breaking: entry.breaking,
                migration_reference: entry.migration_reference,
                endpoints_added: entry.endpoints_added.to_vec(),
                endpoints_deprecated: entry.endpoints_deprecated.to_vec(),
                notes: entry.notes.to_vec(),
            })
            .collect(),
    };

    Ok(v1_json_response(
        StatusCode::OK,
        CHANGELOG_SCHEMA_VERSION,
        &context,
        None,
        false,
        Vec::new(),
        response,
    ))
}

async fn handle_incidents(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
) -> Result<Response, AppError> {
    Ok(v1_json_response(
        StatusCode::OK,
        INCIDENTS_SCHEMA_VERSION,
        &context,
        None,
        false,
        Vec::new(),
        IncidentsResponse {
            incidents: state.incident_store.snapshot(),
        },
    ))
}

async fn handle_bag_detail(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    Query(params): Query<TrackSummaryQuery>,
) -> Result<Response, AppError> {
    validate_v1(&params)?;

    let built = build_bag_detail_result(&state, &params.id)
        .await
        .map_err(into_v1_error)?;

    Ok(v1_json_response(
        StatusCode::OK,
        BAG_DETAIL_SCHEMA_VERSION,
        &context,
        Some(&built.fetch_meta),
        built.partial,
        built.warnings,
        built.detail,
    ))
}

async fn handle_bag_html_v1(
    State(state): State<AppState>,
    Query(params): Query<TrackSummaryQuery>,
) -> Result<Html<String>, AppError> {
    validate_v1(&params)?;
    let fetched = fetch_bag_html_with_meta(&state, &params.id)
        .await
        .map_err(into_v1_error)?;
    Ok(Html(fetched.body.to_string()))
}

async fn handle_manifest_detail(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    Query(params): Query<TrackSummaryQuery>,
) -> Result<Response, AppError> {
    validate_v1(&params)?;

    let built = build_manifest_detail_result(&state, &params.id)
        .await
        .map_err(into_v1_error)?;

    Ok(v1_json_response(
        StatusCode::OK,
        MANIFEST_DETAIL_SCHEMA_VERSION,
        &context,
        Some(&built.fetch_meta),
        built.partial,
        built.warnings,
        built.detail,
    ))
}

async fn handle_manifest_html_v1(
    State(state): State<AppState>,
    Query(params): Query<TrackSummaryQuery>,
) -> Result<Html<String>, AppError> {
    validate_v1(&params)?;
    let fetched = fetch_manifest_html_with_meta(&state, &params.id)
        .await
        .map_err(into_v1_error)?;
    Ok(Html(fetched.body.to_string()))
}

async fn handle_capabilities(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
) -> Result<Response, AppError> {
    let response = CapabilitiesResponse {
        auth: CapabilitiesAuth {
            required_header: "X-Api-Token",
            token_introspection_endpoint: "/v1/whoami",
            supports_scopes: true,
            supports_token_expiry: true,
            supports_ip_allowlist: true,
            tracks_last_used_at: true,
            supports_managed_tokens: state.managed_token_store.is_some(),
            trust_proxy_headers_for_ip_allowlist: state.config.trust_proxy_headers_for_ip_allowlist,
        },
        schemas: CapabilitiesSchemas {
            admin_tokens: ADMIN_TOKENS_SCHEMA_VERSION,
            admin_token_mutation: ADMIN_TOKEN_MUTATION_SCHEMA_VERSION,
            admin_token_rotation: ADMIN_TOKEN_ROTATION_SCHEMA_VERSION,
            admin_token_secret: ADMIN_TOKEN_SECRET_SCHEMA_VERSION,
            bag_detail: BAG_DETAIL_SCHEMA_VERSION,
            changelog: CHANGELOG_SCHEMA_VERSION,
            incidents: INCIDENTS_SCHEMA_VERSION,
            manifest_detail: MANIFEST_DETAIL_SCHEMA_VERSION,
            service_status: SERVICE_STATUS_SCHEMA_VERSION,
            track_detail: TRACK_DETAIL_SCHEMA_VERSION,
            capabilities: CAPABILITIES_SCHEMA_VERSION,
            whoami: WHOAMI_SCHEMA_VERSION,
        },
        limits: CapabilitiesLimits {
            id_max_length: MAX_TRACK_ID_LEN,
            batch_max_items: state.config.batch_max_items,
            batch_concurrency: state.config.batch_concurrency.max(1),
            rate_limit_per_minute: state.config.rate_limit_per_minute,
            rate_limit_burst_capacity: state.config.rate_limit_burst_capacity,
            rate_limit_burst_window_secs: state.config.rate_limit_burst_window_secs,
            rate_limit_class_names: rate_limit_class_names(&state),
            http_timeout_secs: state.config.http_timeout_secs,
            upstream_queue_timeout_secs: state.config.upstream_queue_timeout_secs,
        },
        features: CapabilitiesFeatures {
            admin_token_inventory: true,
            admin_managed_tokens: state.managed_token_store.is_some(),
            admin_token_persistent_state: state.token_state_store.is_some(),
            admin_token_runtime_restore: true,
            admin_token_runtime_revoke: true,
            admin_token_runtime_rotate: true,
            admin_token_secret_rotation: state.managed_token_store.is_some(),
            api_changelog: true,
            incident_feed: true,
            bag_detail: true,
            deprecation_headers_enabled: true,
            manifest_detail: true,
            track_detail: true,
            service_status: true,
            async_track_lite_batch_job: false,
            openapi_available: true,
            stale_if_error_enabled: state.config.stale_if_error_ttl_secs > 0,
            persistent_cache_enabled: state.config.persistent_cache_dir.is_some(),
            parser_guard_enabled: true,
            rate_limit_burst_policy: true,
            rate_limit_scope_defaults: !state.config.rate_limit_scope_class_defaults.is_empty(),
            rate_limit_token_classes: !state.config.rate_limit_classes.is_empty(),
            rate_limit_headers: true,
            webhook_signed_delivery: true,
        },
        endpoints: CapabilitiesEndpoints {
            public: vec!["/healthz", "/readyz", "/canaryz"],
            protected: vec![
                "/v1/capabilities",
                "/v1/changelog",
                "/v1/incidents",
                "/v1/status",
                "/v1/whoami",
                "/v1/admin/tokens",
                "/v1/admin/tokens/managed/create",
                "/v1/admin/tokens/revoke",
                "/v1/admin/tokens/restore",
                "/v1/admin/tokens/rotate",
                "/v1/admin/tokens/managed/rotate-secret",
                "/v1/bag/detail",
                "/v1/bag/html",
                "/v1/manifest/html",
                "/v1/manifest/detail",
                "/v1/track/html",
                "/v1/track/detail",
                "/openapi.json",
            ],
        },
    };

    Ok(v1_json_response(
        StatusCode::OK,
        CAPABILITIES_SCHEMA_VERSION,
        &context,
        None,
        false,
        Vec::new(),
        response,
    ))
}

async fn handle_whoami(
    State(_state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    Extension(auth): Extension<AuthContext>,
) -> Result<Response, AppError> {
    Ok(v1_json_response(
        StatusCode::OK,
        WHOAMI_SCHEMA_VERSION,
        &context,
        None,
        false,
        Vec::new(),
        WhoAmIResponse {
            token_id: auth.token_id,
            label: auth.label,
            token_source: auth.source,
            scopes: auth.scopes,
            created_by: auth.created_by,
            created_at_ms: auth.created_at_ms,
            expires_at_ms: auth.expires_at_ms,
            last_used_at_ms: auth.last_used_at_ms,
            allowed_ips: auth.allowed_ips,
            client_ip: auth.client_ip,
            rate_limit_class: auth.rate_limit_class,
            rate_limit_per_minute: auth.rate_limit_per_minute,
            rate_limit_burst_capacity: auth.rate_limit_burst_capacity,
            rate_limit_burst_window_secs: auth.rate_limit_burst_window_secs,
        },
    ))
}

async fn handle_openapi_json() -> impl IntoResponse {
    Json(openapi_spec())
}

fn build_admin_tokens_response(state: &AppState) -> AdminTokensResponse {
    let now_ms = current_time_ms();
    let mut tokens: Vec<AdminTokenSummary> = state
        .allowed_tokens
        .values()
        .map(|record| build_admin_token_summary(record, now_ms, &state.config))
        .collect();
    if let Some(store) = &state.managed_token_store {
        tokens.extend(
            store
                .list_records()
                .into_iter()
                .map(|record| build_admin_token_summary(record.as_ref(), now_ms, &state.config)),
        );
    }

    tokens.sort_by(|left, right| left.token_id.cmp(&right.token_id));

    let summary = AdminTokensSummary {
        total: tokens.len(),
        active: tokens
            .iter()
            .filter(|token| matches!(token.status, AdminTokenStatus::Active))
            .count(),
        expired: tokens
            .iter()
            .filter(|token| matches!(token.status, AdminTokenStatus::Expired))
            .count(),
        revoked: tokens.iter().filter(|token| token.revoked).count(),
        ip_restricted: tokens
            .iter()
            .filter(|token| !token.allowed_ips.is_empty())
            .count(),
        legacy_full_access: tokens
            .iter()
            .filter(|token| token.token_source == TokenSource::LegacyFullAccess)
            .count(),
        explicit: tokens
            .iter()
            .filter(|token| token.token_source == TokenSource::Explicit)
            .count(),
        managed: tokens
            .iter()
            .filter(|token| token.token_source == TokenSource::Managed)
            .count(),
    };

    AdminTokensResponse { summary, tokens }
}

fn admin_token_operation_warnings(persisted: bool) -> Vec<String> {
    if persisted {
        Vec::new()
    } else {
        vec!["runtime_only_change".to_string()]
    }
}

enum AdminTokenRecordHandle<'a> {
    Static(&'a crate::auth::ApiTokenRecord),
    Managed(Arc<crate::auth::ApiTokenRecord>),
}

impl std::ops::Deref for AdminTokenRecordHandle<'_> {
    type Target = crate::auth::ApiTokenRecord;

    fn deref(&self) -> &Self::Target {
        match self {
            Self::Static(record) => record,
            Self::Managed(record) => record.as_ref(),
        }
    }
}

impl AdminTokenRecordHandle<'_> {
    fn is_managed(&self) -> bool {
        matches!(self, Self::Managed(_))
    }
}

fn find_admin_token_record_by_id<'a>(
    state: &'a AppState,
    token_id: &str,
) -> Option<AdminTokenRecordHandle<'a>> {
    if let Some(record) = state
        .allowed_tokens
        .values()
        .find(|record| record.token_id == token_id)
    {
        return Some(AdminTokenRecordHandle::Static(record));
    }

    state
        .managed_token_store
        .as_ref()
        .and_then(|store| store.find_by_id(token_id))
        .map(AdminTokenRecordHandle::Managed)
}

fn require_managed_token_store(
    state: &AppState,
) -> Result<&Arc<crate::managed_tokens::ManagedTokenStore>, AppError> {
    state.managed_token_store.as_ref().ok_or_else(|| {
        AppError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "MANAGED_TOKEN_STORE_DISABLED",
            anyhow::anyhow!(
                "managed token store is not configured; set MANAGED_API_TOKEN_STORE_FILE"
            ),
        )
    })
}

fn persist_admin_token_state(
    state: &AppState,
    path: &'static str,
    record: &AdminTokenRecordHandle<'_>,
) -> Result<bool, AppError> {
    if record.is_managed() {
        return persist_managed_token_store(state, path);
    }

    let Some(store) = &state.token_state_store else {
        return Ok(false);
    };

    if let Err(error) = store.persist_lookup(&state.allowed_tokens) {
        state.metrics.inc_admin_token_state_persist_error();
        if let Some(context) = current_request_context() {
            state.incident_store.record(ServiceIncidentEvent {
                kind: "token_state".to_string(),
                severity: IncidentSeverity::Critical,
                code: "TOKEN_STATE_PERSIST".to_string(),
                message: format!(
                    "failed to persist API token state to {}",
                    store.path().display()
                ),
                request_id: Some(context.request_id),
                path: Some(path.to_string()),
            });
        } else {
            state.incident_store.record(ServiceIncidentEvent {
                kind: "token_state".to_string(),
                severity: IncidentSeverity::Critical,
                code: "TOKEN_STATE_PERSIST".to_string(),
                message: format!(
                    "failed to persist API token state to {}",
                    store.path().display()
                ),
                request_id: None,
                path: Some(path.to_string()),
            });
        }
        return Err(AppError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "TOKEN_STATE_PERSIST",
            error,
        ));
    }

    state.metrics.inc_admin_token_state_persist();

    Ok(true)
}

fn persist_dual_admin_token_state(
    state: &AppState,
    path: &'static str,
    source_record: &AdminTokenRecordHandle<'_>,
    successor_record: &AdminTokenRecordHandle<'_>,
) -> Result<bool, AppError> {
    if source_record.is_managed() || successor_record.is_managed() {
        return persist_managed_token_store(state, path);
    }

    persist_admin_token_state(state, path, source_record)
}

fn persist_managed_token_store(state: &AppState, path: &'static str) -> Result<bool, AppError> {
    let store = require_managed_token_store(state)?;

    if let Err(error) = store.persist_current_state() {
        state.metrics.inc_admin_token_state_persist_error();
        if let Some(context) = current_request_context() {
            state.incident_store.record(ServiceIncidentEvent {
                kind: "token_state".to_string(),
                severity: IncidentSeverity::Critical,
                code: "TOKEN_STATE_PERSIST".to_string(),
                message: format!(
                    "failed to persist managed API token store to {}",
                    store.path().display()
                ),
                request_id: Some(context.request_id),
                path: Some(path.to_string()),
            });
        } else {
            state.incident_store.record(ServiceIncidentEvent {
                kind: "token_state".to_string(),
                severity: IncidentSeverity::Critical,
                code: "TOKEN_STATE_PERSIST".to_string(),
                message: format!(
                    "failed to persist managed API token store to {}",
                    store.path().display()
                ),
                request_id: None,
                path: Some(path.to_string()),
            });
        }
        return Err(AppError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "TOKEN_STATE_PERSIST",
            error,
        ));
    }

    state.metrics.inc_admin_token_state_persist();
    Ok(true)
}

fn normalize_allowed_ips(raw_ips: Option<Vec<String>>) -> Result<BTreeSet<String>, AppError> {
    let mut normalized = BTreeSet::new();
    for raw in raw_ips.unwrap_or_default() {
        let normalized_ip = normalize_allowed_ip_rule(&raw).ok_or_else(|| {
            v1_validation_error(anyhow::anyhow!(format!("invalid allowed_ip value: {raw}")))
        })?;
        normalized.insert(normalized_ip);
    }
    Ok(normalized)
}

fn build_admin_token_metadata(
    state: &AppState,
    auth: &AuthContext,
    payload: &AdminManagedTokenCreateRequest,
    allowed_ips: BTreeSet<String>,
) -> Result<ApiTokenMetadata, AppError> {
    if let Some(class_name) = payload.rate_limit_class.as_deref() {
        if !state.config.rate_limit_classes.contains_key(class_name) {
            return Err(v1_validation_error(anyhow::anyhow!(format!(
                "rate_limit_class references unknown class: {class_name}"
            ))));
        }
    }

    Ok(ApiTokenMetadata {
        created_by: normalize_optional_text(payload.created_by.clone())
            .or_else(|| Some(auth.token_id.clone())),
        created_at_ms: Some(current_time_ms()),
        expires_at_ms: payload.expires_at_ms,
        allowed_ips,
        rate_limit_class: normalize_optional_text(payload.rate_limit_class.clone()),
        rate_limit_per_minute: payload.rate_limit_per_minute,
        rate_limit_burst_capacity: payload.rate_limit_burst_capacity,
        rate_limit_burst_window_secs: payload.rate_limit_burst_window_secs,
    })
}

fn build_admin_token_secret_response(
    issued: ManagedTokenIssuedSecret,
    now_ms: u64,
    config: &crate::config::AppConfig,
    operation: AdminTokenOperation,
) -> AdminTokenSecretResponse {
    AdminTokenSecretResponse {
        token: issued.token,
        token_once: true,
        token_info: build_admin_token_summary(issued.record.as_ref(), now_ms, config),
        operation,
    }
}

fn managed_token_store_error(code: &'static str, error: anyhow::Error) -> AppError {
    AppError::new(StatusCode::SERVICE_UNAVAILABLE, code, error)
}

fn build_admin_token_summary(
    record: &crate::auth::ApiTokenRecord,
    now_ms: u64,
    config: &crate::config::AppConfig,
) -> AdminTokenSummary {
    let is_expired = record.is_expired(now_ms);
    let resolved = record.resolved_rate_limit(
        config.default_rate_limit_policy(),
        &config.rate_limit_classes,
        &config.rate_limit_scope_class_defaults,
    );
    AdminTokenSummary {
        token_id: record.token_id.clone(),
        label: record.label.clone(),
        token_source: record.source,
        status: if is_expired {
            AdminTokenStatus::Expired
        } else {
            AdminTokenStatus::Active
        },
        revoked: record.is_revoked(),
        revoked_at_ms: record.revoked_at_ms(),
        revoked_by_token_id: record.revoked_by_token_id(),
        revoke_reason: record.revoke_reason(),
        successor_token_id: record.successor_token_id(),
        scopes: record.scopes_vec(),
        created_by: record.metadata.created_by.clone(),
        created_at_ms: record.metadata.created_at_ms,
        expires_at_ms: record.metadata.expires_at_ms,
        last_used_at_ms: record.last_used_at_ms(),
        allowed_ips: record.allowed_ips_vec(),
        rate_limit_class: resolved.class_name,
        rate_limit_per_minute: resolved.policy.per_minute,
        rate_limit_burst_capacity: resolved.policy.burst_capacity,
        rate_limit_burst_window_secs: resolved.policy.burst_window_secs,
    }
}

fn rate_limit_class_names(state: &AppState) -> Vec<String> {
    let mut names: Vec<String> = state.config.rate_limit_classes.keys().cloned().collect();
    names.sort();
    names.insert(0, "default".to_string());
    names
}

async fn build_track_detail_result(
    state: &AppState,
    id: &str,
) -> Result<TrackDetailBuildResult, AppError> {
    let fetched = fetch_track_html_with_meta(state, id).await?;
    let fetch_meta = fetched.meta;
    let url = fetched.url.clone();
    let body = fetched.body.clone();

    let response =
        tokio::task::spawn_blocking(move || crate::parse::track::scrape_track(&body, &url))
            .await
            .map_err(|err| AppError::internal(format!("spawn_blocking failed: {err}")))?;

    response.log_sanity();
    let drift_events = state.drift_guard.analyze_track(id, &response);
    if drift_events > 0 {
        state.metrics.inc_parser_drift(drift_events as u64);
    }

    let mut warnings = Vec::new();
    if drift_events > 0 {
        warnings.push("parser_drift_detected".to_string());
    }

    Ok(TrackDetailBuildResult {
        detail: TrackDetailResponse {
            id: response
                .detail
                .header
                .nomor_kiriman
                .clone()
                .unwrap_or_else(|| id.to_string()),
            authoritative_entity: "shipment",
            record: response,
        },
        fetch_meta,
        warnings,
        partial: drift_events > 0,
    })
}

async fn build_bag_detail_result(
    state: &AppState,
    id: &str,
) -> Result<BagDetailBuildResult, AppError> {
    let fetched = fetch_bag_html_with_meta(state, id).await?;
    let fetch_meta = fetched.meta;
    let url = fetched.url.clone();
    let body = fetched.body.clone();

    let response =
        tokio::task::spawn_blocking(move || crate::parse::bag::scrape_track_bag(&body, &url))
            .await
            .map_err(|err| AppError::internal(format!("spawn_blocking failed: {err}")))?;

    response.log_sanity();
    let drift_events = state.drift_guard.analyze_bag(id, &response);
    if drift_events > 0 {
        state.metrics.inc_parser_drift(drift_events as u64);
    }

    let mut warnings = Vec::new();
    if drift_events > 0 {
        warnings.push("parser_drift_detected".to_string());
    }

    Ok(BagDetailBuildResult {
        detail: BagDetailResponse {
            id: response
                .nomor_kantung
                .clone()
                .unwrap_or_else(|| id.to_string()),
            authoritative_entity: "bag",
            record: response,
        },
        fetch_meta,
        warnings,
        partial: drift_events > 0,
    })
}

async fn build_manifest_detail_result(
    state: &AppState,
    id: &str,
) -> Result<ManifestDetailBuildResult, AppError> {
    let fetched = fetch_manifest_html_with_meta(state, id).await?;
    let fetch_meta = fetched.meta;
    let url = fetched.url.clone();
    let body = fetched.body.clone();

    let response = tokio::task::spawn_blocking(move || {
        crate::parse::manifest::scrape_track_manifest(&body, &url)
    })
    .await
    .map_err(|err| AppError::internal(format!("spawn_blocking failed: {err}")))?;

    response.log_sanity();
    let drift_events = state.drift_guard.analyze_manifest(id, &response);
    if drift_events > 0 {
        state.metrics.inc_parser_drift(drift_events as u64);
    }

    let mut warnings = Vec::new();
    if drift_events > 0 {
        warnings.push("parser_drift_detected".to_string());
    }

    Ok(ManifestDetailBuildResult {
        detail: ManifestDetailResponse {
            id: id.to_string(),
            authoritative_entity: "manifest",
            record: response,
        },
        fetch_meta,
        warnings,
        partial: drift_events > 0,
    })
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn validate_v1<T: Validate>(value: &T) -> Result<(), AppError> {
    value.validate().map_err(v1_validation_error)
}

fn v1_validation_error(error: impl Into<anyhow::Error>) -> AppError {
    AppError::new(StatusCode::UNPROCESSABLE_ENTITY, "VALIDATION_ERROR", error)
}

fn into_v1_error(error: AppError) -> AppError {
    let AppError {
        status,
        code,
        error,
    } = error;

    let remapped_status = match code {
        "VALIDATION_ERROR" => StatusCode::UNPROCESSABLE_ENTITY,
        _ => status,
    };

    AppError {
        status: remapped_status,
        code,
        error,
    }
}

fn openapi_spec() -> Value {
    json!({
        "openapi": "3.1.0",
        "info": {
            "title": "scrap-pid-v3 API",
            "version": "v1",
            "description": "Stable consumer contract for versioned shipment, bag, and manifest detail plus upstream HTML passthrough endpoints."
        },
        "servers": [
            { "url": "http://localhost:3000", "description": "Local development" }
        ],
        "security": [{ "ApiToken": [] }],
        "paths": {
            "/openapi.json": {
                "get": {
                    "summary": "OpenAPI document",
                    "description": "Protected OpenAPI spec for the stable /v1 contract.",
                    "responses": {
                        "200": {
                            "description": "OpenAPI JSON document",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object"
                                    }
                                }
                            }
                        },
                        "401": { "$ref": "#/components/responses/ErrorResponse" },
                        "403": { "$ref": "#/components/responses/ErrorResponse" }
                    }
                }
            },
            "/v1/capabilities": {
                "get": {
                    "summary": "Capabilities contract",
                    "responses": {
                        "200": {
                            "description": "Capabilities and limits",
                            "content": {
                                "application/json": {
                                    "schema": { "$ref": "#/components/schemas/CapabilitiesEnvelope" }
                                }
                            }
                        },
                        "401": { "$ref": "#/components/responses/ErrorResponse" },
                        "403": { "$ref": "#/components/responses/ErrorResponse" },
                        "429": { "$ref": "#/components/responses/ErrorResponse" }
                    }
                }
            },
            "/v1/changelog": {
                "get": {
                    "summary": "API changelog and deprecation policy",
                    "description": "Stable changelog feed for /v1 plus migration mapping for deprecated legacy endpoints.",
                    "responses": {
                        "200": {
                            "description": "Current changelog and deprecation mapping",
                            "content": {
                                "application/json": {
                                    "schema": { "$ref": "#/components/schemas/ChangelogEnvelope" }
                                }
                            }
                        },
                        "401": { "$ref": "#/components/responses/ErrorResponse" },
                        "403": { "$ref": "#/components/responses/ErrorResponse" },
                        "429": { "$ref": "#/components/responses/ErrorResponse" }
                    }
                }
            },
            "/v1/incidents": {
                "get": {
                    "summary": "Recent service incidents",
                    "description": "Recent high-signal service incidents such as upstream degraded state or admin token state persistence failures.",
                    "responses": {
                        "200": {
                            "description": "Recent service incidents",
                            "content": {
                                "application/json": {
                                    "schema": { "$ref": "#/components/schemas/IncidentsEnvelope" }
                                }
                            }
                        },
                        "401": { "$ref": "#/components/responses/ErrorResponse" },
                        "403": { "$ref": "#/components/responses/ErrorResponse" },
                        "429": { "$ref": "#/components/responses/ErrorResponse" }
                    }
                }
            },
            "/v1/status": {
                "get": {
                    "summary": "Service status",
                    "description": "Consumer-friendly service status including upstream canary state and legacy API deprecation policy.",
                    "responses": {
                        "200": {
                            "description": "Current service status",
                            "content": {
                                "application/json": {
                                    "schema": { "$ref": "#/components/schemas/ServiceStatusEnvelope" }
                                }
                            }
                        },
                        "401": { "$ref": "#/components/responses/ErrorResponse" },
                        "403": { "$ref": "#/components/responses/ErrorResponse" },
                        "429": { "$ref": "#/components/responses/ErrorResponse" }
                    }
                }
            },
            "/v1/whoami": {
                "get": {
                    "summary": "Current API token identity",
                    "responses": {
                        "200": {
                            "description": "Current API token metadata and scopes",
                            "content": {
                                "application/json": {
                                    "schema": { "$ref": "#/components/schemas/WhoAmIEnvelope" }
                                }
                            }
                        },
                        "401": { "$ref": "#/components/responses/ErrorResponse" },
                        "403": { "$ref": "#/components/responses/ErrorResponse" },
                        "429": { "$ref": "#/components/responses/ErrorResponse" }
                    }
                }
            },
            "/v1/admin/tokens": {
                "get": {
                    "summary": "Configured API token inventory",
                    "description": "Read-only admin inventory of configured API tokens without exposing raw token secrets.",
                    "responses": {
                        "200": {
                            "description": "Configured token inventory",
                            "content": {
                                "application/json": {
                                    "schema": { "$ref": "#/components/schemas/AdminTokensEnvelope" }
                                }
                            }
                        },
                        "401": { "$ref": "#/components/responses/ErrorResponse" },
                        "403": { "$ref": "#/components/responses/ErrorResponse" },
                        "429": { "$ref": "#/components/responses/ErrorResponse" }
                    }
                }
            },
            "/v1/admin/tokens/managed/create": {
                "post": {
                    "summary": "Create managed API token secret",
                    "description": "Create a persisted managed token in the local token store and return the issued secret exactly once.",
                    "requestBody": {
                        "required": true,
                        "content": {
                            "application/json": {
                                "schema": { "$ref": "#/components/schemas/AdminManagedTokenCreateRequest" }
                            }
                        }
                    },
                    "responses": {
                        "201": {
                            "description": "Managed token created",
                            "content": {
                                "application/json": {
                                    "schema": { "$ref": "#/components/schemas/AdminTokenSecretEnvelope" }
                                }
                            }
                        },
                        "401": { "$ref": "#/components/responses/ErrorResponse" },
                        "403": { "$ref": "#/components/responses/ErrorResponse" },
                        "422": { "$ref": "#/components/responses/ErrorResponse" },
                        "503": { "$ref": "#/components/responses/ErrorResponse" }
                    }
                }
            },
            "/v1/admin/tokens/revoke": {
                "post": {
                    "summary": "Runtime revoke configured API token",
                    "description": "Immediately revoke a configured token. Revocation is persisted to the optional token state file when configured, but does not rotate the underlying secret automatically.",
                    "requestBody": {
                        "required": true,
                        "content": {
                            "application/json": {
                                "schema": { "$ref": "#/components/schemas/AdminTokenRevokeRequest" }
                            }
                        }
                    },
                    "responses": {
                        "200": {
                            "description": "Runtime revocation applied",
                            "content": {
                                "application/json": {
                                    "schema": { "$ref": "#/components/schemas/AdminTokenMutationEnvelope" }
                                }
                            }
                        },
                        "401": { "$ref": "#/components/responses/ErrorResponse" },
                        "403": { "$ref": "#/components/responses/ErrorResponse" },
                        "404": { "$ref": "#/components/responses/ErrorResponse" },
                        "422": { "$ref": "#/components/responses/ErrorResponse" }
                    }
                }
            },
            "/v1/admin/tokens/restore": {
                "post": {
                    "summary": "Runtime restore revoked API token",
                    "description": "Clear revocation state for a configured token. Restore is persisted to the optional token state file when configured, but does not change environment configuration automatically.",
                    "requestBody": {
                        "required": true,
                        "content": {
                            "application/json": {
                                "schema": { "$ref": "#/components/schemas/AdminTokenRestoreRequest" }
                            }
                        }
                    },
                    "responses": {
                        "200": {
                            "description": "Runtime revocation state cleared",
                            "content": {
                                "application/json": {
                                    "schema": { "$ref": "#/components/schemas/AdminTokenMutationEnvelope" }
                                }
                            }
                        },
                        "401": { "$ref": "#/components/responses/ErrorResponse" },
                        "403": { "$ref": "#/components/responses/ErrorResponse" },
                        "404": { "$ref": "#/components/responses/ErrorResponse" },
                        "422": { "$ref": "#/components/responses/ErrorResponse" }
                    }
                }
            },
            "/v1/admin/tokens/rotate": {
                "post": {
                    "summary": "Runtime rotate configured API token",
                    "description": "Coordinate a runtime cutover by revoking one configured token and ensuring the successor token is active in a single persisted operation. This does not mint or replace the underlying token secret automatically.",
                    "requestBody": {
                        "required": true,
                        "content": {
                            "application/json": {
                                "schema": { "$ref": "#/components/schemas/AdminTokenRotateRequest" }
                            }
                        }
                    },
                    "responses": {
                        "200": {
                            "description": "Runtime rotation applied",
                            "content": {
                                "application/json": {
                                    "schema": { "$ref": "#/components/schemas/AdminTokenRotationEnvelope" }
                                }
                            }
                        },
                        "401": { "$ref": "#/components/responses/ErrorResponse" },
                        "403": { "$ref": "#/components/responses/ErrorResponse" },
                        "404": { "$ref": "#/components/responses/ErrorResponse" },
                        "422": { "$ref": "#/components/responses/ErrorResponse" }
                    }
                }
            },
            "/v1/admin/tokens/managed/rotate-secret": {
                "post": {
                    "summary": "Rotate managed API token secret",
                    "description": "Generate a replacement secret for a persisted managed token and invalidate the previous secret immediately.",
                    "requestBody": {
                        "required": true,
                        "content": {
                            "application/json": {
                                "schema": { "$ref": "#/components/schemas/AdminManagedTokenRotateSecretRequest" }
                            }
                        }
                    },
                    "responses": {
                        "200": {
                            "description": "Managed token secret rotated",
                            "content": {
                                "application/json": {
                                    "schema": { "$ref": "#/components/schemas/AdminTokenSecretEnvelope" }
                                }
                            }
                        },
                        "401": { "$ref": "#/components/responses/ErrorResponse" },
                        "403": { "$ref": "#/components/responses/ErrorResponse" },
                        "404": { "$ref": "#/components/responses/ErrorResponse" },
                        "422": { "$ref": "#/components/responses/ErrorResponse" },
                        "503": { "$ref": "#/components/responses/ErrorResponse" }
                    }
                }
            },
            "/v1/bag/html": {
                "get": {
                    "summary": "Bag upstream HTML",
                    "description": "Versioned HTML passthrough of the upstream bag page for debug and raw inspection use cases.",
                    "parameters": [
                        {
                            "name": "id",
                            "in": "query",
                            "required": true,
                            "schema": { "type": "string", "minLength": 1, "maxLength": 50 }
                        }
                    ],
                    "responses": {
                        "200": {
                            "description": "Raw upstream bag HTML",
                            "content": {
                                "text/html": {
                                    "schema": { "type": "string" }
                                }
                            }
                        },
                        "422": { "$ref": "#/components/responses/ErrorResponse" },
                        "401": { "$ref": "#/components/responses/ErrorResponse" },
                        "403": { "$ref": "#/components/responses/ErrorResponse" },
                        "429": { "$ref": "#/components/responses/ErrorResponse" },
                        "502": { "$ref": "#/components/responses/ErrorResponse" },
                        "503": { "$ref": "#/components/responses/ErrorResponse" },
                        "504": { "$ref": "#/components/responses/ErrorResponse" }
                    }
                }
            },
            "/v1/bag/detail": {
                "get": {
                    "summary": "Bag detail",
                    "description": "Versioned full-detail bag record using the stable /v1 envelope.",
                    "parameters": [
                        {
                            "name": "id",
                            "in": "query",
                            "required": true,
                            "schema": { "type": "string", "minLength": 1, "maxLength": 50 }
                        }
                    ],
                    "responses": {
                        "200": {
                            "description": "Bag detail response",
                            "content": {
                                "application/json": {
                                    "schema": { "$ref": "#/components/schemas/BagDetailEnvelope" }
                                }
                            }
                        },
                        "422": { "$ref": "#/components/responses/ErrorResponse" },
                        "401": { "$ref": "#/components/responses/ErrorResponse" },
                        "403": { "$ref": "#/components/responses/ErrorResponse" },
                        "429": { "$ref": "#/components/responses/ErrorResponse" },
                        "502": { "$ref": "#/components/responses/ErrorResponse" },
                        "503": { "$ref": "#/components/responses/ErrorResponse" },
                        "504": { "$ref": "#/components/responses/ErrorResponse" }
                    }
                }
            },
            "/v1/manifest/html": {
                "get": {
                    "summary": "Manifest upstream HTML",
                    "description": "Versioned HTML passthrough of the upstream manifest page for debug and raw inspection use cases.",
                    "parameters": [
                        {
                            "name": "id",
                            "in": "query",
                            "required": true,
                            "schema": { "type": "string", "minLength": 1, "maxLength": 50 }
                        }
                    ],
                    "responses": {
                        "200": {
                            "description": "Raw upstream manifest HTML",
                            "content": {
                                "text/html": {
                                    "schema": { "type": "string" }
                                }
                            }
                        },
                        "422": { "$ref": "#/components/responses/ErrorResponse" },
                        "401": { "$ref": "#/components/responses/ErrorResponse" },
                        "403": { "$ref": "#/components/responses/ErrorResponse" },
                        "429": { "$ref": "#/components/responses/ErrorResponse" },
                        "502": { "$ref": "#/components/responses/ErrorResponse" },
                        "503": { "$ref": "#/components/responses/ErrorResponse" },
                        "504": { "$ref": "#/components/responses/ErrorResponse" }
                    }
                }
            },
            "/v1/manifest/detail": {
                "get": {
                    "summary": "Manifest detail",
                    "description": "Versioned full-detail manifest record using the stable /v1 envelope.",
                    "parameters": [
                        {
                            "name": "id",
                            "in": "query",
                            "required": true,
                            "schema": { "type": "string", "minLength": 1, "maxLength": 50 }
                        }
                    ],
                    "responses": {
                        "200": {
                            "description": "Manifest detail response",
                            "content": {
                                "application/json": {
                                    "schema": { "$ref": "#/components/schemas/ManifestDetailEnvelope" }
                                }
                            }
                        },
                        "422": { "$ref": "#/components/responses/ErrorResponse" },
                        "401": { "$ref": "#/components/responses/ErrorResponse" },
                        "403": { "$ref": "#/components/responses/ErrorResponse" },
                        "429": { "$ref": "#/components/responses/ErrorResponse" },
                        "502": { "$ref": "#/components/responses/ErrorResponse" },
                        "503": { "$ref": "#/components/responses/ErrorResponse" },
                        "504": { "$ref": "#/components/responses/ErrorResponse" }
                    }
                }
            },
            "/v1/track/html": {
                "get": {
                    "summary": "Shipment upstream HTML",
                    "description": "Versioned HTML passthrough of the upstream shipment page for debug and raw inspection use cases.",
                    "parameters": [
                        {
                            "name": "id",
                            "in": "query",
                            "required": true,
                            "schema": { "type": "string", "minLength": 1, "maxLength": 50 }
                        }
                    ],
                    "responses": {
                        "200": {
                            "description": "Raw upstream shipment HTML",
                            "content": {
                                "text/html": {
                                    "schema": { "type": "string" }
                                }
                            }
                        },
                        "422": { "$ref": "#/components/responses/ErrorResponse" },
                        "401": { "$ref": "#/components/responses/ErrorResponse" },
                        "403": { "$ref": "#/components/responses/ErrorResponse" },
                        "429": { "$ref": "#/components/responses/ErrorResponse" },
                        "502": { "$ref": "#/components/responses/ErrorResponse" },
                        "503": { "$ref": "#/components/responses/ErrorResponse" },
                        "504": { "$ref": "#/components/responses/ErrorResponse" }
                    }
                }
            },
            "/v1/track/detail": {
                "get": {
                    "summary": "Shipment detail",
                    "description": "Versioned full-detail shipment record using the stable /v1 envelope.",
                    "parameters": [
                        {
                            "name": "id",
                            "in": "query",
                            "required": true,
                            "schema": { "type": "string", "minLength": 1, "maxLength": 50 }
                        }
                    ],
                    "responses": {
                        "200": {
                            "description": "Track detail response",
                            "content": {
                                "application/json": {
                                    "schema": { "$ref": "#/components/schemas/TrackDetailEnvelope" }
                                }
                            }
                        },
                        "422": { "$ref": "#/components/responses/ErrorResponse" },
                        "401": { "$ref": "#/components/responses/ErrorResponse" },
                        "403": { "$ref": "#/components/responses/ErrorResponse" },
                        "429": { "$ref": "#/components/responses/ErrorResponse" },
                        "502": { "$ref": "#/components/responses/ErrorResponse" },
                        "503": { "$ref": "#/components/responses/ErrorResponse" },
                        "504": { "$ref": "#/components/responses/ErrorResponse" }
                    }
                }
            }
        },
        "components": {
            "securitySchemes": {
                "ApiToken": {
                    "type": "apiKey",
                    "in": "header",
                    "name": "X-Api-Token"
                }
            },
            "responses": {
                "ErrorResponse": {
                    "description": "Standard error response",
                    "content": {
                        "application/json": {
                            "schema": { "$ref": "#/components/schemas/ErrorEnvelope" }
                        }
                    }
                }
            },
            "schemas": {
                "ResponseMeta": {
                    "type": "object",
                    "properties": {
                        "request_id": { "type": "string" },
                        "api_version": { "type": "string" },
                        "schema_version": { "type": "string" },
                        "generated_at_ms": { "type": "integer" },
                        "source": { "type": "string" },
                        "cached": { "type": "boolean" },
                        "cache_status": { "type": ["string", "null"] },
                        "cache_age_ms": { "type": ["integer", "null"] },
                        "source_latency_ms": { "type": ["integer", "null"] },
                        "latency_ms": { "type": "integer" },
                        "partial": { "type": "boolean" },
                        "degraded": { "type": "boolean" },
                        "warnings": {
                            "type": "array",
                            "items": { "type": "string" }
                        }
                    },
                    "required": ["request_id", "api_version", "schema_version", "generated_at_ms", "source", "cached", "latency_ms", "partial", "degraded", "warnings"]
                },
                "ErrorEnvelope": {
                    "type": "object",
                    "properties": {
                        "error": {
                            "type": "object",
                            "properties": {
                                "code": { "type": "string" },
                                "message": { "type": "string" },
                                "retryable": { "type": "boolean" },
                                "request_id": { "type": ["string", "null"] }
                            },
                            "required": ["code", "message", "retryable"]
                        }
                    },
                    "required": ["error"]
                },
                "TrackSummaryBulkRequest": {
                    "type": "object",
                    "properties": {
                        "ids": {
                            "type": "array",
                            "items": { "type": "string", "minLength": 1, "maxLength": 50 }
                        }
                    },
                    "required": ["ids"]
                },
                "TrackSummaryBulkJobCreateRequest": {
                    "type": "object",
                    "properties": {
                        "ids": {
                            "type": "array",
                            "items": { "type": "string", "minLength": 1, "maxLength": 50 }
                        },
                        "webhook_url": { "type": ["string", "null"], "format": "uri" }
                    },
                    "required": ["ids"]
                },
                "TrackSummaryData": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string" },
                        "authoritative_entity": { "type": "string" },
                        "record": {
                            "type": "object",
                            "additionalProperties": true
                        }
                    },
                    "required": ["id", "authoritative_entity", "record"]
                },
                "TrackDetailData": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string" },
                        "authoritative_entity": { "type": "string" },
                        "record": {
                            "type": "object",
                            "additionalProperties": true
                        }
                    },
                    "required": ["id", "authoritative_entity", "record"]
                },
                "BagSummaryData": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string" },
                        "authoritative_entity": { "type": "string" },
                        "bag_number": { "type": ["string", "null"] },
                        "total_items": { "type": "integer" },
                        "latest": { "$ref": "#/components/schemas/BagSummaryLatest" },
                        "status_breakdown": {
                            "type": "object",
                            "additionalProperties": { "type": "integer" }
                        },
                        "sample_items": {
                            "type": "array",
                            "items": { "$ref": "#/components/schemas/BagSummaryItem" }
                        }
                    },
                    "required": ["id", "authoritative_entity", "bag_number", "total_items", "latest", "status_breakdown", "sample_items"]
                },
                "BagDetailData": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string" },
                        "authoritative_entity": { "type": "string" },
                        "record": {
                            "type": "object",
                            "additionalProperties": true
                        }
                    },
                    "required": ["id", "authoritative_entity", "record"]
                },
                "BagSummaryLatest": {
                    "type": "object",
                    "properties": {
                        "status": { "type": ["string", "null"] },
                        "posisi_akhir": { "type": ["string", "null"] },
                        "tanggal_update_raw": { "type": ["string", "null"] },
                        "tanggal_update_iso": { "type": ["string", "null"] },
                        "petugas_update": { "type": ["string", "null"] }
                    },
                    "required": ["status", "posisi_akhir", "tanggal_update_raw", "tanggal_update_iso", "petugas_update"]
                },
                "BagSummaryItem": {
                    "type": "object",
                    "properties": {
                        "no_resi": { "type": ["string", "null"] },
                        "status": { "type": ["string", "null"] },
                        "posisi_akhir": { "type": ["string", "null"] },
                        "tanggal_update_raw": { "type": ["string", "null"] },
                        "tanggal_update_iso": { "type": ["string", "null"] }
                    },
                    "required": ["no_resi", "status", "posisi_akhir", "tanggal_update_raw", "tanggal_update_iso"]
                },
                "BagSummaryEnvelope": {
                    "type": "object",
                    "properties": {
                        "meta": { "$ref": "#/components/schemas/ResponseMeta" },
                        "data": { "$ref": "#/components/schemas/BagSummaryData" }
                    },
                    "required": ["meta", "data"]
                },
                "BagDetailEnvelope": {
                    "type": "object",
                    "properties": {
                        "meta": { "$ref": "#/components/schemas/ResponseMeta" },
                        "data": { "$ref": "#/components/schemas/BagDetailData" }
                    },
                    "required": ["meta", "data"]
                },
                "ManifestSummaryData": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string" },
                        "authoritative_entity": { "type": "string" },
                        "total_items": { "type": "integer" },
                        "total_berat_raw": { "type": ["string", "null"] },
                        "latest": { "$ref": "#/components/schemas/ManifestSummaryLatest" },
                        "status_breakdown": {
                            "type": "object",
                            "additionalProperties": { "type": "integer" }
                        },
                        "service_breakdown": {
                            "type": "object",
                            "additionalProperties": { "type": "integer" }
                        },
                        "sample_bags": {
                            "type": "array",
                            "items": { "$ref": "#/components/schemas/ManifestSummaryBag" }
                        }
                    },
                    "required": ["id", "authoritative_entity", "total_items", "total_berat_raw", "latest", "status_breakdown", "service_breakdown", "sample_bags"]
                },
                "ManifestDetailData": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string" },
                        "authoritative_entity": { "type": "string" },
                        "record": {
                            "type": "object",
                            "additionalProperties": true
                        }
                    },
                    "required": ["id", "authoritative_entity", "record"]
                },
                "ManifestSummaryLatest": {
                    "type": "object",
                    "properties": {
                        "nomor_kantung": { "type": ["string", "null"] },
                        "status": { "type": ["string", "null"] },
                        "lokasi_akhir": { "type": ["string", "null"] },
                        "tanggal_raw": { "type": ["string", "null"] },
                        "tanggal_iso": { "type": ["string", "null"] }
                    },
                    "required": ["nomor_kantung", "status", "lokasi_akhir", "tanggal_raw", "tanggal_iso"]
                },
                "ManifestSummaryBag": {
                    "type": "object",
                    "properties": {
                        "nomor_kantung": { "type": ["string", "null"] },
                        "jenis_layanan": { "type": ["string", "null"] },
                        "status": { "type": ["string", "null"] },
                        "lokasi_akhir": { "type": ["string", "null"] },
                        "tanggal_raw": { "type": ["string", "null"] },
                        "tanggal_iso": { "type": ["string", "null"] }
                    },
                    "required": ["nomor_kantung", "jenis_layanan", "status", "lokasi_akhir", "tanggal_raw", "tanggal_iso"]
                },
                "ManifestSummaryEnvelope": {
                    "type": "object",
                    "properties": {
                        "meta": { "$ref": "#/components/schemas/ResponseMeta" },
                        "data": { "$ref": "#/components/schemas/ManifestSummaryData" }
                    },
                    "required": ["meta", "data"]
                },
                "ManifestDetailEnvelope": {
                    "type": "object",
                    "properties": {
                        "meta": { "$ref": "#/components/schemas/ResponseMeta" },
                        "data": { "$ref": "#/components/schemas/ManifestDetailData" }
                    },
                    "required": ["meta", "data"]
                },
                "TrackSummaryLatest": {
                    "type": "object",
                    "properties": {
                        "status": { "type": ["string", "null"] },
                        "location": { "type": ["string", "null"] },
                        "datetime_raw": { "type": ["string", "null"] },
                        "datetime_iso": { "type": ["string", "null"] },
                        "officer_name": { "type": ["string", "null"] },
                        "officer_id": { "type": ["string", "null"] }
                    },
                    "required": ["status", "location", "datetime_raw", "datetime_iso", "officer_name", "officer_id"]
                },
                "TrackSummarySla": {
                    "type": "object",
                    "properties": {
                        "target": { "type": ["string", "null"] },
                        "category": { "type": ["string", "null"] },
                        "days_diff": { "type": ["integer", "null"] }
                    },
                    "required": ["target", "category", "days_diff"]
                },
                "TrackSummaryFlags": {
                    "type": "object",
                    "properties": {
                        "is_cod": { "type": "boolean" },
                        "has_pod": { "type": "boolean" },
                        "has_delivery_runsheet": { "type": "boolean" },
                        "has_irregularity": { "type": "boolean" },
                        "is_cod_retur": { "type": "boolean" }
                    },
                    "required": ["is_cod", "has_pod", "has_delivery_runsheet", "has_irregularity", "is_cod_retur"]
                },
                "TrackSummaryCod": {
                    "type": "object",
                    "properties": {
                        "virtual_account": { "type": ["string", "null"] },
                        "total": { "type": "number" },
                        "status": { "type": ["string", "null"] },
                        "tanggal_raw": { "type": ["string", "null"] },
                        "tanggal_iso": { "type": ["string", "null"] }
                    },
                    "required": ["virtual_account", "total", "status", "tanggal_raw", "tanggal_iso"]
                },
                "TrackSummaryHistoryEntry": {
                    "type": "object",
                    "properties": {
                        "datetime_raw": { "type": "string" },
                        "datetime_iso": { "type": ["string", "null"] },
                        "text": { "type": "string" }
                    },
                    "required": ["datetime_raw", "datetime_iso", "text"]
                },
                "TrackSummaryEnvelope": {
                    "type": "object",
                    "properties": {
                        "meta": { "$ref": "#/components/schemas/ResponseMeta" },
                        "data": { "$ref": "#/components/schemas/TrackSummaryData" }
                    },
                    "required": ["meta", "data"]
                },
                "TrackDetailEnvelope": {
                    "type": "object",
                    "properties": {
                        "meta": { "$ref": "#/components/schemas/ResponseMeta" },
                        "data": { "$ref": "#/components/schemas/TrackDetailData" }
                    },
                    "required": ["meta", "data"]
                },
                "TrackSummaryBulkError": {
                    "type": "object",
                    "properties": {
                        "code": { "type": "string" },
                        "message": { "type": "string" },
                        "retryable": { "type": "boolean" }
                    },
                    "required": ["code", "message", "retryable"]
                },
                "TrackSummaryBulkData": {
                    "type": "object",
                    "properties": {
                        "requested": { "type": "integer" },
                        "succeeded": { "type": "integer" },
                        "failed": { "type": "integer" },
                        "records": {
                            "type": "object",
                            "additionalProperties": { "$ref": "#/components/schemas/TrackSummaryData" }
                        },
                        "errors_by_id": {
                            "type": "object",
                            "additionalProperties": { "$ref": "#/components/schemas/TrackSummaryBulkError" }
                        }
                    },
                    "required": ["requested", "succeeded", "failed", "records", "errors_by_id"]
                },
                "TrackSummaryBulkEnvelope": {
                    "type": "object",
                    "properties": {
                        "meta": { "$ref": "#/components/schemas/ResponseMeta" },
                        "data": { "$ref": "#/components/schemas/TrackSummaryBulkData" }
                    },
                    "required": ["meta", "data"]
                },
                "JobSummary": {
                    "type": "object",
                    "properties": {
                        "job_id": { "type": "string" },
                        "status": { "type": "string", "enum": ["queued", "running", "completed", "failed"] },
                        "total": { "type": "integer" },
                        "success": { "type": "integer" },
                        "failed": { "type": "integer" },
                        "error": { "type": ["string", "null"] },
                        "created_at_ms": { "type": "integer" },
                        "updated_at_ms": { "type": "integer" },
                        "completed_at_ms": { "type": ["integer", "null"] }
                    },
                    "required": ["job_id", "status", "total", "success", "failed", "created_at_ms", "updated_at_ms"]
                },
                "TrackSummaryBulkJobData": {
                    "type": "object",
                    "properties": {
                        "summary": { "$ref": "#/components/schemas/JobSummary" },
                        "status_url": { "type": "string" },
                        "result_url": { "type": "string" }
                    },
                    "required": ["summary", "status_url", "result_url"]
                },
                "TrackSummaryBulkJobEnvelope": {
                    "type": "object",
                    "properties": {
                        "meta": { "$ref": "#/components/schemas/ResponseMeta" },
                        "data": { "$ref": "#/components/schemas/TrackSummaryBulkJobData" }
                    },
                    "required": ["meta", "data"]
                },
                "TrackSummaryBulkJobResultData": {
                    "type": "object",
                    "properties": {
                        "summary": { "$ref": "#/components/schemas/JobSummary" },
                        "result": {
                            "oneOf": [
                                { "type": "null" },
                                { "$ref": "#/components/schemas/TrackSummaryBulkData" }
                            ]
                        },
                        "status_url": { "type": "string" },
                        "result_url": { "type": "string" }
                    },
                    "required": ["summary", "status_url", "result_url"]
                },
                "TrackSummaryBulkJobResultEnvelope": {
                    "type": "object",
                    "properties": {
                        "meta": { "$ref": "#/components/schemas/ResponseMeta" },
                        "data": { "$ref": "#/components/schemas/TrackSummaryBulkJobResultData" }
                    },
                    "required": ["meta", "data"]
                },
                "WhoAmIData": {
                    "type": "object",
                    "properties": {
                        "token_id": { "type": "string" },
                        "label": { "type": ["string", "null"] },
                        "token_source": {
                            "type": "string",
                            "enum": ["legacy_full_access", "explicit", "managed"]
                        },
                        "scopes": {
                            "type": "array",
                            "items": { "type": "string" }
                        },
                        "created_by": { "type": ["string", "null"] },
                        "created_at_ms": { "type": ["integer", "null"] },
                        "expires_at_ms": { "type": ["integer", "null"] },
                        "last_used_at_ms": { "type": ["integer", "null"] },
                        "allowed_ips": {
                            "type": "array",
                            "items": { "type": "string" }
                        },
                        "client_ip": { "type": ["string", "null"], "format": "ip" },
                        "rate_limit_class": { "type": "string" },
                        "rate_limit_per_minute": { "type": "integer" },
                        "rate_limit_burst_capacity": { "type": "integer" },
                        "rate_limit_burst_window_secs": { "type": "integer" }
                    },
                    "required": [
                        "token_id",
                        "token_source",
                        "scopes",
                        "allowed_ips",
                        "rate_limit_class",
                        "rate_limit_per_minute",
                        "rate_limit_burst_capacity",
                        "rate_limit_burst_window_secs"
                    ]
                },
                "AdminTokenRevokeRequest": {
                    "type": "object",
                    "properties": {
                        "token_id": { "type": "string", "minLength": 1, "maxLength": 100 },
                        "reason": { "type": ["string", "null"], "maxLength": 500 },
                        "successor_token_id": { "type": ["string", "null"], "maxLength": 100 }
                    },
                    "required": ["token_id"]
                },
                "AdminTokenRestoreRequest": {
                    "type": "object",
                    "properties": {
                        "token_id": { "type": "string", "minLength": 1, "maxLength": 100 }
                    },
                    "required": ["token_id"]
                },
                "AdminTokenRotateRequest": {
                    "type": "object",
                    "properties": {
                        "from_token_id": { "type": "string", "minLength": 1, "maxLength": 100 },
                        "to_token_id": { "type": "string", "minLength": 1, "maxLength": 100 },
                        "reason": { "type": ["string", "null"], "maxLength": 500 }
                    },
                    "required": ["from_token_id", "to_token_id"]
                },
                "AdminManagedTokenCreateRequest": {
                    "type": "object",
                    "properties": {
                        "token_id": { "type": "string", "minLength": 1, "maxLength": 100 },
                        "label": { "type": ["string", "null"], "maxLength": 120 },
                        "scopes": {
                            "type": "array",
                            "items": { "type": "string" },
                            "minItems": 1,
                            "maxItems": 50
                        },
                        "created_by": { "type": ["string", "null"], "maxLength": 120 },
                        "expires_at_ms": { "type": ["integer", "null"] },
                        "allowed_ips": {
                            "type": ["array", "null"],
                            "items": { "type": "string" }
                        },
                        "rate_limit_class": { "type": ["string", "null"], "maxLength": 64 },
                        "rate_limit_per_minute": { "type": ["integer", "null"] },
                        "rate_limit_burst_capacity": { "type": ["integer", "null"] },
                        "rate_limit_burst_window_secs": { "type": ["integer", "null"] }
                    },
                    "required": ["token_id", "scopes"]
                },
                "AdminManagedTokenRotateSecretRequest": {
                    "type": "object",
                    "properties": {
                        "token_id": { "type": "string", "minLength": 1, "maxLength": 100 }
                    },
                    "required": ["token_id"]
                },
                "AdminTokensSummary": {
                    "type": "object",
                    "properties": {
                        "total": { "type": "integer" },
                        "active": { "type": "integer" },
                        "expired": { "type": "integer" },
                        "revoked": { "type": "integer" },
                        "ip_restricted": { "type": "integer" },
                        "legacy_full_access": { "type": "integer" },
                        "explicit": { "type": "integer" },
                        "managed": { "type": "integer" }
                    },
                    "required": [
                        "total",
                        "active",
                        "expired",
                        "revoked",
                        "ip_restricted",
                        "legacy_full_access",
                        "explicit",
                        "managed"
                    ]
                },
                "AdminTokenSummary": {
                    "type": "object",
                    "properties": {
                        "token_id": { "type": "string" },
                        "label": { "type": ["string", "null"] },
                        "token_source": {
                            "type": "string",
                            "enum": ["legacy_full_access", "explicit", "managed"]
                        },
                        "status": {
                            "type": "string",
                            "enum": ["active", "expired"]
                        },
                        "revoked": { "type": "boolean" },
                        "revoked_at_ms": { "type": ["integer", "null"] },
                        "revoked_by_token_id": { "type": ["string", "null"] },
                        "revoke_reason": { "type": ["string", "null"] },
                        "successor_token_id": { "type": ["string", "null"] },
                        "scopes": {
                            "type": "array",
                            "items": { "type": "string" }
                        },
                        "created_by": { "type": ["string", "null"] },
                        "created_at_ms": { "type": ["integer", "null"] },
                        "expires_at_ms": { "type": ["integer", "null"] },
                        "last_used_at_ms": { "type": ["integer", "null"] },
                        "allowed_ips": {
                            "type": "array",
                            "items": { "type": "string" }
                        },
                        "rate_limit_class": { "type": "string" },
                        "rate_limit_per_minute": { "type": "integer" },
                        "rate_limit_burst_capacity": { "type": "integer" },
                        "rate_limit_burst_window_secs": { "type": "integer" }
                    },
                    "required": [
                        "token_id",
                        "token_source",
                        "status",
                        "revoked",
                        "scopes",
                        "allowed_ips",
                        "rate_limit_class",
                        "rate_limit_per_minute",
                        "rate_limit_burst_capacity",
                        "rate_limit_burst_window_secs"
                    ]
                },
                "AdminTokensData": {
                    "type": "object",
                    "properties": {
                        "summary": { "$ref": "#/components/schemas/AdminTokensSummary" },
                        "tokens": {
                            "type": "array",
                            "items": { "$ref": "#/components/schemas/AdminTokenSummary" }
                        }
                    },
                    "required": ["summary", "tokens"]
                },
                "AdminTokensEnvelope": {
                    "type": "object",
                    "properties": {
                        "meta": { "$ref": "#/components/schemas/ResponseMeta" },
                        "data": { "$ref": "#/components/schemas/AdminTokensData" }
                    },
                    "required": ["meta", "data"]
                },
                "AdminTokenOperation": {
                    "type": "object",
                    "properties": {
                        "action": { "type": "string", "enum": ["created", "revoked", "restored", "rotated", "rotated_secret"] },
                        "runtime_only": { "type": "boolean" },
                        "persisted": { "type": "boolean" },
                        "effective_immediately": { "type": "boolean" },
                        "performed_at_ms": { "type": "integer" },
                        "performed_by_token_id": { "type": "string" },
                        "restored_successor": { "type": "boolean" },
                        "invalidated_previous_secret": { "type": "boolean" }
                    },
                    "required": [
                        "action",
                        "runtime_only",
                        "persisted",
                        "effective_immediately",
                        "performed_at_ms",
                        "performed_by_token_id"
                    ]
                },
                "AdminTokenMutationData": {
                    "type": "object",
                    "properties": {
                        "token": { "$ref": "#/components/schemas/AdminTokenSummary" },
                        "operation": { "$ref": "#/components/schemas/AdminTokenOperation" }
                    },
                    "required": ["token", "operation"]
                },
                "AdminTokenMutationEnvelope": {
                    "type": "object",
                    "properties": {
                        "meta": { "$ref": "#/components/schemas/ResponseMeta" },
                        "data": { "$ref": "#/components/schemas/AdminTokenMutationData" }
                    },
                    "required": ["meta", "data"]
                },
                "AdminTokenRotationData": {
                    "type": "object",
                    "properties": {
                        "source_token": { "$ref": "#/components/schemas/AdminTokenSummary" },
                        "successor_token": { "$ref": "#/components/schemas/AdminTokenSummary" },
                        "operation": { "$ref": "#/components/schemas/AdminTokenOperation" }
                    },
                    "required": ["source_token", "successor_token", "operation"]
                },
                "AdminTokenRotationEnvelope": {
                    "type": "object",
                    "properties": {
                        "meta": { "$ref": "#/components/schemas/ResponseMeta" },
                        "data": { "$ref": "#/components/schemas/AdminTokenRotationData" }
                    },
                    "required": ["meta", "data"]
                },
                "AdminTokenSecretData": {
                    "type": "object",
                    "properties": {
                        "token": { "type": "string" },
                        "token_once": { "type": "boolean" },
                        "token_info": { "$ref": "#/components/schemas/AdminTokenSummary" },
                        "operation": { "$ref": "#/components/schemas/AdminTokenOperation" }
                    },
                    "required": ["token", "token_once", "token_info", "operation"]
                },
                "AdminTokenSecretEnvelope": {
                    "type": "object",
                    "properties": {
                        "meta": { "$ref": "#/components/schemas/ResponseMeta" },
                        "data": { "$ref": "#/components/schemas/AdminTokenSecretData" }
                    },
                    "required": ["meta", "data"]
                },
                "ServiceStatusInfo": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string" },
                        "version": { "type": "string" },
                        "status": { "type": "string", "enum": ["operational", "degraded"] },
                        "strict_canary_enabled": { "type": "boolean" }
                    },
                    "required": ["name", "version", "status", "strict_canary_enabled"]
                },
                "UpstreamCanaryStatus": {
                    "type": "object",
                    "properties": {
                        "status": { "type": "string" },
                        "strict_mode": { "type": "boolean" },
                        "degraded": { "type": "boolean" },
                        "checked_at_ms": { "type": "integer" },
                        "latency_ms": { "type": ["integer", "null"] },
                        "upstream_http_status": { "type": ["integer", "null"] },
                        "body_bytes": { "type": ["integer", "null"] },
                        "consecutive_failures": { "type": "integer" },
                        "fail_threshold": { "type": "integer" },
                        "last_success_at_ms": { "type": ["integer", "null"] },
                        "reason": { "type": ["string", "null"] }
                    },
                    "required": [
                        "status",
                        "strict_mode",
                        "degraded",
                        "checked_at_ms",
                        "latency_ms",
                        "upstream_http_status",
                        "body_bytes",
                        "consecutive_failures",
                        "fail_threshold",
                        "last_success_at_ms",
                        "reason"
                    ]
                },
                "ServiceStatusDeprecation": {
                    "type": "object",
                    "properties": {
                        "legacy_endpoints_deprecated": { "type": "boolean" },
                        "deprecation_headers_enabled": { "type": "boolean" },
                        "sunset_at_http": { "type": "string" },
                        "successor_api_version": { "type": "string" },
                        "migration_reference": { "type": "string" },
                        "changelog_path": { "type": "string" },
                        "affected_endpoints": {
                            "type": "array",
                            "items": { "type": "string" }
                        }
                    },
                    "required": [
                        "legacy_endpoints_deprecated",
                        "deprecation_headers_enabled",
                        "sunset_at_http",
                        "successor_api_version",
                        "migration_reference",
                        "changelog_path",
                        "affected_endpoints"
                    ]
                },
                "ChangelogDeprecatedEndpoint": {
                    "type": "object",
                    "properties": {
                        "legacy_path": { "type": "string" },
                        "successor_path": { "type": "string" },
                        "successor_kind": { "type": "string" }
                    },
                    "required": ["legacy_path", "successor_path", "successor_kind"]
                },
                "ChangelogDeprecation": {
                    "type": "object",
                    "properties": {
                        "legacy_endpoints_deprecated": { "type": "boolean" },
                        "deprecation_headers_enabled": { "type": "boolean" },
                        "sunset_at_http": { "type": "string" },
                        "successor_api_version": { "type": "string" },
                        "migration_reference": { "type": "string" },
                        "affected_endpoints": {
                            "type": "array",
                            "items": { "$ref": "#/components/schemas/ChangelogDeprecatedEndpoint" }
                        }
                    },
                    "required": [
                        "legacy_endpoints_deprecated",
                        "deprecation_headers_enabled",
                        "sunset_at_http",
                        "successor_api_version",
                        "migration_reference",
                        "affected_endpoints"
                    ]
                },
                "ChangelogEntry": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string" },
                        "published_on": { "type": "string" },
                        "summary": { "type": "string" },
                        "change_type": { "type": "string" },
                        "api_version": { "type": "string" },
                        "breaking": { "type": "boolean" },
                        "migration_reference": { "type": "string" },
                        "endpoints_added": {
                            "type": "array",
                            "items": { "type": "string" }
                        },
                        "endpoints_deprecated": {
                            "type": "array",
                            "items": { "type": "string" }
                        },
                        "notes": {
                            "type": "array",
                            "items": { "type": "string" }
                        }
                    },
                    "required": [
                        "id",
                        "published_on",
                        "summary",
                        "change_type",
                        "api_version",
                        "breaking",
                        "migration_reference",
                        "endpoints_added",
                        "endpoints_deprecated",
                        "notes"
                    ]
                },
                "ChangelogData": {
                    "type": "object",
                    "properties": {
                        "current_api_version": { "type": "string" },
                        "migration_reference": { "type": "string" },
                        "deprecation": { "$ref": "#/components/schemas/ChangelogDeprecation" },
                        "entries": {
                            "type": "array",
                            "items": { "$ref": "#/components/schemas/ChangelogEntry" }
                        }
                    },
                    "required": [
                        "current_api_version",
                        "migration_reference",
                        "deprecation",
                        "entries"
                    ]
                },
                "ChangelogEnvelope": {
                    "type": "object",
                    "properties": {
                        "meta": { "$ref": "#/components/schemas/ResponseMeta" },
                        "data": { "$ref": "#/components/schemas/ChangelogData" }
                    },
                    "required": ["meta", "data"]
                },
                "IncidentSeverity": {
                    "type": "string",
                    "enum": ["info", "warning", "critical"]
                },
                "ServiceIncident": {
                    "type": "object",
                    "properties": {
                        "kind": { "type": "string" },
                        "severity": { "$ref": "#/components/schemas/IncidentSeverity" },
                        "code": { "type": "string" },
                        "message": { "type": "string" },
                        "first_seen_at_ms": { "type": "integer" },
                        "last_seen_at_ms": { "type": "integer" },
                        "occurrence_count": { "type": "integer" },
                        "request_id": { "type": ["string", "null"] },
                        "path": { "type": ["string", "null"] }
                    },
                    "required": [
                        "kind",
                        "severity",
                        "code",
                        "message",
                        "first_seen_at_ms",
                        "last_seen_at_ms",
                        "occurrence_count",
                        "request_id",
                        "path"
                    ]
                },
                "ServiceIncidentsSnapshot": {
                    "type": "object",
                    "properties": {
                        "total_incidents": { "type": "integer" },
                        "recent": {
                            "type": "array",
                            "items": { "$ref": "#/components/schemas/ServiceIncident" }
                        }
                    },
                    "required": ["total_incidents", "recent"]
                },
                "IncidentsData": {
                    "type": "object",
                    "properties": {
                        "incidents": { "$ref": "#/components/schemas/ServiceIncidentsSnapshot" }
                    },
                    "required": ["incidents"]
                },
                "IncidentsEnvelope": {
                    "type": "object",
                    "properties": {
                        "meta": { "$ref": "#/components/schemas/ResponseMeta" },
                        "data": { "$ref": "#/components/schemas/IncidentsData" }
                    },
                    "required": ["meta", "data"]
                },
                "ServiceStatusData": {
                    "type": "object",
                    "properties": {
                        "service": { "$ref": "#/components/schemas/ServiceStatusInfo" },
                        "upstream": { "$ref": "#/components/schemas/UpstreamCanaryStatus" },
                        "deprecation": { "$ref": "#/components/schemas/ServiceStatusDeprecation" }
                    },
                    "required": ["service", "upstream", "deprecation"]
                },
                "ServiceStatusEnvelope": {
                    "type": "object",
                    "properties": {
                        "meta": { "$ref": "#/components/schemas/ResponseMeta" },
                        "data": { "$ref": "#/components/schemas/ServiceStatusData" }
                    },
                    "required": ["meta", "data"]
                },
                "WhoAmIEnvelope": {
                    "type": "object",
                    "properties": {
                        "meta": { "$ref": "#/components/schemas/ResponseMeta" },
                        "data": { "$ref": "#/components/schemas/WhoAmIData" }
                    },
                    "required": ["meta", "data"]
                },
                "CapabilitiesAuth": {
                    "type": "object",
                    "properties": {
                        "required_header": { "type": "string" },
                        "token_introspection_endpoint": { "type": "string" },
                        "supports_scopes": { "type": "boolean" },
                        "supports_token_expiry": { "type": "boolean" },
                        "supports_ip_allowlist": { "type": "boolean" },
                        "tracks_last_used_at": { "type": "boolean" },
                        "supports_managed_tokens": { "type": "boolean" },
                        "trust_proxy_headers_for_ip_allowlist": { "type": "boolean" }
                    },
                    "required": [
                        "required_header",
                        "token_introspection_endpoint",
                        "supports_scopes",
                        "supports_token_expiry",
                        "supports_ip_allowlist",
                        "tracks_last_used_at",
                        "supports_managed_tokens",
                        "trust_proxy_headers_for_ip_allowlist"
                    ]
                },
                "CapabilitiesSchemas": {
                    "type": "object",
                    "properties": {
                        "admin_tokens": { "type": "string" },
                        "admin_token_mutation": { "type": "string" },
                        "admin_token_rotation": { "type": "string" },
                        "admin_token_secret": { "type": "string" },
                        "bag_detail": { "type": "string" },
                        "changelog": { "type": "string" },
                        "incidents": { "type": "string" },
                        "manifest_detail": { "type": "string" },
                        "service_status": { "type": "string" },
                        "track_detail": { "type": "string" },
                        "capabilities": { "type": "string" },
                        "whoami": { "type": "string" }
                    },
                    "required": [
                        "admin_tokens",
                        "admin_token_mutation",
                        "admin_token_rotation",
                        "admin_token_secret",
                        "bag_detail",
                        "changelog",
                        "incidents",
                        "manifest_detail",
                        "service_status",
                        "track_detail",
                        "capabilities",
                        "whoami"
                    ]
                },
                "CapabilitiesLimits": {
                    "type": "object",
                    "properties": {
                        "id_max_length": { "type": "integer" },
                        "batch_max_items": { "type": "integer" },
                        "batch_concurrency": { "type": "integer" },
                        "rate_limit_per_minute": { "type": "integer" },
                        "rate_limit_burst_capacity": { "type": "integer" },
                        "rate_limit_burst_window_secs": { "type": "integer" },
                        "rate_limit_class_names": {
                            "type": "array",
                            "items": { "type": "string" }
                        },
                        "http_timeout_secs": { "type": "integer" },
                        "upstream_queue_timeout_secs": { "type": "integer" }
                    },
                    "required": [
                        "id_max_length",
                        "batch_max_items",
                        "batch_concurrency",
                        "rate_limit_per_minute",
                        "rate_limit_burst_capacity",
                        "rate_limit_burst_window_secs",
                        "rate_limit_class_names",
                        "http_timeout_secs",
                        "upstream_queue_timeout_secs"
                    ]
                },
                "CapabilitiesFeatures": {
                    "type": "object",
                    "properties": {
                        "admin_token_inventory": { "type": "boolean" },
                        "admin_managed_tokens": { "type": "boolean" },
                        "admin_token_persistent_state": { "type": "boolean" },
                        "admin_token_runtime_restore": { "type": "boolean" },
                        "admin_token_runtime_revoke": { "type": "boolean" },
                        "admin_token_runtime_rotate": { "type": "boolean" },
                        "admin_token_secret_rotation": { "type": "boolean" },
                        "api_changelog": { "type": "boolean" },
                        "incident_feed": { "type": "boolean" },
                        "bag_detail": { "type": "boolean" },
                        "deprecation_headers_enabled": { "type": "boolean" },
                        "manifest_detail": { "type": "boolean" },
                        "service_status": { "type": "boolean" },
                        "track_detail": { "type": "boolean" },
                        "async_track_lite_batch_job": { "type": "boolean" },
                        "openapi_available": { "type": "boolean" },
                        "stale_if_error_enabled": { "type": "boolean" },
                        "persistent_cache_enabled": { "type": "boolean" },
                        "parser_guard_enabled": { "type": "boolean" },
                        "rate_limit_burst_policy": { "type": "boolean" },
                        "rate_limit_scope_defaults": { "type": "boolean" },
                        "rate_limit_token_classes": { "type": "boolean" },
                        "rate_limit_headers": { "type": "boolean" },
                        "webhook_signed_delivery": { "type": "boolean" }
                    },
                    "required": [
                        "admin_token_inventory",
                        "admin_managed_tokens",
                        "admin_token_persistent_state",
                        "admin_token_runtime_restore",
                        "admin_token_runtime_revoke",
                        "admin_token_runtime_rotate",
                        "admin_token_secret_rotation",
                        "api_changelog",
                        "incident_feed",
                        "bag_detail",
                        "deprecation_headers_enabled",
                        "manifest_detail",
                        "service_status",
                        "track_detail",
                        "async_track_lite_batch_job",
                        "openapi_available",
                        "stale_if_error_enabled",
                        "persistent_cache_enabled",
                        "parser_guard_enabled",
                        "rate_limit_burst_policy",
                        "rate_limit_scope_defaults",
                        "rate_limit_token_classes",
                        "rate_limit_headers",
                        "webhook_signed_delivery"
                    ]
                },
                "CapabilitiesEndpoints": {
                    "type": "object",
                    "properties": {
                        "public": {
                            "type": "array",
                            "items": { "type": "string" }
                        },
                        "protected": {
                            "type": "array",
                            "items": { "type": "string" }
                        }
                    },
                    "required": ["public", "protected"]
                },
                "CapabilitiesData": {
                    "type": "object",
                    "properties": {
                        "auth": { "$ref": "#/components/schemas/CapabilitiesAuth" },
                        "schemas": { "$ref": "#/components/schemas/CapabilitiesSchemas" },
                        "limits": { "$ref": "#/components/schemas/CapabilitiesLimits" },
                        "features": { "$ref": "#/components/schemas/CapabilitiesFeatures" },
                        "endpoints": { "$ref": "#/components/schemas/CapabilitiesEndpoints" }
                    },
                    "required": ["auth", "schemas", "limits", "features", "endpoints"]
                },
                "CapabilitiesEnvelope": {
                    "type": "object",
                    "properties": {
                        "meta": { "$ref": "#/components/schemas/ResponseMeta" },
                        "data": { "$ref": "#/components/schemas/CapabilitiesData" }
                    },
                    "required": ["meta", "data"]
                }
            }
        }
    })
}
