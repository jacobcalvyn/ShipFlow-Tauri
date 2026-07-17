use std::collections::VecDeque;
use std::env;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use shipflow_core::model::{BagResponse, ManifestResponse};
use shipflow_ipc::{RpcError, RpcMessage, RpcRequest};
use shipflow_service_client::{track_bag, track_manifest, track_shipment, ServiceConnectionConfig};
use shipflow_workspace_engine::commands::{
    JobIdRequest, RefreshSheetRowsTrackingRequest, WorkspaceEngineCommand, WorkspaceEngineResponse,
};
use shipflow_workspace_engine::engine::{
    WorkspaceEngineBootstrapConfig, WorkspaceEngineConfig, WorkspaceEngineRuntime,
};
use shipflow_workspace_engine::events::WorkspaceEngineEvent;
use shipflow_workspace_engine::import_engine::{ImportLookupFailure, ImportLookupSource};
use shipflow_workspace_engine::storage::SqliteWorkspaceStore;
use shipflow_workspace_engine::tracking::{
    TrackingBatchLookupFuture, TrackingBatchResultCallback, TrackingLookupFailure,
    TrackingLookupFuture, TrackingLookupSource,
};
use tokio::task::JoinSet;

const PRODUCT: &str = "shipflow-workspace-host";
const DEFAULT_WORKSPACE_ID: &str = "default-workspace";
const DEFAULT_WORKSPACE_NAME: &str = "Default Workspace";
const DEFAULT_WORKSPACE_SHEET_ID: &str = "default-sheet";
const DEFAULT_WORKSPACE_SHEET_NAME: &str = "Sheet 1";
const MAX_CONCURRENT_TRACKING_LOOKUPS: usize = 5;
const SERVICE_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const SERVICE_READ_TIMEOUT: Duration = Duration::from_secs(30);
const SERVICE_REQUEST_TIMEOUT: Duration = Duration::from_secs(35);
static TRACKING_BATCH_SEQUENCE: AtomicU64 = AtomicU64::new(0);

type HostRuntime = WorkspaceEngineRuntime<ServiceLookupSource>;
type Output = Arc<Mutex<io::Stdout>>;

#[derive(Clone, Debug)]
struct HostConfig {
    database_path: PathBuf,
    service: ServiceConnectionConfig,
}

impl HostConfig {
    fn parse() -> Result<Self, String> {
        let mut database_path = None;
        let mut service_ipc = None;
        let mut service_token = env::var("SHIPFLOW_INTERNAL_SERVICE_TOKEN").ok();
        let mut args = env::args().skip(1);

        while let Some(argument) = args.next() {
            match argument.as_str() {
                "--database" => database_path = args.next().map(PathBuf::from),
                "--service-ipc" => service_ipc = args.next(),
                "--help" | "-h" => {
                    println!(
                        "ShipFlow Workspace Host\n\n\
Usage:\n  shipflow-workspace-host --database <path> --service-ipc <endpoint>\n\n\
Environment:\n  SHIPFLOW_INTERNAL_SERVICE_TOKEN"
                    );
                    std::process::exit(0);
                }
                _ => return Err(format!("Unknown argument: {argument}")),
            }
        }

        let config = Self {
            database_path: database_path.ok_or_else(|| "--database is required.".to_string())?,
            service: ServiceConnectionConfig::new_ipc(
                service_ipc.ok_or_else(|| "--service-ipc is required.".to_string())?,
                service_token
                    .take()
                    .ok_or_else(|| "SHIPFLOW_INTERNAL_SERVICE_TOKEN is required.".to_string())?,
            ),
        };
        config.service.validate()?;
        Ok(config)
    }
}

#[derive(Clone)]
struct ServiceLookupSource {
    client: reqwest::Client,
    config: ServiceConnectionConfig,
}

impl ServiceLookupSource {
    fn new(config: ServiceConnectionConfig) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .connect_timeout(SERVICE_CONNECT_TIMEOUT)
            .read_timeout(SERVICE_READ_TIMEOUT)
            .timeout(SERVICE_REQUEST_TIMEOUT)
            .build()
            .map_err(|error| format!("Unable to build workspace service client: {error}"))?;
        Ok(Self { client, config })
    }
}

impl ImportLookupSource for ServiceLookupSource {
    async fn fetch_bag<'a>(
        &'a mut self,
        bag_id: &'a str,
    ) -> Result<BagResponse, ImportLookupFailure> {
        track_bag(&self.client, &self.config, bag_id, false)
            .await
            .map_err(ImportLookupFailure::from)
    }

    async fn fetch_manifest<'a>(
        &'a mut self,
        manifest_id: &'a str,
    ) -> Result<ManifestResponse, ImportLookupFailure> {
        track_manifest(&self.client, &self.config, manifest_id, false)
            .await
            .map_err(ImportLookupFailure::from)
    }
}

