# Desktop and Service Split

## Target Shape

ShipFlow should move toward a split runtime model:

- ShipFlow Desktop owns the operator UI, workspace files, and desktop settings.
- ShipFlow Service owns the local/internal HTTP API, scraping source configuration, cache, auth token, and lifecycle.
- `shipflow-core` stays as the shared parser and domain crate.
- `shipflow-service-runtime` owns the HTTP API server and lookup-cache runtime that both Desktop-managed and standalone service binaries can call.

The first migration step keeps the current monorepo and companion binary, but separates how Desktop chooses the service it calls.

## Completed Split Steps

Desktop service settings now include a Desktop-to-Service connection mode:

- `managedLocal`: current behavior. Desktop can ensure a local managed ShipFlow Service on `127.0.0.1:<port>`.
- `custom`: Desktop does not spawn a managed runtime for tracking. It calls the configured `desktopServiceUrl` with `desktopServiceAuthToken`.

The custom connection is validated before it is saved:

- URL is required.
- URL must use `http` or `https`.
- URL must include a host.
- URL must not include query strings or fragments.
- bearer token is required.
- authenticated `GET /status` must respond with the ShipFlow Service product marker.

Desktop lookup calls now build service endpoints from the configured client base URL instead of hard-coding `http://127.0.0.1:<port>`.

When Desktop uses `custom`, it does not enable or manage the Desktop-bundled API endpoint. The API tab is informational in that mode because the target service owns its endpoint, token, and lifecycle.

Desktop-to-Service HTTP calls now live behind `src-tauri/src/service_client.rs`. The Tauri runtime layer calls that client boundary instead of owning endpoint construction, bearer auth, service error parsing, or `/status` identity checks directly.

`apps/service` now exists as the standalone ShipFlow Service binary package. The bundled-service preparation script builds this package and copies its release binary into `src-tauri/binaries` for the current Tauri bundle flow.

`crates/shipflow-service-runtime` now owns the service HTTP API server, authenticated route handling, lookup cache, force-refresh header semantics, and service runtime validation. `src-tauri/src/service/http_api.rs` is now only an adapter from Desktop config into that shared runtime crate.

The repository now also has a standalone service binary workflow at `.github/workflows/build-service-binary.yml`. It builds `apps/service` on macOS and Windows and uploads service-only binary artifacts. This is not a full installer split yet, but it gives Service its own release artifact path before Desktop moves into a separate package.

## Service-Owned Config

When Desktop uses `custom`, the target service owns its own runtime and scraping configuration:

- bind host and port
- bearer token accepted by `/status`, `/track`, `/bag`, and `/manifest`
- internal scraping source/base URL/token
- cache and runtime state

Desktop only stores:

- connection mode
- service base URL
- service bearer token

## Next Migration Phases

1. Move service state/config/process lifecycle ownership out of `src-tauri/src/service` into service-owned crates or `apps/service`.
2. Reduce `apps/service` dependency on the desktop crate once tray/settings UI boundaries are separated.
3. Move Desktop into `apps/desktop` after service extraction is stable.
4. Add independent Service and Desktop installer jobs on top of the service-only binary workflow.
5. Add an optional combined installer only after both standalone installers are reliable.

## Recommended Monorepo Layout

```text
shipflow/
  apps/
    desktop/
      src/
      src-tauri/
    service/
      Cargo.toml
      src/
  crates/
    shipflow-core/
      Cargo.toml
      src/
    shipflow-service-runtime/
      Cargo.toml
      src/
  docs/
    desktop-service-split.md
    service-api.md
```

## Dev Flow

Run Desktop and Service on separate ports during development:

```bash
npm run tauri -- dev --config '{"build":{"devUrl":"http://127.0.0.1:1431","beforeDevCommand":"npm run dev -- --host 127.0.0.1 --port 1431 --strictPort"}}'
```

Use `custom` mode in ShipFlow Service settings when the service is already running outside the Desktop-managed lifecycle.
