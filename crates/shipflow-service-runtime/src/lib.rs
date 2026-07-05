#![recursion_limit = "256"]

pub mod api_contract;
pub mod contact_cache;
pub mod http_api;
pub mod lookup_cache;
pub mod model;
pub mod openapi;
pub mod persistent_store;
mod upstream_backpressure;

pub const FORCE_REFRESH_HEADER_NAME: &str = "x-shipflow-force-refresh";

pub use http_api::run_service_process;
pub use lookup_cache::{
    resolve_bag_request_cached, resolve_manifest_request_cached, resolve_tracking_request_cached,
    LookupCacheState, LookupRequestOptions,
};
pub use model::{
    validate_service_runtime_config, ServiceRuntimeConfig, ServiceRuntimeMode,
    SERVICE_STATUS_PRODUCT,
};
