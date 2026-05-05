# ShipFlow Desktop

Desktop shipment tracking workspace built with Tauri, Rust, React, and Vite.

The app is optimized for spreadsheet-style operational analysis. Each row represents one shipment. The first data column accepts a shipment ID, then the app asks `ShipFlow Service` for tracking data and fills the rest of the row. A sheet is treated as one independent workspace.

The runtime foundation now supports POS bag and manifest lookups through the shared Rust core and the local service API. The desktop workspace still stays shipment-first, but each sheet can now import shipment IDs from bag and manifest lookups through sheet-local modal flows.

Architecture references:

- [docs/runtime-architecture.md](./docs/runtime-architecture.md)
- [docs/desktop-service-split.md](./docs/desktop-service-split.md)
- [docs/service-api-v1.md](./docs/service-api-v1.md)
- [docs/refactor-audit.md](./docs/refactor-audit.md)
- [docs/native-platform-architecture.md](./docs/native-platform-architecture.md)

## What The App Does

- Runs as a desktop app with Tauri
- Uses a document-style desktop workspace with open / save / save as
- Uses `ShipFlow Service` as the runtime that owns tracking configuration and API access
- Supports both internal POS scraping and external ShipFlow API source selection from `ShipFlow Service`
- Supports three lookup kinds in the runtime layer: `track`, `bag`, and `manifest`
- Shows shipment detail and `status_akhir` fields in a wide spreadsheet-style table
- Supports importing shipment IDs from bag and manifest lookups into the active sheet
- Supports bulk paste, row selection, CSV export, column pin/hide, sorting, and filtering
- Supports both text filters and per-column multi-select value filters with value counts and quick include/exclude actions
- Supports retracking all current shipments from the action bar
- Supports multiple sheets, where each sheet is an isolated tracking workspace
- Supports creating a new sheet from selected shipment IDs only
- Supports appending selected shipment IDs into another existing sheet
- Uses a standalone `ShipFlow Service` for Desktop tracking and optional API access for other apps
- Exposes a documented `ShipFlow Service` API v1 contract for status, capabilities, lookup, and batch tracking jobs

## Tracking Flow

1. Enter a shipment ID in the `Nomor Kiriman` column
2. The frontend calls the Tauri `track_shipment` command
3. `ShipFlow Desktop` forwards the request to `ShipFlow Service`
4. The service runtime resolves the active tracking source:
   - internal POS scraper
   - external ShipFlow API
5. For the internal scraper, the Rust tracking layer converts the shipment ID to Base64 and calls:

```text
https://pid.posindonesia.co.id/lacak/admin/detail_lacak_banyak.php?id=...
```

6. The response is normalized into the app's JSON shape
7. The matching row is updated with shipment details

Example shipment ID:

```text
P2603310114291
```

Example generated upstream URL:

```text
https://pid.posindonesia.co.id/lacak/admin/detail_lacak_banyak.php?id=UDI2MDMzMTAxMTQyOTE%3D
```

## Lookup Kinds

The runtime now distinguishes between:

- `track`: shipment / resi detail
- `bag`: bag detail plus the shipment list inside the bag
- `manifest`: manifest detail plus the bag list inside the manifest

Current ownership:

- `shipflow-core` parses all three kinds
- `ShipFlow Service` exposes all three kinds from the local API
- Desktop and service runtime paths now share one lookup cache facade for `track`, `bag`, and `manifest`
- `ShipFlow Desktop` currently renders only shipment rows in the workspace table

Current local service routes:

- `GET /health`
- `GET /status`
- `GET /track/:shipment_id`
- `GET /bag/:bag_id`
- `GET /manifest/:manifest_id`

Current versioned service API routes:

- `GET /v1/openapi.json`
- `GET /v1/status`
- `GET /v1/capabilities`
- `GET /v1/track/:shipment_id`
- `GET /v1/bag/:bag_id`
- `GET /v1/manifest/:manifest_id`
- `POST /v1/jobs/track-batch`
- `GET /v1/jobs/:job_id`
- `GET /v1/jobs/:job_id/result`
- `POST /v1/jobs/:job_id/cancel`

The full service API contract is documented in [docs/service-api-v1.md](./docs/service-api-v1.md).

Important note:

- external API source selection currently applies to shipment tracking
- bag and manifest lookups currently use the internal POS scraper path

## ShipFlow Service API v1

`ShipFlow Service` owns the local/LAN API used by Desktop and optional internal clients. Every API endpoint requires:

```http
Authorization: Bearer <service-token>
```

Successful `/v1` responses use an envelope with `meta`, `data`, and `warnings`. Errors use the same `meta` shape plus an `error.message`.

Envelope timestamps such as `generatedAt`, `createdAt`, and `updatedAt` use RFC3339 timestamps, for example `2026-05-04T00:00:00.123Z`.

The API supports:

