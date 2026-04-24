# ShipFlow Desktop

Desktop shipment tracking workspace built with Tauri, Rust, React, and Vite.

The app is optimized for spreadsheet-style operational analysis. Each row represents one shipment. The first data column accepts a shipment ID, then the app asks `ShipFlow Service` for tracking data and fills the rest of the row. A sheet is treated as one independent workspace.

The runtime foundation now supports POS bag and manifest lookups through the shared Rust core and the local service API. The desktop workspace still stays shipment-first, but each sheet can now import shipment IDs from bag and manifest lookups through sheet-local modal flows.

Architecture references:

- [docs/runtime-architecture.md](./docs/runtime-architecture.md)
- [docs/desktop-service-split.md](./docs/desktop-service-split.md)
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
- Supports both text filters and per-column multi-select value filters
- Supports retracking all current shipments from the action bar
- Supports multiple sheets, where each sheet is an isolated tracking workspace
- Supports creating a new sheet from selected shipment IDs only
- Supports appending selected shipment IDs into another existing sheet
- Includes external API access for other apps through the companion service

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

- `GET /status`
- `GET /track/:shipment_id`
- `GET /bag/:bag_id`
- `GET /manifest/:manifest_id`

Important note:

- external API source selection currently applies to shipment tracking
- bag and manifest lookups currently use the internal POS scraper path

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
- Toast notifications are shown as a fixed top-center queue and do not shift the sheet layout
- `Setting` is opened from a gear icon in the tabs panel and includes display scale controls plus a launcher to open `ShipFlow Service`
- `ShipFlow Service` owns:
  - runtime tracking source selection
  - external API access mode (`localhost` or `LAN`)
  - external API port
  - service-generated bearer token
- `ShipFlow Service` is laid out as a compact desktop preference window with a stable full-height content panel, persistent footer actions, and tighter control alignment across macOS and Windows
- The `ShipFlow Service` footer now keeps `Reset Perubahan`, `Sembunyikan`, and `Simpan`; `Sembunyikan` hides the service window without discarding unsaved local draft changes
- The external API `Base URL` field no longer ships with a hard-coded example endpoint placeholder
- `Nomor Kiriman` rows include per-row QR preview, copy ID, and source-link actions
- `PID/Kantong Terakhir` is derived from the latest `bagging` / `unbagging` event and includes QR preview, copy ID, and print actions for the latest bag/PID
- `Manifest Terakhir` is derived from the latest `history_summary.manifest_r7` entry and includes a copy-ID action
- `Delivery Terakhir` is derived from the latest `history_summary.delivery_runsheet` entry
- QR previews are generated locally in-app and do not rely on an external QR image service
- `POD Photo 1` and `POD Photo 2` render as image thumbnails with hover preview
- POD hover previews are resolved through the Tauri backend, cap remote/data-image payloads at `5 MB`, reject SVG payloads, and keep only a bounded in-memory frontend preview cache
- `history_summary` cells open scrollable popup details inside the app
- Value-filter popups for sender/recipient name and address columns use a wider panel for long values
- The workspace layout is tuned to be more compact so tabs, actions, shortcuts, and the sheet grid fit more comfortably in one screen
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
- Desktop `Setting` only launches `ShipFlow Service`; service configuration is not edited from the desktop modal.
- `ShipFlow Service` settings can now choose whether Desktop uses the managed local service or a custom service URL/token.
- In custom Desktop-to-Service mode, Desktop does not spawn a managed tracking runtime and the target service owns its own scraper/internal API config.
- Custom Desktop-to-Service settings are saved only after an authenticated `/status` response proves the endpoint is ShipFlow Service.
- In custom Desktop-to-Service mode, Desktop does not enable or manage the bundled API endpoint; the target service owns that endpoint and token.
- External API access can be opened or closed from `ShipFlow Service` without affecting the desktop runtime itself.
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
- Manual refresh flows such as `Lacak Ulang`, `Retry Gagal`, and bag/manifest modal fetches can explicitly bypass cache when the user intends a fresh lookup.
- Runtime startup and source/config refresh paths now invalidate lookup cache explicitly before using the refreshed tracking configuration.
- Active, dirty, and loading rows remain visible even while filters are active.
- Filtered views now force selection to exactly the currently visible shipment IDs, and clearing filters stops that auto-follow mode before normal manual selection resumes.
- Request telemetry is emitted for `start`, `success`, `fail`, and `abort` with `sheetId`, `rowKey`, and `shipmentId`.
- `Delete All` resets rows, filters, value filters, sort state, and in-flight tracking work so the table returns to a clean input state.
- Delivery-runsheet parsing is hardened so `FAILEDTODELIVERED` cases are not incorrectly split into two updates on the latest runsheet.
- Delivery-runsheet parsing now keeps only the latest effective update for a runsheet summary.
- The service companion always keeps tray/background behavior enabled; it is no longer exposed as a user-facing desktop setting.
- Desktop startup now proactively checks whether `ShipFlow Service` is already running and starts the companion runtime when needed.
- Desktop/service readiness checks now require an authenticated `GET /status` response from `ShipFlow Service`, including a ShipFlow-specific product marker, before reusing an existing runtime process.
- Custom Desktop-to-Service lookups re-check the authenticated `/status` identity before sending shipment, bag, or manifest IDs to a custom endpoint.
- Service configuration is validated before it is persisted, and enabled service configs are written only after the companion process has started and passed the authenticated readiness probe.
- Service config, runtime config, PID markers, pending activation requests, and runtime logs are stored under the user app-data state directory, with legacy temp-dir reads kept only as a migration fallback.
- Service state files are written through unique temporary file names and atomic replacement paths to avoid in-process temp-file collisions.
- PID-based shutdown now verifies the recorded process command line matches the expected ShipFlow service/tray process before attempting to terminate it.
- Desktop bag and manifest lookups no longer bypass `ShipFlow Service` with a direct POS fallback when the service request fails.
- Desktop and service runtime events are written to per-process log files under the shared runtime state directory.
- Runtime log files now also emit `[ShipFlowCacheMetrics]` summary lines with per-kind cache ratios and counters for operator audit.
- ShipFlow Service lookup endpoints now percent-encode bag and manifest IDs before issuing local HTTP requests.
- Windows native URL launching now keeps full query strings intact, so bag print URLs preserve both `bag_id` and `oid`.
- The service-settings UI is tuned to keep the main content panel height stable across view switches so the window does not expose large empty gaps.
- Lookup cache remains in-memory only for now; cache persistence across restart is intentionally not enabled yet.
- Workspace document saves write through a temporary file and replace the target only after the new payload has been written.

