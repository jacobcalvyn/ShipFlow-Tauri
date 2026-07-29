use std::collections::{HashMap, VecDeque};
use std::env;
use std::io::{self, BufRead, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use shipflow_core::model::{BagResponse, ManifestResponse};
use shipflow_ipc::{RpcError, RpcMessage, RpcRequest, MAX_FRAME_BYTES};
use shipflow_service_client::{track_bag, track_manifest, track_shipment, ServiceConnectionConfig};
use shipflow_workspace_engine::commands::{
    RefreshSheetRowsTrackingRequest, WorkspaceEngineCommand, WorkspaceEngineResponse,
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
use tokio::sync::{watch, Semaphore};
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
static IMPORT_LOOKUP_SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();

type HostRuntime = WorkspaceEngineRuntime<ServiceLookupSource>;
type Output = Arc<Mutex<io::Stdout>>;

#[derive(Debug)]
struct PreviewRun {
    request_key: String,
    active_requests: usize,
    cancellation: watch::Sender<bool>,
}

#[derive(Debug, Default)]
struct PreviewCancellationRegistry {
    runs: Mutex<HashMap<String, PreviewRun>>,
}

impl PreviewCancellationRegistry {
    fn register(
        &self,
        scope_key: &str,
        request_key: &str,
    ) -> Result<watch::Receiver<bool>, String> {
        let mut runs = self
            .runs
            .lock()
            .map_err(|_| "Import preview cancellation registry is unavailable.".to_string())?;

        if let Some(run) = runs.get_mut(scope_key) {
            if run.request_key == request_key {
                run.active_requests = run.active_requests.saturating_add(1);
                return Ok(run.cancellation.subscribe());
            }
            let _ = run.cancellation.send(true);
        }

        let (cancellation, receiver) = watch::channel(false);
        runs.insert(
            scope_key.to_string(),
            PreviewRun {
                request_key: request_key.to_string(),
                active_requests: 1,
                cancellation,
            },
        );
        Ok(receiver)
    }

    fn cancel(&self, scope_key: &str, request_key: Option<&str>) -> Result<bool, String> {
        let runs = self
            .runs
            .lock()
            .map_err(|_| "Import preview cancellation registry is unavailable.".to_string())?;
        let Some(run) = runs.get(scope_key) else {
            return Ok(false);
        };
        if request_key.is_some_and(|key| key != run.request_key) {
            return Ok(false);
        }
        let _ = run.cancellation.send(true);
        Ok(true)
    }

    fn complete(&self, scope_key: &str, request_key: &str) {
        let Ok(mut runs) = self.runs.lock() else {
            return;
        };
        let Some(run) = runs.get_mut(scope_key) else {
            return;
        };
        if run.request_key != request_key {
            return;
        }
        run.active_requests = run.active_requests.saturating_sub(1);
        if run.active_requests == 0 {
            runs.remove(scope_key);
        }
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelImportPreviewRequest {
    scope_key: String,
    request_key: Option<String>,
}

fn validate_preview_key(value: &str, label: &str) -> Result<(), RpcError> {
    if value.trim().is_empty() || value.len() > 256 {
        return Err(RpcError::new(
            "invalid_params",
            format!("{label} must contain between 1 and 256 characters."),
        ));
    }
    Ok(())
}

fn import_preview_identity(request: &RpcRequest) -> Result<(String, String), RpcError> {
    let payload = request
        .params
        .get("payload")
        .ok_or_else(|| RpcError::new("invalid_params", "Import preview payload is required."))?;
    let scope_key = payload
        .get("scopeKey")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(&request.id)
        .to_string();
    let request_key = payload
        .get("requestKey")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(&request.id)
        .to_string();
    validate_preview_key(&scope_key, "scopeKey")?;
    validate_preview_key(&request_key, "requestKey")?;
    Ok((scope_key, request_key))
}

async fn wait_for_preview_cancellation(mut cancellation: watch::Receiver<bool>) {
    if *cancellation.borrow() {
        return;
    }
    while cancellation.changed().await.is_ok() {
        if *cancellation.borrow() {
            return;
        }
    }
}

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
    import_lookup_slots: Arc<Semaphore>,
}

impl ServiceLookupSource {
    fn new(config: ServiceConnectionConfig) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .connect_timeout(SERVICE_CONNECT_TIMEOUT)
            .read_timeout(SERVICE_READ_TIMEOUT)
            .timeout(SERVICE_REQUEST_TIMEOUT)
            .build()
            .map_err(|error| format!("Unable to build workspace service client: {error}"))?;
        Ok(Self {
            client,
            config,
            import_lookup_slots: Arc::clone(
                IMPORT_LOOKUP_SLOTS
                    .get_or_init(|| Arc::new(Semaphore::new(MAX_CONCURRENT_IMPORT_PREVIEWS))),
            ),
        })
    }
}

impl ImportLookupSource for ServiceLookupSource {
    async fn fetch_bag<'a>(
        &'a mut self,
        bag_id: &'a str,
    ) -> Result<BagResponse, ImportLookupFailure> {
        let _permit = self
            .import_lookup_slots
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| ImportLookupFailure::new("Import lookup limiter is unavailable."))?;
        track_bag(&self.client, &self.config, bag_id, true)
            .await
            .map_err(ImportLookupFailure::from)
    }

    async fn fetch_manifest<'a>(
        &'a mut self,
        manifest_id: &'a str,
    ) -> Result<ManifestResponse, ImportLookupFailure> {
        let _permit = self
            .import_lookup_slots
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| ImportLookupFailure::new("Import lookup limiter is unavailable."))?;
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
            let import_lookup_slots = Arc::clone(&self.import_lookup_slots);
            tasks.spawn(async move {
                let result = match tokio::time::timeout(request_timeout, async {
                    let _permit = import_lookup_slots.acquire_owned().await.map_err(|_| {
                        ImportLookupFailure::new("Import lookup limiter is unavailable.")
                    })?;
                    track_bag(&client, &config, &bag_id, true)
                        .await
                        .map_err(ImportLookupFailure::from)
                })
                .await
                {
                    Ok(result) => result,
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

    async fn fetch_manifests<'a>(
        &'a mut self,
        manifest_ids: &'a [String],
        request_timeout: Duration,
        max_concurrency: usize,
    ) -> Vec<(String, Result<ManifestResponse, ImportLookupFailure>)> {
        let started_at = Instant::now();
        let concurrency = max_concurrency.max(1).min(manifest_ids.len().max(1));
        shipflow_core::shipflow_log!(
            "[ShipFlowImport] manifest_batch_start count={} concurrency={} timeout_seconds={}",
            manifest_ids.len(),
            concurrency,
            request_timeout.as_secs()
        );
        let mut pending = manifest_ids.iter().cloned().enumerate();
        let mut tasks = JoinSet::new();
        let mut indexed_results = std::iter::repeat_with(|| None)
            .take(manifest_ids.len())
            .collect::<Vec<Option<Result<ManifestResponse, ImportLookupFailure>>>>();

        let spawn_lookup = |tasks: &mut JoinSet<_>, index: usize, manifest_id: String| {
            let client = self.client.clone();
            let config = self.config.clone();
            let import_lookup_slots = Arc::clone(&self.import_lookup_slots);
            tasks.spawn(async move {
                let result = match tokio::time::timeout(request_timeout, async {
                    let _permit = import_lookup_slots.acquire_owned().await.map_err(|_| {
                        ImportLookupFailure::new("Import lookup limiter is unavailable.")
                    })?;
                    track_manifest(&client, &config, &manifest_id, true)
                        .await
                        .map_err(ImportLookupFailure::from)
                })
                .await
                {
                    Ok(result) => result,
                    Err(_) => Err(ImportLookupFailure::new(format!(
                        "Timeout ambil data setelah {} detik.",
                        request_timeout.as_secs()
                    ))),
                };
                (index, result)
            });
        };

        while tasks.len() < concurrency {
            let Some((index, manifest_id)) = pending.next() else {
                break;
            };
            spawn_lookup(&mut tasks, index, manifest_id);
        }

        while let Some(joined) = tasks.join_next().await {
            match joined {
                Ok((index, result)) => indexed_results[index] = Some(result),
                Err(error) => {
                    shipflow_core::shipflow_log!(
                        "[ShipFlowImport] manifest_worker_failed error={error}"
                    );
                }
            }

            if let Some((index, manifest_id)) = pending.next() {
                spawn_lookup(&mut tasks, index, manifest_id);
            }
        }

        let results = manifest_ids
            .iter()
            .cloned()
            .zip(indexed_results.into_iter().map(|result| {
                result.unwrap_or_else(|| {
                    Err(ImportLookupFailure::new(
                        "Manifest lookup worker stopped unexpectedly.",
                    ))
                })
            }))
            .collect::<Vec<_>>();
        let succeeded = results.iter().filter(|(_, result)| result.is_ok()).count();
        shipflow_core::shipflow_log!(
            "[ShipFlowImport] manifest_batch_complete count={} succeeded={} failed={} concurrency={} elapsed_ms={}",
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
    if request.method == "workspace.refresh_tracking_with_progress" {
        return true;
    }

    request.method == "workspace.command"
        && matches!(
            request
                .params
                .get("command")
                .and_then(serde_json::Value::as_str),
            Some("refresh_sheet_row_tracking" | "refresh_sheet_rows_tracking")
        )
}

fn is_obsolete_import_job_command(command: &WorkspaceEngineCommand) -> bool {
    matches!(
        command,
        WorkspaceEngineCommand::CreateImportJob(_)
            | WorkspaceEngineCommand::RunImportJob(_)
            | WorkspaceEngineCommand::RetryImportJobFailed(_)
            | WorkspaceEngineCommand::CancelImportJob(_)
            | WorkspaceEngineCommand::GetImportJob(_)
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
            if is_obsolete_import_job_command(&command) {
                return Err(RpcError::new(
                    "method_not_found",
                    "Persisted import jobs are no longer exposed. Use preview_import_source.",
                ));
            }
            let result = runtime
                .handle_command(command)
                .await
                .map_err(|error| RpcError::new("workspace_error", error.to_string()))?;
            send_result(output, &request.id, result)
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
    let preview_cancellations = Arc::new(PreviewCancellationRegistry::default());
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
        if request.method == "workspace.cancel_import_preview" {
            let result = (|| {
                request.validate()?;
                let params: CancelImportPreviewRequest = serde_json::from_value(request.params)
                    .map_err(|error| RpcError::new("invalid_params", error.to_string()))?;
                validate_preview_key(&params.scope_key, "scopeKey")?;
                if let Some(request_key) = params.request_key.as_deref() {
                    validate_preview_key(request_key, "requestKey")?;
                }
                preview_cancellations
                    .cancel(&params.scope_key, params.request_key.as_deref())
                    .map_err(|error| RpcError::new("runtime_error", error))
            })();
            match result {
                Ok(cancelled) => {
                    let _ = send_result(
                        &output,
                        &request_id,
                        serde_json::json!({ "cancelled": cancelled }),
                    );
                }
                Err(error) => {
                    let _ = send(&output, &RpcMessage::error(request_id, error));
                }
            }
            continue;
        }
        if is_import_preview_request(&request) {
            let (scope_key, preview_request_key) = match import_preview_identity(&request) {
                Ok(identity) => identity,
                Err(error) => {
                    let _ = send(&output, &RpcMessage::error(request_id, error));
                    continue;
                }
            };
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
            let cancellation =
                match preview_cancellations.register(&scope_key, &preview_request_key) {
                    Ok(cancellation) => cancellation,
                    Err(error) => {
                        let _ = send(
                            &output,
                            &RpcMessage::error(request_id, RpcError::new("runtime_error", error)),
                        );
                        continue;
                    }
                };
            let task_slots = Arc::clone(&import_preview_slots);
            let task_config = config.clone();
            let task_output = Arc::clone(&output);
            let task_cancellations = Arc::clone(&preview_cancellations);
            tokio_runtime.spawn(async move {
                let _capacity_permit = capacity_permit;
                let request_id = request.id.clone();
                let operation = async {
                    let _execution_permit = task_slots.acquire_owned().await.map_err(|_| {
                        RpcError::new(
                            "runtime_error",
                            "Import preview dispatcher is shutting down.",
                        )
                    })?;
                    handle_import_preview_request(request, &task_config, &task_output).await
                };
                let result = tokio::select! {
                    _ = wait_for_preview_cancellation(cancellation) => {
                        Err(RpcError::new("cancelled", "Import preview was cancelled."))
                    }
                    result = operation => result,
                };
                task_cancellations.complete(&scope_key, &preview_request_key);
                if let Err(error) = result {
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
    fn dispatches_tracking_runs_outside_the_serial_actor() {
        assert!(is_long_running_request(&request(
            "workspace.refresh_tracking_with_progress",
            json!({ "sheetId": "sheet-1", "rowIds": [] }),
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
    }

    #[test]
    fn rejects_obsolete_import_job_commands_at_the_host_boundary() {
        assert!(is_obsolete_import_job_command(
            &WorkspaceEngineCommand::GetImportJob(
                shipflow_workspace_engine::commands::JobIdRequest {
                    job_id: "job-1".to_string(),
                },
            ),
        ));
        assert!(!is_obsolete_import_job_command(
            &WorkspaceEngineCommand::PreviewImportSource(
                shipflow_workspace_engine::imports::ImportSourcePreviewRequest {
                    kind: shipflow_workspace_engine::imports::ImportKind::Bag,
                    ids: vec!["PID1".to_string()],
                    scope_key: None,
                    request_key: None,
                },
            ),
        ));
    }

    #[test]
    fn superseding_preview_cancels_only_the_previous_request_key() {
        let registry = PreviewCancellationRegistry::default();
        let first = registry
            .register("sheet-1:bag", "request-1")
            .expect("first request registers");
        let second = registry
            .register("sheet-1:bag", "request-2")
            .expect("second request registers");

        assert!(*first.borrow());
        assert!(!*second.borrow());
        assert!(!registry
            .cancel("sheet-1:bag", Some("request-1"))
            .expect("stale cancellation is handled"));
        assert!(registry
            .cancel("sheet-1:bag", Some("request-2"))
            .expect("current cancellation is handled"));
        assert!(*second.borrow());
    }
}
