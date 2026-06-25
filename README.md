# ShipFlow Desktop

Desktop shipment tracking workspace built with Tauri, Rust, React, and Vite.

The app is optimized for spreadsheet-style operational analysis. Each row represents one shipment. The first data column accepts a shipment ID, then the app asks `ShipFlow Service` for tracking data and fills the rest of the row. A sheet is treated as one independent workspace with its own `Workspace` mode and `Pivot/Grafik` mode.

The current frontend tooling baseline is Node.js `24`, Vite `7`, Vitest `4`, and Playwright smoke coverage for the pivot workspace.

The runtime foundation now supports POS bag and manifest lookups through the shared Rust core and the local service API. The desktop workspace still stays shipment-first, but each sheet can now import shipment IDs from bag and manifest lookups through sheet-local modal flows.

Architecture references:

- [docs/runtime-architecture.md](./docs/runtime-architecture.md)
- [docs/rust-core-engine-big-bang.md](./docs/rust-core-engine-big-bang.md)
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
- Supports per-sheet `Workspace` and `Pivot/Grafik` modes without changing other sheets
- Supports creating a new sheet from selected shipment IDs only
- Supports appending selected shipment IDs into another existing sheet
- Uses a standalone `ShipFlow Service` for Desktop tracking and optional API access for other apps
- Exposes a documented `ShipFlow Service` API v1 contract for status, capabilities, lookup, and batch tracking jobs

## Tracking Flow

1. Enter a shipment ID in the `Nomor Kiriman` column
2. The frontend upserts the visible row into the Rust workspace engine
3. The frontend calls `refresh_sheet_row_tracking` for that Rust row
4. `ShipFlow Desktop` forwards the engine refresh to `ShipFlow Service`
5. The service runtime resolves the active tracking source:
   - internal POS scraper
   - external ShipFlow API
6. For the internal scraper, the Rust tracking layer sends the shipment ID to the POS PID detail endpoint with a base64-encoded `id` query:

```text
https://pid.posindonesia.co.id/lacak/admin/detail_lacak_banyak.php?id=...
```

7. ShipFlow Service enriches only missing sender/recipient phone numbers from `lacak-mitra`:

```text
https://lacak-mitra.posindonesia.co.id/lacak_barcode.php?id=<shipment_id>
```

8. Contact enrichment is best-effort and cached persistently per exact shipment ID. The `lacak-mitra` response is not used to overwrite status, SLA, history, POD, bagging, manifest, delivery, names, or addresses.
9. The response is normalized into the app's JSON shape
10. The Rust workspace engine persists the tracking record and returns a row projection
11. The matching row is updated with shipment details

Example shipment ID:

```text
P2604100065109
```

Example generated upstream URL:

