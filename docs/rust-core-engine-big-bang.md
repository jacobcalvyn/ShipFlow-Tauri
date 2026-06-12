# Rust Core Engine Big-Bang Migration

## Status

Proposed target architecture for a non-incremental cutover branch.

This document is intentionally not a step-by-step roadmap. It defines the end state
that must be true before the branch can replace the current React-owned sheet data
model.

## Objective

Move ShipFlow Desktop to a Rust-owned data engine where React is a renderer and
command surface only.

The cutover is successful only when:

- sheet rows, tracking records, import jobs, retry state, raw responses, and
  analytics inputs are durable in Rust-owned storage
- React no longer owns the canonical row array or import job state
- import jobs can resume after process restart
- pivot/chart results are queried from the engine instead of computed from large
  React arrays
- old TypeScript orchestration for import/retry/dedupe/detail lookup is removed or
  reduced to UI adapters

## Target Architecture

```text
React Renderer
  - transient UI state only
  - visible row window
  - selection/hover/modal/tab state
  - progress counters and result summaries received from Rust

Tauri 2 IPC
  - commands for mutations and queries
  - channels for batched progress/result events

Rust Core Engine
  - tokio runtime
  - job queue and global semaphore
  - retry/backoff/cancel/resume
  - SQLite WAL operational store
  - DuckDB embedded analytics
  - content-addressed blob store

shipflow-core
  - tracking, bag, manifest domain models
  - POS parsing and upstream request rules
  - ID normalization and dotted-ID lookup policy
```

## Ownership Rules

React owns:

- active view mode
- active sheet id
- modal open/closed state
- draft text inside active input controls
- selection and hover state
- current visible row window
- progress snapshots received from Rust

React must not own:

- canonical sheet rows
- loaded tracking detail
- import job items
- retry attempt state
- raw upstream responses
- analytics source rows
- pivot/chart aggregation loops
- dotted shipment lookup decisions

Rust owns:

- workspace operational state
- sheet row identity and ordering
- import job lifecycle
- retry policy and attempt log
- tracking fetch/update lifecycle
- raw response persistence
- analytics query execution
- crash recovery

## Rust Module Layout

Recommended new crate:

```text
crates/shipflow-workspace-engine/
  src/lib.rs
  src/engine.rs
  src/storage.rs
  src/schema.rs
  src/blob_store.rs
  src/jobs.rs
  src/imports.rs
  src/tracking.rs
  src/analytics.rs
  src/events.rs
  src/commands.rs
  src/test_support.rs
```

Responsibilities:

- `engine`: shared state, dependency wiring, lifecycle bootstrap
- `storage`: SQLite connection pool, WAL setup, transactions, repositories
- `schema`: migrations and schema version checks
- `blob_store`: content-addressed raw HTML/JSON storage
- `jobs`: queue, semaphore, cancel/resume/backoff, attempt logging
- `imports`: Bag/Manifest import jobs, dedupe, failed-only retry
- `tracking`: shipment detail lookup, dotted ID resolution, row updates
- `analytics`: DuckDB connection, SQLite attach/read path, pivot/chart queries
- `events`: Tauri channel payload contracts and batching
- `commands`: Tauri-facing DTOs and command handlers

## SQLite Operational Schema