- OpenAPI 3.1 discovery through `GET /v1/openapi.json`
- authenticated status and product identity checks
- capability discovery
- shipment, bag, and manifest lookups
- force-refresh lookups with `x-shipflow-force-refresh: true`
- background batch tracking jobs with start/status/result/cancel endpoints

See [docs/service-api-v1.md](./docs/service-api-v1.md) for endpoint details and example payloads.

Quick setup for other projects and AI agents:

```text
Base URL: http://127.0.0.1:18422
OpenAPI: http://127.0.0.1:18422/v1/openapi.json
Auth: Bearer <ShipFlow Service Token>
```

For LAN clients, replace `127.0.0.1` with the machine IP that runs `ShipFlow Service`:

```text
Base URL: http://<service-host-ip>:18422
OpenAPI: http://<service-host-ip>:18422/v1/openapi.json
Auth: Bearer <ShipFlow Service Token>
```

Use the OpenAPI document as the source of truth for generated clients or agent tool schemas. A `401` response means the route exists but the bearer token is missing or invalid. A `404` response usually means the request is reaching an older service binary or the wrong port.

## Background Batch Jobs

Bulk tracking can be delegated to `ShipFlow Service` through `/v1/jobs/track-batch`.

The job API returns a `jobId`, status endpoint, and result endpoint. A running job can be cancelled through `POST /v1/jobs/:job_id/cancel`. This is the backend foundation for heavier bulk tracking flows without making the Desktop command layer block on every row.

Batch job guardrails:

- up to `1,000` shipment IDs per job
- shipment IDs are trimmed, empty IDs are ignored, and duplicates are collapsed
- individual shipment IDs must be `128` characters or fewer
- completed job records are retained for a bounded service-runtime window and cleaned up automatically

## JSON Shape

The frontend uses this response structure:

- `url`
- `detail`
  - `shipment_header`
  - `origin_detail`
  - `package_detail`
  - `billing_detail`
  - `actors`
  - `performance_detail`
- `status_akhir`
- `pod`
- `history`
- `history_summary`

Main TypeScript definitions live in [src/types.ts](./src/types.ts).

## UI Features

- Spreadsheet-style table with `50` initial rows
- Multi-sheet workspace with create / rename / duplicate / delete sheet
- Sheet tabs use a `+` button for new sheets, keep full sheet names visible, horizontally scroll when needed, and expose sheet-specific actions from a right-click context menu on each tab
- Sticky selector column and sticky `Nomor Kiriman`
- Keyboard row navigation in `Nomor Kiriman` with `Enter`, `ArrowUp`, and `ArrowDown`
- Row checkbox selection for copy/delete actions
- When any text or value filter is active, row selection automatically follows the visible filtered rows only
- Column context menu for:
  - sort
  - pin / unpin
  - hide / unhide
  - filter by value
- Filter row for free-text filtering
- Action bar for:
  - retrack all
  - export CSV
  - copy all shipment IDs
  - clear filter
  - delete all
  - clear selection
  - create a new sheet from selected shipment IDs
  - append selected shipment IDs into another existing sheet from a hover target menu
  - copy selected shipment IDs
  - delete selected rows
- The action bar keeps a dedicated second row for selection actions and disables those buttons when nothing is selected, so the layout stays stable
- The action bar now includes a dedicated `Import From` panel with `Bag` and `Manifest` entry points
- `Bag` import opens a sheet-local modal that can fetch a bag, show the shipment ID list, and either `Ganti Semua` or `Tambah Data` into the current sheet
- `Manifest` import opens a sheet-local modal that fetches manifest bag IDs first, then resolves each bag to shipment IDs in parallel before allowing `Ganti Semua` or `Tambah Data`
- Bag and manifest import results are cached per sheet, so reopening the modal restores the latest lookup draft and result for that sheet only
- CSV export follows the visible table schema but intentionally skips heavy/non-tabular fields such as POD image URLs and raw `history_summary` arrays
- Column shortcut buttons that horizontally scroll to key columns
- Shortcut badges now include operational jump targets such as `PID/Kantong`, `Status Akhir`, and `Kantor Kirim`
- Temporary header highlight when a shortcut scroll target is reached
- Sheet-specific scroll position, request state, and notices
- `Setting` is opened from a gear icon in the tabs panel and includes display scale controls plus a connection panel for the standalone `ShipFlow Service`
- The standalone `ShipFlow Service` owns:
  - runtime tracking source selection
  - service bind mode (`localhost` or `LAN`)
  - service API port
  - service-generated bearer token
