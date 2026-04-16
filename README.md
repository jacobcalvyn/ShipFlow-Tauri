# ShipFlow Desktop

Desktop shipment tracking workspace built with Tauri, Rust, React, and Vite.

The app is optimized for spreadsheet-style operational analysis. Each row represents one shipment. The first data column accepts a shipment ID, then the app fetches POS Indonesia tracking details and fills the rest of the row. A sheet is treated as one independent workspace.

## What The App Does

- Runs as a desktop app with Tauri
- Scrapes tracking details directly from POS Indonesia without login
- Uses direct Tauri IPC from the React UI into Rust tracking code
- Shows shipment detail and `status_akhir` fields in a wide spreadsheet-style table
- Supports bulk paste, row selection, CSV export, column pin/hide, sorting, and filtering
- Supports both text filters and per-column multi-select value filters
- Supports retracking all current shipments from the action bar
- Supports multiple sheets, where each sheet is an isolated tracking workspace
- Supports creating a new sheet from selected shipment IDs only

## Tracking Flow

1. Enter a shipment ID in the `Nomor Kiriman` column
2. The frontend calls the Tauri `track_shipment` command directly
3. The Rust tracking layer converts the shipment ID to Base64 and calls:

```text
https://pid.posindonesia.co.id/lacak/admin/detail_lacak_banyak.php?id=...
```

4. The HTML response is parsed into the app's JSON shape
5. The matching row is updated with shipment details

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
  - copy selected shipment IDs
  - delete selected rows
- Column shortcut buttons that horizontally scroll to key columns
- Temporary header highlight when a shortcut scroll target is reached
- Sheet-specific scroll position, request state, and notices
- Toast notifications are shown as a fixed top-center queue and do not shift the sheet layout
- `Nomor Kiriman` rows include per-row QR preview, copy ID, and source-link actions
- `POD Photo 1` and `POD Photo 2` render as image thumbnails with hover preview
- `history_summary` cells open scrollable popup details inside the app
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

- Tracking now uses direct IPC instead of a localhost HTTP hop.
- Retrack failures do not wipe the last successful shipment data. Failed refreshes keep the old row data and mark the row as stale.
- Numeric parsing in the Rust scraper is hardened: invalid upstream numeric fields now fail loudly instead of silently falling back to `0`.
- Empty numeric upstream fields are preserved as `null`, not coerced to `0`.
- Shipment IDs are sanitized before tracking and rejected when they exceed `64` characters.
- Duplicate in-flight requests for the same `sheetId + rowKey + shipmentId` are skipped.
- Active, dirty, and loading rows remain visible even while filters are active.
- Request telemetry is emitted for `start`, `success`, `fail`, and `abort` with `sheetId`, `rowKey`, and `shipmentId`.
- `Delete All` resets rows, filters, value filters, sort state, and in-flight tracking work so the table returns to a clean input state.
- Delivery-runsheet parsing is hardened so `FAILEDTODELIVERED` cases are not incorrectly split into two updates on the latest runsheet.

## Project Structure

### Frontend

- [src/App.tsx](./src/App.tsx): main state orchestration and app flow
- [src/features/sheet/columns.ts](./src/features/sheet/columns.ts): spreadsheet column definitions
- [src/features/sheet/types.ts](./src/features/sheet/types.ts): sheet-level UI types
- [src/features/sheet/utils.ts](./src/features/sheet/utils.ts): formatting and table helpers
- [src/features/sheet/state.ts](./src/features/sheet/state.ts): pure state helpers for filter/pin/hide logic
- [src/features/sheet/components](./src/features/sheet/components): table, header, row, and action bar components
- [src/features/workspace](./src/features/workspace): multi-sheet workspace state and tabs

### Backend

- [src-tauri/src/lib.rs](./src-tauri/src/lib.rs): app startup and Tauri wiring
- [src-tauri/src/tracking/model.rs](./src-tauri/src/tracking/model.rs): tracking response models
- [src-tauri/src/tracking/upstream.rs](./src-tauri/src/tracking/upstream.rs): upstream request and URL building
- [src-tauri/src/tracking/parser.rs](./src-tauri/src/tracking/parser.rs): POS HTML parsing
- [src-tauri/src/fixtures](./src-tauri/src/fixtures): parser fixtures used by Rust tests

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

## Build

Build the frontend bundle:

```bash
npm run build
```

Build the desktop app:

```bash
npm run tauri build
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

Current frontend tests cover:

- sheet utility functions
- sheet state helpers for pin / hide / filter logic
- `SheetTable` interaction smoke test
- `SheetActionBar` interaction smoke test
- multi-sheet app-level isolation and stress scenarios
- tracking telemetry and malformed-response guards

Rust tests live in [src-tauri/src/lib.rs](./src-tauri/src/lib.rs) and cover:

- Base64 + percent-encoded tracking URL generation
- sample HTML parsing
- not-found parser behavior
- invalid numeric parser behavior
- nullable numeric parsing
- reordered-table parsing
- selected-field parser snapshots
- partial-upstream vs true not-found heuristics
- latest-runsheet `FAILEDTODELIVERED` parsing with `keterangan_status`

Run Rust tests with:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

## Notes

- The app depends on the current HTML structure of the POS Indonesia tracking page
- If the upstream HTML changes, the Rust parser may need updates
- Hidden columns are stored in browser/webview local storage
- Pinned columns are stored in browser/webview local storage
- Sheet data is currently in-memory only unless explicitly persisted in a later change