SQLite must run with WAL enabled:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
```

Core tables:

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  schema_version INTEGER NOT NULL
);

CREATE TABLE sheets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  view_mode TEXT NOT NULL DEFAULT 'workspace',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sheet_rows (
  id TEXT PRIMARY KEY,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  display_tracking_id TEXT NOT NULL,
  lookup_tracking_id TEXT NOT NULL,
  tracking_record_id TEXT REFERENCES tracking_records(id),
  row_status TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(sheet_id, position)
);

CREATE TABLE tracking_records (
  id TEXT PRIMARY KEY,
  display_tracking_id TEXT NOT NULL,
  lookup_tracking_id TEXT NOT NULL,
  normalized_status TEXT,
  status_json TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  history_json TEXT NOT NULL,
  raw_blob_id TEXT REFERENCES raw_blobs(id),
  fetched_at TEXT NOT NULL,
  source_url TEXT NOT NULL
);

CREATE TABLE import_jobs (
  id TEXT PRIMARY KEY,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  total_count INTEGER NOT NULL,
  success_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  pending_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  cancelled_at TEXT
);

CREATE TABLE import_job_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  source_item_id TEXT NOT NULL,
  source_item_kind TEXT NOT NULL,
  position INTEGER NOT NULL,
  status TEXT NOT NULL,
  tracking_ids_json TEXT NOT NULL DEFAULT '[]',
  error_message TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(job_id, source_item_id, source_item_kind)
);

CREATE TABLE import_attempts (
  id TEXT PRIMARY KEY,
  job_item_id TEXT NOT NULL REFERENCES import_job_items(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  error_message TEXT,
  raw_blob_id TEXT REFERENCES raw_blobs(id),
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE raw_blobs (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL,
  byte_len INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE analytics_cache (
  id TEXT PRIMARY KEY,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  query_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(sheet_id, query_hash, source_revision)
);
```

Required indexes:

```sql
CREATE INDEX idx_sheet_rows_sheet_position ON sheet_rows(sheet_id, position);
CREATE INDEX idx_sheet_rows_sheet_display_id ON sheet_rows(sheet_id, display_tracking_id);
CREATE INDEX idx_sheet_rows_lookup_id ON sheet_rows(lookup_tracking_id);
CREATE INDEX idx_import_jobs_sheet_status ON import_jobs(sheet_id, status);
CREATE INDEX idx_import_items_job_status ON import_job_items(job_id, status);
CREATE INDEX idx_import_attempts_item_number ON import_attempts(job_item_id, attempt_number);
CREATE INDEX idx_tracking_records_lookup_id ON tracking_records(lookup_tracking_id);
```

Status enums:

```text
import_jobs.status: pending | running | completed | failed | cancelled
import_job_items.status: pending | running | succeeded | failed | cancelled
sheet_rows.row_status: empty | loading | loaded | failed | stale
```

## Blob Store Contract

Raw upstream responses must not be stored inline in large SQLite fields.

Blob layout:

```text
workspace-data/
  blobs/
    ab/
      abcdef...sha256.html
      abcdef...sha256.json
```

Rules:

- blob id is the SHA-256 hash of bytes plus media type
- write to a temp file, fsync, then atomic rename
- store only relative blob paths in SQLite
- never log blob content
- keep raw HTML/JSON available for audit and parser debugging

## Command Contract

All command names below are target contracts. Existing commands can remain as
temporary adapters only until cutover.

```ts
type ImportKind = "bag" | "manifest";
type ImportMode = "replace" | "append";

type CreateImportJobRequest = {
  sheetId: string;
  kind: ImportKind;
  ids: string[];
  mode: ImportMode;
};

type ImportJobSummary = {
  jobId: string;
  sheetId: string;
  kind: ImportKind;
  mode: ImportMode;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  totalCount: number;
  successCount: number;
  failedCount: number;
  pendingCount: number;
};
```

Commands:

```text
create_import_job(request) -> ImportJobSummary
retry_import_job_failed(job_id) -> ImportJobSummary
cancel_import_job(job_id) -> ImportJobSummary
get_import_job(job_id) -> ImportJobDetail
preview_import_source(kind, ids) -> ImportSourcePreviewResult
query_sheet_rows(sheet_id, window, filters, sort) -> SheetRowWindow
refresh_sheet_row_tracking(row_id, force_refresh) -> SheetRow
query_pivot(sheet_id, query) -> PivotResult
query_chart(sheet_id, query) -> ChartResult
resolve_tracking_id(display_id) -> ResolvedTrackingId
```

`ChartResult` includes the same `sourceRowCount` denominator as `PivotResult`.
The desktop UI uses `query_pivot` for `Pivot` mode and `query_chart` for `Bar`
/ `Donut` mode. Chart queries intentionally send empty `columnFields`; column
dimensions belong to the pivot table, not to chart series splitting.

