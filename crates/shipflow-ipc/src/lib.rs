use std::io;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

#[cfg(unix)]
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
#[cfg(unix)]
use std::path::PathBuf;
#[cfg(windows)]
use tokio::net::windows::named_pipe::{
    ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions,
};
#[cfg(unix)]
use tokio::net::{UnixListener, UnixStream};

pub const PROTOCOL_VERSION: u16 = 1;
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcRequest {
    pub protocol_version: u16,
    pub id: String,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_token: Option<String>,
    #[serde(default)]
    pub params: Value,
}

impl RpcRequest {
    pub fn validate(&self) -> Result<(), RpcError> {
        if self.protocol_version != PROTOCOL_VERSION {
            return Err(RpcError::new(
                "unsupported_protocol",
                format!(
                    "Unsupported ShipFlow IPC protocol version {}. Expected {}.",
                    self.protocol_version, PROTOCOL_VERSION
                ),
            ));
        }
        if self.id.trim().is_empty() {
            return Err(RpcError::new("invalid_request", "Request id is required."));
        }
        if self.method.trim().is_empty() {
            return Err(RpcError::new(
                "invalid_request",
                "Request method is required.",
            ));
        }
        Ok(())
    }
}

pub async fn write_json_frame<W, T>(writer: &mut W, value: &T) -> io::Result<()>
where
    W: tokio::io::AsyncWrite + Unpin,
    T: Serialize,
{
    let payload = serde_json::to_vec(value)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if payload.len() > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "ShipFlow IPC frame exceeds the maximum size.",
        ));
    }
    writer.write_all(&payload).await?;
    writer.write_all(b"\n").await?;
    writer.flush().await
}

pub async fn read_json_frame<R, T>(reader: &mut R) -> io::Result<T>
where
    R: tokio::io::AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let reader = BufReader::new(reader);
    let mut payload = Vec::new();
    let bytes_read = reader
        .take((MAX_FRAME_BYTES + 1) as u64)
        .read_until(b'\n', &mut payload)
        .await?;
    if bytes_read == 0 {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "ShipFlow IPC peer closed before sending a response.",
        ));
    }
    if payload.len() > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "ShipFlow IPC frame exceeds the maximum size.",
        ));
    }
    while matches!(payload.last(), Some(b'\n' | b'\r')) {
        payload.pop();
    }
    serde_json::from_slice(&payload)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

#[cfg(unix)]
pub type LocalIpcServerStream = UnixStream;
#[cfg(unix)]
pub type LocalIpcClientStream = UnixStream;

#[cfg(unix)]
pub struct LocalIpcListener {
    listener: UnixListener,
    path: PathBuf,
}

#[cfg(unix)]
impl LocalIpcListener {
    pub fn bind(endpoint: &str) -> io::Result<Self> {
        let path = PathBuf::from(endpoint);
        if endpoint.trim().is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "ShipFlow IPC endpoint is required.",
            ));
        }
        if let Ok(metadata) = std::fs::symlink_metadata(&path) {
            if !metadata.file_type().is_socket() {
                return Err(io::Error::new(
                    io::ErrorKind::AddrInUse,
                    "ShipFlow IPC endpoint exists and is not a Unix socket.",
                ));
            }
            std::fs::remove_file(&path)?;
        }
        let listener = UnixListener::bind(&path)?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        Ok(Self { listener, path })
    }

    pub async fn accept(&self) -> io::Result<LocalIpcServerStream> {
        self.listener.accept().await.map(|(stream, _)| stream)
    }
}

#[cfg(unix)]
impl Drop for LocalIpcListener {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(unix)]
pub async fn connect_local_ipc(endpoint: &str) -> io::Result<LocalIpcClientStream> {
    UnixStream::connect(endpoint).await
}

#[cfg(windows)]
pub type LocalIpcServerStream = NamedPipeServer;
#[cfg(windows)]
pub type LocalIpcClientStream = NamedPipeClient;

#[cfg(windows)]
pub struct LocalIpcListener {
    endpoint: String,
}

#[cfg(windows)]
impl LocalIpcListener {
    pub fn bind(endpoint: &str) -> io::Result<Self> {
        if !endpoint.starts_with(r"\\.\pipe\") {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                r"ShipFlow Windows IPC endpoint must start with \\.\pipe\.",
            ));
        }
        Ok(Self {
            endpoint: endpoint.to_string(),
        })
    }

    pub async fn accept(&self) -> io::Result<LocalIpcServerStream> {
        let server = ServerOptions::new()
            .reject_remote_clients(true)
            .create(&self.endpoint)?;
        server.connect().await?;
        Ok(server)
    }
}