```text
https://pid.posindonesia.co.id/lacak/admin/detail_lacak_banyak.php?id=UDI2MDQxMDAwNjUxMDk%3D
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

Current service API routes:

- `GET /v1/openapi.json`
- `GET /v1/status`
- `GET /v1/capabilities`
- `GET /v1/track/:shipment_id`
- `GET /v1/track/:shipment_id/html`
- `GET /v1/bag/:bag_id`
- `GET /v1/manifest/:manifest_id`

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
- raw upstream shipment HTML lookup through `GET /v1/track/:shipment_id/html`
- best-effort contact enrichment for sender/recipient phone numbers from `lacak-mitra`, with persistent contact cache
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

## Upstream Lookup Backpressure

Bulk tracking clients should use direct `GET /v1/track/:shipment_id` calls.

ShipFlow Service protects every upstream lookup path with a shared 15-permit concurrency gate, so multiple clients can share parallel tracking without creating unbounded upstream scraping pressure. The gate covers direct tracking, raw tracking HTML, bag lookup, and manifest lookup.

Upstream lookup guardrails:

- at most 15 active upstream lookups run through the Service backpressure gate
- additional direct tracking, HTML, bag, and manifest requests wait for the next permit instead of creating extra upstream pressure
- lookup cache and in-flight request coalescing still apply inside the Service runtime

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
- Text and value filters do not auto-select rows; existing selections are only pruned when selected rows leave the visible result set
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
- `Bag` import opens a sheet-local modal that can fetch one or more bag IDs, show the shipment ID list, and either `Ganti Semua` or `Tambah Data` into the current sheet
- `Manifest` import opens a sheet-local modal that fetches one or more manifest IDs, resolves manifest bag IDs first, then resolves each bag to shipment IDs in parallel before allowing `Ganti Semua` or `Tambah Data`
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
- Column filter capability is metadata-driven from the column registry: normal text/number/date/boolean columns are filterable, while POD image and raw JSON/history columns are marked non-filterable and do not expose text or value-filter controls.
- The workspace layout is tuned to be more compact so tabs, actions, shortcuts, and the sheet grid fit more comfortably in one screen
- Toast notifications are shown as a fixed top-right queue and do not shift the sheet layout
- `history_summary.delivery_runsheet` now keeps the latest delivery result as one update with:
  - `status` as the final delivery status
  - `keterangan_status` as the delivery failure/detail reason when available

## Sheet Modes And Pivot Analytics

Each sheet owns its mode and analytics configuration independently. Switching one sheet to `Pivot/Grafik`, changing rows, changing columns, changing values, or changing chart mode does not affect another sheet.

Sheet modes:

- `Workspace`: the shipment tracking table and sheet action workflow
- `Pivot/Grafik`: the sheet-local analytics workspace for pivot tables and charts

`Pivot/Grafik` defaults to `Pivot`. The mode selector is ordered as:

1. `Pivot`
2. `Bar`
3. `Donut`

The analytics action panel contains:

- `Sumber`: choose filtered rows, all rows, or selected rows
- `Mode`: choose `Pivot`, `Bar`, or `Donut`
- `Row`: searchable multi-select fields used as pivot row dimensions and chart groups
- `Column`: searchable multi-select fields used as pivot column dimensions
- `Value`: searchable multi-select fields used as pivot/chart values with type-aware formulas

`Row`, `Column`, and `Value` can use only this curated field list:

| Field | Type |
|---|---|
| `Nomor Kiriman` | `text` |
| `TRX - TODAY` | `number` |
| `TRX - UNBAG` | `number` |
| `PID/Kantong Terakhir` | `text` |
| `Manifest Terakhir` | `text` |
| `Status Akhir` | `text` |
| `Lokasi Akhir` | `text` |
| `Petugas Akhir` | `text` |
| `ID Petugas Akhir` | `text` |
| `Tanggal Status Akhir` | `text` |
| `Waktu Status Akhir` | `text` |
| `Nama Pengirim` | `text` |
| `Telepon Pengirim` | `text` |
| `Alamat Pengirim` | `text` |
| `Nama Penerima` | `text` |
| `Telepon Penerima` | `text` |
| `Alamat Penerima` | `text` |
| `Kode Pos Penerima` | `text` |
| `ID Pelanggan Korporat` | `text` |
| `Nama Kantor` | `text` |
| `ID Kantor` | `text` |
| `Nama Petugas` | `text` |
| `ID Petugas` | `text` |
| `Tanggal Input` | `date` |
| `Jenis Layanan` | `text` |
| `Is COD` | `boolean` |
| `Total COD` | `currency` |
| `Status COD` | `text` |
| `SLA Target` | `text` |
| `SLA Category` | `text` |
| `SLA Days Diff` | `number` |
| `Jumlah Delivery Runsheet` | `number` |

Value behavior:

- numeric, currency, weight, text, date, and boolean columns can be selected as values
- selected values can be reordered and removed from the active value list
- selected value order is preserved by summaries, chart primary value selection, and pivot display
- numeric, currency, and weight values support `Jumlah`, `Rata-rata`, `Nilai Maksimum`, `Nilai Minimum`, `Jumlah Data`, and `Banyaknya Nilai Berbeda`
- text, date, and boolean values support `Teks`, `Jumlah Data`, `Banyaknya Nilai Berbeda`, `Paling Sering`, `Pertama`, and `Terakhir`
- the value formula menu is type-aware, so text fields do not offer numeric formulas such as `Jumlah`, `Rata-rata`, `Nilai Maksimum`, or `Nilai Minimum`
- the `Value` list only contains allowed sheet columns, without built-in virtual values
- missing numeric, currency, or weight row/column values render as `0`
- missing text, date, or boolean row/column values render as `-`

Pivot table behavior:

- pivot rows are grouped by the selected `Row` fields
- pivot columns are grouped by the selected `Column` fields
- when no `Row` is selected, the pivot uses a single `Semua Row` row
- when no `Column` is selected, the selected `Value` fields render as normal value columns
- selected `Value` fields fill pivot cells using their selected formulas
- `Share` in `Pivot` mode is based on row count share for each pivot group
- pivot headers are sortable for row columns, pivot value columns, and `Share`
- the default pivot table sort is `Share` descending
- when `Share` is not available because no primary value is selected, pivot sorting falls back to the first visible row or value column
- pivot rows use stable internal keys, so rows with identical joined display labels still render independently

Chart behavior:

- `Bar` and `Donut` use Rust `query_chart`, selected `Row` fields for grouping, and the primary selected `Value` as the chart value
- `Column` fields are only sent to Rust for `Pivot` mode; chart modes do not use column fields to split the chart series
- `Column` fields are preserved in the sheet config but only affect `Pivot` mode
- chart rows are sorted by value descending before label tie-breaks
- `Share` in chart calculations follows the selected value, while `Pivot` share follows row count share

Analytics engine notes:

- the active production analytics query path is Rust-first for representable scopes, using `query_pivot` for `Pivot` mode and `query_chart` for `Bar` / `Donut` as the authoritative result
- supported filtered-row text filters and value filters are sent to the Rust analytics query; when a query is not representable or fails, the UI shows an empty analytics summary instead of recomputing from the React row mirror
- [src/features/sheet/rust-analytics-adapter.ts](./src/features/sheet/rust-analytics-adapter.ts) owns the frontend boundary for Rust pivot/chart queries and result view models
- [crates/shipflow-workspace-engine](./crates/shipflow-workspace-engine) now includes the Rust cutover path for embedded DuckDB pivot/chart commands, Bag/Manifest preview lookups, Rust-owned import jobs, manual/paste row upserts, row delete/clear commands, row detail refresh, batch row detail refresh, paged sheet-row windows, and distinct field-value queries for value-filter menus. The desktop Bag/Manifest modal uses the Rust preview command for `Ambil Data` and preview-only failed retry flows, uses Rust import jobs for `Ganti Semua` / `Tambah Data`, retries failed committed source items through the Rust failed-only import job channel, reads committed row ids from Rust import job items before refreshing tracking detail, closes completed imports without copying Rust row windows back into React `sheet.rows`, and the workspace grid receives Rust row-window metadata while requesting the next visible row window through the view model. Valid manual `Nomor Kiriman` drafts and multi-line paste seed `sheet_rows` through Rust, projection-backed row edits pass `engineRowId` back to Rust while keeping UI keys local, single-row manual lookup uses `refresh_sheet_row_tracking`, multi-line paste plus selected-ID transfer use `refresh_sheet_rows_tracking`, completed tracking refreshes settle local loading/queued flags without copying returned tracking detail projections into React `sheet.rows`, empty manual drafts delete stale Rust rows, row delete/move/clear flows remove stale Rust rows before the next row-window query, selected-ID transfer and sheet duplication no longer materialize returned Rust row windows into target React `sheet.rows`, sheet duplication no longer clones local row data, `.shipflow` document saves require Rust row-window snapshots instead of falling back to the UI mirror, settled grid value filters now derive Rust payloads from column metadata instead of scanning the React row mirror, open value-filter menus query distinct option counts from Rust when the current grid query is representable, table body plus visible totals, tracking auto-width, and lightweight selection/copy/retry/count/export selectors use `SheetTableRow` projection view models instead of letting `SheetTable` rebuild rows from canonical React `SheetRow[]`, unselected CSV export pages through Rust row queries instead of exporting only the active UI window, failed representable Rust row-window queries no longer resurrect filled React mirror rows, `Retry Gagal` uses projection `engineRowId` values directly for Rust batch refresh instead of remapping display ids through React, `Lacak Ulang` uses Rust batch refresh for unfiltered sheets and collects Rust row ids for filtered scopes, queued, loading, and dirty mirror rows no longer block supported Rust row-window queries, including filtered and sorted scopes, analytics summaries trust Rust `sourceRowCount` plus supported filtered-row text/value filters for representable scopes instead of requiring React row-count parity, and React row state is limited to transient draft/edit/runtime UI bridging rather than production data ownership.
- Representable Rust row-window responses are authoritative once resolved or failed. While the current Rust query is still pending, the grid may keep the filtered React mirror visible as a transient UI bridge so action-bar selection and table controls do not flicker or disable before the Rust window arrives.

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
- Custom Desktop-to-Service settings are saved only after an authenticated `/v1/status` response proves the endpoint is ShipFlow Service.
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
- Filtered views keep manual selection stable and only prune selected row keys that are no longer visible, so applying a filter does not implicitly select every matching shipment.
- Request telemetry is emitted for `start`, `success`, `fail`, and `abort` with `sheetId`, `rowKey`, and `shipmentId`.
- `Delete All` resets rows, filters, value filters, sort state, and in-flight tracking work so the table returns to a clean input state.
- `Lacak Ulang` marks all target rows as queued first, then promotes only the active worker row to loading while preserving completed/failed row status.
- Batch tracking refreshes carry a per-sheet `runId`; stale progress/results from cancelled, deleted, or superseded runs are ignored so old events cannot restore deleted rows or downgrade completed rows back to pending.
- Batch tracking progress updates local row runtime state only; Rust row-window/cache mutation is emitted after the batch result settles, not once per row progress event.
- Sheet duplication deep-copies analytics arrays and aggregation maps, so the duplicate sheet cannot mutate the source sheet's pivot configuration by shared reference.
- Workspace persistence repairs duplicate persisted sheet IDs, duplicate row keys, and duplicate selected row keys during load instead of allowing corrupted saved state to destabilize the workspace.
- Legacy persisted `cod_total` value aggregations are migrated to the current `Total COD` analytics field key.
- Browser-only frontend dev sessions guard Tauri event listeners before subscribing, so missing Tauri internals do not produce runtime console errors outside the desktop shell.
- Delivery-runsheet parsing is hardened so `FAILEDTODELIVERED` cases are not incorrectly split into two updates on the latest runsheet.
- Delivery-runsheet parsing now keeps only the latest effective update for a runsheet summary.
- Desktop no longer manages service tray/background lifecycle.
- Desktop startup no longer starts a service companion. Start the standalone service first, then configure Desktop with that service port/token.
- Desktop/service readiness checks now require an authenticated `GET /v1/status` response from `ShipFlow Service`, including a ShipFlow-specific product marker, before reusing an existing runtime process.
- Windows release builds of `ShipFlow Service` use the Windows subsystem, so launching the installed service app does not open a console window.
- Windows installers use fixed `C:\ShipFlow` locations: `C:\ShipFlow\Desktop` for Desktop, `C:\ShipFlow\Service` for Service, and `C:\ShipFlow\Data` for shared runtime state, lookup cache, token vault, PID files, and logs.
- Launching `ShipFlow Service` normally starts it in the background and keeps only the system-tray/menu-bar entry visible.
- Closing the `ShipFlow Service` settings window hides it and keeps the service tray companion available.
- Reopening `ShipFlow Service` from the tray/menu-bar entry focuses or recreates the existing settings window instead of starting a duplicate settings instance.
- On macOS, `ShipFlow Service` stays in accessory/menu-bar mode while hidden, switches to a regular app policy when the settings window is shown, exposes native About/Preferences/Hide/Quit menu items, and handles Dock/Finder reopen by focusing the existing settings window.
- Quitting `ShipFlow Service` from the native menu or tray stops the API runtime and any open Service settings UI instead of leaving a duplicate or hidden process behind.
- `Start ShipFlow Service at login` is an explicit Service setting. It remains independent from the current-session menu-bar/system-tray persistence toggle.
- Service autostart defaults off until the user explicitly enables `Start ShipFlow Service at login`.
- Desktop and Service settings register the official Tauri single-instance plugin before other plugins, so duplicate UI launches are delegated to the running app lifecycle before another window is created.
- macOS duplicate launches focus the existing app through the Tauri single-instance callback, Dock/Finder reopen handling, and app-bundle activation via `open -b`; Windows keeps the named-mutex guard plus activation request fallback.
- On Windows, closing a clean Desktop main window hides it behind a tray icon; the tray can reopen the same Desktop UI or quit the Desktop process explicitly.
- If the Service tray/menu-bar companion cannot start, the Service settings window is shown as a fallback so the user can still edit configuration.
- Desktop and Service cross-launch helpers look for the separately installed app first and no longer fall back to launching the current app as the other product.
- On Windows, cross-launch discovery prefers the installer-written `ExecutablePath` registry value and falls back to `InstallLocation`, so Desktop and Service can still find each other when the install directory contains spaces or the binary name changes.
- Desktop custom connection saves no longer start or stop the Service tray companion.
- Windows Desktop and Service installers run shutdown hooks before install and uninstall replacement, so running ShipFlow processes are closed before files are overwritten.
- Custom Desktop-to-Service lookups re-check the authenticated `/v1/status` identity before sending shipment, bag, or manifest IDs to a custom endpoint.
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
- [src/backend/events.ts](./src/backend/events.ts): guarded frontend boundary for Tauri event listeners
- [public/favicon.svg](./public/favicon.svg): browser/dev favicon asset
- [src/features/workspace/components/SheetTabs.tsx](./src/features/workspace/components/SheetTabs.tsx): sheet tab shell and tab/menu orchestration
- [src/features/workspace/components/SheetFileMenu.tsx](./src/features/workspace/components/SheetFileMenu.tsx): workspace file menu
- [src/features/workspace/components/DesktopServiceConnectionPanel.tsx](./src/features/workspace/components/DesktopServiceConnectionPanel.tsx): Desktop-to-Service port/token settings panel
- [src/features/sheet/components/SheetActionBar.tsx](./src/features/sheet/components/SheetActionBar.tsx): sheet action bar shell
- [src/features/sheet/components/ImportSourceModal.tsx](./src/features/sheet/components/ImportSourceModal.tsx): bag/manifest import modal
- [src/features/sheet/components/SheetAnalyticsView.tsx](./src/features/sheet/components/SheetAnalyticsView.tsx): sheet-local `Pivot/Grafik` side panel, chart view, and sortable pivot table
- [src/features/sheet/analytics.ts](./src/features/sheet/analytics.ts): analytics field eligibility, value aggregation, pivot grouping, share, and summary logic
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
- [crates/shipflow-workspace-engine](./crates/shipflow-workspace-engine): Rust-owned workspace engine for the big-bang cutover target, including durable sheet data, import jobs, paged sheet-row window queries, Bag/Manifest preview lookups, failed-only retry contracts, dotted-ID tracking refresh, content-addressed raw response blobs, and embedded DuckDB analytics query contracts
- [crates/shipflow-service-runtime](./crates/shipflow-service-runtime): shared ShipFlow Service HTTP API and lookup cache runtime
- [crates/shipflow-service-runtime/src/api_contract.rs](./crates/shipflow-service-runtime/src/api_contract.rs): versioned API envelope and error contract
- [crates/shipflow-service-runtime/src/persistent_store.rs](./crates/shipflow-service-runtime/src/persistent_store.rs): persistent lookup payload store
- [crates/shipflow-tauri-runtime/src/tracking/mod.rs](./crates/shipflow-tauri-runtime/src/tracking/mod.rs): shared tracking facade used by Tauri command handlers
- [src-tauri/src/fixtures](./src-tauri/src/fixtures): parser fixtures used by Rust tests

### Runtime Split

- `ShipFlow Desktop`: document workspace, sheet management, and table UI
- `ShipFlow Service`: runtime lookup API, source selection, service token, cache, and external API access
- `shipflow-tauri-runtime`: neutral shared runtime used by both Desktop and Service
- `shipflow-core`: shared lookup engine used by desktop/service Rust code
- `shipflow-workspace-engine`: Rust-owned workspace data engine for the big-bang cutover target; it is wired through Tauri commands, Bag/Manifest preview lookup commands, import progress channels, manual/paste `upsert_sheet_rows`, single-row `refresh_sheet_row_tracking`, bulk/import/selection `refresh_sheet_rows_tracking`, content-addressed raw response blobs for successful import/tracking responses, empty-draft/delete/clear row commands, paged row-window queries, distinct field-value option queries for filter menus, guarded production `query_sheet_rows` usage for settled workspace grids with supported filter/sort/value-filter semantics, metadata-driven value-filter payloads that no longer require a React row mirror for non-tracking fields, projection-backed table row view models passed directly into `SheetTable`, projection-backed visible totals and tracking auto-width, lightweight visible-window/export selectors, Rust-paged unselected CSV export, Rust-authoritative `.shipflow` document snapshots, import job item `sheetRowIds` before post-import tracking refresh without copying imported row windows into React `sheet.rows`, tracking refresh completion without copying Rust tracking detail projections into React `sheet.rows`, Rust failed-only import retry, projection `engineRowId` driven failed-row retry, Rust batch retrack for representable row-query scopes, storage-level `analytics_cache` invalidation for sheet/tracking mutations, and production `query_pivot` / `query_chart` usage for representable analytics scopes including supported filtered-row value filters through the Rust analytics-result adapter
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
- `GET /v1/status` with the expected bearer token returns `200 OK` and the `product: "shipflow-service"` marker in the response envelope.
- `GET /v1/status` with the wrong bearer token returns `401 Unauthorized`.
- Starting a second service process on the same port fails with `Address already in use`.
- `npm run build`, `cargo fmt --all -- --check`, and `cargo clippy --workspace --all-targets -- -D warnings` pass after the runtime smoke test.

The CLI smoke test does not replace a visual Desktop smoke pass. Still verify the Tauri window flow for standalone service settings, POD hover previews, and native workspace save dialogs before a user-facing release.

For signed installed artifacts, use [docs/native-runtime-release-smoke-checklist.md](./docs/native-runtime-release-smoke-checklist.md). That checklist is the required release evidence for native single-instance behavior, explicit autostart, Windows Desktop close/reopen/exit behavior, menu/tray lifecycle, stable Desktop/Service discovery, and signed updater installation on macOS and Windows.

Latest frontend workspace and pivot/grafik audit baseline, verified on 2026-05-29:

- `npm run security:baseline` passes the Tauri capability, CSP, and updater artifact config checks.
- `npm test` passes `179` tests across `24` frontend/backend test files.
- `npm run build` passes the TypeScript and Vite production build.
- `git diff --check` passes for whitespace validation.
- Playwright opens the local Vite app, switches into `Pivot/Grafik`, renders the pivot action panel and pivot table without a blank screen, and reports no app runtime console errors.
- Desktop and Service both pass `tauri build --no-bundle --ci`, validating the narrowed Tauri capability files and production Tauri config.
- The audit specifically covers per-sheet workspace isolation, pivot/grafik mode isolation, value order preservation, empty field display by column type, Row/Column/Value pivot behavior, stable row keys for colliding pivot labels, visible fallback sorting when values are empty, persisted workspace repair, and guarded Tauri event listeners in browser/dev mode.

### Reference Only

`EX-SCRAP/` is kept only as a reference. It is not part of the active app flow and must not be modified for app changes.

## Run Locally

Use Node.js `24` or newer. The repository includes `.node-version` for local version managers.

Install dependencies:

```bash
npm install
```

Run the frontend only:

```bash
npm run dev
```

Run the Playwright pivot smoke test:

```bash
npm run test:e2e
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

