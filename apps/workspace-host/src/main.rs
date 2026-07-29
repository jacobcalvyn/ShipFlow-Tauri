use std::collections::VecDeque;
use std::env;
use std::io::{self, BufRead, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use shipflow_core::model::{BagResponse, ManifestResponse};
use shipflow_ipc::{RpcError, RpcMessage, RpcRequest, MAX_FRAME_BYTES};
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
use tokio::sync::Semaphore;
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
const MAX_CONCURRENT_IMPORT_PREVIEWS: usize = 4;
const MAX_BUFFERED_IMPORT_PREVIEWS: usize = 64;
const MAX_CONCURRENT_LONG_OPERATIONS: usize = 1;
const MAX_BUFFERED_LONG_OPERATIONS: usize = 64;
const MAX_BUFFERED_SERIAL_REQUESTS: usize = 256;
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
        track_bag(&self.client, &self.config, bag_id, true)
            .await
            .map_err(ImportLookupFailure::from)
    }

    async fn fetch_manifest<'a>(
        &'a mut self,
        manifest_id: &'a str,
    ) -> Result<ManifestResponse, ImportLookupFailure> {
        track_manifest(&self.client, &self.config, manifest_id, true)
            .await
            .map_err(ImportLookupFailure::from)
    }

    async fn fetch_bags<'a>(
        &'a mut self,
        bag_ids: &'a [String],
        request_timeout: Duration,
        max_concurrency: usize,
    ) -> Vec<(String, Result<BagResponse, ImportLookupFailure>)> {
        let started_at = Instant::now();
        let concurrency = max_concurrency.max(1).min(bag_ids.len().max(1));
        shipflow_core::shipflow_log!(
            "[ShipFlowImport] manifest_bag_batch_start count={} concurrency={} timeout_seconds={}",
            bag_ids.len(),
            concurrency,
            request_timeout.as_secs()
        );
        let mut pending = bag_ids.iter().cloned().enumerate();
        let mut tasks = JoinSet::new();
        let mut indexed_results = std::iter::repeat_with(|| None)
            .take(bag_ids.len())
            .collect::<Vec<Option<Result<BagResponse, ImportLookupFailure>>>>();

        let spawn_lookup = |tasks: &mut JoinSet<_>, index: usize, bag_id: String| {
            let client = self.client.clone();
            let config = self.config.clone();
            tasks.spawn(async move {
                let result = match tokio::time::timeout(
                    request_timeout,
                    track_bag(&client, &config, &bag_id, true),
                )
                .await
                {
                    Ok(result) => result.map_err(ImportLookupFailure::from),
                    Err(_) => Err(ImportLookupFailure::new(format!(
                        "Timeout ambil data setelah {} detik.",
                        request_timeout.as_secs()
                    ))),
                };
                (index, result)
            });
        };

        while tasks.len() < concurrency {
            let Some((index, bag_id)) = pending.next() else {
                break;
            };
            spawn_lookup(&mut tasks, index, bag_id);
        }

        while let Some(joined) = tasks.join_next().await {
            match joined {
                Ok((index, result)) => indexed_results[index] = Some(result),
                Err(error) => {
                    shipflow_core::shipflow_log!(
                        "[ShipFlowImport] manifest_bag_worker_failed error={error}"
                    );
                }
            }

            if let Some((index, bag_id)) = pending.next() {
                spawn_lookup(&mut tasks, index, bag_id);
            }
        }

        let results = bag_ids
            .iter()
            .cloned()
            .zip(indexed_results.into_iter().map(|result| {
                result.unwrap_or_else(|| {
                    Err(ImportLookupFailure::new(
                        "Manifest bag lookup worker stopped unexpectedly.",
                    ))
                })
            }))
            .collect::<Vec<_>>();
        let succeeded = results.iter().filter(|(_, result)| result.is_ok()).count();
        shipflow_core::shipflow_log!(
            "[ShipFlowImport] manifest_bag_batch_complete count={} succeeded={} failed={} concurrency={} elapsed_ms={}",
            results.len(),
            succeeded,
            results.len().saturating_sub(succeeded),
            concurrency,
            started_at.elapsed().as_millis()
        );
        results
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

fn build_existing_runtime(config: &HostConfig) -> Result<HostRuntime, String> {
    let store =
        SqliteWorkspaceStore::open(&config.database_path).map_err(|error| error.to_string())?;
    Ok(WorkspaceEngineRuntime::new_with_blob_root_path(
        WorkspaceEngineConfig::default(),
        store,
        ServiceLookupSource::new(config.service.clone())?,
        config.database_path.parent().map(PathBuf::from),
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

fn is_import_preview_request(request: &RpcRequest) -> bool {
    request.method == "workspace.command"
        && request
            .params
            .get("command")
            .and_then(serde_json::Value::as_str)
            == Some("preview_import_source")
}

fn is_long_running_request(request: &RpcRequest) -> bool {
    if matches!(
        request.method.as_str(),
        "workspace.run_import_job_with_progress"
            | "workspace.retry_import_job_with_progress"
            | "workspace.refresh_tracking_with_progress"
    ) {
        return true;
    }

    request.method == "workspace.command"
        && matches!(
            request
                .params
                .get("command")
                .and_then(serde_json::Value::as_str),
            Some(
                "run_import_job"
                    | "retry_import_job_failed"
                    | "refresh_sheet_row_tracking"
                    | "refresh_sheet_rows_tracking"
            )
        )
}

fn send_busy(output: &Output, request_id: impl Into<String>, message: &'static str) {
    let _ = send(
        output,
        &RpcMessage::error(request_id, RpcError::new("busy", message)),
    );
}

fn spawn_serial_actor(
    mut runtime: HostRuntime,
    output: Output,
) -> Result<(SyncSender<RpcRequest>, thread::JoinHandle<()>), String> {
    let (sender, receiver) = mpsc::sync_channel::<RpcRequest>(MAX_BUFFERED_SERIAL_REQUESTS);
    let actor = thread::Builder::new()
        .name("shipflow-workspace-actor".to_string())
        .spawn(move || {
            let tokio_runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("failed to create Workspace Host actor runtime");
            while let Ok(request) = receiver.recv() {
                let request_id = request.id.clone();
                if let Err(error) =
                    tokio_runtime.block_on(handle_request(request, &mut runtime, &output))
                {
                    let _ = send(&output, &RpcMessage::error(request_id, error));
                }
            }
        })
        .map_err(|error| format!("Unable to start Workspace Host actor: {error}"))?;
    Ok((sender, actor))
}

async fn handle_import_preview_request(
    request: RpcRequest,
    config: &HostConfig,
    output: &Output,
) -> Result<(), RpcError> {
    request.validate()?;
    let command: WorkspaceEngineCommand = serde_json::from_value(request.params)
        .map_err(|error| RpcError::new("invalid_params", error.to_string()))?;
    if !matches!(command, WorkspaceEngineCommand::PreviewImportSource(_)) {
        return Err(RpcError::new(
            "invalid_request",
            "Request is not an import source preview.",
        ));
    }

    let result = build_preview_runtime(config)
        .map_err(|error| RpcError::new("runtime_error", error))?
        .handle_command(command)
        .await
        .map_err(|error| RpcError::new("workspace_error", error.to_string()))?;
    send_result(output, &request.id, result)
        .map_err(|error| RpcError::new("transport_error", error))
}

async fn handle_request(
    request: RpcRequest,
    runtime: &mut HostRuntime,
    output: &Output,
) -> Result<(), RpcError> {
    request.validate()?;
    match request.method.as_str() {
        "workspace.command" => {
            let command: WorkspaceEngineCommand = serde_json::from_value(request.params)
                .map_err(|error| RpcError::new("invalid_params", error.to_string()))?;
            let result = runtime
                .handle_command(command)
                .await
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
    let workspace_runtime = build_runtime(&config).unwrap_or_else(|error| {
        eprintln!("[ShipFlowWorkspaceHost] startup error: {error}");
        std::process::exit(1);
    });
    let tokio_runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("failed to create Workspace Host Tokio runtime");
    let output = Arc::new(Mutex::new(io::stdout()));
    let import_preview_slots = Arc::new(Semaphore::new(MAX_CONCURRENT_IMPORT_PREVIEWS));
    let import_preview_capacity = Arc::new(Semaphore::new(MAX_BUFFERED_IMPORT_PREVIEWS));
    let long_operation_slots = Arc::new(Semaphore::new(MAX_CONCURRENT_LONG_OPERATIONS));
    let long_operation_capacity = Arc::new(Semaphore::new(MAX_BUFFERED_LONG_OPERATIONS));
    let (serial_sender, serial_actor) = spawn_serial_actor(workspace_runtime, Arc::clone(&output))
        .unwrap_or_else(|error| {
            eprintln!("[ShipFlowWorkspaceHost] actor startup error: {error}");
            std::process::exit(1);
        });
    send(&output, &RpcMessage::ready(PRODUCT)).unwrap_or_else(|error| {
        eprintln!("[ShipFlowWorkspaceHost] ready handshake failed: {error}");
        std::process::exit(1);
    });

    let stdin = io::stdin();
    let mut input = stdin.lock();
    loop {
        let mut payload = Vec::new();
        let read_result = (&mut input)
            .take((MAX_FRAME_BYTES + 1) as u64)
            .read_until(b'\n', &mut payload);
        let bytes_read = match read_result {
            Ok(0) => break,
            Ok(bytes_read) => bytes_read,
            Err(error) => {
                eprintln!("[ShipFlowWorkspaceHost] stdin error: {error}");
                break;
            }
        };
        if bytes_read > MAX_FRAME_BYTES || payload.len() > MAX_FRAME_BYTES {
            let _ = send(
                &output,
                &RpcMessage::error(
                    "invalid-request",
                    RpcError::new(
                        "frame_too_large",
                        "Workspace Host request exceeds the maximum frame size.",
                    ),
                ),
            );
            break;
        }
        while matches!(payload.last(), Some(b'\n' | b'\r')) {
            payload.pop();
        }
        if payload.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let request = match serde_json::from_slice::<RpcRequest>(&payload) {
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
        if is_import_preview_request(&request) {
            let capacity_permit = match Arc::clone(&import_preview_capacity).try_acquire_owned() {
                Ok(permit) => permit,
                Err(_) => {
                    let _ = send(
                        &output,
                        &RpcMessage::error(
                            request_id,
                            RpcError::new(
                                "busy",
                                "Import preview queue is full. Retry the request.",
                            ),
                        ),
                    );
                    continue;
                }
            };
            let task_slots = Arc::clone(&import_preview_slots);
            let task_config = config.clone();
            let task_output = Arc::clone(&output);
            tokio_runtime.spawn(async move {
                let _capacity_permit = capacity_permit;
                let execution_permit = match task_slots.acquire_owned().await {
                    Ok(permit) => permit,
                    Err(_) => {
                        let _ = send(
                            &task_output,
                            &RpcMessage::error(
                                request.id,
                                RpcError::new(
                                    "runtime_error",
                                    "Import preview dispatcher is shutting down.",
                                ),
                            ),
                        );
                        return;
                    }
                };
                let _execution_permit = execution_permit;
                let request_id = request.id.clone();
                if let Err(error) =
                    handle_import_preview_request(request, &task_config, &task_output).await
                {
                    let _ = send(&task_output, &RpcMessage::error(request_id, error));
                }
            });
            continue;
        }

        if is_long_running_request(&request) {
            let capacity_permit = match Arc::clone(&long_operation_capacity).try_acquire_owned() {
                Ok(permit) => permit,
                Err(_) => {
                    send_busy(
                        &output,
                        request_id,
                        "Workspace operation queue is full. Retry the request.",
                    );
                    continue;
                }
            };
            let task_slots = Arc::clone(&long_operation_slots);
            let task_config = config.clone();
            let task_output = Arc::clone(&output);
            tokio_runtime.spawn(async move {
                let _capacity_permit = capacity_permit;
                let execution_permit = match task_slots.acquire_owned().await {
                    Ok(permit) => permit,
                    Err(_) => {
                        send_busy(
                            &task_output,
                            request.id,
                            "Workspace operation dispatcher is shutting down.",
                        );
                        return;
                    }
                };
                let _execution_permit = execution_permit;
                let request_id = request.id.clone();
                let result = match build_existing_runtime(&task_config) {
                    Ok(mut runtime) => handle_request(request, &mut runtime, &task_output).await,
                    Err(error) => Err(RpcError::new("runtime_error", error)),
                };
                if let Err(error) = result {
                    let _ = send(&task_output, &RpcMessage::error(request_id, error));
                }
            });
            continue;
        }

        match serial_sender.try_send(request) {
            Ok(()) => {}
            Err(TrySendError::Full(request)) => send_busy(
                &output,
                request.id,
                "Workspace command queue is full. Retry the request.",
            ),
            Err(TrySendError::Disconnected(request)) => {
                let _ = send(
                    &output,
                    &RpcMessage::error(
                        request.id,
                        RpcError::new(
                            "runtime_error",
                            "Workspace command dispatcher is unavailable.",
                        ),
                    ),
                );
                break;
            }
        }
    }

    drop(serial_sender);
    if serial_actor.join().is_err() {
        eprintln!("[ShipFlowWorkspaceHost] command actor stopped unexpectedly");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use shipflow_ipc::PROTOCOL_VERSION;

    fn request(method: &str, params: serde_json::Value) -> RpcRequest {
        RpcRequest {
            protocol_version: PROTOCOL_VERSION,
            id: "request-1".to_string(),
            method: method.to_string(),
            auth_token: None,
            params,
        }
    }

    #[test]
    fn identifies_import_preview_requests_for_concurrent_dispatch() {
        assert!(is_import_preview_request(&request(
            "workspace.command",
            json!({
                "command": "preview_import_source",
                "payload": { "kind": "bag", "ids": ["PID1"] }
            }),
        )));
    }

    #[test]
    fn keeps_short_mutating_workspace_commands_on_the_serial_runtime() {
        assert!(!is_import_preview_request(&request(
            "workspace.command",
            json!({
                "command": "clear_sheet_rows",
                "payload": { "sheetId": "sheet-1" }
            }),
        )));
        assert!(!is_long_running_request(&request(
            "workspace.command",
            json!({
                "command": "clear_sheet_rows",
                "payload": { "sheetId": "sheet-1" }
            }),
        )));
    }

    #[test]
    fn dispatches_tracking_and_import_runs_outside_the_serial_actor() {
        assert!(is_long_running_request(&request(
            "workspace.refresh_tracking_with_progress",
            json!({ "sheetId": "sheet-1", "rowIds": [] }),
        )));
        assert!(is_long_running_request(&request(
            "workspace.run_import_job_with_progress",
            json!({ "jobId": "job-1" }),
        )));
        assert!(is_long_running_request(&request(
            "workspace.command",
            json!({
                "command": "refresh_sheet_rows_tracking",
                "payload": {
                    "sheetId": "sheet-1",
                    "rowIds": [],
                    "forceRefresh": true,
                    "runId": null
                }
            }),
        )));
        assert!(!is_long_running_request(&request(
            "workspace.command",
            json!({
                "command": "cancel_import_job",
                "payload": { "jobId": "job-1" }
            }),
        )));
    }
}