- Desktop stores only the localhost service port and bearer token it uses to call that separate service.
- The Desktop connection panel asks for the service port, not a full service URL, because Desktop always connects to the local `ShipFlow Service` app.
- The external API `Base URL` field no longer ships with a hard-coded example endpoint placeholder
- `Nomor Kiriman` rows include per-row QR preview, copy ID, and source-link actions
- `PID/Kantong Terakhir` is derived from the latest `bagging` / `unbagging` event and includes QR preview, copy ID, and print actions for the latest bag/PID
- `Manifest Terakhir` is derived from the latest `history_summary.manifest_r7` entry and includes a copy-ID action
- `Delivery Terakhir` is derived from the latest `history_summary.delivery_runsheet` entry
- `TRX - TODAY` shows the day count from the shipment transaction date to today
- `TRX - UNBAG` shows the day count from the latest unbagging event to today
- QR previews are generated locally in-app and do not rely on an external QR image service
- `POD Photo 1` and `POD Photo 2` render as image thumbnails with hover preview
- POD hover previews are resolved through the Tauri backend, cap remote/data-image payloads at `5 MB`, reject SVG payloads, and keep only a bounded in-memory frontend preview cache
- `history_summary` cells open scrollable popup details inside the app
- Value-filter popups show per-value item counts, for example `PID94102398 - UNBAGGING (33)`
- Hovering a value-filter option exposes `Filter ini` and `Filter kecuali ini` shortcuts for quick include/exclude filtering
- Value-filter popups for sender/recipient name, address, and latest delivery columns use a wider panel for long values
- The workspace layout is tuned to be more compact so tabs, actions, shortcuts, and the sheet grid fit more comfortably in one screen
- Toast notifications are shown as a fixed top-right queue and do not shift the sheet layout
- `history_summary.delivery_runsheet` now keeps the latest delivery result as one update with:
  - `status` as the final delivery status
  - `keterangan_status` as the delivery failure/detail reason when available

## Current Data Shown In The Table

The main table currently focuses on:

- `detail.shipment_header`
- `status_akhir`
- `detail.actors.pengirim`
- `detail.actors.penerima`
- `detail.origin_detail`
- `detail.package_detail`
- `detail.billing_detail`
- `detail.performance_detail`
- `pod.photo1_url`
- `pod.photo2_url`
- `history_summary.irregularity`
- `history_summary.bagging_unbagging`
- `history_summary.manifest_r7`
- `history_summary.delivery_runsheet`

`history` is still returned by the backend but is not expanded as a full table module yet.

## Stability And Safety Notes

