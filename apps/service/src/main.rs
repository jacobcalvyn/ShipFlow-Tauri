#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;

use shipflow_core::model::{TrackingSource, TrackingSourceConfig};
use shipflow_service_runtime::{
    run_service_with_options, ServiceRuntimeConfig, ServiceRuntimeMode,
};

#[derive(Clone, Debug)]
struct CliConfig {
    mode: ServiceRuntimeMode,
    port: u16,
    auth_token: String,
    tracking_source: TrackingSourceConfig,
}

impl Default for CliConfig {
    fn default() -> Self {
        let external_api_base_url = env::var("SHIPFLOW_EXTERNAL_API_BASE_URL").unwrap_or_default();
        Self {
            mode: ServiceRuntimeMode::Local,
            port: 18422,
            auth_token: env::var("SHIPFLOW_SERVICE_TOKEN").unwrap_or_default(),
            tracking_source: TrackingSourceConfig {
                tracking_source: if external_api_base_url.trim().is_empty() {
                    TrackingSource::Default
                } else {
                    TrackingSource::ExternalApi
                },
                external_api_base_url,
                external_api_auth_token: env::var("SHIPFLOW_EXTERNAL_API_TOKEN")
                    .unwrap_or_default(),
                allow_insecure_external_api_http: env::var("SHIPFLOW_ALLOW_INSECURE_HTTP")
                    .is_ok_and(|value| value.trim().eq_ignore_ascii_case("true")),
            },
        }
    }
}

fn print_help() {
    println!(
        "ShipFlow Service\n\n\
Usage:\n  shipflow-service --auth-token <token> [--port <port>] [--lan]\n\n\
Options:\n  --auth-token <token>               Public bearer token for third-party API clients.\n  --port <port>                      HTTP port. Defaults to 18422.\n  --lan                              Bind to 0.0.0.0 instead of 127.0.0.1.\n  --external-api-base-url <url>      Use an external tracking API instead of POS scraping.\n  --external-api-token <token>       API token for the external tracking API.\n  --allow-insecure-external-api-http Allow HTTP external API URLs.\n  --help                             Show this help.\n\n\
Environment:\n  SHIPFLOW_SERVICE_TOKEN\n  SHIPFLOW_INTERNAL_SERVICE_TOKEN\n  SHIPFLOW_INTERNAL_IPC_ENDPOINT\n  SHIPFLOW_EXTERNAL_API_BASE_URL\n  SHIPFLOW_EXTERNAL_API_TOKEN\n  SHIPFLOW_ALLOW_INSECURE_HTTP=true"
    );
}

fn parse_args() -> Result<Option<CliConfig>, String> {
    let mut config = CliConfig::default();
    let mut args = env::args().skip(1);

    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--help" | "-h" => return Ok(None),
            "--lan" => config.mode = ServiceRuntimeMode::Lan,
            "--local" => config.mode = ServiceRuntimeMode::Local,
            "--port" => {
                let value = args
                    .next()
                    .ok_or_else(|| "--port requires a value.".to_string())?;
                config.port = value
                    .parse::<u16>()
                    .map_err(|error| format!("Invalid --port value: {error}"))?;
            }
            "--auth-token" | "--token" => {
                config.auth_token = args
                    .next()
                    .ok_or_else(|| "--auth-token requires a value.".to_string())?;
            }
            "--external-api-base-url" => {
                config.tracking_source.tracking_source = TrackingSource::ExternalApi;
                config.tracking_source.external_api_base_url = args
                    .next()
                    .ok_or_else(|| "--external-api-base-url requires a value.".to_string())?;
            }
            "--external-api-token" => {
                config.tracking_source.tracking_source = TrackingSource::ExternalApi;
                config.tracking_source.external_api_auth_token = args
                    .next()
                    .ok_or_else(|| "--external-api-token requires a value.".to_string())?;
            }
            "--allow-insecure-external-api-http" => {
                config.tracking_source.allow_insecure_external_api_http = true;
            }
            _ => return Err(format!("Unknown argument: {argument}")),
        }
    }

    Ok(Some(config))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LaunchConfig {
    schema_version: u32,
    service: ServiceRuntimeConfig,
    runtime: shipflow_service_runtime::runtime_options::RuntimeOptions,
}