#[cfg(windows)]
pub async fn connect_local_ipc(endpoint: &str) -> io::Result<LocalIpcClientStream> {
    loop {
        match ClientOptions::new().open(endpoint) {
            Ok(client) => return Ok(client),
            Err(error) if error.raw_os_error() == Some(231) => {
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
            Err(error) => return Err(error),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcError {
    pub code: String,
    pub message: String,
}

impl RpcError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RpcMessage {
    Ready {
        protocol_version: u16,
        product: String,
        process_id: u32,
    },
    Response {
        protocol_version: u16,
        id: String,
        result: Value,
    },
    Error {
        protocol_version: u16,
        id: String,
        error: RpcError,
    },
    Event {
        protocol_version: u16,
        id: String,
        event: Value,
    },
}

impl RpcMessage {
    pub fn ready(product: impl Into<String>) -> Self {
        Self::Ready {
            protocol_version: PROTOCOL_VERSION,
            product: product.into(),
            process_id: std::process::id(),
        }
    }

    pub fn response(id: impl Into<String>, result: Value) -> Self {
        Self::Response {
            protocol_version: PROTOCOL_VERSION,
            id: id.into(),
            result,
        }
    }

    pub fn error(id: impl Into<String>, error: RpcError) -> Self {
        Self::Error {
            protocol_version: PROTOCOL_VERSION,
            id: id.into(),
            error,
        }
    }

    pub fn event(id: impl Into<String>, event: Value) -> Self {
        Self::Event {
            protocol_version: PROTOCOL_VERSION,
            id: id.into(),
            event,
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{RpcMessage, RpcRequest, PROTOCOL_VERSION};

    #[test]
    fn request_contract_uses_versioned_camel_case_fields() {
        let request = RpcRequest {
            protocol_version: PROTOCOL_VERSION,
            id: "request-1".into(),
            method: "workspace.command".into(),
            auth_token: None,
            params: json!({ "command": "list_sheets" }),
        };

        let json = serde_json::to_value(&request).expect("request serializes");

        assert_eq!(json["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(json["id"], "request-1");
        assert_eq!(json["method"], "workspace.command");
        request.validate().expect("request validates");
    }

    #[test]
    fn request_serializes_internal_auth_only_when_present() {
        let request = RpcRequest {
            protocol_version: PROTOCOL_VERSION,
            id: "request-2".into(),
            method: "service.status".into(),
            auth_token: Some("sf_internal".into()),
            params: json!({}),
        };

        let json = serde_json::to_value(&request).expect("request serializes");

        assert_eq!(json["authToken"], "sf_internal");
    }

    #[test]
    fn event_contract_keeps_request_correlation_id() {
        let message = RpcMessage::event("request-7", json!({ "type": "progress" }));
        let json = serde_json::to_value(message).expect("message serializes");

        assert_eq!(json["kind"], "event");
        assert_eq!(json["id"], "request-7");
        assert_eq!(json["protocolVersion"], PROTOCOL_VERSION);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_transport_round_trips_a_versioned_frame() {
        let endpoint = std::path::Path::new("/tmp").join(format!(
            "shipflow-ipc-test-{}-{}.sock",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should be valid")
                .as_nanos()
        ));
        let endpoint_string = endpoint.to_string_lossy().into_owned();
        let listener =
            super::LocalIpcListener::bind(&endpoint_string).expect("listener should bind");
        let server = tokio::spawn(async move {
            let mut stream = listener.accept().await.expect("server should accept");
            let request: RpcRequest = super::read_json_frame(&mut stream)
                .await
                .expect("server should read request");
            super::write_json_frame(
                &mut stream,
                &RpcMessage::response(request.id, serde_json::json!({ "ok": true })),
            )
            .await
            .expect("server should write response");
        });

        let mut stream = super::connect_local_ipc(&endpoint_string)
            .await
            .expect("client should connect");
        super::write_json_frame(
            &mut stream,
            &RpcRequest {
                protocol_version: PROTOCOL_VERSION,
                id: "transport-1".into(),
                method: "service.status".into(),
                auth_token: Some("sf_internal".into()),
                params: serde_json::json!({}),
            },
        )
        .await
        .expect("client should write request");
        let response: RpcMessage = super::read_json_frame(&mut stream)
            .await
            .expect("client should read response");

        assert_eq!(
            serde_json::to_value(response).expect("response serializes")["result"]["ok"],
            true
        );
        server.await.expect("server task should finish");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_named_pipe_round_trips_a_versioned_frame() {
        let endpoint = format!(
            r"\\.\pipe\shipflow-ipc-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should be valid")
                .as_nanos()
        );
        let listener = super::LocalIpcListener::bind(&endpoint).expect("listener should configure");
        let server = tokio::spawn(async move {
            let mut stream = listener.accept().await.expect("server should accept");
            let request: RpcRequest = super::read_json_frame(&mut stream)
                .await
                .expect("server should read request");
            super::write_json_frame(
                &mut stream,
                &RpcMessage::response(request.id, serde_json::json!({ "ok": true })),
            )
            .await
            .expect("server should write response");
        });

        let mut stream = super::connect_local_ipc(&endpoint)
            .await
            .expect("client should connect");
        super::write_json_frame(
            &mut stream,
            &RpcRequest {
                protocol_version: PROTOCOL_VERSION,
                id: "transport-1".into(),
                method: "service.status".into(),
                auth_token: Some("sf_internal".into()),
                params: serde_json::json!({}),
            },
        )
        .await
        .expect("client should write request");
        let response: RpcMessage = super::read_json_frame(&mut stream)
            .await
            .expect("client should read response");

        assert_eq!(
            serde_json::to_value(response).expect("response serializes")["result"]["ok"],
            true
        );
        server.await.expect("server task should finish");
    }
}
