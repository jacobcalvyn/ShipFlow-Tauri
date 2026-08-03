use serde::Deserialize;
use serde_json::{json, Value};
use shipflow_core::model::TrackingError;
use shipflow_ipc::{
    read_json_frame, write_json_frame, LocalIpcListener, RpcError, RpcMessage, RpcRequest,
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    io::AsyncReadExt,
    sync::{Semaphore, TryAcquireError},
    task::{JoinError, JoinSet},
    time::timeout,
};

use crate::http_api::{
    constant_time_token_eq, resolve_bag_payload, resolve_manifest_payload,
    resolve_tracking_payload, HttpApiState, LookupTrafficClass,
};
use crate::lookup_cache::LookupRequestOptions;
use crate::model::SERVICE_STATUS_PRODUCT;

const MAX_ACTIVE_INTERNAL_IPC_CONNECTIONS: usize = 128;
const INTERNAL_IPC_FRAME_TIMEOUT_SECS: u64 = 10;
const INTERNAL_IPC_DRAIN_TIMEOUT_SECS: u64 = 5;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LookupParams {
    lookup_id: String,
    #[serde(default)]
    force_refresh: bool,
}

pub(crate) async fn run_internal_ipc_server(
    listener: LocalIpcListener,
    state: HttpApiState,
) -> Result<(), String> {
    let connection_limiter = Arc::new(Semaphore::new(MAX_ACTIVE_INTERNAL_IPC_CONNECTIONS));
    let mut connections = JoinSet::new();
    let accept_result = loop {
        tokio::select! {
            biased;
            _ = state.shutdown_signal.cancelled() => break Ok(()),
            completed = connections.join_next(), if !connections.is_empty() => {
                if let Some(result) = completed {
                    log_connection_join_result(result);
                }
            }
            accepted = listener.accept() => {
                let stream = match accepted {
                    Ok(stream) => stream,
                    Err(error) => break Err(format!("Internal IPC listener failed: {error}")),
                };
                let connection_permit = match connection_limiter.clone().try_acquire_owned() {
                    Ok(permit) => permit,
                    Err(TryAcquireError::NoPermits) => {
                        shipflow_core::shipflow_log!(
                            "[ShipFlowIPC] internal connection rejected reason=capacity limit={MAX_ACTIVE_INTERNAL_IPC_CONNECTIONS}"
                        );
                        continue;
                    }
                    Err(TryAcquireError::Closed) => {
                        break Err("Internal IPC connection limiter is unavailable.".into());
                    }
                };
                let connection_state = state.clone();
                connections.spawn(async move {
                    let _connection_permit = connection_permit;
                    if let Err(error) = handle_connection(stream, connection_state).await {
                        shipflow_core::shipflow_log!("[ShipFlowIPC] internal connection failed: {error}");
                    }
                });
            }
        }
    };

    drop(listener);
    drain_internal_ipc_connections(
        &mut connections,
        Duration::from_secs(INTERNAL_IPC_DRAIN_TIMEOUT_SECS),
    )
    .await;
    accept_result
}

fn log_connection_join_result(result: Result<(), JoinError>) {
    if let Err(error) = result {
        shipflow_core::shipflow_log!(
            "[ShipFlowIPC] internal connection task ended unexpectedly: {error}"
        );
    }
}

async fn drain_internal_ipc_connections(connections: &mut JoinSet<()>, drain_timeout: Duration) {
    if connections.is_empty() {
        return;
    }

    let started_count = connections.len();
    let drained = timeout(drain_timeout, async {
        while let Some(result) = connections.join_next().await {
            log_connection_join_result(result);
        }
    })
    .await;
    if drained.is_ok() {
        shipflow_core::shipflow_log!(
            "[ShipFlowIPC] internal connections drained count={started_count}"
        );
        return;
    }

    let remaining = connections.len();
    shipflow_core::shipflow_log!(
        "[ShipFlowIPC] internal connection drain timed out remaining={remaining}; aborting"
    );
    connections.abort_all();
    while let Some(result) = connections.join_next().await {
        if let Err(error) = result {
            if !error.is_cancelled() {
                log_connection_join_result(Err(error));
            }
        }
    }
}

