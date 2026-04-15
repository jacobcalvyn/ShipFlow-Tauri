# ShipFlow Desktop

Desktop shipment tracking workspace built with Tauri, Rust, React, and Vite.

The app is optimized for spreadsheet-style operational analysis. Each row represents one shipment. The first data column accepts a shipment ID, then the app fetches POS Indonesia tracking details and fills the rest of the row.

## What The App Does

- Runs as a desktop app with Tauri
- Starts an internal Rust tracking server bundled with the app
- Scrapes tracking details directly from POS Indonesia without login
- Shows shipment detail and `status_akhir` fields in a wide spreadsheet-style table
- Supports bulk paste, row selection, CSV export, column pin/hide, sorting, and filtering
- Supports both text filters and per-column multi-select value filters
- Supports retracking all current shipments from the action bar

## Tracking Flow

1. Enter a shipment ID in the `Nomor Kiriman` column
2. The frontend calls the internal Rust server
3. The Rust server converts the shipment ID to Base64 and calls:

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
- Sticky selector column and sticky `Nomor Kiriman`
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
  - copy selected shipment IDs
  - delete selected rows
- Column shortcut buttons that horizontally scroll to key columns
- Temporary header highlight when a shortcut scroll target is reached

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

The backend still returns `pod`, `history`, and `history_summary`, but those are not the main focus of the current spreadsheet view.

## Stability And Safety Notes

- The internal Rust server now uses a per-session access token. The frontend must send that token in `x-shipflow-token` on tracking requests.
- CORS for the internal server is restricted to the local app/dev origins instead of being fully open.
- Retrack failures do not wipe the last successful shipment data. Failed refreshes keep the old row data and mark the row as stale.
- Numeric parsing in the Rust scraper is hardened: invalid upstream numeric fields now fail loudly instead of silently falling back to `0`.
- `Delete All` resets rows, filters, value filters, sort state, and in-flight tracking work so the table returns to a clean input state.

## Project Structure

### Frontend

- [src/App.tsx](./src/App.tsx): main state orchestration and app flow
- [src/features/sheet/columns.ts](./src/features/sheet/columns.ts): spreadsheet column definitions
- [src/features/sheet/types.ts](./src/features/sheet/types.ts): sheet-level UI types
- [src/features/sheet/utils.ts](./src/features/sheet/utils.ts): formatting and table helpers
- [src/features/sheet/state.ts](./src/features/sheet/state.ts): pure state helpers for filter/pin/hide logic
- [src/features/sheet/components](./src/features/sheet/components): table, header, row, and action bar components

### Backend

- [src-tauri/src/lib.rs](./src-tauri/src/lib.rs): app startup and Tauri wiring
- [src-tauri/src/tracking/model.rs](./src-tauri/src/tracking/model.rs): tracking response models
- [src-tauri/src/tracking/upstream.rs](./src-tauri/src/tracking/upstream.rs): upstream request and URL building
- [src-tauri/src/tracking/parser.rs](./src-tauri/src/tracking/parser.rs): POS HTML parsing
- [src-tauri/src/tracking/server.rs](./src-tauri/src/tracking/server.rs): internal HTTP server and Tauri command

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

Rust tests live in [src-tauri/src/lib.rs](./src-tauri/src/lib.rs) and cover:

- Base64 + percent-encoded tracking URL generation
- sample HTML parsing
- not-found parser behavior
- invalid numeric parser behavior

Run Rust tests with:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

## Notes

- The app depends on the current HTML structure of the POS Indonesia tracking page
- If the upstream HTML changes, the Rust parser may need updates
- Hidden columns are stored in browser/webview local storage
- Pinned columns are stored in browser/webview local storage