Build a local standalone service macOS app bundle for developer smoke checks:

```bash
npm run build:service:bundle:macos
```

Windows distribution uses the Service installer produced by GitHub Actions, not the raw binary.

Build the Windows desktop installer on Windows:

```bash
npm run build:bundle:nsis
```

This builds the Desktop app binary and packages it with the custom NSIS installer that installs to `C:\ShipFlow\Desktop`.

Build a local macOS app bundle for developer smoke checks:

```bash
npm run build:bundle:macos
```

Local macOS bundle commands are not release publishing paths. Distributable Desktop,
Service, and updater artifacts must be produced by the signed GitHub Actions workflows
or an equivalent explicit `APPLE_SIGNING_IDENTITY` overlay.

Build signed updater artifacts with the required Tauri signing key and updater endpoint configuration:

```bash
npm run build:updater:desktop
npm run build:updater:service
```

The signed updater workflow also notarizes and staples the macOS `.app` bundle
and any generated DMG installer before upload. Windows updater builds verify the
generated installer signatures with `signtool`.

## GitHub Actions Quality Gate

The repository includes a quality workflow at:

- `.github/workflows/quality.yml`

The workflow name shown in GitHub Actions is:

- `Quality Gate`

What it does:

- runs on `ubuntu-latest`
- installs Node.js `24` and Rust
- installs Linux Tauri system dependencies
- checks the local security baseline for Tauri capability scope, CSP, and updater artifact config
- runs frontend tests
- runs the production frontend build
- installs Chromium and runs the Playwright pivot smoke test
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
- checks the local security baseline for Tauri capability scope, CSP, and updater artifact config
- runs frontend tests
- runs `cargo fmt --all -- --check`
- runs `cargo test --workspace --all-targets`
- runs `cargo clippy --workspace --all-targets -- -D warnings`
- builds the Desktop NSIS installer without bundling `ShipFlow Service`
- requires `WINDOWS_CERTIFICATE` and `WINDOWS_CERTIFICATE_PASSWORD`
- signs `target/release/shipflow3-tauri.exe` before packaging
- signs `target/release/ShipFlow-Desktop-Setup.exe` after packaging
- installs Desktop to `C:\ShipFlow\Desktop` and prepares writable runtime data folders under `C:\ShipFlow\Data`
- wires the Desktop NSIS installer to close running Desktop processes before reinstall or uninstall replacement
- smoke-checks the Desktop executable and installer icon
- uploads the Desktop NSIS installer artifact: `shipflow-desktop-windows-installer`

