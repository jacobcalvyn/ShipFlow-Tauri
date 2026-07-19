# Electron Parity Program

## Status

Source and runtime cutover complete. The Electron runtime, native Rust hosts,
packaging, and packaged macOS smoke test pass. Dormant Tauri source, config,
installer, evidence scripts, and obsolete architecture documents are removed.

## Decision

ShipFlow has migrated from Tauri to a single ShipFlow product suite with:

- one Electron and React `ShipFlow Desktop` application
- one native Rust `shipflow-service` agent
- one native Rust `shipflow-workspace-host` sidecar
- one installer and one atomic updater per operating system

Electron does not launch, embed, or wrap a Tauri executable. Tauri is not part
of the source workspace, dependency graph, build, package, or release pipeline.

## Ownership

### Electron Desktop

Owns:

- application and window lifecycle
- menus, file dialogs, clipboard, and external navigation
- secure preload IPC
- renderer lifecycle and React UI
- service settings and external API-key management surfaces
- packaged suite updates

Does not own:

- POS scraping or tracking normalization
- SQLite or DuckDB workspace execution
- service lookup cache or upstream concurrency

### Rust Service Agent

Owns:

- `/v1/*` HTTP API for third-party clients
- POS scraping, tracking normalization, cache, and upstream backpressure
- headless request processing and graceful shutdown

Electron owns Service process lifecycle, tray, login autostart, configuration,
and encrypted credentials. Electron-to-Service and Workspace-Host-to-Service
traffic uses a Unix domain socket on macOS or local named pipe on Windows with a
private suite credential. The third-party HTTP API keeps a separate, explicit
bearer token.

### Rust Workspace Host

Owns:

- SQLite workspace persistence
- DuckDB pivot and chart execution
- import jobs
- row queries and tracking refresh orchestration
- one isolated database runtime per Electron workspace window

The Workspace Host is a Desktop-owned sidecar and communicates over a versioned,
framed JSON protocol through standard input and standard output.

## Security Contract

The Electron renderer runs with:

- `contextIsolation: true`
- `sandbox: true`
- `nodeIntegration: false`
- no remote content
- a strict Content Security Policy
- a narrow, allowlisted preload bridge
- navigation and new-window denial by default

Desktop internal IPC credentials must never be shown as user configuration.
Public API keys remain explicit because they are intended for third-party clients.

## Data Compatibility Contract

The migration preserves:

- ShipFlow workspace document format
- SQLite workspace databases
- DuckDB-derived analytics behavior
- Service configuration and lookup/contact caches
- current platform-standard application-data locations

Any path or schema migration must be idempotent, create a backup before mutation,
and expose rollback evidence in logs.

## Parity Matrix

| Surface | Required behavior | Gate |
| --- | --- | --- |
| Workspace windows | Independent document claim, title, dirty state, close guard, and database | Electron multi-window integration test |
| Sheets | Create, rename, delete, transfer, isolation, and persistence | Existing unit tests plus packaged smoke |
| Tracking | Five Desktop lookups in flight, ordered queue, per-row progress, terminal success/failure | Stress and fault-injection tests |
| Import | Multiple Bag/Manifest IDs, four preview workers, timeout, retry failed item, exact dotted IDs | Existing import tests plus sidecar integration |
| Table | Filtering, value options, sorting, pin/hide, selection, and virtualized rows | React and Playwright parity tests |
| Analytics | Pivot default mode, row/column/value DnD, aggregation typing, sort, and chart parity | Rust engine tests plus visual smoke |
| Service | Background availability, health, restart, Electron tray, single instance, and autostart | Electron lifecycle and native agent integration tests |
| Internal connection | Automatic native endpoint discovery with no endpoint or token form | IPC authorization and transport tests |
| External API | Versioned `/v1/*`, OpenAPI, scoped bearer tokens, explicit LAN exposure | API contract and security tests |
| Persistence | Existing config, caches, workspace files, and databases survive upgrade | Clean-install and upgrade tests |
| Packaging | One installer contains Desktop and both Rust binaries | macOS local and Windows CI packaged smoke |
| Updater | Suite update is atomic and rollback-safe | Signed-artifact verifier when credentials exist |

## Build And Publication Contract

- The Quality Gate is the only workflow that owns the complete frontend, Rust,
  Clippy, formatting, native IPC, and Electron smoke suites.
- Manual platform workflows may package a commit only after the Quality Gate
  has succeeded for that exact SHA.
- Packaging always uses `--publish never`; installer creation cannot publish a
  GitHub release as a side effect.
- Unsigned builds omit all signing credentials and disable certificate
  auto-discovery. Unsigned macOS artifacts use a full ad-hoc signature and must
  pass strict deep signature verification; signed builds receive credentials
  only in their dedicated packaging step after validation.
- Artifact upload, release publication, code signing, and notarization are
  separate operations with explicit credentials and permissions.
- Manual macOS builds publish only the DMG installer. ZIP, update metadata, and
  blockmap artifacts are reserved for the dedicated updater workflow so GitHub
  artifacts do not contain two compressed copies of the same application.
- Electron packages retain only English and Indonesian locales, omit production
  source maps, and package stripped thin-LTO Rust binaries.

## Cutover Gates

The migration is complete only when:

1. Electron packaged builds pass all parity and security gates on macOS and Windows.
2. A Tauri installation upgrades without losing configuration or workspace data.
3. No production source imports `@tauri-apps/*`.
4. No Cargo workspace package depends on `tauri` or `tauri-plugin-*`.
5. Tauri configs, installers, updater scripts, and workflows are removed.
6. The shipped Electron process never launches a Tauri binary.

Gates 3 through 6 are complete in the repository. Gate 1 is complete for the
local macOS package and is enforced for Windows by GitHub Actions on the next
published revision. Gate 2 is implemented through the stable application-data
identity, existing workspace schema migration, and legacy Service config
import; final manual in-place upgrade smoke remains a release validation step.

## Current Evidence

- `npm run typecheck` passes.
- `npm test` must pass the complete frontend suite; the exact test count is
  intentionally not pinned because it grows with the product.
- `cargo test --workspace --all-targets`, strict Clippy, and Rust formatting pass.
- development Electron smoke passes against real Service and Workspace Host
  child processes.
- the unpacked macOS Electron application passes packaged-process smoke and
  contains both native Rust executables.
- package content and security baseline verifiers pass.
- Windows package creation and native resource checks run in GitHub Actions;
  manual Windows installation smoke remains unavailable in this workspace.
- production signing, notarization, and signed updater publication remain
  blocked until the required platform credentials are available.