`query_sheet_rows` contract:

```ts
type SheetRowWindow = {
  sheetId: string;
  offset: number;
  limit: number;
  totalCount: number;
  hasMore: boolean;
  nextOffset: number | null;
  rows: SheetRowProjection[];
};
```

`hasMore` and `nextOffset` are part of the cutover contract. The grid must page
through Rust row windows instead of materializing a large canonical row array in
React state.

`resolve_tracking_id` contract:

```ts
type ResolvedTrackingId = {
  displayId: string;
  lookupId: string;
  resolution: "exact" | "stripped_numeric_suffix";
};
```

For dotted IDs, the default target behavior is:

```text
P2606020189412.30 -> displayId=P2606020189412.30, lookupId=P2606020189412
```

Reviewer question: decide whether the final implementation should try the exact
ID first and fall back to base ID, or keep direct base-ID lookup for `.number`
suffixes.

Current tracking engine status:

- `refresh_sheet_row_tracking` resolves the target row from SQLite, fetches
  detail using `lookupTrackingId`, writes a durable `tracking_records` entry,
  and attaches it back to the row.
- Dotted display IDs remain row-local display values; the upstream fetch uses
  the stripped base lookup ID when the suffix is numeric.
- Failed refreshes mark only the row as `failed` and preserve the original
  display and lookup IDs.
- Persistent runtime writes successful tracking responses to the
  content-addressed blob store and links the blob id from `tracking_records`
  while still persisting normalized JSON detail/status/history data for query
  paths.

## Channel Contract

Use Tauri channels for job progress and row deltas.

Progress payloads must be batched:

```ts
type ImportJobProgressEvent = {
  type: "import_job_progress";
  jobId: string;
  sheetId: string;
  status: ImportJobSummary["status"];
  totalCount: number;
  successCount: number;
  failedCount: number;
  pendingCount: number;
  itemDeltas: Array<{
    itemId: string;
    status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
    trackingIds: string[];
    errorMessage: string | null;
  }>;
};
```

Rules:

- emit no more than one progress event per job per animation frame equivalent,
  unless the job completes
- include counters in every event
- include only changed items in `itemDeltas`
- UI must be able to reconstruct the current modal state from `get_import_job`
  plus subsequent channel events

## DuckDB Analytics Contract

DuckDB is the source of truth for pivot/chart aggregations.

Minimum supported query:

```ts
type PivotQuery = {
  sheetId: string;
  sourceScope: "all_rows" | "filtered_rows" | "selected_rows";
  filters: Array<{ field: string; value: string }>;
  valueFilters: Array<{ field: string; values: string[] }>;
  selectedRowIds: string[];
  rowFields: string[];
  columnFields: string[];
  values: Array<{
    field: string;
    aggregation:
      | "sum"
      | "average"
      | "min"
      | "max"
      | "count"
      | "count_unique"
      | "unique_list"
      | "most_frequent"
      | "first"
      | "last";
  }>;
  sort: Array<{ field: string; direction: "asc" | "desc" }>;
  limit: number;
};
```

Required parity:

- numeric blank values render as `0`
- text blank values render as `-`
- allowed analytics fields match `ANALYTICS_FIELD_COLUMN_PATHS`
- text columns support `count` and `count_unique`
- pivot share calculation must use the same denominator as the current UI

Current branch status:

- `crates/shipflow-workspace-engine` dispatches `query_pivot` and `query_chart`
  through embedded DuckDB instead of returning a placeholder error.
- The Rust pivot engine projects SQLite sheet rows into an in-memory DuckDB
  table per query, groups by `rowFields` and `columnFields`, and returns
  long-form pivot rows with `rowValues`, `columnValues`, `count`, `metrics`,
  and `share`.
- The Rust chart command wraps the same DuckDB aggregation path and returns
  `sourceRowCount` plus `series` so Bar/Donut summaries do not need a frontend
  row-array fallback.
- The SQLite `analytics_cache` table is guarded by storage-level invalidation:
  sheet-row inserts, deletes, moves, status updates, tracking-record attaches,
  and attached tracking-record updates clear cache rows for the affected sheet,
  so future cache activation cannot serve stale pivot/chart results after a
  mutation.