- `ShipFlow Desktop` does not scrape directly. Tracking is resolved by `ShipFlow Service`.
- `ShipFlow Service` is the single source of truth for tracking source and external API access.
- Desktop `Setting` only edits the Desktop-to-Service localhost port/token. It does not edit service-owned tracking source configuration.
- Desktop always uses the configured standalone service port/token for tracking.
- Desktop does not spawn a managed tracking runtime and the target service owns its own scraper/internal API config.
- Custom Desktop-to-Service settings are saved only after an authenticated `/status` response proves the endpoint is ShipFlow Service.
- In custom Desktop-to-Service mode, Desktop does not enable or manage the Service API endpoint; the target service owns that endpoint and token.
- The Service API token is required for Desktop tracking in both internal scraper mode and external API mode.
- ShipFlow Service does not generate or rotate the API token automatically. The token changes only when the user clicks `Generate` or confirms `Regenerate`.
- Legacy Desktop connection data that was saved into the old Service config file is migrated into `desktop-service-config.json`, so Service-owned runtime config and token remain stable after restart.
- External tracking source access can be opened or closed from `ShipFlow Service` without affecting the desktop runtime itself.
- Retrack failures do not wipe the last successful shipment data. Failed refreshes keep the old row data and mark the row as stale.
- Numeric parsing in the Rust scraper is hardened: invalid upstream numeric fields now fail loudly instead of silently falling back to `0`.
- Empty numeric upstream fields are preserved as `null`, not coerced to `0`.
- Shipment IDs are sanitized before tracking and rejected when they exceed `64` characters.
- The backend now applies the same shipment-ID validation rules as the frontend, including embedded API requests.
- Duplicate in-flight requests for the same `sheetId + rowKey + shipmentId` are skipped.
- Bag and manifest import modal state is isolated per sheet, including the current draft, lookup cache, and open/closed modal state.
- Manifest-to-bag fan-out now uses capped parallel lookup workers and ignores stale downstream results when a manifest lookup is replaced or rerun.
- Manifest and bag imports auto-close the modal after `Ganti Semua` or `Tambah Data`, then immediately start shipment tracking in the target sheet.
- Runtime lookup results for `track`, `bag`, and `manifest` now use one in-memory cache with in-flight coalescing, kind-specific TTL, and short negative-cache protection.
- Successful lookup payloads are also persisted into a local user-state lookup store so repeated lookups can survive service restarts.
- The persistent lookup store belongs to the `ShipFlow Service` app-data namespace, with a one-time legacy migration from the old `ShipFlow Desktop` namespace.
- Persistent lookup-store writes run outside the lookup response path, so successful rows can return to Desktop without waiting for local disk persistence.
- Persistent lookup-store writes use unique temporary files and OS-aware replacement, so repeated writes remain durable on Windows after the first cache file already exists.
- Manual refresh flows such as `Lacak Ulang`, `Retry Gagal`, and bag/manifest modal fetches can explicitly bypass cache when the user intends a fresh lookup.
- Runtime startup and source/config refresh paths now invalidate lookup cache explicitly before using the refreshed tracking configuration.
- External API tracking uses the `/v1` route as authoritative when the configured base URL includes `/v1` or `/v1/openapi.json`, avoiding an unnecessary legacy fallback request on `404`.
- External API tracking starts a hedged duplicate request when a request is still pending after a short delay, then uses whichever identical request finishes first to reduce random tail-latency spikes.
- Active, dirty, and loading rows remain visible even while filters are active.
- Filtered views now force selection to exactly the currently visible shipment IDs, and clearing filters stops that auto-follow mode before normal manual selection resumes.
- Request telemetry is emitted for `start`, `success`, `fail`, and `abort` with `sheetId`, `rowKey`, and `shipmentId`.
- `Delete All` resets rows, filters, value filters, sort state, and in-flight tracking work so the table returns to a clean input state.
- `Lacak Ulang` marks all target rows as queued first, then promotes only the active worker row to loading while preserving completed/failed row status.
- Delivery-runsheet parsing is hardened so `FAILEDTODELIVERED` cases are not incorrectly split into two updates on the latest runsheet.
- Delivery-runsheet parsing now keeps only the latest effective update for a runsheet summary.
- Desktop no longer manages service tray/background lifecycle.
- Desktop startup no longer starts a service companion. Start the standalone service first, then configure Desktop with that service port/token.
- Desktop/service readiness checks now require an authenticated `GET /status` response from `ShipFlow Service`, including a ShipFlow-specific product marker, before reusing an existing runtime process.
- Windows release builds of `ShipFlow Service` use the Windows subsystem, so launching the installed service app does not open a console window.
- Launching `ShipFlow Service` normally starts it in the background and keeps only the system-tray/menu-bar entry visible.
- Closing the `ShipFlow Service` settings window hides it and keeps the service tray companion available.
- Reopening `ShipFlow Service` from the tray/menu-bar entry focuses or recreates the existing settings window instead of starting a duplicate settings instance.
- If the Service tray/menu-bar companion cannot start, the Service settings window is shown as a fallback so the user can still edit configuration.
- Desktop and Service cross-launch helpers look for the separately installed app first and no longer fall back to launching the current app as the other product.
- Desktop custom connection saves no longer start or stop the Service tray companion.
- Windows Desktop and Service installers run shutdown hooks before install and uninstall replacement, so running ShipFlow processes are closed before files are overwritten.
- Custom Desktop-to-Service lookups re-check the authenticated `/status` identity before sending shipment, bag, or manifest IDs to a custom endpoint.
- Service configuration is validated before it is persisted, and enabled service configs are written only after the companion process has started and passed the authenticated readiness probe.
- Service config, runtime config, PID markers, pending activation requests, and runtime logs are stored under the user app-data state directory, with legacy temp-dir reads kept only as a migration fallback.
- Service state files are written through unique temporary file names and atomic replacement paths to avoid in-process temp-file collisions.
- PID-based shutdown now verifies the recorded process command line matches the expected ShipFlow service/tray process before attempting to terminate it.
- Desktop bag and manifest lookups no longer bypass `ShipFlow Service` with a direct POS fallback when the service request fails.
- Desktop and service runtime events are written to per-process log files under the shared runtime state directory.
- Runtime log files now also emit `[ShipFlowCacheMetrics]` summary lines with per-kind cache ratios and counters for operator audit.
- Runtime log files also emit `[ShipFlowPerf]` timing lines for Desktop-to-Service, Service lookup, and external API lookup stages. These timings intentionally include route, lookup ID, duration, HTTP status, and byte counts, but never bearer tokens.
- ShipFlow Service lookup endpoints now percent-encode bag and manifest IDs before issuing local HTTP requests.
- ShipFlow Service now exposes a documented `/v1` API contract with response envelopes and batch tracking job endpoints.
- Service tokens are written to a separate local token vault file and hydrated into runtime config when needed, so primary config files do not carry raw token fields.
- Windows native URL launching now keeps full query strings intact, so bag print URLs preserve both `bag_id` and `oid`.
- The service-settings UI is tuned to keep the main content panel height stable across view switches so the window does not expose large empty gaps.
- CSV export now uses a native save dialog and backend file write instead of a browser download link.
- Workspace document saves write through a temporary file, create bounded recovery snapshots, and replace the target only after the new payload has been written.

## Project Structure

### Frontend

