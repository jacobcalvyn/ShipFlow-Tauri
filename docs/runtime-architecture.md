# Runtime Architecture

## Product Boundary

ShipFlow is one installed Electron suite with two native Rust executables. The
Electron process owns user-facing lifecycle. Rust owns data and network work.

| Runtime | Responsibility |
| --- | --- |
| Electron main | workspace windows, tray, menus, single instance, updates, file dialogs, native process supervision |
| Electron preload | narrow, context-isolated, allowlisted IPC |
| React renderer | visual state, user interaction, visible row windows |
| ShipFlow Service | public HTTP API, native internal IPC, scraping, cache, source selection, request concurrency and backpressure |
| Workspace Host | SQLite workspace mutations, import jobs, progress events, DuckDB pivot/chart queries |

## Native Process Topology

Electron starts one managed `shipflow-service` instance. Every workspace window
gets one `shipflow-workspace-host` process and one workspace database. Closing a
window terminates only its Workspace Host.

Electron and Workspace Hosts call the Service through a Unix domain socket on
macOS or a local-only named pipe on Windows. Each request uses a private suite
credential. The public HTTP port and token are separate and exist only for
third-party API clients. Neither internal credential nor native process control
is exposed to a renderer.

## IPC Contract

Renderer code can only use commands and workspace methods declared in
`src/backend/bridge-contract.ts`. The preload rejects unknown commands. Electron
main independently validates the sender window, top-level frame, command scope,
argument shape, and workspace method.

Workspace RPC and Service IPC use newline-delimited JSON with a protocol
version, request ID, bounded frame size, bounded timeout, and one terminal
response or error. Workspace RPC additionally carries progress events. The
Service transport is permission-restricted to the current OS user on macOS and
rejects remote named-pipe clients on Windows.

Each Service IPC connection carries exactly one request. If the caller closes
the connection or reaches its timeout, the Service drops the in-flight lookup
future so abandoned requests release their upstream concurrency slot.

## Storage

The main database remains at the historical application-data identity:

```text
<appData>/com.shipflow.desktop/workspace-engine/workspace.sqlite3
```

The stable identity lets Electron reuse existing Rust workspace data without
copying a large SQLite/WAL pair. Additional workspace windows use isolated
databases below `workspace-engine/windows/<window-label>`.

Service Agent configuration lives at:

```text
<appData>/ShipFlow Service/shipflow-service-runtime/agent-config.json
```

Electron imports the legacy Service config on first run. Secret values are
encrypted with `safeStorage` when OS credential encryption is available.
If a legacy Service already owns the configured port without the managed IPC
endpoint, Electron rejects startup with an explicit instruction to stop it.
Electron never adopts a process through the public token and never kills an
unverified process by stale PID.

## Runtime Logs

Electron main owns the suite log and combines lifecycle events, renderer runtime
errors, Service output, and Workspace Host diagnostics into
`shipflow-desktop.log`. The file lives in Electron's platform-native logs
directory and rotates to one bounded `.1` backup after reaching 5 MiB.
ShipFlow and Authorization token patterns are redacted before persistence.

Users can open the active file from either the native
`File > Open Log File` menu or the workspace toolbar
`File > Buka File Log` action. The renderer receives no arbitrary filesystem
path or direct filesystem access.

## Lifecycle Rules

1. Only one Electron suite instance may run per OS user.
2. A second launch focuses the existing workspace and may open its integrated Service Settings modal.
3. The tray belongs to Electron, never to a Rust child process.
4. Closing windows keeps the Service running only when tray persistence is enabled.
5. Quit and updater installation stop all Workspace Hosts and the managed Service.
6. A foreign or stale Service occupying the configured port is detected before spawn and reported explicitly.

Service Settings is not a separate application window. Workspace display,
tracking source, and public API settings share one modal in the active Desktop
window. The modal backdrop blocks workspace interaction until the user saves or
cancels it. Tray, menu, and `--service-settings` entry points all focus the
Desktop window and select the Service section in that modal.

## Security Boundary

- renderer Node integration is disabled;
- context isolation and renderer sandboxing are enabled;
- navigation and new-window creation are denied;
- CSP is applied by Electron session headers;
- OS permissions requested by renderers are denied;
- Service credentials are stored outside renderer storage;
- POD URL fetching is validated and size bounded;
- native RPC methods are allowlisted in preload and main.

## Release Model

Electron Builder creates one platform installer containing Electron,
`shipflow-service`, `shipflow-workspace-host`, DuckDB runtime files where needed,
and application icons. CI verifies packaged resources before artifact upload.

The current release-readiness boundary is runtime readiness before signing.
Unsigned local macOS packages are smoke-tested as real Electron applications.
Windows package creation is verified in GitHub Actions. Apple notarization,
platform signing, signed updater publication, and manual Windows installation
smoke remain explicit external prerequisites.