- The current Rust implementation supports `all_rows`, `filtered_rows`, and
  `selected_rows` source scopes through `filters`, `valueFilters`, and
  `selectedRowIds` payloads.
- Import jobs can stream committed progress snapshots through
  `WorkspaceEngineEvent::ImportJobProgress`; Tauri exposes dedicated channel
  commands for run and failed-only retry so React can render progress without
  owning import state.
- Rust exposes `preview_import_source` for Bag/Manifest lookup previews. The
  desktop Bag/Manifest modal now uses this command for `Ambil Data` and
  preview-only failed retry flows, so preview lookup orchestration is owned by
  Rust without mutating `sheet_rows`.
- The desktop Bag/Manifest commit path now creates Rust import jobs, runs them
  through the Tauri progress channel, reads committed `sheetRowIds` from the
  completed Rust import job detail, refreshes only those committed Rust rows,
  retries failed committed source items through the Rust failed-only import job
  channel, and closes the modal without seeding imported row copies into
  `SheetState.rows`. The workspace grid is expected to re-query the Rust row
  window after the engine mutation revision advances.
- `query_sheet_rows` returns explicit grid-window metadata (`hasMore` and
  `nextOffset`) in addition to the row projections, so the final `SheetTable`
  cutover can page against Rust-owned rows.
- Rust row-window queries now support explicit, allow-listed filtering and
  sorting over row metadata plus direct tracking JSON fields, as well as exact
  value filters for allow-listed fields. The frontend row-query adapter now
  derives text, numeric/currency/weight, boolean, and direct date value-filter
  payloads from column metadata and selected UI values instead of scanning the
  React row mirror, so settled or resumed grids can query Rust even when React
  has no current row data. The tracking-number value filter remains guarded
  because its UI option is a prefix bucket that cannot be safely expanded to full
  IDs without source rows. Complex JSON and unsupported computed/latest-summary
  fields intentionally remain on the legacy path until their Rust semantics
  match exactly. This keeps SQL generation bounded while moving grid
  filtering/sorting toward the Rust engine.
- Rust now exposes `query_sheet_field_values` for value-filter menus. The
  frontend uses it when the current grid query is representable, so distinct
  option counts come from SQLite instead of the visible React row window. The
  tracking-number field intentionally returns the same five-character prefix
  buckets as the legacy UI, and Rust value filtering applies those prefixes with
  `LIKE` semantics so selecting a bucket filters the expected full IDs.
- The production sheet view model now issues async `query_pivot` commands while
  analytics mode is active, converts `PivotResult` responses through the Rust
  analytics adapter, and treats Rust `sourceRowCount` as authoritative when the
  analytics scope can be represented by the Rust query contract. The old React
  source-row parity guard has been removed because it would keep React as a
  hidden analytics owner after Rust has enough information to answer the query.
- Unsupported analytics filters or failed Rust pivot queries no longer fall
  back to TypeScript aggregation. The UI surfaces an empty analytics summary
  until the Rust query contract can represent those fields.
- The production sheet view model now treats settled `query_sheet_rows`
  responses as the authoritative displayed row source in workspace mode when
  active text-filter/sort/value-filter semantics are supported by the Rust
  query adapter. It also queries Rust when React has no non-empty row mirror,
  which is required for resume-style reconstruction after the Rust engine owns
  durable rows.
- Failed representable `query_sheet_rows` requests no longer fall back to filled
  React mirror rows. The grid keeps only draft-style placeholder rows from an
  empty Rust window shape, so stale React tracking detail cannot reappear as the
  displayed data source when the engine query is unavailable.
- Pending representable `query_sheet_rows` requests may keep the filtered React
  mirror visible as a transient UI bridge. Resolved or failed Rust row-window
  responses remain authoritative, but pending queries must not make selection
  or action-bar controls flicker or disable before the current Rust window
  arrives.