## Project Structure

### Frontend

- [src/App.tsx](./src/App.tsx): entry shell that routes between workspace and service-settings windows
- [src/features/workspace/WorkspaceApp.tsx](./src/features/workspace/WorkspaceApp.tsx): workspace container
- [src/features/workspace/useWorkspaceAppController.ts](./src/features/workspace/useWorkspaceAppController.ts): workspace composition root
- [src/features/workspace/components/WorkspaceShellView.tsx](./src/features/workspace/components/WorkspaceShellView.tsx): workspace render shell
- [src/features/service/ServiceSettingsApp.tsx](./src/features/service/ServiceSettingsApp.tsx): service-settings window app shell
- [src/features/service/useServiceSettingsController.ts](./src/features/service/useServiceSettingsController.ts): service-settings controller
- [src/features/service/components/ServiceSettingsWindow.tsx](./src/features/service/components/ServiceSettingsWindow.tsx): service-settings window UI
- [src/features/sheet/components](./src/features/sheet/components): table, header, row, and action bar components
- [src/features/workspace](./src/features/workspace): workspace controllers, adapters, dialogs, and shell components

### Backend

- [apps/service](./apps/service): standalone ShipFlow Service binary package
- [src-tauri/src/lib.rs](./src-tauri/src/lib.rs): Tauri command composition layer
- [src-tauri/src/app_runtime.rs](./src-tauri/src/app_runtime.rs): desktop bootstrap and runtime setup
- [src-tauri/src/app_menu_runtime.rs](./src-tauri/src/app_menu_runtime.rs): desktop app menu wiring
- [src-tauri/src/lookup_runtime.rs](./src-tauri/src/lookup_runtime.rs): Tauri compatibility re-export for the shared service runtime lookup cache
- [src-tauri/src/os_bridge.rs](./src-tauri/src/os_bridge.rs): clipboard, URL, and native file-picker bridge
- [src-tauri/src/window_runtime.rs](./src-tauri/src/window_runtime.rs): window/document registry runtime
- [src-tauri/src/workspace_document.rs](./src-tauri/src/workspace_document.rs): workspace document read/write helpers
- [src-tauri/src/service.rs](./src-tauri/src/service.rs): service controller composition layer
- [src-tauri/src/service_client.rs](./src-tauri/src/service_client.rs): Desktop-to-Service HTTP client boundary
- [src-tauri/src/service](./src-tauri/src/service): Desktop-side service adapters, config/state store, process runtime, and tray runtime
- [crates/shipflow-core](./crates/shipflow-core): shared lookup core for shipment, bag, and manifest parser/upstream logic and models
- [crates/shipflow-service-runtime](./crates/shipflow-service-runtime): shared ShipFlow Service HTTP API and lookup cache runtime
- [src-tauri/src/tracking/mod.rs](./src-tauri/src/tracking/mod.rs): Tauri-side compatibility module that re-exports the shared tracking core
- [src-tauri/src/fixtures](./src-tauri/src/fixtures): parser fixtures used by Rust tests