impl TrackingLookupSource for ServiceLookupSource {
    fn fetch_tracking<'a>(
        &'a mut self,
        lookup_tracking_id: &'a str,
        force_refresh: bool,
    ) -> TrackingLookupFuture<'a> {
        Box::pin(async move {
            track_shipment(
                &self.client,
                &self.config,
                lookup_tracking_id,
                force_refresh,
            )
            .await
            .map_err(TrackingLookupFailure::from)
        })
    }

    fn fetch_tracking_batch_with_progress<'a>(
        &'a mut self,
        lookup_tracking_ids: Vec<String>,
        force_refresh: bool,
        mut on_result: TrackingBatchResultCallback<'a>,
    ) -> TrackingBatchLookupFuture<'a> {
        Box::pin(async move {
            let batch_id = TRACKING_BATCH_SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1;
            let mut queue = VecDeque::from(lookup_tracking_ids);
            let mut tasks = JoinSet::new();

            while !queue.is_empty() || !tasks.is_empty() {
                while tasks.len() < MAX_CONCURRENT_TRACKING_LOOKUPS && !queue.is_empty() {
                    let lookup_id = queue.pop_front().expect("queue checked as non-empty");
                    let client = self.client.clone();
                    let config = self.config.clone();
                    tasks.spawn(async move {
                        let result = track_shipment(&client, &config, &lookup_id, force_refresh)
                            .await
                            .map_err(TrackingLookupFailure::from);
                        (lookup_id, result)
                    });
                }

                match tasks.join_next().await {
                    Some(Ok((lookup_id, result))) => {
                        if !on_result(lookup_id, result) {
                            tasks.abort_all();
                            break;
                        }
                    }
                    Some(Err(error)) => {
                        tasks.abort_all();
                        return Err(TrackingLookupFailure::new(format!(
                            "tracking worker failed in batch {batch_id}: {error}"
                        )));
                    }
                    None => break,
                }
            }

            Ok(())
        })
    }
}

fn build_runtime(config: &HostConfig) -> Result<HostRuntime, String> {
    let source = ServiceLookupSource::new(config.service.clone())?;
    WorkspaceEngineRuntime::open_persistent(
        WorkspaceEngineConfig::default(),
        WorkspaceEngineBootstrapConfig::new(
            &config.database_path,
            DEFAULT_WORKSPACE_ID,
            DEFAULT_WORKSPACE_NAME,
            DEFAULT_WORKSPACE_SHEET_ID,
            DEFAULT_WORKSPACE_SHEET_NAME,
        ),
        source,
    )
    .map(|bootstrap| bootstrap.runtime)
    .map_err(|error| error.to_string())
}

fn build_preview_runtime(config: &HostConfig) -> Result<HostRuntime, String> {
    let store = SqliteWorkspaceStore::open_memory().map_err(|error| error.to_string())?;
    Ok(WorkspaceEngineRuntime::new(
        WorkspaceEngineConfig::default(),
        store,
        ServiceLookupSource::new(config.service.clone())?,
    ))
}

fn send(output: &Output, message: &RpcMessage) -> Result<(), String> {
    let mut output = output
        .lock()
        .map_err(|_| "Workspace Host output lock is poisoned.".to_string())?;
    serde_json::to_writer(&mut *output, message)
        .map_err(|error| format!("Unable to serialize Workspace Host message: {error}"))?;
    output
        .write_all(b"\n")
        .map_err(|error| format!("Unable to write Workspace Host message: {error}"))?;
    output
        .flush()
        .map_err(|error| format!("Unable to flush Workspace Host message: {error}"))
}

fn send_result<T: serde::Serialize>(
    output: &Output,
    request_id: &str,
    result: T,
) -> Result<(), String> {
    let value = serde_json::to_value(result)
        .map_err(|error| format!("Unable to serialize Workspace Host result: {error}"))?;
    send(output, &RpcMessage::response(request_id, value))
}

fn send_event(output: &Output, request_id: &str, event: WorkspaceEngineEvent) {
    match serde_json::to_value(event) {
        Ok(event) => {
            let _ = send(output, &RpcMessage::event(request_id, event));
        }
        Err(error) => eprintln!("[ShipFlowWorkspaceHost] event serialization failed: {error}"),
    }
}

