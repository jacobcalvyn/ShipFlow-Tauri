use serde::Deserialize;
use serde_json::{json, Value};
use shipflow_core::model::TrackingError;
use shipflow_ipc::{
    read_json_frame, write_json_frame, LocalIpcListener, RpcError, RpcMessage, RpcRequest,
};
use tokio::io::AsyncReadExt;

use crate::http_api::{
    constant_time_token_eq, resolve_bag_payload, resolve_manifest_payload,
    resolve_tracking_payload, HttpApiState,
};
use crate::lookup_cache::LookupRequestOptions;
use crate::model::SERVICE_STATUS_PRODUCT;

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
    loop {
        tokio::select! {
            _ = state.shutdown_signal.notified() => return Ok(()),
            accepted = listener.accept() => {
                let stream = accepted
                    .map_err(|error| format!("Internal IPC listener failed: {error}"))?;
                let connection_state = state.clone();
                tokio::spawn(async move {
                    if let Err(error) = handle_connection(stream, connection_state).await {
                        eprintln!("[ShipFlowIPC] internal connection failed: {error}");
                    }
                });
            }
        }
    }
}

async fn handle_connection(
    stream: shipflow_ipc::LocalIpcServerStream,
    state: HttpApiState,
) -> Result<(), String> {
    let (mut reader, mut writer) = tokio::io::split(stream);
    let request: RpcRequest = read_json_frame(&mut reader)
        .await
        .map_err(|error| format!("Unable to read internal IPC request: {error}"))?;
    let request_id = request.id.clone();
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
    write_json_frame(&mut writer, &message)
        .await
        .map_err(|error| format!("Unable to write internal IPC response: {error}"))?;
    if should_shutdown {
        state.shutdown_signal.notify_waiters();
    }
    Ok(())
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
    use serde_json::json;
    use shipflow_core::model::TrackingSourceConfig;
    use shipflow_ipc::{RpcMessage, RpcRequest, PROTOCOL_VERSION};
    use std::sync::Arc;
    use tokio::sync::Notify;

    use super::{handle_request, parse_lookup_params};
    use crate::{
        contact_cache::ContactCacheState, http_api::HttpApiState, lookup_cache::LookupCacheState,
        model::ServiceRuntimeMode, upstream_backpressure::UpstreamBackpressure,
    };

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
        assert!(!should_shutdown);
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
            upstream_backpressure: UpstreamBackpressure::default(),
            shutdown_signal: Arc::new(Notify::new()),
        }
    }
}
