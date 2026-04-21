# Runtime Architecture

## Status

Active

## Goal

Keep the current ShipFlow product split, but raise the internal architecture to a stronger desktop standard:

- `ShipFlow Desktop` owns UI, workspace documents, and user interaction
- `ShipFlow Service` owns runtime API access, tray lifecycle, and background availability
- `shipflow-core` owns tracking domain models, POS parsing, upstream request rules, and shared validation

## Current Runtime Boundaries

### `ShipFlow Desktop`

Owns:

- Tauri window lifecycle
- document workspace flow
- sheet state and table rendering
- desktop command handling

Does not own:

- POS scraping rules
- external API validation rules
- tracking response normalization logic

### `ShipFlow Service`

Owns:

- service configuration
- tray process and background lifecycle
- external API access mode and token handling
- track endpoint for other local clients

Does not own:

- desktop workspace UI
- parser-specific business rules

### `shipflow-core`

Owns:

- tracking response models
- shipment ID normalization and validation
- POS HTML parsing
- upstream URL construction and retry logic
- external API source validation

Does not own:

- window management
- tray UI
- desktop document persistence

## Why This Split Matters

This project already had the right product split with `ShipFlow Desktop` and `ShipFlow Service`, but the tracking logic still lived inside the Tauri crate. That kept the Rust app functional, but it did not create a reusable engine boundary.

By extracting `shipflow-core`, the shared logic can now evolve independently from the desktop shell and the service runtime. That is the first required step toward a higher-standard desktop architecture.

## Practical Rules

When adding new features:

1. Put tracking parsing, request normalization, and shared tracking validation in `shipflow-core`.
2. Put runtime process behavior, tray behavior, and local API behavior in `ShipFlow Service`.
3. Put document UI, sheet UI, and user interaction flow in `ShipFlow Desktop`.
4. Do not place new scraping logic directly in `src-tauri/src/lib.rs` or React components.

## Next Recommended Steps

1. Move more runtime-facing tracking orchestration out of the Tauri app layer and into service/core boundaries.
2. Introduce a persistent local data model for workspace documents instead of relying so heavily on frontend-owned state.
3. Reduce custom HTML shell surfaces so the desktop shell feels less like a web app and more like a desktop workspace.
4. Use `docs/native-platform-architecture.md` as the migration baseline when native macOS and Windows shells begin.
