# Runtime Architecture

## Product Boundary

ShipFlow is one installed Electron suite with two native Rust executables. The
Electron process owns user-facing lifecycle. Rust owns data and network work.

| Runtime | Responsibility |
| --- | --- |
| Electron main | workspace windows, tray, menus, single instance, updates, file dialogs, native process supervision |
| Electron preload | narrow, context-isolated, allowlisted IPC |
| React renderers | isolated workspace and Service Settings presentation |
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
The Service accepts at most 128 simultaneous internal IPC connections. Reading
and writing an IPC frame each has a 10-second limit, while the native client
allows 130 seconds for the complete request so the Service's 120-second lookup
deadline remains authoritative.

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
unverified process by stale PID. The managed native endpoint is deterministic
for the OS user and Desktop data identity. If a Service survives an unexpected
Electron exit, the next launch authenticates it through private IPC, asks it to
stop, waits for the endpoint to close, and starts a fresh supervised process.
It is never adopted through the public API.

## Runtime Logs

Electron main writes lifecycle events, renderer runtime errors, and Workspace
Host diagnostics to `shipflow-desktop.log`. The managed Rust Service writes
native HTTP, IPC, backpressure, cache, and memory diagnostics directly to
`shipflow-service.log` through its own cross-platform rotating writer. Electron
passes only the destination path, so Service logging and authenticated orphan
recovery remain functional if Electron crashes. Both files live in Electron's
platform-native logs directory, rotate during a long-running process, and keep
one bounded `.1` backup after reaching 5 MiB.
Each entry includes a per-launch session ID and monotonic sequence. Structured
events cover application startup and shutdown, windows, renderer termination,
native child-process lifecycle, IPC duration and result, Service restart, and
60-second memory snapshots. Individual entries are capped at 32 KiB. ShipFlow,
Authorization, and common secret-field patterns are redacted before
persistence.

Users can open the active file from either the native
`File > Open Log File` or `File > Open Logs Folder` menu, or the workspace toolbar
`File > Buka File Log` action. The renderer receives no arbitrary filesystem
path or direct filesystem access.

Run the privacy-preserving summary analyzer against either active file. It
automatically includes the adjacent Desktop or Service file and all optional
rotated backups:

```bash
npm run diagnostics:log -- "/path/to/shipflow-desktop.log"
```

The default report prints Electron and native Service event counts, risk
signals, sessions, error scopes, HTTP 5xx totals, and memory peaks without
printing raw operational messages. Packaged smoke uses `--fail-on=high` as an
enforced quality gate. Add `--verbose` only during local investigation. Runtime
logs can still contain shipment or facility identifiers emitted by native
components and must be treated as operationally sensitive.
The cross-platform evidence procedure is documented in
[runtime-log-audit.md](./runtime-log-audit.md).

## Lifecycle Rules

1. Only one Electron suite instance may run per OS user.
2. A second launch focuses the existing workspace or opens the dedicated Service Settings window.
3. The tray belongs to Electron, never to a Rust child process.
4. Closing windows keeps the Service running only when tray persistence is enabled.
5. Quit and updater installation stop all Workspace Hosts and the managed Service.
6. A foreign or stale Service occupying the configured port is detected before spawn and reported explicitly.
7. Unexpected Service exits are restarted after 1, 2, 5, 10, and 30 seconds.
8. More than five unexpected exits inside a two-minute window stop automatic restart and require an explicit lifecycle action.

Service Settings is a dedicated application window with its own renderer and
persistent Electron session partition. It belongs to the same single-instance
application and controls the same managed Service process. Workspace display
settings remain in the workspace window. Tray, menu, and
`--service-settings` entry points focus the existing Service Settings window or
create exactly one when none exists. Service Settings has no Workspace Engine
access, while workspace renderers no longer mount Service configuration UI.
On Windows, renderer crash-loop accounting is scoped to workspace windows;
a Service Settings renderer failure cannot enable workspace hardware safe mode.

The managed Service exposes authenticated `/v1/diagnostics` data for uptime,
current-suite restart count, RSS, cache sizes, and active or queued
backpressure lanes. HTTP ingress, upstream lookups, public lookups, and contact
enrichment each have independent bounded lanes. Successful lookup payloads are
persisted through a single bounded SQLite WAL writer instead of rewriting one
JSON snapshot per result. A maintenance task prunes the in-memory lookup cache
and logs a diagnostic snapshot every 60 seconds. These metrics are operational
signals, not a durable monitoring history.

## Security Boundary

- renderer Node integration is disabled;
- context isolation and renderer sandboxing are enabled;
- navigation and new-window creation are denied;
- CSP is declared in the packaged renderer HTML, which is the supported enforcement path for the local `file://` renderer;
- OS permissions requested by renderers are denied;
- Service credentials are stored outside renderer storage;
- POD URL fetching is validated and size bounded;
- native RPC methods are allowlisted in preload and main.

## Release Model

Electron Builder creates one platform installer containing Electron,
`shipflow-service`, `shipflow-workspace-host`, DuckDB runtime files where needed,
and application icons. CI verifies packaged resources and launches the unpacked
application on both macOS and Windows. The packaged smoke test verifies the
isolated settings flow, single-instance behavior, native API health, and
managed Service crash recovery before artifact upload.

The current release-readiness boundary is runtime readiness before signing.
Unsigned macOS and Windows unpacked packages are smoke-tested as real Electron
applications in GitHub Actions. Apple notarization, platform signing, signed
updater publication, and manual installer walkthroughs remain explicit external
prerequisites. Failed Electron smoke jobs upload their Playwright report,
screenshots, and attached isolated Desktop plus Service runtime logs for 14
days.