### Runtime Split

- `ShipFlow Desktop`: document workspace, sheet management, and table UI
- `ShipFlow Service`: runtime lookup API, source selection, service token, tray/background lifecycle, and external API access
- `shipflow-core`: shared lookup engine used by desktop/service Rust code
- `shipflow-service-runtime`: shared service HTTP API and lookup-cache engine used by Desktop-managed and standalone service binaries
- Desktop and service currently ship together as one product bundle, but run as separate executables/processes
- The repo is moving toward separate Desktop and Service installer packages while keeping `shipflow-core` shared inside the monorepo.
- `shipflow-core` is linked into the Rust binaries and is not packaged as a standalone app

## Runtime Smoke Checklist

Use this checklist before publishing a runtime/security change:

- Start Desktop with the managed local service and confirm tracking, bag import, and manifest import all resolve through `ShipFlow Service`.
- Switch Desktop-to-Service to a custom localhost URL/token and confirm the authenticated `/status` check passes before lookup.
- Start another process on the configured service port and confirm Desktop does not treat a plain open port as ShipFlow Service.
- Tamper or stale the recorded service PID file and confirm shutdown/reuse refuses a non-ShipFlow process.
- Open normal POD previews, then confirm oversized `data:image` payloads, SVG payloads, and private/loopback remote URLs are rejected.
- Save the same workspace repeatedly and confirm the existing file remains readable after each save.

Latest CLI/runtime smoke baseline, verified on 2026-04-25:

- `npm run build:service` builds the standalone service binary.
- `cargo test --manifest-path src-tauri/Cargo.toml` passes the runtime hardening tests, including POD guardrails, custom service status identity checks, concurrent state writes, and workspace finalize failure preservation.
- A standalone `ShipFlow Service` process can start on `127.0.0.1:19431` with a generated runtime config.
- `GET /status` with the expected bearer token returns `200 OK` and the `product: "shipflow-service"` marker.
- `GET /status` with the wrong bearer token returns `401 Unauthorized`.
- `GET /health` returns `200 OK`.
- Starting a second service process on the same port fails with `Address already in use`.
- `npm run build` and `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` pass after the runtime smoke test.

The CLI smoke test does not replace a visual Desktop smoke pass. Still verify the Tauri window flow for managed local service startup, custom service settings, POD hover previews, and native workspace save dialogs before a user-facing release.

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

Run the service app directly in dev:

```bash
cargo run --manifest-path apps/service/Cargo.toml --
```

## Build

Build the frontend bundle:

```bash
npm run build
```

Build the desktop app:

```bash
npm run tauri build
```

Prepare the bundled service binary:

```bash
npm run prepare:service-binary
```

Build the standalone service binary:

```bash
npm run build:service
```

Build the bundled desktop installer with the companion service binary included:

```bash
npm run build:bundle
```

Build the macOS app bundle only, with the companion service binary included:

```bash
npm run build:bundle:macos
```

## GitHub Actions Windows Build

The repository includes a Windows build workflow at:

- `.github/workflows/build-windows-exe.yml`

What it does:

- runs on `windows-latest`
- installs Node.js and Rust
- runs frontend tests
- runs Tauri, shared core, service runtime, and service package Rust tests
- runs Rust clippy with warnings denied
- builds the NSIS installer through the bundled-service config so `ShipFlow Service` is included
- uploads two artifacts:
  - portable app executable: `shipflow-desktop-windows-portable`
  - NSIS installer executable: `shipflow-desktop-windows-installer`

Triggers:

- manual run via `workflow_dispatch`
- no automatic push trigger by default

The uploaded Windows outputs are:

- `src-tauri/target/release/shipflow3-tauri.exe`
- `src-tauri/target/release/bundle/nsis/*.exe`

## GitHub Actions macOS Build

The repository also includes a macOS build workflow at:

- `.github/workflows/build-macos-app.yml`

What it does:

- runs on `macos-latest`
- installs Node.js and Rust
- runs frontend tests
- runs Tauri, shared core, service runtime, and service package Rust tests
- runs Rust clippy with warnings denied
- optionally uses Apple signing and notarization credentials when the corresponding `APPLE_*` repository secrets are configured
- otherwise falls back to Tauri ad-hoc signing (`bundle.macOS.signingIdentity = "-"`) so the app bundle is still signed for local validation
- builds the macOS app bundle through the bundled-service config so `ShipFlow Service` is included
- verifies the generated `.app` bundle signature with `codesign --verify --deep --strict`
- archives the `.app` bundle as a `.zip` artifact to preserve the macOS bundle structure during download

Triggers:

- manual run via `workflow_dispatch`
- no automatic push trigger by default

The uploaded macOS outputs are:

- `src-tauri/target/release/bundle/macos/ShipFlow-Desktop-macos-app.zip`

Important notes:

- A browser-downloaded macOS app should be signed to avoid the broken-app warning from Gatekeeper.
- Ad-hoc signing is sufficient for local/manual validation, especially on Apple Silicon, but it is not a substitute for a Developer ID Application certificate plus notarization.
- For distribution to other users, configure the `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, and notarization credentials (`APPLE_API_*` or `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`) as described in the Tauri macOS signing documentation.

## GitHub Actions Service Binary Build

The repository includes a standalone service binary workflow at:

- `.github/workflows/build-service-binary.yml`

What it does:

- runs on `macos-latest` and `windows-latest`
- installs Rust
- runs service runtime and service package Rust tests
- builds `apps/service` in release mode
- uploads standalone service binary artifacts:
  - `shipflow-service-macos`
  - `shipflow-service-windows`

This is the first packaging step toward separate Desktop and Service release artifacts. The bundled desktop installers still include the companion service binary for now.

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

- Base64 + percent-encoded tracking URL generation
- embedded API bearer-auth validation
- authenticated service readiness probing and ShipFlow service identity checks
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
- [src-tauri/src/service/runtime_config.rs](./src-tauri/src/service/runtime_config.rs)
- [src-tauri/src/service/http_api.rs](./src-tauri/src/service/http_api.rs)
- [src-tauri/src/service/process_runtime.rs](./src-tauri/src/service/process_runtime.rs)
- [src-tauri/src/service/state_store.rs](./src-tauri/src/service/state_store.rs)
- [src-tauri/src/workspace_document.rs](./src-tauri/src/workspace_document.rs)

Run Rust tests with:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Run shared core Rust tests with:

```bash
cargo test --manifest-path crates/shipflow-core/Cargo.toml
```

Run service runtime Rust tests with:

```bash
cargo test --manifest-path crates/shipflow-service-runtime/Cargo.toml
```

Run service package Rust tests with:

```bash
cargo test --manifest-path apps/service/Cargo.toml
```

Run Rust clippy with warnings denied:

```bash
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

## Notes

- The app depends on the current HTML structure of the POS Indonesia tracking page
- If the upstream HTML changes, the Rust parser may need updates
- Hidden columns are stored in browser/webview local storage
- Pinned columns are stored in browser/webview local storage
- Workspace and sheet state are persisted in browser/webview local storage with a storage-safe fallback snapshot
- Service runtime state, PID markers, pending activation requests, and runtime logs are stored under the user app-data `shipflow-service-runtime` state directory; the old temp-dir location is read only as a migration fallback