- Service lookup-cache invalidation is generation-safe under test: late results
  from an invalidated generation still resolve for their original caller, but
  cannot replace the fresh cache entry used by later lookups.
- Rust now exposes a batch `refresh_sheet_rows_tracking` command. It accepts
  Rust row ids for one sheet, refreshes tracking detail into SQLite, preserves
  dotted display ids, and returns per-row loaded/failed projections without
  failing the whole batch when one upstream detail lookup fails.
- `refresh_sheet_rows_tracking` also accepts an empty `rowIds` list as an
  engine-owned full-sheet refresh. In that mode Rust refreshes all sheet rows
  and returns only counts, so React no longer has to query every row id or
  receive every refreshed projection over IPC after an import commit.
- The desktop Bag/Manifest commit bridge now uses `sheetRowIds` stored on each
  succeeded Rust import job item and calls `refresh_sheet_rows_tracking` only
  for rows committed by that job. Import commits no longer scan paged row
  windows in React to rediscover imported row ids, no longer fan out detail
  lookups through the old
  `track_shipment`/bulk-paste TypeScript path, no longer refresh unrelated
  append targets, and no longer request a 100k-row materialization just to close
  the modal.
- Manual `Nomor Kiriman` entry and multi-line paste now seed Rust-owned
  `sheet_rows` through `upsert_sheet_rows` using the UI row id, position, and
  display tracking id. Valid manual drafts sync into Rust as the input changes,
  and empty manual drafts delete the matching Rust row so settled row-window
  queries do not resurrect stale values. Dotted display ids are preserved while
  the lookup id is resolved in Rust. Single-row manual detail lookup calls
  `refresh_sheet_row_tracking`; multi-line paste calls
  `refresh_sheet_rows_tracking` for target UI row ids and applies the returned
  Rust projections. The old frontend `track_shipment` bridge is no longer the
  manual or bulk-paste row refresh path, and the frontend command module no
  longer exports direct `trackShipment`/`trackBag`/`trackManifest` wrappers.
  The Desktop Tauri invoke handler also no longer registers direct
  `track_shipment`, `track_shipments_batch`, `track_bag`, or `track_manifest`
  commands; renderer tracking/import lookups must go through
  `workspace_engine_command`.
  When a visible table row is backed by a Rust projection, input change, blur,
  paste, clear, and refresh commands pass the projection `engineRowId` to Rust
  while keeping the UI row key for local draft state and selection.
- Selected-ID copy/move now uses the Rust `transfer_sheet_rows` command.
  Projection-backed selected rows send `engineRowId` values to Rust; target
  rows are copied with their existing `tracking_record_id`, so copied/moved
  loaded rows keep detail/status/history without an upstream refetch. Transfer
  and copy no longer materialize the returned Rust row window into target
  `SheetState.rows`; target sheets render the copied rows from the next Rust
  row-window query after the engine mutation revision advances.
- Row-removal mutations now have Rust commands as well: `delete_sheet_rows`
  removes selected/UI row ids and compacts remaining positions, while
  `clear_sheet_rows` clears all rows for a sheet. Delete selected, clear cell,
  empty blur, and delete-all flows use these commands before the UI mutation
  that triggers the next row-window query. Move selected and drag/drop move use
  `transfer_sheet_rows` so source deletion and target append happen in one Rust
  transaction.
  Projection-backed selected rows now carry `engineRowId`, so Rust mutations use
  the engine row identity even when the visible UI key is still a legacy bridge
  key.
- Sheet duplication now calls the Rust `copy_sheet_rows` command after creating
  the target sheet metadata. The duplicated sheet keeps only empty local draft
  rows and renders copied data from Rust row-window queries, so row ids, dotted
  display ids, lookup ids, and attached tracking records come from the engine
  instead of from a React row clone.
- Sheet deletion now calls the Rust `delete_sheet` command before removing the
  local tab. The SQLite foreign-key cascade removes sheet rows and related job
  state for the deleted sheet, so React tab deletion no longer leaves a stale
  engine-owned sheet behind.