async fn handle_request(
    request: RpcRequest,
    config: &HostConfig,
    runtime: &mut HostRuntime,
    output: &Output,
) -> Result<(), RpcError> {
    request.validate()?;
    match request.method.as_str() {
        "workspace.command" => {
            let command: WorkspaceEngineCommand = serde_json::from_value(request.params)
                .map_err(|error| RpcError::new("invalid_params", error.to_string()))?;
            let result = if matches!(command, WorkspaceEngineCommand::PreviewImportSource(_)) {
                build_preview_runtime(config)
                    .map_err(|error| RpcError::new("runtime_error", error))?
                    .handle_command(command)
                    .await
            } else {
                runtime.handle_command(command).await
            }
            .map_err(|error| RpcError::new("workspace_error", error.to_string()))?;
            send_result(output, &request.id, result)
                .map_err(|error| RpcError::new("transport_error", error))
        }
        "workspace.run_import_job_with_progress" => {
            let params: JobIdRequest = serde_json::from_value(request.params)
                .map_err(|error| RpcError::new("invalid_params", error.to_string()))?;
            let output_for_event = Arc::clone(output);
            let request_id = request.id.clone();
            let detail = runtime
                .run_import_job_with_progress(&params.job_id, move |event| {
                    send_event(&output_for_event, &request_id, event);
                })
                .await
                .map_err(|error| RpcError::new("workspace_error", error.to_string()))?;
            send_result(
                output,
                &request.id,
                WorkspaceEngineResponse::ImportJobDetail(detail),
            )
            .map_err(|error| RpcError::new("transport_error", error))
        }
        "workspace.retry_import_job_with_progress" => {
            let params: JobIdRequest = serde_json::from_value(request.params)
                .map_err(|error| RpcError::new("invalid_params", error.to_string()))?;
            let output_for_event = Arc::clone(output);
            let request_id = request.id.clone();
            let detail = runtime
                .retry_import_job_failed_with_progress(&params.job_id, move |event| {
                    send_event(&output_for_event, &request_id, event);
                })
                .await
                .map_err(|error| RpcError::new("workspace_error", error.to_string()))?;
            send_result(
                output,
                &request.id,
                WorkspaceEngineResponse::ImportJobDetail(detail),
            )
            .map_err(|error| RpcError::new("transport_error", error))
        }
        "workspace.refresh_tracking_with_progress" => {
            let params: RefreshSheetRowsTrackingRequest = serde_json::from_value(request.params)
                .map_err(|error| RpcError::new("invalid_params", error.to_string()))?;
            let output_for_event = Arc::clone(output);
            let request_id = request.id.clone();
            let result = runtime
                .refresh_sheet_rows_tracking_with_progress(
                    &params.sheet_id,
                    &params.row_ids,
                    params.force_refresh,
                    params.run_id,
                    move |event| send_event(&output_for_event, &request_id, event),
                )
                .await
                .map_err(|error| RpcError::new("workspace_error", error.to_string()))?;
            send_result(
                output,
                &request.id,
                WorkspaceEngineResponse::SheetRowsTrackingRefresh(result),
            )
            .map_err(|error| RpcError::new("transport_error", error))
        }
        method => Err(RpcError::new(
            "method_not_found",
            format!("Unsupported Workspace Host method: {method}"),
        )),
    }
}

fn main() {
    let config = HostConfig::parse().unwrap_or_else(|error| {
        eprintln!("[ShipFlowWorkspaceHost] configuration error: {error}");
        std::process::exit(2);
    });
    let mut workspace_runtime = build_runtime(&config).unwrap_or_else(|error| {
        eprintln!("[ShipFlowWorkspaceHost] startup error: {error}");
        std::process::exit(1);
    });
    let tokio_runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("failed to create Workspace Host Tokio runtime");
    let output = Arc::new(Mutex::new(io::stdout()));
    send(&output, &RpcMessage::ready(PRODUCT)).unwrap_or_else(|error| {
        eprintln!("[ShipFlowWorkspaceHost] ready handshake failed: {error}");
        std::process::exit(1);
    });

    for line in io::stdin().lock().lines() {
        let line = match line {
            Ok(line) if !line.trim().is_empty() => line,
            Ok(_) => continue,
            Err(error) => {
                eprintln!("[ShipFlowWorkspaceHost] stdin error: {error}");
                break;
            }
        };
        let request = match serde_json::from_str::<RpcRequest>(&line) {
            Ok(request) => request,
            Err(error) => {
                let _ = send(
                    &output,
                    &RpcMessage::error(
                        "invalid-request",
                        RpcError::new("invalid_json", error.to_string()),
                    ),
                );
                continue;
            }
        };
        let request_id = request.id.clone();
        if let Err(error) = tokio_runtime.block_on(handle_request(
            request,
            &config,
            &mut workspace_runtime,
            &output,
        )) {
            let _ = send(&output, &RpcMessage::error(request_id, error));
        }
    }
}