- [src/App.tsx](./src/App.tsx): entry shell that routes between workspace and service-settings windows
- [src/features/workspace/WorkspaceApp.tsx](./src/features/workspace/WorkspaceApp.tsx): workspace container
- [src/features/workspace/useWorkspaceAppController.ts](./src/features/workspace/useWorkspaceAppController.ts): workspace composition root
- [src/features/workspace/components/WorkspaceShellView.tsx](./src/features/workspace/components/WorkspaceShellView.tsx): workspace render shell
- [src/features/service/ServiceSettingsApp.tsx](./src/features/service/ServiceSettingsApp.tsx): service-settings window app shell
- [src/features/service/useServiceSettingsController.ts](./src/features/service/useServiceSettingsController.ts): service-settings controller
- [src/features/service/components/ServiceSettingsWindow.tsx](./src/features/service/components/ServiceSettingsWindow.tsx): service-settings window UI
- [src/backend/commands.ts](./src/backend/commands.ts): typed frontend boundary for Tauri commands
- [src/features/workspace/components/SheetTabs.tsx](./src/features/workspace/components/SheetTabs.tsx): sheet tab shell and tab/menu orchestration
- [src/features/workspace/components/SheetFileMenu.tsx](./src/features/workspace/components/SheetFileMenu.tsx): workspace file menu
- [src/features/workspace/components/DesktopServiceConnectionPanel.tsx](./src/features/workspace/components/DesktopServiceConnectionPanel.tsx): Desktop-to-Service port/token settings panel
- [src/features/sheet/components/SheetActionBar.tsx](./src/features/sheet/components/SheetActionBar.tsx): sheet action bar shell
- [src/features/sheet/components/ImportSourceModal.tsx](./src/features/sheet/components/ImportSourceModal.tsx): bag/manifest import modal
- [src/features/sheet/components](./src/features/sheet/components): table, header, row, and action bar components
- [src/features/workspace](./src/features/workspace): workspace controllers, adapters, dialogs, and shell components

### Backend

- [Cargo.toml](./Cargo.toml): root Rust workspace that owns the single Cargo lockfile
- [apps/service](./apps/service): standalone ShipFlow Service binary package
- [src-tauri](./src-tauri): ShipFlow Desktop Tauri app crate and Desktop-only command registration
- [src-tauri/src/desktop_app.rs](./src-tauri/src/desktop_app.rs): Desktop Tauri builder and bootstrap
- [src-tauri/src/commands](./src-tauri/src/commands): Desktop command modules grouped by tracking, workspace, service, and system boundaries
- [crates/shipflow-tauri-runtime](./crates/shipflow-tauri-runtime): shared Tauri runtime library used by Desktop and Service
- [crates/shipflow-tauri-runtime/src/service_settings_app.rs](./crates/shipflow-tauri-runtime/src/service_settings_app.rs): Service settings app builder and Service-only command registration
- [crates/shipflow-tauri-runtime/src/service](./crates/shipflow-tauri-runtime/src/service): shared service config, process, state, API, and tray runtime
- [crates/shipflow-tauri-runtime/src/service/state_store](./crates/shipflow-tauri-runtime/src/service/state_store): app-data paths and per-OS atomic state-file replacement helpers
- [crates/shipflow-tauri-runtime/src/service_client.rs](./crates/shipflow-tauri-runtime/src/service_client.rs): Desktop-to-Service HTTP client boundary
- [crates/shipflow-tauri-runtime/src/os_bridge.rs](./crates/shipflow-tauri-runtime/src/os_bridge.rs): clipboard, URL, and native file-picker bridge
- [crates/shipflow-tauri-runtime/src/window_runtime.rs](./crates/shipflow-tauri-runtime/src/window_runtime.rs): window/document registry runtime
- [crates/shipflow-tauri-runtime/src/workspace_document.rs](./crates/shipflow-tauri-runtime/src/workspace_document.rs): workspace document read/write helpers
- [crates/shipflow-core](./crates/shipflow-core): shared lookup core for shipment, bag, and manifest parser/upstream logic and models
- [crates/shipflow-service-runtime](./crates/shipflow-service-runtime): shared ShipFlow Service HTTP API and lookup cache runtime
- [crates/shipflow-service-runtime/src/api_contract.rs](./crates/shipflow-service-runtime/src/api_contract.rs): versioned API envelope and error contract
- [crates/shipflow-service-runtime/src/jobs.rs](./crates/shipflow-service-runtime/src/jobs.rs): background batch job registry for Service API jobs
- [crates/shipflow-service-runtime/src/persistent_store.rs](./crates/shipflow-service-runtime/src/persistent_store.rs): persistent lookup payload store
- [crates/shipflow-tauri-runtime/src/tracking/mod.rs](./crates/shipflow-tauri-runtime/src/tracking/mod.rs): shared tracking facade used by Tauri command handlers
- [src-tauri/src/fixtures](./src-tauri/src/fixtures): parser fixtures used by Rust tests

### Runtime Split