- Sheet creation and rename now sync sheet metadata through Rust
  `create_sheet` and `rename_sheet` commands. The current UI keeps an optimistic
  tab bridge for desktop responsiveness, but Rust receives the resolved sheet
  id, display name, and tab position instead of lazily creating sheets with
  `sheetId` as the fallback name.
- Rust now exposes `list_sheets` for ordered sheet metadata. The React app
  performs a safe metadata hydration pass: matching engine sheet ids update tab
  names/order and missing engine sheets are added, while local-only tabs are
  preserved until bootstrap ids are fully unified.
- New React workspaces now use the same default sheet contract as the Rust
  bootstrap (`default-sheet` / `Sheet 1`). This removes the previous fresh-start
  mismatch where React created a random first sheet id while Rust created
  `default-sheet`; the remaining safe-hydration guard exists only for legacy
  local state or document scopes that have not been migrated into the engine yet.
- Legacy local workspace state now migrates its primary sheet id to the Rust
  bootstrap sheet id and syncs sheet metadata at startup. Non-empty local
  tracking-id rows are seeded only when the corresponding Rust sheet is still
  empty, so a stale browser/webview mirror cannot replace durable engine rows.
  Document files preserve their own sheet ids when opened, then use replace-mode
  metadata/row sync so file identity is not rewritten just to satisfy the
  default local bootstrap contract.
- Startup sync now distinguishes legacy `seed` mode from document/new-workspace
  `replace` mode. Seed mode still creates sheet metadata, but it only migrates
  non-empty legacy rows after `query_sheet_rows` proves the Rust sheet is empty.
- Workspace-engine sync completion now invalidates the active sheet row-window
  query. This prevents a startup race where React could query an empty Rust
  window before local legacy rows were seeded, then keep displaying the stale
  empty window because the visible React row mirror did not change.
- Browser/webview workspace snapshots are now stored as inputs-only data. Local
  restart bootstrap can keep sheet names, modes, column preferences, and
  tracking inputs, but it no longer persists full tracking detail payloads in
  local storage. Explicit `.shipflow` document saves still use the existing full
  document serializer until a file-backed Rust workspace document contract
  replaces it.
- Explicit `.shipflow` saves now require Rust row-window data when building the
  document workspace payload. The save path paginates every sheet from the
  engine and converts row projections back into document rows; unsynced local
  React rows are not serialized as production data, and a failed engine snapshot
  fails the save instead of falling back to the UI mirror.
- Rust row-window fetch identity no longer includes React mirror rows, tracking
  ids, or tracking detail payloads. Import, transfer, delete, duplicate, manual
  tracking, and refresh flows now bump a controller-owned workspace-engine
  mutation revision after successful Rust commands. The current React rows are
  used only to project draft rows and stable UI keys for rendering.
- Projection-backed grid rows now treat matching local rows as transient draft
  overlays when the local input value has already changed but the latest Rust
  row window still contains the previous display tracking id. This keeps manual
  input editing responsive without making React rows part of the row-window
  query identity again.
- Projection-backed table rows now carry their Rust `position` into single-cell
  tracking edit and blur handlers. When a visible Rust row has no matching local
  mirror row, the tracking runtime creates a temporary local draft bridge and
  upserts the edit to Rust with the engine position, so single-row edits no
  longer require a pre-existing canonical React row.
- Multi-line paste from a projection-backed row now also carries the Rust
  position into the tracking runtime. If the start row is not present in the
  local mirror, React creates only temporary draft bridge rows for the pasted
  values and sends row ids plus positions to `upsert_sheet_rows`; the engine
  remains the owner of the persisted row window.
- Import modal lookup state now carries the active Rust import `jobId` and can
  hydrate its visible source/bag rows from `ImportJobDetail` snapshots in
  addition to progress channel deltas. The current UI still mirrors that state
  into legacy sheet state, but it now has the Rust job anchor needed for
  `get_import_job` and resume-style reconstruction.
- Reopening an import modal with an existing Rust `jobId` now calls
  `get_import_job` and applies the returned `ImportJobDetail` if the request is
  still current. This proves the UI can reconstruct modal rows from the Rust job
  store instead of depending only on previously mirrored local state.
