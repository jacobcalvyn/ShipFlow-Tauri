# ShipFlow Desktop

Desktop shipment tracking workspace built with Tauri, Rust, React, and Vite.

The app is optimized for spreadsheet-style operational analysis. Each row represents one shipment. The first data column accepts a shipment ID, then the app asks `ShipFlow Service` for tracking data and fills the rest of the row. A sheet is treated as one independent workspace.

## What The App Does

- Runs as a desktop app with Tauri
- Uses a document-style desktop workspace with open / save / save as
- Uses `ShipFlow Service` as the runtime that owns tracking configuration and API access
- Supports both internal POS scraping and external ShipFlow API source selection from `ShipFlow Service`
- Shows shipment detail and `status_akhir` fields in a wide spreadsheet-style table
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
- Sheet tabs use a `+` button for new sheets, and sheet-specific actions are exposed from a hover menu on each tab
- Sticky selector column and sticky `Nomor Kiriman`
- Keyboard row navigation in `Nomor Kiriman` with `Enter`, `ArrowUp`, and `ArrowDown`
- Row checkbox selection for copy/delete actions
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
- Column shortcut buttons that horizontally scroll to key columns
- Temporary header highlight when a shortcut scroll target is reached
- Sheet-specific scroll position, request state, and notices
- Toast notifications are shown as a fixed top-center queue and do not shift the sheet layout
- `Setting` is opened from a gear icon in the tabs panel and includes display scale controls plus a launcher to open `ShipFlow Service`
- `ShipFlow Service` owns:
  - runtime tracking source selection
  - external API access mode (`localhost` or `LAN`)
  - external API port
  - service-generated bearer token
- `Nomor Kiriman` rows include per-row QR preview, copy ID, and source-link actions
- QR previews are generated locally in-app and do not rely on an external QR image service
- `POD Photo 1` and `POD Photo 2` render as image thumbnails with hover preview
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
- External API access can be opened or closed from `ShipFlow Service` without affecting the desktop runtime itself.
- Retrack failures do not wipe the last successful shipment data. Failed refreshes keep the old row data and mark the row as stale.
- Numeric parsing in the Rust scraper is hardened: invalid upstream numeric fields now fail loudly instead of silently falling back to `0`.
- Empty numeric upstream fields are preserved as `null`, not coerced to `0`.
- Shipment IDs are sanitized before tracking and rejected when they exceed `64` characters.
- The backend now applies the same shipment-ID validation rules as the frontend, including embedded API requests.
- Duplicate in-flight requests for the same `sheetId + rowKey + shipmentId` are skipped.
- Active, dirty, and loading rows remain visible even while filters are active.
- Request telemetry is emitted for `start`, `success`, `fail`, and `abort` with `sheetId`, `rowKey`, and `shipmentId`.
- `Delete All` resets rows, filters, value filters, sort state, and in-flight tracking work so the table returns to a clean input state.
- Delivery-runsheet parsing is hardened so `FAILEDTODELIVERED` cases are not incorrectly split into two updates on the latest runsheet.
- Delivery-runsheet parsing now keeps only the latest effective update for a runsheet summary.
- The service companion always keeps tray/background behavior enabled; it is no longer exposed as a user-facing desktop setting.

## Project Structure

### Frontend

- [src/App.tsx](./src/App.tsx): main state orchestration and app flow
- [src/features/service/components/ServiceSettingsWindow.tsx](./src/features/service/components/ServiceSettingsWindow.tsx): companion service settings window UI
- [src/features/sheet/columns.ts](./src/features/sheet/columns.ts): spreadsheet column definitions
- [src/features/sheet/types.ts](./src/features/sheet/types.ts): sheet-level UI types
- [src/features/sheet/utils.ts](./src/features/sheet/utils.ts): formatting and table helpers
- [src/features/sheet/state.ts](./src/features/sheet/state.ts): pure state helpers for filter/pin/hide logic
- [src/features/sheet/components](./src/features/sheet/components): table, header, row, and action bar components
- [src/features/workspace](./src/features/workspace): multi-sheet workspace state and tabs

### Backend

- [src-tauri/src/lib.rs](./src-tauri/src/lib.rs): app startup and Tauri wiring
- [src-tauri/src/service.rs](./src-tauri/src/service.rs): companion service runtime, tray, and external API controller
- [src-tauri/src/tracking/model.rs](./src-tauri/src/tracking/model.rs): tracking response models
- [src-tauri/src/tracking/upstream.rs](./src-tauri/src/tracking/upstream.rs): upstream request and URL building
- [src-tauri/src/tracking/parser.rs](./src-tauri/src/tracking/parser.rs): POS HTML parsing
- [src-tauri/src/fixtures](./src-tauri/src/fixtures): parser fixtures used by Rust tests

### Runtime Split

- `ShipFlow Desktop`: document workspace, sheet management, and table UI
- `ShipFlow Service`: tracking runtime, source selection, service token, tray/background lifecycle, and external API access
- Desktop and service are installed together, but run as separate apps/processes

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

Run the service app directly in dev:

```bash
cargo run --manifest-path src-tauri/Cargo.toml --bin shipflow-service --
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

## GitHub Actions Windows Build

The repository includes a Windows build workflow at:

- `.github/workflows/build-windows-exe.yml`

What it does:

- runs on `windows-latest`
- installs Node.js and Rust
- runs frontend tests
- builds the Tauri Windows app
- uploads two artifacts:
  - portable app executable: `shipflow-desktop-windows-portable`
  - NSIS installer executable: `shipflow-desktop-windows-installer`

Triggers:

- manual run via `workflow_dispatch`
- no automatic push trigger by default

The uploaded Windows outputs are:

- `src-tauri/target/release/shipflow3-tauri.exe`
- `src-tauri/target/release/bundle/nsis/*.exe`

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
- tracking telemetry and malformed-response guards

The table benchmark is kept separate from the normal test suite so regular checks stay fast. It renders `1000` rows, verifies virtualization is still active, and logs baseline render / scroll timings for the table body.

Rust tests live in [src-tauri/src/lib.rs](./src-tauri/src/lib.rs) and cover:

- Base64 + percent-encoded tracking URL generation
- embedded API bearer-auth validation
- backend shipment-ID normalization and validation
- sample HTML parsing
- not-found parser behavior
- invalid numeric parser behavior
- nullable numeric parsing
- reordered-table parsing
- selected-field parser snapshots
- partial-upstream vs true not-found heuristics
- latest-runsheet `FAILEDTODELIVERED` parsing with `keterangan_status`
- latest-effective-update-only runsheet parsing

Run Rust tests with:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

## Notes

- The app depends on the current HTML structure of the POS Indonesia tracking page
- If the upstream HTML changes, the Rust parser may need updates
- Hidden columns are stored in browser/webview local storage
- Pinned columns are stored in browser/webview local storage
- Workspace and sheet state are persisted in browser/webview local storage with a storage-safe fallback snapshot