async fn handle_connection(
    stream: shipflow_ipc::LocalIpcServerStream,
    state: HttpApiState,
) -> Result<(), String> {
    let (mut reader, mut writer) = tokio::io::split(stream);
    let request: RpcRequest = timeout(
        Duration::from_secs(INTERNAL_IPC_FRAME_TIMEOUT_SECS),
        read_json_frame(&mut reader),
    )
    .await
    .map_err(|_| {
        format!(
            "Internal IPC request frame timed out after {INTERNAL_IPC_FRAME_TIMEOUT_SECS} seconds."
        )
    })?
    .map_err(|error| format!("Unable to read internal IPC request: {error}"))?;
    let request_id = request.id.clone();
    let audit_request_id = audit_value(&request.id);
    let audit_method = audit_value(&request.method);
    let started_at = Instant::now();
    shipflow_core::shipflow_log!(
        "[ShipFlowIPC] request_started requestId={} method={}",
        audit_request_id,
        audit_method,
    );
    let handled = tokio::select! {
        result = handle_request(&state, request) => Some(result),
        disconnected = wait_for_peer_disconnect(&mut reader) => {
            disconnected.map_err(|error| format!("Internal IPC disconnect monitor failed: {error}"))?;
            None
        }
    };
    let Some(handled) = handled else {
        return Ok(());
    };
    let (message, should_shutdown) = match handled {
        Ok(result) => result,
        Err(error) => (RpcMessage::error(request_id, error), false),
    };
    let result = if matches!(message, RpcMessage::Error { .. }) {
        "error"
    } else {
        "ok"
    };
    timeout(
        Duration::from_secs(INTERNAL_IPC_FRAME_TIMEOUT_SECS),
        write_json_frame(&mut writer, &message),
    )
        .await
        .map_err(|_| {
            format!(
                "Internal IPC response frame timed out after {INTERNAL_IPC_FRAME_TIMEOUT_SECS} seconds."
            )
        })?
        .map_err(|error| format!("Unable to write internal IPC response: {error}"))?;
    shipflow_core::shipflow_log!(
        "[ShipFlowIPC] request_completed requestId={} method={} result={} durationMs={}",
        audit_request_id,
        audit_method,
        result,
        started_at.elapsed().as_millis(),
    );
    if should_shutdown {
        state.shutdown_signal.cancel();
    }
    Ok(())
}

fn audit_value(value: &str) -> String {
    value
        .chars()
        .take(128)
        .map(|character| {
            if character.is_ascii_alphanumeric() || "-_.:".contains(character) {
                character
            } else {
                '_'
            }
        })
        .collect()
}

async fn wait_for_peer_disconnect<R>(reader: &mut R) -> std::io::Result<()>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut byte = [0_u8; 1];
    match reader.read(&mut byte).await? {
        0 => Ok(()),
        _ => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "ShipFlow IPC accepts one request per connection.",
        )),
    }
}

async fn handle_request(
    state: &HttpApiState,
    request: RpcRequest,
) -> Result<(RpcMessage, bool), RpcError> {
    request.validate()?;
    let token = request.auth_token.as_deref().unwrap_or_default();
    if state.internal_auth_token.is_empty()
        || !constant_time_token_eq(token, &state.internal_auth_token)
    {
        return Err(RpcError::new(
            "unauthorized",
            "Internal ShipFlow credential is invalid.",
        ));
    }

    let request_id = request.id.clone();
    let result = match request.method.as_str() {
        "service.status" => json!({
            "service": "running",
            "product": SERVICE_STATUS_PRODUCT,
            "processId": std::process::id(),
            "mode": state.mode.clone(),
            "bindAddress": state.bind_address.clone(),
            "port": state.port,
        }),
        "service.shutdown" => {
            return Ok((
                RpcMessage::response(request_id, json!({ "status": "stopping" })),
                true,
            ));
        }
        "tracking.track" => {
            let params = parse_lookup_params(request.params)?;
            serialize_lookup_result(
                resolve_tracking_payload(
                    state,
                    &params.lookup_id,
                    LookupRequestOptions {
                        force_refresh: params.force_refresh,
                    },
                    "ipc_track",
                    &request_id,
                    LookupTrafficClass::Internal,
                )
                .await,
            )?
        }
        "tracking.bag" => {
            let params = parse_lookup_params(request.params)?;
            serialize_lookup_result(
                resolve_bag_payload(
                    state,
                    &params.lookup_id,
                    LookupRequestOptions {
                        force_refresh: params.force_refresh,
                    },
                    "ipc_bag",
                    &request_id,
                    LookupTrafficClass::Internal,
                )
                .await,
            )?
        }
        "tracking.manifest" => {
            let params = parse_lookup_params(request.params)?;
            serialize_lookup_result(
                resolve_manifest_payload(
                    state,
                    &params.lookup_id,
                    LookupRequestOptions {
                        force_refresh: params.force_refresh,
                    },
                    "ipc_manifest",
                    &request_id,
                    LookupTrafficClass::Internal,
                )
                .await,
            )?
        }
        method => {
            return Err(RpcError::new(
                "method_not_found",
                format!("Unsupported ShipFlow Service IPC method: {method}"),
            ));
        }
    };

    Ok((RpcMessage::response(request_id, result), false))
}

fn parse_lookup_params(params: Value) -> Result<LookupParams, RpcError> {
    let params: LookupParams = serde_json::from_value(params)
        .map_err(|error| RpcError::new("invalid_params", error.to_string()))?;
    if params.lookup_id.trim().is_empty() {
        return Err(RpcError::new("bad_request", "Lookup id is required."));
    }
    Ok(params)
}