- Completed Bag/Manifest commits no longer copy the resulting Rust row window
  back into React `sheet.rows`. The UI closes the modal, refreshes committed row
  details through Rust, and invalidates the row-window query so the grid reads
  the imported rows from the engine.
- The workspace grid now receives Rust row-window metadata (`offset`, `limit`,
  `totalCount`, `hasMore`, `nextOffset`) and reports visible row ranges back to
  the view model. The production view model uses that callback to query the
  next Rust-owned row window instead of requesting a 100k-row materialization.
  Workspace totals use the Rust `totalCount` when a row window is active.
  `SheetBodyRow` now renders through a `SheetTableRow` view model that can be
  backed directly by `SheetRowProjection` rows from the Rust window, so the
  table body no longer needs a converted `SheetRow[]` as its render contract
  when Rust window data is active. Lightweight visible-window selectors for
  visible totals, tracking auto-width, selection keys, selected/all tracking
  IDs, retry/retrack entries, and loaded/loading counts now read the same
  projection-backed `SheetTableRow` view models. CSV export also reads
  `SheetTableRow.getFormattedValue()` and no longer accepts `SheetRow[]` export
  data through the command controller.
  Local `queued`, `loading`, and dirty mirror flags no longer block Rust
  row-window queries. Dirty edits overlay matching Rust projections while the
  engine query remains authoritative for unfiltered and supported filtered/sorted
  scopes. Single-row and bulk tracking refreshes now settle those local runtime
  flags after the Rust command completes instead of copying returned tracking
  detail projections into React `sheet.rows`.
  Unselected CSV export now pages through `query_sheet_rows` when the current
  filter/sort contract is representable in Rust, so exports are not limited to
  the active UI row window. `Retry Gagal` now attempts the same Rust-owned
  detail-refresh path by taking projection `engineRowId` values directly from
  the visible `SheetTableRow` view models and calling
  `refresh_sheet_rows_tracking` for those rows; Rust-backed failed-row retry no
  longer remaps display ids through React or falls back to the frontend bulk
  runner when a Rust row id is missing. `Lacak Ulang` now uses
  `refresh_sheet_rows_tracking` for
  representable Rust scopes: unfiltered sheets use the engine-owned full-sheet
  refresh (`rowIds: []`), while filtered scopes page through `query_sheet_rows`
  to collect matching Rust row ids before refreshing. Selected export remains
  tied to the selected visible UI rows because selection is still transient
  React state. The remaining React row bridge is temporary draft/edit/runtime UI
  state; production row mutations and document snapshots go through Rust
  commands. Analytics no longer recomputes pivot data from the React row mirror; unsupported or
  failed Rust pivot queries surface an empty analytics summary instead.
- Rust-owned pivot parity is covered by the DuckDB fixture, filtered source
  scope, selected source scope, and 10k-row smoke tests in
  `shipflow-workspace-engine`.

Latest local validation snapshot:

- `cargo fmt --all -- --check`
- `cargo test --workspace`
- `npm run build`
- `npm test`
- `npm run test:e2e`

## React Cutover Rules

React must query, not own, operational data:

- `SheetTable` receives `SheetRowWindow` metadata and requests visible windows;
  its body rows must render from `SheetTableRow`/projection view models rather
  than requiring canonical `SheetRow[]`
  - A successful empty Rust row window is now authoritative; the view model may
    keep empty draft input rows for UI, but it no longer falls back to filled
    React mirror rows when Rust returns no rows.
  - A representable Rust row-window response is authoritative once resolved or
    failed. Pending requests may keep the filtered React mirror visible as a
    transient UI bridge, but React must replace it with the Rust projection as
    soon as the current window arrives.
  - `SheetTable` now requires `SheetTableRow[]` from the view model and no
    longer accepts canonical `SheetRow[]` as an internal fallback source.
  - The workspace view model derives visible shipment totals and tracking
    column auto-width from `SheetTableRow` projections, using Rust
    `SheetRowWindow.totalCount` whenever a Rust window is active.
