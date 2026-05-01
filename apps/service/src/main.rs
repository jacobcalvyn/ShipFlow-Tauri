use std::env;

use shipflow_core::model::{TrackingSource, TrackingSourceConfig};
use shipflow_service_runtime::{run_service_process, ServiceRuntimeConfig, ServiceRuntimeMode};

#[derive(Clone, Debug)]
struct CliConfig {
    mode: ServiceRuntimeMode,
    port: u16,
    auth_token: String,
    tracking_source: TrackingSourceConfig,
}

impl Default for CliConfig {
    fn default() -> Self {
        Self {
            mode: ServiceRuntimeMode::Local,
            port: 18422,
            auth_token: env::var("SHIPFLOW_SERVICE_TOKEN").unwrap_or_default(),
            tracking_source: TrackingSourceConfig {
                tracking_source: TrackingSource::Default,
                external_api_base_url: env::var("SHIPFLOW_EXTERNAL_API_BASE_URL")
                    .unwrap_or_default(),
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
Options:\n  --auth-token <token>               Bearer token required by Desktop and API clients.\n  --port <port>                      HTTP port. Defaults to 18422.\n  --lan                              Bind to 0.0.0.0 instead of 127.0.0.1.\n  --external-api-base-url <url>      Use an external tracking API instead of POS scraping.\n  --external-api-token <token>       Bearer token for the external tracking API.\n  --allow-insecure-external-api-http Allow HTTP external API URLs.\n  --help                             Show this help.\n\n\
Environment:\n  SHIPFLOW_SERVICE_TOKEN\n  SHIPFLOW_EXTERNAL_API_BASE_URL\n  SHIPFLOW_EXTERNAL_API_TOKEN\n  SHIPFLOW_ALLOW_INSECURE_HTTP=true"
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

fn run_service_settings_app() {
    shipflow3_tauri_lib::install_runtime_logging();

    if shipflow3_tauri_lib::maybe_run_service_tray_from_current_args()
        .expect("failed to initialize ShipFlow service tray companion")
    {
        return;
    }

    if shipflow3_tauri_lib::maybe_run_service_process_from_current_args()
        .expect("failed to initialize ShipFlow service process")
    {
        return;
    }

    if shipflow3_tauri_lib::maybe_delegate_to_existing_service_settings_process()
        .expect("failed to delegate to existing ShipFlow Service settings process")
    {
        return;
    }

    shipflow3_tauri_lib::run_service_settings();
}

fn run_cli_service() {
    let Some(config) = parse_args().unwrap_or_else(|error| {
        eprintln!("{error}");
        eprintln!("Run `shipflow-service --help` for usage.");
        std::process::exit(2);
    }) else {
        print_help();
        return;
    };

    let runtime_config = ServiceRuntimeConfig {
        mode: config.mode,
        port: config.port,
        auth_token: config.auth_token,
        tracking_source: config.tracking_source,
    };

    eprintln!(
        "Starting ShipFlow Service on {}:{}",
        runtime_config.mode.bind_address_label(),
        runtime_config.port
    );

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("failed to create ShipFlow Service runtime");

    if let Err(error) = runtime.block_on(run_service_process(runtime_config)) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn main() {
    if env::args().len() == 1
        || env::args().skip(1).any(|argument| {
            argument == "--shipflow-service-process" || argument == "--shipflow-service-tray"
        })
    {
        run_service_settings_app();
        return;
    }

    run_cli_service();
}
