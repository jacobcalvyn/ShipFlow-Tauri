# Multi-Sheet Architecture Design

## Status

This document defines the safest path to add multi-sheet support to the current tracking workspace.

It is a design document only. It does not imply that the feature is already implemented.

## Goals

- Keep the current sheet UX intact
- Allow multiple case-specific sheets inside one workspace
- Reuse the existing sheet engine instead of creating separate logic per sheet
- Keep request handling safe so late responses never write into the wrong sheet
- Preserve current table capabilities:
  - bulk paste
  - bulk retrack
  - filters
  - value filters
  - sorting
  - pin / hide columns
  - CSV export
  - row selection

## Non-Goals

- Full Excel-like workbook behavior
- Formula engine
- Cross-sheet formulas or references
- Drag-and-drop row transfer between sheets in the first version
- Shared filters or shared selections between sheets

## Product Model

The current `action panel + shortcut bar + table` should remain one `SheetView`.

Multi-sheet support should be introduced by adding a `Workspace` that can host many `SheetView` instances, while rendering only one active sheet at a time.

## High-Level Architecture

```text
AppShell
  -> WorkspaceProvider / WorkspaceState
    -> SheetTabs
    -> ActiveSheetScreen
      -> SheetActionBar
      -> SheetShortcuts
      -> SheetTable
```

The important rule is:

- one global workspace state
- one active sheet id
- one reusable sheet engine
- one isolated state bag per sheet

## State Model

### Global App State

Global state should stay small.

```ts
type AppState = {
  trackingServer: TrackingServerConfig | null;
  serverError: string;
  workspace: WorkspaceState;
};
```

Global state should not own per-sheet filters, rows, or selections.

### Workspace State

```ts
type WorkspaceState = {
  version: 1;
  activeSheetId: string;
  sheetOrder: string[];
  sheetsById: Record<string, SheetState>;
};
```

### Sheet State

```ts
type SheetState = {
  id: string;
  name: string;
  rows: SheetRow[];
  filters: Record<string, string>;
  valueFilters: Record<string, string[]>;
  sortState: SortState;
  hiddenColumnPaths: string[];
  pinnedColumnPaths: string[];
  selectedRowKeys: string[];
  selectionFollowsVisibleRows: boolean;
  columnWidths: Record<string, number>;
  openColumnMenuPath: string | null;
  highlightedColumnPath: string | null;
  deleteAllArmed: boolean;
  createdAt: string;
  updatedAt: string;
};
```

### Row Identity

`SheetRow.key` remains row-local, but request bookkeeping must use a composite key:

```ts
type RequestKey = `${sheetId}:${rowKey}`;
```

This is required to prevent late responses from writing into the wrong sheet.

## Storage Model

Workspace state should be persisted as one versioned object.

```ts
type PersistedWorkspace = {
  version: 1;
  activeSheetId: string;
  sheetOrder: string[];
  sheetsById: Record<string, PersistedSheetState>;
};
```

Recommendations:

- debounce persistence
- validate on load
- fallback to a default single empty sheet if invalid
- never persist in-flight request handles
- never persist transient UI refs

## Sheet Engine Boundaries

The safest implementation path is to split current `App.tsx` behavior into three layers.

### 1. Sheet Selectors

Pure derived state:

- `getNonEmptyRows(sheet)`
- `getDisplayedRows(sheet, columns)`
- `getLoadedCount(sheet, displayedRows)`
- `getSelectedVisibleRowKeys(sheet, displayedRows)`
- `getExportableRows(sheet, displayedRows)`
- `getValueOptionsByPath(sheet, columns)`
- `getPinnedLeftMap(sheet, columns, widths)`

### 2. Sheet Actions

Pure or near-pure state transitions:

- edit tracking input
- fetch one row
- bulk paste
- clear filters
- clear selection
- delete selected
- delete all
- retrack all
- toggle pin / hide / sort / value filter

### 3. Workspace Actions

Workspace-level operations:

- create sheet
- rename sheet
- duplicate sheet
- delete sheet
- switch active sheet
- move sheet order

## Component Responsibilities

### `AppShell`

Owns:

- server config
- workspace state
- persistence bootstrap
- global request infrastructure

Does not own:

- active sheet filtering logic
- row rendering details

### `SheetTabs`

Owns:

- sheet tab UI only

Actions:

- create
- rename
- duplicate
- delete
- switch active sheet

### `ActiveSheetScreen`

Receives:

- `sheet: SheetState`
- `dispatchSheetAction`
- `dispatchWorkspaceAction`
- `trackingServerConfig`

Renders:

- action bar
- shortcut bar
- table

## Request Safety Rules

This is the most important part of the design.

### Rule 1