- import modal receives `ImportJobDetail`, not local lookup state
- analytics view receives `PivotResult` or `ChartResult`, not computed row arrays
  - The workspace view model now uses Rust/DuckDB analytics only; when a Rust
    pivot/chart query cannot be built or fails, analytics returns an empty UI
    summary instead of falling back to React row-array computation.
  - `Pivot` mode uses `query_pivot`; `Bar` and `Donut` use `query_chart` with
    chart-only series and a Rust-owned `sourceRowCount`.
  - For `selected_rows` analytics scope, selected UI keys are mapped through
    projection `engineRowId` values before querying Rust. If that mapping is not
    complete yet, React waits for the Rust row window instead of sending legacy
    UI keys as engine row ids.
- old TS reducers/selectors for canonical row mutation must be deleted or renamed
  as UI-only adapters

Allowed React state after cutover:

- active sheet id and active mode
- visible row window request
- selected row ids for UI selection only; mutations must pass projection
  `engineRowId` values to Rust when they are available
- draft input text
- modal open state
- drag/drop and hover state
- last progress snapshot for active jobs

## Crash Recovery Contract

On engine startup:

1. Open SQLite with WAL and run migrations.
2. Find jobs with `status in ('pending', 'running')`.
3. Mark stale `running` items as `pending` unless cancelled.
4. Requeue pending items.
5. Emit a recovered job snapshot when the UI subscribes.

Crash recovery is proven only if:

- a job started before process kill is visible after restart
- succeeded items are not refetched unless explicitly forced
- failed items remain failed and can be retried
- pending/running items resume
- sheet rows already committed before crash remain visible

## Big-Bang Cutover Gates

The branch is not mergeable until all gates pass:

```text
cargo test --workspace
npm run build
npm test
npm run test:e2e
```

The Vitest gate intentionally caps `maxWorkers` at `2` and disables file
parallelism in `vite.config.ts`. The desktop suite includes long jsdom
import/workspace flows, so unbounded file parallelism can make worker startup
time out before any product assertion runs.

Additional required scenarios:

- crash-resume import test with at least 500 items
- failed-only retry test in Rust
- dotted ID test in Rust and UI integration
- multi-sheet request isolation test
- pivot parity fixture test against current expected output
- 10k-row import/query/pivot performance smoke in `shipflow-workspace-engine`
- blob store atomic-write test and runtime attachment tests for import/tracking
- migration/open-existing-workspace test

## Cutover Acceptance Checklist

- [ ] React no longer stores canonical sheet rows.
- [x] Import modal can be reconstructed from Rust `ImportJobDetail`.
- [x] Failed-only retry creates new attempts only for failed items.
- [x] Dotted display IDs never lose suffixes in sheet rows.
- [x] Detail lookup policy is tested independently in Rust.
- [x] Successful import/tracking responses are content-addressed and linked from
      durable records without duplicate blob writes.
- [x] Restart resumes unfinished import jobs, preserves already committed rows,
      and continues pending/running items.
- [x] DuckDB pivot output matches the current TS fixture output for row,
      column, value, count, and share behavior.
- [x] Existing workspace documents either migrate or fail with a recoverable,
      user-facing message.
- [ ] Old TS orchestration is removed or made UI-only.

## Known Risks

- This is a full architecture migration, not a feature patch.
- Maintaining current TS state and new Rust state at the same time creates two
  sources of truth; the cutover branch must remove the old source before merge.
- DuckDB integration may be straightforward for aggregates but harder for current
  text-list display behavior.
- Exact upstream semantics for dotted shipment IDs remain business-critical.
- Large import jobs need rate-limit/backoff policy before live use.

## First Implementation Entry Point

Because this is a big-bang branch, the first code change should be structural:

1. Add `crates/shipflow-workspace-engine`.
2. Add SQLite schema migrations and repository tests.
3. Add command DTOs and a non-UI engine test harness.
4. Wire Tauri commands only after the Rust engine can pass cargo tests without
   React.

Do not start by rewriting React components. The UI cutover should happen after
the engine can own durable workspace state on its own.
