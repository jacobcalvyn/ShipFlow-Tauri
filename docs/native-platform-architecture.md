# Native Platform Architecture

## Goal

Prepare ShipFlow for a future where macOS and Windows use fully native app shells without duplicating tracking logic.

## Non-Negotiable Rule

Do not duplicate scraping, parsing, or tracking normalization logic per platform.

That logic must stay shared.

## Shared Foundation

### `shipflow-core`

Owns:

- shipment ID normalization
- upstream validation rules
- POS parser logic
- tracking response models
- external API source validation

This remains the shared domain engine.

### `ShipFlow Service`

Owns:

- local runtime API
- tray/background lifecycle
- endpoint/token configuration
- shared runtime availability for desktop shells

This remains the shared operational backend.

## Native App Targets

### `ShipFlow macOS`

Recommended stack:

- `SwiftUI` for scene structure
- `AppKit` interop for desktop-only behaviors that SwiftUI does not model well enough

Recommended ownership:

- window lifecycle
- native menu and toolbar structure
- workspace shell and settings shell
- native file dialogs
- native shortcuts and responder-chain behaviors

### `ShipFlow Windows`

Recommended stack:

- `WinUI 3` as the preferred modern target
- `WPF` as the fallback if team velocity and control matter more than WinUI polish

Recommended ownership:

- native command bar / menu structure
- workspace shell and settings shell
- native file dialogs
- shortcut handling
- Windows-specific inspector/table shell behavior

## Contract Between Native Shells And Shared Runtime

Use `ShipFlow Service` as the shared runtime boundary.

Native shells should:

1. detect whether the service is already running
2. launch it when needed
3. call it through a stable local contract
4. render the result natively

Recommended contract style:

- loopback HTTP first
- versioned request / response models
- explicit health/config/status endpoints

Suggested endpoint families:

- `GET /health`
- `GET /service/config`
- `POST /service/config`
- `GET /service/status`
- `POST /track`
- `POST /pod/resolve`

## Migration Structure

Preferred repository direction:

```text
apps/
  tauri/
  macos/
  windows/
crates/
  shipflow-core/
```

Notes:

- keep the current Tauri app as the compatibility shell during migration
- do not force parity by rewriting everything at once
- move one user-visible surface at a time

## Migration Phases

### Phase 1. Stabilize shared contracts

- keep growing tests around `shipflow-core`
- make `ShipFlow Service` the explicit runtime contract
- document status/config/track flows clearly

### Phase 2. Native settings and service control

Build the easiest native surface first:

- service settings
- endpoint/token status
- runtime health

This gives native shells immediate value without needing the sheet grid yet.

### Phase 3. Native workspace shell

Move:

- document open/save shell
- sheet strip shell
- command surfaces
- settings and dialog shell

Keep the data grid migration separate.

### Phase 4. Native grid and high-throughput interaction

Move:

- dense table rendering
- column pin/hide
- filtering
- selection transfer
- keyboard-heavy workflows

This is the hardest phase and should only start after contracts are stable.

### Phase 5. Retire Tauri shell

Only after the native shells reach functional parity:

- demote Tauri to legacy support
- or remove it fully

## Practical Recommendation

Short term:

- keep investing in `shipflow-core` and `ShipFlow Service`
- keep the current Tauri shell stable

Medium term:

- build `apps/macos` first if desktop fidelity is the main product pressure
- use the same service/runtime contract for Windows later

Long term:

- native shells become platform-specific UX layers
- tracking logic remains shared and fixed in one place