- `ShipFlow Desktop`: document workspace, sheet management, and table UI
- `ShipFlow Service`: runtime lookup API, source selection, service token, cache, and external API access
- `shipflow-tauri-runtime`: neutral shared runtime used by both Desktop and Service
- `shipflow-core`: shared lookup engine used by desktop/service Rust code
- `shipflow-service-runtime`: shared service HTTP API and lookup-cache engine used by the standalone service binary
- Desktop and service are separate runtime artifacts. Desktop does not bundle, spawn, or stop ShipFlow Service.
- The repo keeps Desktop and Service in one monorepo while producing separate release artifacts.
- `shipflow-core` is linked into the Rust binaries and is not packaged as a standalone app

## Runtime Smoke Checklist

Use this checklist before publishing a runtime/security change:

- Start standalone `ShipFlow Service` and configure Desktop with its localhost port/token.
- Confirm tracking, bag import, and manifest import all resolve through `ShipFlow Service`.
- Start another process on the configured service port and confirm Desktop does not treat a plain open port as ShipFlow Service.
- Confirm Desktop reports a clear configuration error when no standalone service port/token is saved.
- Open normal POD previews, then confirm oversized `data:image` payloads, SVG payloads, and private/loopback remote URLs are rejected.
- Save the same workspace repeatedly and confirm the existing file remains readable after each save.

Latest CLI/runtime smoke baseline, verified on 2026-04-25:

- `npm run build:service` builds the standalone service binary.
- `cargo test --workspace --all-targets` passes the runtime hardening tests, including POD guardrails, custom service status identity checks, concurrent state writes, and workspace finalize failure preservation.
- A standalone `ShipFlow Service` process can start on `127.0.0.1:19431` with a generated runtime config.
- `GET /status` with the expected bearer token returns `200 OK` and the `product: "shipflow-service"` marker.
- `GET /status` with the wrong bearer token returns `401 Unauthorized`.
- `GET /health` returns `200 OK`.
- Starting a second service process on the same port fails with `Address already in use`.
- `npm run build`, `cargo fmt --all -- --check`, and `cargo clippy --workspace --all-targets -- -D warnings` pass after the runtime smoke test.

The CLI smoke test does not replace a visual Desktop smoke pass. Still verify the Tauri window flow for standalone service settings, POD hover previews, and native workspace save dialogs before a user-facing release.

### Reference Only

`EX-SCRAP/` is kept only as a reference. It is not part of the active app flow and must not be modified for app changes.

## Run Locally

Install dependencies:

```bash
npm install
```

Run the frontend only:

```bash
npm run dev
```

Run the desktop app:

```bash
npm run tauri dev
```

Run a Desktop dev instance on a non-default Vite port:

```bash
npm run tauri -- dev --config '{"build":{"devUrl":"http://127.0.0.1:1431","beforeDevCommand":"npm run dev -- --host 127.0.0.1 --port 1431 --strictPort"}}'
```

Run the service app directly in dev. This starts the Service frontend on port `1432`, waits until it is ready, then starts the Service app in the background with its tray/menu-bar entry:

```bash
npm run dev:service
```

Open the Service window from the tray/menu-bar entry. In the Service window:

1. Open `Sumber Lacak` and choose `Internal ShipFlow` or `API ShipFlow Eksternal`.
2. Open `API`, review the localhost endpoint, generate a token if needed, and save.
3. Copy the endpoint and token into Desktop `Setting`.

The service also supports CLI mode for headless testing:

```bash
cargo run -p shipflow-service -- --auth-token sf_dev_token --port 18422
```

For CLI mode, configure Desktop with:

```text
ShipFlow Service Port: 18422
ShipFlow Service Token: sf_dev_token
```

In the Desktop settings UI, enter only the port, for example `18422`; Desktop builds the localhost endpoint internally.

## Build

Build the frontend bundle:

```bash
npm run build
```

Build the desktop app:

```bash
npm run tauri build
```

Build the standalone service app binary:

```bash
npm run build:service
```

This builds the Service app binary with Tauri `custom-protocol` enabled, so the Service settings window uses embedded production assets instead of a localhost dev server. This raw binary is for local build validation only.

Build the standalone service macOS app bundle:

```bash
npm run build:service:bundle:macos
```

Windows distribution uses the Service installer produced by GitHub Actions, not the raw binary.

Build the desktop installer:

```bash
npm run build:bundle
```

Build the macOS app bundle only:

```bash
npm run build:bundle:macos
```

## GitHub Actions Quality Gate

The repository includes a quality workflow at:

- `.github/workflows/quality.yml`

The workflow name shown in GitHub Actions is:

- `Quality Gate`

What it does:

- runs on `ubuntu-latest`
- installs Node.js and Rust
- installs Linux Tauri system dependencies
- runs frontend tests
- runs the production frontend build
- runs `cargo fmt --all -- --check`
- runs `cargo test --workspace --all-targets`
- runs `cargo clippy --workspace --all-targets -- -D warnings`

