use shipflow_service_runtime::{
    run_service_process as run_service_runtime_process, ServiceRuntimeConfig, ServiceRuntimeMode,
};

use super::ApiServiceConfig;

pub(crate) async fn run_service_process(config: ApiServiceConfig) -> Result<(), String> {
    run_service_runtime_process(service_runtime_config_from_api_config(&config)).await
}

fn service_runtime_config_from_api_config(config: &ApiServiceConfig) -> ServiceRuntimeConfig {
    ServiceRuntimeConfig {
        mode: match config.mode {
            super::ApiServiceMode::Local => ServiceRuntimeMode::Local,
            super::ApiServiceMode::Lan => ServiceRuntimeMode::Lan,
        },
        port: config.port,
        auth_token: config.auth_token.clone(),
        tracking_source: config.tracking_source_config(),
    }
}