fn read_launch_config() -> Result<Option<LaunchConfig>, String> {
    use std::io::Read;
    let Some(path) = env::var_os("SHIPFLOW_CONFIG_FILE") else {
        return Ok(None);
    };
    let file =
        std::fs::File::open(&path).map_err(|_| "Unable to read service configuration file.")?;
    let mut bytes = Vec::new();
    file.take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| "Unable to read service configuration file.")?;
    if bytes.len() > 65536 {
        return Err("Service configuration exceeds 64 KiB.".into());
    }
    let config: LaunchConfig =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid service configuration file.")?;
    if config.schema_version != 1 {
        return Err("Unsupported service configuration version.".into());
    }
    shipflow_service_runtime::validate_service_runtime_config(&config.service)?;
    config.runtime.validate()?;
    Ok(Some(config))
}

fn main() {
    std::panic::set_hook(Box::new(|panic_info| {
        shipflow_core::shipflow_log!(
            "[ShipFlowLifecycle] panic processId={} detail={panic_info}",
            std::process::id()
        );
    }));

    if env::args().any(|arg| arg == "--print-build") {
        println!(
            "{}",
            serde_json::to_string(&shipflow_service_runtime::build_identity::build_identity())
                .unwrap()
        );
        return;
    }
    let launch = read_launch_config().unwrap_or_else(|error| {
        eprintln!("{error}");
        std::process::exit(2);
    });
    if env::args().any(|arg| arg == "--healthcheck") {
        let Some(config) = launch else {
            std::process::exit(2);
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let healthy = runtime.block_on(async {
            let client = reqwest::Client::builder()
                .no_proxy()
                .timeout(std::time::Duration::from_secs(20))
                .build()
                .ok()?;
            let response = client
                .get(format!(
                    "http://127.0.0.1:{}/v1/readiness",
                    config.service.port
                ))
                .bearer_auth(config.service.auth_token)
                .send()
                .await
                .ok()?;
            if !response.status().is_success() {
                return None;
            }
            let value: serde_json::Value =
                serde_json::from_slice(&response.bytes().await.ok()?).ok()?;
            (value["data"]["ready"] == true && value["data"]["storageHealthy"] == true)
                .then_some(())
        });
        std::process::exit(if healthy.is_some() { 0 } else { 1 });
    }
    let (runtime_config, options) = if let Some(config) = launch {
        (config.service, config.runtime)
    } else {
        let Some(config) = parse_args().unwrap_or_else(|error| {
            shipflow_core::shipflow_log!("[ShipFlowLifecycle] invalid_arguments error={error:?}");
            shipflow_core::shipflow_log!(
                "[ShipFlowLifecycle] invalid_arguments_help command=shipflow-service--help"
            );
            std::process::exit(2);
        }) else {
            print_help();
            return;
        };

        let runtime_config = ServiceRuntimeConfig {
            mode: config.mode,
            port: config.port,
            auth_token: config.auth_token,
            internal_auth_token: env::var("SHIPFLOW_INTERNAL_SERVICE_TOKEN").unwrap_or_default(),
            internal_ipc_endpoint: env::var("SHIPFLOW_INTERNAL_IPC_ENDPOINT")
                .ok()
                .filter(|endpoint| !endpoint.trim().is_empty()),
            tracking_source: config.tracking_source,
        };

        (runtime_config, Default::default())
    };

    shipflow_core::shipflow_log!(
        "[ShipFlowLifecycle] service_starting bindAddress={} port={} processId={}",
        runtime_config.mode.bind_address_label(),
        runtime_config.port,
        std::process::id()
    );

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("failed to create ShipFlow Service runtime");

    if let Err(error) = runtime.block_on(run_service_with_options(runtime_config, options)) {
        shipflow_core::shipflow_log!(
            "[ShipFlowLifecycle] service_failed processId={} error={error:?}",
            std::process::id()
        );
        std::process::exit(1);
    }
}