Triggers:

- automatic run on `push` to `main`
- automatic run on `pull_request`
- manual run via `workflow_dispatch`

## GitHub Actions Build Desktop Windows

The repository includes a Windows build workflow at:

- `.github/workflows/build-windows-exe.yml`

The workflow name shown in GitHub Actions is:

- `Build Desktop Windows`

What it does:

- runs on `windows-latest`
- installs Node.js and Rust
- runs frontend tests
- runs `cargo fmt --all -- --check`
- runs `cargo test --workspace --all-targets`
- runs `cargo clippy --workspace --all-targets -- -D warnings`
- builds the Desktop NSIS installer without bundling `ShipFlow Service`
- wires the Desktop NSIS installer to close running Desktop processes before reinstall or uninstall replacement
- smoke-checks the Desktop executable and installer icon
- uploads the Desktop NSIS installer artifact: `shipflow-desktop-windows-installer`

Triggers:

- manual run via `workflow_dispatch`
- no automatic push trigger by default

The uploaded Windows output is:

- `target/release/bundle/nsis/*.exe`

## GitHub Actions Build Desktop macOS

The repository also includes a macOS build workflow at:

- `.github/workflows/build-macos-app.yml`

The workflow name shown in GitHub Actions is:

- `Build Desktop macOS`

What it does:

- runs on `macos-latest`
- installs Node.js and Rust
- runs frontend tests
- runs `cargo fmt --all -- --check`
- runs `cargo test --workspace --all-targets`
- runs `cargo clippy --workspace --all-targets -- -D warnings`
- optionally uses Apple signing and notarization credentials when the corresponding `APPLE_*` repository secrets are configured
- otherwise falls back to Tauri ad-hoc signing (`bundle.macOS.signingIdentity = "-"`) so the app bundle is still signed for local validation
- builds the Desktop macOS app bundle without bundling `ShipFlow Service`
- smoke-checks the generated app bundle and icon resources
- verifies the generated `.app` bundle signature with `codesign --verify --deep --strict`
- archives the `.app` bundle as a `.zip` artifact to preserve the macOS bundle structure during download

Triggers:

- manual run via `workflow_dispatch`
- no automatic push trigger by default

The uploaded macOS outputs are:

- `target/release/bundle/macos/ShipFlow-Desktop-macos-app.zip`

Important notes:

- A browser-downloaded macOS app should be signed to avoid the broken-app warning from Gatekeeper.
- Ad-hoc signing is sufficient for local/manual validation, especially on Apple Silicon, but it is not a substitute for a Developer ID Application certificate plus notarization.
- For distribution to other users, configure the `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, and notarization credentials (`APPLE_API_*` or `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`) as described in the Tauri macOS signing documentation.

## GitHub Actions Build Service Windows

The repository includes a standalone Windows service workflow at:

- `.github/workflows/build-service-windows-installer.yml`

The workflow name shown in GitHub Actions is:

- `Build Service Windows`

What it does:

- runs on `windows-latest`
- installs Node.js, Rust, and frontend dependencies
- builds the frontend assets embedded by the Service settings window
- runs `cargo fmt --all -- --check`
- runs `cargo test --workspace --all-targets`
- runs `cargo clippy --workspace --all-targets -- -D warnings`
- builds `apps/service` in release mode with Tauri `custom-protocol` enabled
- builds a per-user Windows installer with NSIS
- builds the Windows Service app without a console window, applies the Service icon to the app executable and installer, and closes running `shipflow-service.exe` processes before reinstall or uninstall replacement
- smoke-checks the generated installer and Service icon
- uploads the Windows Service installer artifact: `shipflow-service-windows-installer`

Triggers:

- manual run via `workflow_dispatch`
- no automatic push trigger by default

The uploaded Windows Service output is:

- `target/release/ShipFlow-Service-Setup.exe`

## GitHub Actions Build Service macOS

The repository includes a standalone macOS service workflow at:

- `.github/workflows/build-service-macos-app.yml`

The workflow name shown in GitHub Actions is:

- `Build Service macOS`

What it does:

- runs on `macos-latest`
- installs Node.js, Rust, and frontend dependencies
- builds the frontend assets embedded by the Service settings window
- runs `cargo fmt --all -- --check`
- runs `cargo test --workspace --all-targets`
- runs `cargo clippy --workspace --all-targets -- -D warnings`
- imports the Apple Developer ID certificate and notarization key when `APPLE_*` secrets are configured
- otherwise falls back to Tauri ad-hoc signing after clearing Apple signing environment variables, so partial secrets do not trigger an invalid certificate import
- builds and signs a macOS `ShipFlow Service.app` bundle with the Service icon
- smoke-checks the generated app bundle and icon resources
- verifies the generated `.app` bundle signature with `codesign --verify --deep --strict`
- archives the `.app` bundle as a `.zip` artifact to preserve the macOS bundle structure during download
- uploads the macOS Service app artifact: `shipflow-service-macos-app`

Triggers:

- manual run via `workflow_dispatch`
- no automatic push trigger by default

The uploaded macOS Service output is:

- `target/release/bundle/macos/ShipFlow-Service-macos-app.zip`

Desktop installers no longer include the service app. Install ShipFlow Service separately, then configure Desktop with the service port and token.

Important macOS distribution note:

- A downloaded `ShipFlow Service.app` must be Developer ID signed and notarized to pass Gatekeeper without the "Apple could not verify" warning.
- The Service workflow falls back to ad-hoc signing only when Apple signing/notarization secrets are missing; that fallback is for local validation, not end-user distribution.
- Configure the same `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, and notarization credentials used by the Desktop macOS workflow before publishing the Service artifact.