fn serialize_lookup_result<T: serde::Serialize>(
    result: Result<T, TrackingError>,
) -> Result<Value, RpcError> {
    let payload = result.map_err(rpc_error_from_tracking_error)?;
    serde_json::to_value(payload)
        .map_err(|error| RpcError::new("serialization_error", error.to_string()))
}

fn rpc_error_from_tracking_error(error: TrackingError) -> RpcError {
    match error {
        TrackingError::BadRequest(message) => RpcError::new("bad_request", message),
        TrackingError::NotFound(message) => RpcError::new("not_found", message),
        TrackingError::RateLimited(message) => RpcError::new("rate_limited", message),
        TrackingError::ServiceUnavailable(message) => RpcError::new("service_unavailable", message),
        TrackingError::Upstream(message) => RpcError::new("upstream", message),
    }
}

#[cfg(test)]
mod tests {
    use super::{drain_internal_ipc_connections, handle_request, parse_lookup_params};
    use crate::{
        bag_route_cache::BagRouteCacheState,
        contact_cache::ContactCacheState,
        http_api::{HttpApiState, ShutdownSignal},
        lookup_cache::LookupCacheState,
        model::ServiceRuntimeMode,
        upstream_backpressure::UpstreamBackpressure,
    };
    use serde_json::json;
    use shipflow_core::model::TrackingSourceConfig;
    use shipflow_ipc::{RpcMessage, RpcRequest, PROTOCOL_VERSION};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use tokio::task::JoinSet;

    #[test]
    fn lookup_params_preserve_dotted_shipment_ids() {
        let params = parse_lookup_params(json!({
            "lookupId": "P2606020189412.30",
            "forceRefresh": true,
        }))
        .expect("params should parse");

        assert_eq!(params.lookup_id, "P2606020189412.30");
        assert!(params.force_refresh);
    }

    #[test]
    fn service_request_contract_keeps_internal_auth_out_of_params() {
        let request = RpcRequest {
            protocol_version: PROTOCOL_VERSION,
            id: "request-1".into(),
            method: "tracking.track".into(),
            auth_token: Some("sf_internal".into()),
            params: json!({ "lookupId": "P1" }),
        };
        let value = serde_json::to_value(request).expect("request serializes");

        assert_eq!(value["authToken"], "sf_internal");
        assert!(value["params"].get("authToken").is_none());
    }

    #[tokio::test]
    async fn status_requires_internal_auth_and_reports_service_identity() {
        let state = test_state();
        let unauthorized = handle_request(
            &state,
            RpcRequest {
                protocol_version: PROTOCOL_VERSION,
                id: "status-1".into(),
                method: "service.status".into(),
                auth_token: Some("sf_wrong".into()),
                params: json!({}),
            },
        )
        .await
        .expect_err("wrong token should fail");
        assert_eq!(unauthorized.code, "unauthorized");

        let (message, should_shutdown) = handle_request(
            &state,
            RpcRequest {
                protocol_version: PROTOCOL_VERSION,
                id: "status-2".into(),
                method: "service.status".into(),
                auth_token: Some("sf_internal".into()),
                params: json!({}),
            },
        )
        .await
        .expect("valid status request should succeed");
        let RpcMessage::Response { result, .. } = message else {
            panic!("status should return a response")
        };
        assert_eq!(result["product"], "shipflow-service");
        assert_eq!(result["service"], "running");
        assert_eq!(result["processId"], std::process::id());
        assert!(!should_shutdown);
    }

    #[tokio::test]
    async fn bounded_connection_drain_aborts_and_joins_slow_tasks() {
        struct DropSignal(Arc<AtomicBool>);

        impl Drop for DropSignal {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }

        let dropped = Arc::new(AtomicBool::new(false));
        let drop_signal = DropSignal(dropped.clone());
        let mut connections = JoinSet::new();
        connections.spawn(async move {
            let _drop_signal = drop_signal;
            std::future::pending::<()>().await;
        });

        drain_internal_ipc_connections(&mut connections, std::time::Duration::from_millis(10))
            .await;

        assert!(connections.is_empty());
        assert!(dropped.load(Ordering::SeqCst));
    }

    fn test_state() -> HttpApiState {
        HttpApiState {
            client: reqwest::Client::new(),
            auth_token: "sf_public".into(),
            internal_auth_token: "sf_internal".into(),
            mode: ServiceRuntimeMode::Local,
            bind_address: "127.0.0.1".into(),
            port: 18422,
            tracking_source: TrackingSourceConfig::default(),
            lookup_cache: LookupCacheState::default(),
            contact_cache: ContactCacheState::default(),
            bag_route_cache: BagRouteCacheState::default(),
            public_upstream_backpressure: UpstreamBackpressure::public_default(),
            upstream_backpressure: UpstreamBackpressure::default(),
            contact_backpressure: UpstreamBackpressure::contact_default(),
            http_ingress_backpressure: UpstreamBackpressure::http_ingress_default(),
            shutdown_signal: ShutdownSignal::new(),
            started_at: std::time::Instant::now(),
        }
    }
}