Every active request must be keyed by `sheetId + rowKey`.

### Rule 2

Every fetch completion must verify:

- the request controller still matches
- the request epoch still matches
- the target sheet still exists
- the target row still exists inside that sheet

### Rule 3

Deleting a sheet must invalidate all pending requests for that sheet.

### Rule 4

Switching active tabs must not cancel requests by default. Requests should continue in the background, but only update their own sheet.

### Rule 5

Duplicating a sheet must clone row data and view state, but must not clone in-flight request handles.

## UX Rules

### Sheet Tabs

First version should support:

- create sheet
- rename sheet
- duplicate sheet
- delete sheet
- switch active sheet

First version should not support:

- nested tabs
- tab grouping
- drag transfer between sheets
- cross-sheet selection

### Default Sheet Cases

The feature should support user-created case sheets such as:

- `All Shipments`
- `COD Review`
- `SLA Investigation`
- `Return Cases`
- `Pending Delivery`

These should be normal sheets with different names, not different engines.

Optional future enhancement:

- create sheet from current filters
- create sheet from current selection

## Delete and Reset Rules

All destructive behavior must remain sheet-scoped.

### `Delete Selected`

- affects only the active sheet
- only clears rows in the active sheet

### `Delete All`

- affects only the active sheet
- resets:
  - rows
  - filters
  - value filters
  - sort state
  - selection state
  - menu state
  - delete-arm state

It must not modify any other sheet.

## Migration Plan

### Phase 1

Refactor current single-sheet app into reusable sheet engine logic without changing UX.

Deliverables:

- `sheet/selectors.ts`
- `sheet/actions.ts`
- `sheet/default-state.ts`

### Phase 2

Introduce `WorkspaceState`, but keep exactly one sheet.

Deliverables:

- `workspace/types.ts`
- `workspace/state.ts`
- one default sheet only

This phase proves the architecture without changing the visible behavior much.

### Phase 3

Add `SheetTabs` UI and support:

- create
- rename
- switch
- delete

### Phase 4

Add duplicate sheet and autosave workspace.

### Phase 5

Optional advanced flows:

- create sheet from current filter
- create sheet from selected rows
- import/export workspace

## Suggested File Layout

```text
src/
  features/
    workspace/
      components/
        SheetTabs.tsx
      storage.ts
      state.ts
      types.ts
      utils.ts
    sheet/
      actions.ts
      default-state.ts
      selectors.ts
      columns.ts
      state.ts
      types.ts
      utils.ts
      components/
        SheetActionBar.tsx
        SheetTable.tsx
        SheetBodyRow.tsx
        ColumnHeaderCell.tsx
```

## Persistence Strategy

Recommended behavior:

- autosave workspace to local storage or app-local file
- debounce writes by `300-800ms`
- save after meaningful state changes only
- ignore transient refs and controllers

Recommended validation on load:

- schema version exists
- active sheet exists in `sheetOrder`
- all `sheetOrder` ids exist in `sheetsById`
- all sheet states can be normalized

If validation fails:

- rebuild a default workspace with one sheet

## Test Plan

### Unit Tests

- `workspace/state.test.ts`
  - create sheet
  - rename sheet
  - duplicate sheet
  - delete sheet
  - switch active sheet

- `sheet/selectors.test.ts`
  - displayed rows
  - loaded count
  - selected visible rows
  - exportable rows

- `sheet/actions.test.ts`
  - delete all affects only one sheet
  - clear filters affects only one sheet
  - duplicate sheet does not carry transient request state

### Integration Tests

- switch tabs preserves per-sheet filters
- delete active sheet moves focus safely
- background request updates only the original sheet
- `Delete All` on one sheet leaves other sheets untouched

## Risk Register

### Risk 1: Cross-Sheet Response Corruption

Cause:

- request identity does not include `sheetId`

Mitigation:

- composite request key
- epoch validation

### Risk 2: Hidden Shared State

Cause:

- keeping filter / sort / selection outside `SheetState`

Mitigation:

- make all view state sheet-local

### Risk 3: Persistence Drift

Cause:

- schema evolves but local storage payload is stale

Mitigation:

- versioned payload
- normalization on load

### Risk 4: Overbuilt UX Too Early

Cause:

- implementing full workbook behavior immediately

Mitigation:

- keep v1 to tabs + isolated sheet state only

## Recommended First Implementation Slice

The safest first implementation is not multi-tab UI.

It is this:

1. extract the current single-sheet logic into `SheetState + selectors + actions`
2. wrap it with a one-sheet `WorkspaceState`
3. verify nothing regresses
4. only then add visible sheet tabs

This keeps the migration controlled and makes rollback easy if something goes wrong.