Triggers:

- manual run via `workflow_dispatch`
- no automatic push trigger by default

The uploaded Windows output is:

- `target/release/ShipFlow-Desktop-Setup.exe`

## GitHub Actions Build Desktop macOS

The repository also includes a macOS build workflow at:

- `.github/workflows/build-macos-app.yml`

The workflow name shown in GitHub Actions is:

- `Build Desktop macOS`

What it does:

- runs on `macos-latest`
- installs Node.js and Rust
- checks the local security baseline for Tauri capability scope, CSP, and updater artifact config
- runs frontend tests
- runs `cargo fmt --all -- --check`
- runs `cargo test --workspace --all-targets`
- runs `cargo clippy --workspace --all-targets -- -D warnings`
- requires Apple Developer ID signing and notarization credentials before building a distributable artifact
- builds the Desktop macOS app bundle without bundling `ShipFlow Service`
- builds a signed Desktop macOS DMG installer for user installation
- smoke-checks the generated app bundle and icon resources
- verifies the generated `.app` bundle signature with `codesign --verify --deep --strict`
- submits the signed app and DMG installer to Apple notarization, staples the notary tickets, and runs `spctl --assess`
- archives the `.app` bundle as a `.zip` artifact to preserve the macOS bundle structure during download
- uploads the notarized DMG installer alongside the app archive

