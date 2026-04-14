pub const LEGACY_API_SUNSET_HTTP_DATE: &str = "Wed, 31 Mar 2027 00:00:00 GMT";
pub const LEGACY_SUCCESSOR_API_VERSION: &str = "v1";
pub const API_CHANGELOG_PATH: &str = "/v1/changelog";
pub const API_MIGRATION_REFERENCE_PATH: &str = "/openapi.json";

const HISTORICAL_LEGACY_ENDPOINTS: &[&str] = &[
    "/track",
    "/trackLite",
    "/trackLiteBatch",
    "/jobs/trackLiteBatch",
    "/jobs/trackLiteBatch/:job_id",
    "/jobs/trackLiteBatch/:job_id/result",
    "/trackBag",
    "/trackManifest",
];

#[derive(Debug, Clone, Copy)]
pub struct LegacyEndpointMigration {
    pub legacy_path: &'static str,
    pub successor_path: &'static str,
    pub successor_kind: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub struct ApiChangelogEntryDef {
    pub id: &'static str,
    pub published_on: &'static str,
    pub summary: &'static str,
    pub change_type: &'static str,
    pub api_version: &'static str,
    pub breaking: bool,
    pub migration_reference: &'static str,
    pub endpoints_added: &'static [&'static str],
    pub endpoints_deprecated: &'static [&'static str],
    pub notes: &'static [&'static str],
}

const CHANGELOG_ENTRY_TRACK_V1: ApiChangelogEntryDef = ApiChangelogEntryDef {
    id: "2026-03-07-track-v1-summary",
    published_on: "2026-03-07",
    summary: "Introduced stable /v1 shipment detail/html endpoints and OpenAPI discovery.",
    change_type: "added",
    api_version: "v1",
    breaking: false,
    migration_reference: API_MIGRATION_REFERENCE_PATH,
    endpoints_added: &[
        "/v1/track/detail",
        "/v1/track/html",
        "/openapi.json",
        "/v1/capabilities",
    ],
    endpoints_deprecated: &[
        "/track",
        "/trackLite",
        "/trackLiteBatch",
        "/jobs/trackLiteBatch*",
    ],
    notes: &[
        "versioned shipment contract is keyed to authoritative shipment data",
        "legacy shipment endpoints emit deprecation headers with successor-version links",
    ],
};

const CHANGELOG_ENTRY_STATUS_AND_ADMIN: ApiChangelogEntryDef = ApiChangelogEntryDef {
    id: "2026-03-07-ops-and-admin-contracts",
    published_on: "2026-03-07",
    summary: "Added consumer-facing status, token introspection, admin inventory, and runtime revoke/restore controls.",
    change_type: "added",
    api_version: "v1",
    breaking: false,
    migration_reference: API_MIGRATION_REFERENCE_PATH,
    endpoints_added: &[
        "/v1/status",
        "/v1/whoami",
        "/v1/admin/tokens",
        "/v1/admin/tokens/revoke",
        "/v1/admin/tokens/restore",
    ],
    endpoints_deprecated: &[],
    notes: &[
        "status surface includes upstream canary and deprecation policy snapshot",
        "admin token operations do not edit environment configuration or rotate underlying secrets automatically",
    ],
};

const CHANGELOG_ENTRY_ADMIN_TOKEN_PERSISTENCE: ApiChangelogEntryDef = ApiChangelogEntryDef {
    id: "2026-03-07-admin-token-state-persistence",
    published_on: "2026-03-07",
    summary: "Added optional persisted admin token revoke/restore state via local JSON store.",
    change_type: "added",
    api_version: "v1",
    breaking: false,
    migration_reference: API_CHANGELOG_PATH,
    endpoints_added: &[],
    endpoints_deprecated: &[],
    notes: &[
        "revoke and restore survive process restart when API_TOKEN_STATE_FILE is configured",
        "persisted state covers admin revocation metadata only and does not rotate the underlying token secret",
    ],
};

const CHANGELOG_ENTRY_ADMIN_TOKEN_ROTATION: ApiChangelogEntryDef = ApiChangelogEntryDef {
    id: "2026-03-07-admin-token-runtime-rotation",
    published_on: "2026-03-07",
    summary:
        "Added coordinated runtime token rotation so admins can revoke one configured token while activating a successor token in a single call.",
    change_type: "added",
    api_version: "v1",
    breaking: false,
    migration_reference: API_CHANGELOG_PATH,
    endpoints_added: &["/v1/admin/tokens/rotate"],
    endpoints_deprecated: &[],
    notes: &[
        "rotation only changes runtime revocation state and does not mint or replace underlying secrets automatically",
        "if persistence is enabled, both source revocation and successor restore are rolled back together when state persistence fails",
    ],
};

