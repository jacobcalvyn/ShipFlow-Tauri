# Refactor Audit

## Status

Active

## Scope

Audit the current `Desktop / Service / Core` split after the large refactor and identify the most important remaining coupling.

## Strong Results

- `src/App.tsx` is now an entry shell instead of the frontend orchestration hotspot.
- `shipflow-core` owns parser, upstream validation, and tracking models.
- `src-tauri/src/lib.rs` and `src-tauri/src/service.rs` are now composition layers instead of monoliths.
- Service-specific runtime logic is split into focused modules:
  - `http_api`
  - `runtime_config`
  - `state_store`
  - `process_runtime`
  - `tray_runtime`

## Remaining Coupling

### 1. Workspace shell still fans out a very large view contract

Files:

- `src/features/workspace/useWorkspaceShellViewController.ts`
- `src/features/workspace/useWorkspaceTabsProps.ts`
- `src/features/workspace/useWorkspaceActionBarProps.ts`
- `src/features/workspace/useWorkspaceTableProps.ts`

The current boundary is cleaner than before, but the shell still relies on a large prop-bundle assembly layer. This is better than a single huge component, but it still means the shell contract changes in many places whenever `SheetTabs`, `SheetActionBar`, or `SheetTable` evolve.

Recommended next step:

- introduce domain-specific view models for `document shell`, `sheet tabs`, and `sheet grid`
- reduce direct `ComponentProps<typeof ...>` coupling across these adapter hooks

### 2. `SheetTabs` still owns too many shell responsibilities

File:

- `src/features/workspace/components/SheetTabs.tsx`

This component still combines:

- file menu
- sheet context menu
- settings launcher flow
- rename flow
- selection-transfer drag/drop shell

That makes it the largest remaining custom HTML shell surface in the frontend. It also keeps a lot of desktop command behavior in a React component that should gradually move toward thinner command surfaces.

Recommended next step:

- split `SheetTabs` into `document toolbar`, `sheet strip`, and `sheet context menu`
- move more global commands to native menu/tray surfaces where practical

### 3. Styling is still a monolith and still drives web-like drift

File:

- `src/styles.css`

The structural refactor succeeded, but visual/system coupling is still concentrated in one global stylesheet. This is where desktop drift returns fastest because shell, modal, sheet, settings, popover, and table styles are still co-located.

Recommended next step:

- split global style layers into `shell`, `workspace`, `service-settings`, `dialogs`, and `sheet-grid`
- keep desktop shell tokens flatter and more platform-neutral than the old glass/card styling

### 4. Service settings are cleaner, but still presentation-heavy

Files:

- `src/features/service/ServiceSettingsApp.tsx`
- `src/features/service/components/ServiceSettingsWindow.tsx`

The window is now cleaner and uses the shared notice flow again, but the component still owns many local view concerns:

- token visibility
- tab navigation state
- external API test result state
- save/reset UX state

Recommended next step:

- extract a `useServiceSettingsViewState` hook if the surface keeps growing
- keep controller ownership in `useServiceSettingsController`

## Direction

The refactor is successful. The remaining work is no longer emergency decomposition. It is now about:

1. shrinking high-fanout UI contracts
2. reducing custom HTML shell surfaces
3. preventing style-system drift back toward a web dashboard