Triggers:

- manual run via `workflow_dispatch`
- no automatic push trigger by default

The uploaded macOS outputs are:

- `target/release/bundle/macos/ShipFlow-Desktop-macos-app.zip`
- `target/release/bundle/**/*.dmg`

Important notes:

- A browser-downloaded macOS app should be signed to avoid the broken-app warning from Gatekeeper.
- Configure the `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, and notarization credentials (`APPLE_API_*` or `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`) before publishing Desktop artifacts.

## GitHub Actions Build Service Windows

The repository includes a standalone Windows service workflow at:

- `.github/workflows/build-service-windows-installer.yml`

The workflow name shown in GitHub Actions is:

- `Build Service Windows`

What it does:

- runs on `windows-latest`
- installs Node.js, Rust, and frontend dependencies
- checks the local security baseline for Tauri capability scope, CSP, and updater artifact config
- builds the frontend assets embedded by the Service settings window
- runs `cargo fmt --all -- --check`
- runs `cargo test --workspace --all-targets`
- runs `cargo clippy --workspace --all-targets -- -D warnings`
- builds `apps/service` through Tauri in no-bundle release mode with `custom-protocol` enabled
- requires `WINDOWS_CERTIFICATE` and `WINDOWS_CERTIFICATE_PASSWORD`
- signs `target/release/shipflow-service.exe` before packaging
- signs `target/release/ShipFlow-Service-Setup.exe` after packaging
- builds an admin Windows installer with NSIS
- installs Service to `C:\ShipFlow\Service` and prepares writable runtime data folders under `C:\ShipFlow\Data`
- removes the explicit `ShipFlowServiceTray` user autostart entry during uninstall
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
- checks the local security baseline for Tauri capability scope, CSP, and updater artifact config
- builds the frontend assets embedded by the Service settings window
- runs `cargo fmt --all -- --check`
- runs `cargo test --workspace --all-targets`
- runs `cargo clippy --workspace --all-targets -- -D warnings`
- requires Apple Developer ID signing and notarization credentials before building a distributable Service artifact
- builds and signs a macOS `ShipFlow Service.app` bundle and DMG installer with the Service icon
- smoke-checks the generated app bundle and icon resources
- verifies the generated `.app` bundle signature with `codesign --verify --deep --strict`
- submits the signed Service app and DMG installer to Apple notarization, staples the notary tickets, and runs `spctl --assess`
- archives the `.app` bundle as a `.zip` artifact to preserve the macOS bundle structure during download
- uploads the macOS Service distribution artifact: `shipflow-service-macos-distribution`

Triggers:

- manual run via `workflow_dispatch`
- no automatic push trigger by default

The uploaded macOS Service output is:

- `target/release/bundle/macos/ShipFlow-Service-macos-app.zip`
- `apps/service/target/release/bundle/**/*.dmg`

Desktop installers no longer include the service app. Install ShipFlow Service separately, then configure Desktop with the service port and token.

Important macOS distribution note:

- A downloaded `ShipFlow Service.app` must be Developer ID signed and notarized to pass Gatekeeper without the "Apple could not verify" warning.
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
- sheet-local `Workspace` / `Pivot/Grafik` mode isolation
- pivot analytics Row/Column/Value behavior, share calculation, and field eligibility
- per-sheet bag / manifest modal isolation, cache, append, replace, and auto-track flows
- concurrent manifest lookups across multiple sheets with stale-result protection
- tracking telemetry and malformed-response guards

The table benchmark is kept separate from the normal test suite so regular checks stay fast. It renders `1000` rows, verifies virtualization is still active, and logs baseline render / scroll timings for the table body.

Rust tests are now split by domain and cover:

- Service API v1 response envelope timestamp formatting
- Service API batch-job status/result bookkeeping
- persistent lookup-store overwrite durability
- PID shipment detail URL generation with base64-encoded lookup IDs
- embedded API bearer-auth validation
- authenticated service readiness probing and ShipFlow service identity checks
- service settings activation, single-instance detection, and tray companion lifecycle checks
- native runtime release gates compile and lint the shared Tauri runtime on macOS and Windows through the `Quality Gate` workflow matrix
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
npm run security:baseline
npm test
npm run build
npm run test:e2e
cargo fmt --all -- --check
cargo test --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
```

## Notes

- The app depends on the current HTML structure of the POS Indonesia tracking page
- If the upstream HTML changes, the Rust parser may need updates
- Hidden columns are stored in browser/webview local storage
- Pinned columns are stored in browser/webview local storage
- Browser/webview workspace snapshots are persisted as inputs-only data so local storage keeps sheet layout and tracking inputs without duplicating full tracking detail payloads
- Local startup seed sync writes legacy tracking inputs into Rust only when the Rust sheet is empty; existing engine rows stay authoritative over stale browser/webview mirrors
- `.shipflow` document saves prefer Rust row-window data and fall back to the current UI state if the engine snapshot cannot be queried
- Desktop stores only the standalone ShipFlow Service port/token it uses for lookups