## Tests

Run frontend tests:

```bash
npm test
```

Run the large-table virtualization benchmark:

```bash
npm run bench:table
```

Current frontend tests cover:

- sheet utility functions
- sheet state helpers for pin / hide / filter logic
- `SheetTable` interaction smoke test
- `SheetActionBar` interaction smoke test
- multi-sheet app-level isolation and stress scenarios
- per-sheet bag / manifest modal isolation, cache, append, replace, and auto-track flows
- concurrent manifest lookups across multiple sheets with stale-result protection
- tracking telemetry and malformed-response guards

The table benchmark is kept separate from the normal test suite so regular checks stay fast. It renders `1000` rows, verifies virtualization is still active, and logs baseline render / scroll timings for the table body.

Rust tests are now split by domain and cover:

- Service API v1 response envelope timestamp formatting
- Service API batch-job status/result bookkeeping
- persistent lookup-store overwrite durability
- Base64 + percent-encoded tracking URL generation
- embedded API bearer-auth validation
- authenticated service readiness probing and ShipFlow service identity checks
- service settings activation, single-instance detection, and tray companion lifecycle checks
- backend shipment-ID normalization and validation
- backend bag-ID and manifest-ID normalization and validation
- service-side bag / manifest lookup endpoint encoding and error-message parsing
- app-data service state persistence, legacy temp-dir migration fallback, and activation-request consumption
- POD preview data-image size guardrails and SVG rejection
- sample HTML parsing
- bag HTML parsing
- manifest HTML parsing
- not-found parser behavior
- invalid numeric parser behavior
- nullable numeric parsing
- reordered-table parsing
- selected-field parser snapshots
- partial-upstream vs true not-found heuristics
- latest-runsheet `FAILEDTODELIVERED` parsing with `keterangan_status`
- latest-effective-update-only runsheet parsing

Main Rust test locations:

- [crates/shipflow-core/src/bag.rs](./crates/shipflow-core/src/bag.rs)
- [crates/shipflow-core/src/manifest.rs](./crates/shipflow-core/src/manifest.rs)
- [crates/shipflow-core/src/parser.rs](./crates/shipflow-core/src/parser.rs)
- [crates/shipflow-core/src/upstream.rs](./crates/shipflow-core/src/upstream.rs)
- [crates/shipflow-tauri-runtime/src/service/runtime_config.rs](./crates/shipflow-tauri-runtime/src/service/runtime_config.rs)
- [crates/shipflow-tauri-runtime/src/service/http_api.rs](./crates/shipflow-tauri-runtime/src/service/http_api.rs)
- [crates/shipflow-tauri-runtime/src/service/process_runtime.rs](./crates/shipflow-tauri-runtime/src/service/process_runtime.rs)
- [crates/shipflow-tauri-runtime/src/service/state_store.rs](./crates/shipflow-tauri-runtime/src/service/state_store.rs)
- [crates/shipflow-tauri-runtime/src/workspace_document.rs](./crates/shipflow-tauri-runtime/src/workspace_document.rs)

Run all Rust tests with:

```bash
cargo test --workspace --all-targets
```

Run Rust format check with:

```bash
cargo fmt --all -- --check
```

Run Rust clippy with warnings denied:

```bash
cargo clippy --workspace --all-targets -- -D warnings
```

Run an individual Rust workspace package when debugging a narrow area:

```bash
cargo test -p shipflow-core
```

Quality-gate commands for local release checks:

```bash
npm test
npm run build
cargo fmt --all -- --check
cargo test --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
```

## Notes

- The app depends on the current HTML structure of the POS Indonesia tracking page
- If the upstream HTML changes, the Rust parser may need updates
- Hidden columns are stored in browser/webview local storage
- Pinned columns are stored in browser/webview local storage
- Workspace and sheet state are persisted in browser/webview local storage with a storage-safe fallback snapshot
- Desktop stores only the standalone ShipFlow Service port/token it uses for lookups
