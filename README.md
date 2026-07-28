# ShipFlow Desktop

ShipFlow is a desktop shipment workspace built as one installed Electron product
with native Rust engines.

The shipped suite contains:

- one Electron application with isolated workspace and Service Settings
  windows, plus tray, menus, file integration, and updates;
- `shipflow-service`, a headless Rust HTTP agent for tracking, Bag, Manifest,
  caching, concurrency, and third-party API access;
- `shipflow-workspace-host`, a per-window Rust sidecar for SQLite workspace
  state, DuckDB analytics, import jobs, and tracking progress;
- one installer that owns the Electron shell and both Rust executables.

Electron never launches or embeds a Tauri executable. React owns presentation
state only; operational and analytical data stay in Rust.

## Runtime Architecture

```text
React renderer
  -> narrow context-isolated preload bridge
  -> Electron main process
       -> ShipFlow Service (Unix socket on macOS, named pipe on Windows)
       -> Workspace Host (NDJSON RPC, one process per workspace window)
            -> ShipFlow Service (native local IPC, private suite credential)
            -> SQLite workspace database
            -> DuckDB analytics
```

The private suite credential is generated and encrypted by Electron and is not
shown in the UI. The public API token shown in Service Settings is only for
third-party clients.

Service Settings uses a dedicated Electron window, HTML entry, renderer bundle,
and persistent session partition. It remains part of the same installed
application and controls the same managed Rust Service process, but it does not
load workspace UI code and a renderer failure cannot take down or reload the
workspace renderer.

## Requirements

- Node.js 24 or newer
- Rust stable
- npm
- macOS or Windows

Windows native builds also require the DuckDB runtime DLL prepared by
`scripts/windows/prepare-duckdb-download.ps1`.

## Development

```bash
npm install
npm run dev
```

`npm run dev` builds the debug Rust executables and starts the complete Electron
suite. To run only the headless Service for API development:

```bash
npm run dev:service
```

The default Service endpoint is `http://127.0.0.1:18422`. OpenAPI is available
at `/v1/openapi.json`.

## Validation

```bash
npm run typecheck
npm test
npm run security:baseline
cargo fmt --all -- --check
cargo test --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
```

## Build And Package

```bash
npm run build
npm run build:native
npm run package:dir
```

Create platform installers with `npm run package:macos` or
`npm run package:windows`. Packaging commands always use
`electron-builder --publish never`; creating an artifact never publishes a
GitHub release implicitly.

The manual macOS and Windows artifact workflows require a successful Quality
Gate for the exact commit being packaged. The Quality Gate builds unpacked
packages on both operating systems and launches each real package to verify
single-instance behavior, isolated Service settings, API health, and managed
Service crash recovery. Artifact workflows then build, verify, and upload the
installer without repeating the full suites. Publishing a release remains a
separate, explicit operation with release credentials.

Unsigned workflows omit signing credentials entirely and disable certificate
auto-discovery. Unsigned macOS artifacts receive a complete ad-hoc signature so
their bundle integrity remains verifiable, while signed workflows inject
platform credentials only after their dedicated credential validation step
succeeds.

Unsigned local builds are suitable for development smoke tests. Production
macOS distribution still requires Apple Developer signing and notarization.
Production Windows distribution still requires a code-signing certificate.
GitHub Actions performs the Windows build because local Windows validation is
not available in this workspace.

## Data And Configuration

Desktop data:

- macOS: `~/Library/Application Support/com.shipflow.desktop`
- Windows: `%APPDATA%\\com.shipflow.desktop`

The main workspace database is stored at
`workspace-engine/workspace.sqlite3` below that directory. Electron keeps the
historical application identifier, so an existing database is reused in place.

Service Agent configuration:

- macOS: `~/Library/Application Support/ShipFlow Service/shipflow-service-runtime/agent-config.json`
- Windows: `%APPDATA%\\ShipFlow Service\\shipflow-service-runtime\\agent-config.json`

Service tokens are encrypted at rest through Electron `safeStorage` when OS
credential encryption is available. Legacy Service configuration is imported
on first run and rewritten into the Agent configuration. An older standalone
Service that still owns the configured HTTP port must be stopped before the
managed suite can start; Electron never adopts it through the public API token.

Do not use `C:\\ShipFlow\\Data`; that legacy machine-wide location is no longer
part of the runtime contract.

Runtime diagnostics are written to `shipflow-desktop.log` and
`shipflow-service.log` in Electron's native logs directory. The Service writes
independently so its HTTP, IPC, backpressure, cache, and memory evidence remains
available after an Electron crash. Both files rotate at 5 MiB and keep one
backup. Desktop entries redact known credential formats and include a session
ID plus sequence. Open the active file from `File > Buka File Log` in the
workspace or `File > Open Log File` / `File > Open Logs Folder` in the native
application menu.

Generate a privacy-preserving operational summary with:

```bash
npm run diagnostics:log -- "/path/to/shipflow-desktop.log"
```

Use `--fail-on=high` when the report is part of an automated runtime gate.

See [docs/runtime-log-audit.md](./docs/runtime-log-audit.md) for the matching
macOS and Windows reproduction, collection, and acceptance procedure.

## Service API

The supported public API is versioned under `/v1` and uses Bearer authentication
for protected routes. Primary routes include:

- `GET /v1/status`
- `GET /v1/auth/check`
- `GET /v1/track/:shipment_id`
- `GET /v1/track/:shipment_id/html`
- `GET /v1/bag/:bag_id`
- `GET /v1/manifest/:manifest_id`
- `GET /v1/openapi.json`

The removed `/v1/jobs/track-batch` route is not part of the contract. Clients
send direct tracking requests; the Service applies bounded concurrency and
backpressure.

See [docs/service-api-v1.md](./docs/service-api-v1.md) and
[docs/runtime-architecture.md](./docs/runtime-architecture.md).

## Repository Layout

- `electron/main`: Electron lifecycle, tray, Service Agent, updater, documents,
  and native process supervision
- `electron/preload`: allowlisted renderer bridge
- `src`: React workspace and Service Settings renderers
- `apps/service`: headless ShipFlow Service executable
- `apps/workspace-host`: workspace-engine RPC executable
- `crates/shipflow-core`: scraping and parsing
- `crates/shipflow-service-runtime`: public HTTP API, internal IPC, cache, and request controls
- `crates/shipflow-workspace-engine`: SQLite and DuckDB workspace engine
- `crates/shipflow-service-client`: native Service client
- `crates/shipflow-ipc`: native RPC contracts

## Release Readiness

Current completion target is **native runtime readiness before signing**:

- local macOS Electron package and installed-app smoke pass;
- unpacked macOS and Windows package smoke passes in GitHub Actions;
- Windows Electron installer build passes in GitHub Actions;
- quality, Rust, security, and packaged-content gates pass;
- signing, notarization, signed updater publication, and Windows manual install
  smoke remain blocked until credentials and the target OS are available.