const CHANGELOG_ENTRY_MANAGED_TOKEN_STORE: ApiChangelogEntryDef = ApiChangelogEntryDef {
    id: "2026-03-07-managed-token-store",
    published_on: "2026-03-07",
    summary:
        "Added optional managed token store support so admins can create persisted local tokens and rotate their secrets without editing .env.",
    change_type: "added",
    api_version: "v1",
    breaking: false,
    migration_reference: API_CHANGELOG_PATH,
    endpoints_added: &[
        "/v1/admin/tokens/managed/create",
        "/v1/admin/tokens/managed/rotate-secret",
    ],
    endpoints_deprecated: &[],
    notes: &[
        "managed tokens are persisted in MANAGED_API_TOKEN_STORE_FILE and become effective immediately after creation or secret rotation",
        "static tokens defined via API_TOKEN, API_TOKENS, or API_TOKEN_SPECS are not modified by the managed token endpoints",
    ],
};

const CHANGELOG_ENTRY_BAG_AND_MANIFEST: ApiChangelogEntryDef = ApiChangelogEntryDef {
    id: "2026-03-07-bag-manifest-v1-summary",
    published_on: "2026-03-07",
    summary: "Added versioned /v1 detail/html endpoints for bag and manifest entities.",
    change_type: "added",
    api_version: "v1",
    breaking: false,
    migration_reference: API_MIGRATION_REFERENCE_PATH,
    endpoints_added: &[
        "/v1/bag/detail",
        "/v1/bag/html",
        "/v1/manifest/detail",
        "/v1/manifest/html",
    ],
    endpoints_deprecated: &["/trackBag", "/trackManifest"],
    notes: &[
        "bag and manifest summaries stay distinct from authoritative shipment status",
        "legacy bag and manifest routes now expose successor-version links",
    ],
};

const CHANGELOG_ENTRY_WEBHOOK_SIGNING: ApiChangelogEntryDef = ApiChangelogEntryDef {
    id: "2026-03-07-webhook-signing-v1",
    published_on: "2026-03-07",
    summary:
        "Webhook deliveries now include signed event metadata headers with HMAC-SHA256 support for receiver-side replay protection.",
    change_type: "added",
    api_version: "v1",
    breaking: false,
    migration_reference: API_CHANGELOG_PATH,
    endpoints_added: &[],
    endpoints_deprecated: &[],
    notes: &[
        "async job webhooks now include delivery id, event name, timestamp, attempt number, and X-Scrap-Webhook-Signature when WEBHOOK_SECRET is configured",
        "legacy plaintext X-Scrap-Webhook-Secret can be re-enabled temporarily with WEBHOOK_INCLUDE_LEGACY_SECRET_HEADER=true during receiver migration",
    ],
};

const CHANGELOG_ENTRY_OBSERVABILITY_HISTOGRAMS: ApiChangelogEntryDef = ApiChangelogEntryDef {
    id: "2026-03-07-observability-histograms",
    published_on: "2026-03-07",
    summary:
        "Added Prometheus histograms for API request duration and upstream attempt duration to support p50/p95/p99 dashboards.",
    change_type: "added",
    api_version: "v1",
    breaking: false,
    migration_reference: API_CHANGELOG_PATH,
    endpoints_added: &[],
    endpoints_deprecated: &[],
    notes: &[
        "metrics now expose scrap_http_request_duration_ms labeled by endpoint, method, and status_class",
        "metrics now expose scrap_upstream_attempt_duration_ms labeled by entity kind and attempt outcome",
    ],
};

const CHANGELOG_ENTRY_DEPRECATION_POLICY: ApiChangelogEntryDef = ApiChangelogEntryDef {
    id: "2026-03-07-legacy-deprecation-policy",
    published_on: "2026-03-07",
    summary: "Formalized legacy endpoint deprecation lifecycle with Sunset and successor-version headers.",
    change_type: "deprecated",
    api_version: "v1",
    breaking: false,
    migration_reference: API_CHANGELOG_PATH,
    endpoints_added: &[],
    endpoints_deprecated: HISTORICAL_LEGACY_ENDPOINTS,
    notes: &[
        "legacy routes remain available until the published sunset date",
        "consumers should migrate to /v1 and use /v1/changelog plus /openapi.json for contract tracking",
    ],
};

const API_CHANGELOG_ENTRIES: &[ApiChangelogEntryDef] = &[
    CHANGELOG_ENTRY_MANAGED_TOKEN_STORE,
    CHANGELOG_ENTRY_ADMIN_TOKEN_ROTATION,
    CHANGELOG_ENTRY_ADMIN_TOKEN_PERSISTENCE,
    CHANGELOG_ENTRY_OBSERVABILITY_HISTOGRAMS,
    CHANGELOG_ENTRY_WEBHOOK_SIGNING,
    CHANGELOG_ENTRY_BAG_AND_MANIFEST,
    CHANGELOG_ENTRY_STATUS_AND_ADMIN,
    CHANGELOG_ENTRY_TRACK_V1,
    CHANGELOG_ENTRY_DEPRECATION_POLICY,
];

pub fn legacy_deprecated_endpoints() -> &'static [&'static str] {
    &[]
}

pub fn legacy_endpoint_migrations() -> &'static [LegacyEndpointMigration] {
    &[]
}

pub fn api_changelog_entries() -> &'static [ApiChangelogEntryDef] {
    API_CHANGELOG_ENTRIES
}

pub fn legacy_successor_path(path: &str) -> Option<&'static str> {
    let _ = path;
    None
}
