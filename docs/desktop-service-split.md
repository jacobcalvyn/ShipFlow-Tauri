# Desktop and Service Split

## Target Shape

ShipFlow should move toward a split runtime model:

- ShipFlow Desktop owns the operator UI, workspace files, and desktop settings.
- ShipFlow Service owns the local/internal HTTP API, scraping source configuration, cache, auth token, and lifecycle.
- `shipflow-core` stays as the shared parser and domain crate.
- `shipflow-service-runtime` owns the HTTP API server and lookup-cache runtime used by the standalone service binary.

The current split keeps the monorepo, but Desktop and Service are separate runtime artifacts.

## Completed Split Steps

Desktop connection settings now use a standalone Desktop-to-Service connection:

- Desktop does not spawn a managed runtime for tracking.
- Desktop calls the configured `desktopServiceUrl` with `desktopServiceAuthToken`.
- The Desktop-to-Service token is required for all lookup flows, including internal scraper mode and external API mode.

The custom connection is validated before it is saved:

- URL is required.
- URL must use `http` or `https`.
- URL must include a host.
- URL must not include query strings or fragments.
- bearer token is required.
- authenticated `GET /status` must respond with the ShipFlow Service product marker.

Desktop lookup calls now build service endpoints from the configured client base URL instead of hard-coding `http://127.0.0.1:<port>`.

Desktop does not enable or manage a bundled API endpoint. The target service owns its endpoint, API Service token, source mode, and lifecycle.

Desktop-to-Service HTTP calls now live behind `src-tauri/src/service_client.rs`. The Tauri runtime layer calls that client boundary instead of owning endpoint construction, bearer auth, service error parsing, or `/status` identity checks directly.

`apps/service` is the standalone ShipFlow Service app package. It reuses the shared runtime/core crates and the existing Tauri service-settings window shell, but it is built and run as a separate Service artifact.

`crates/shipflow-service-runtime` now owns the service HTTP API server, authenticated route handling, lookup cache, force-refresh header semantics, and service runtime validation. `src-tauri/src/service/http_api.rs` is now only an adapter from Desktop config into that shared runtime crate.

The repository has a standalone service binary workflow at `.github/workflows/build-service-binary.yml`. It builds `apps/service` on macOS and Windows and uploads service-only binary artifacts. Desktop workflows no longer bundle the service binary.

## Service-Owned Config

The target service owns its own runtime and tracking configuration:

- bind host and port
- API Service bearer token accepted by `/status`, `/track`, `/bag`, and `/manifest`
- source mode: internal scrap or external API
- external API base URL/token when the service is configured for external API mode
- cache and runtime state

Desktop only stores:

- connection mode
- service base URL
- service bearer token

## Next Migration Phases

1. Move remaining Desktop service-settings UI into a Desktop connection-settings surface only.
2. Move Desktop into `apps/desktop` after service extraction is stable.
3. Add independent Service and Desktop installer jobs on top of the service-only binary workflow.
4. Add an optional combined installer only after both standalone installers are reliable.

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
npm run dev:service
```

In the Service window, choose the tracking source, review the localhost endpoint, generate a token if needed, and save. Then run Desktop:

```bash
npm run tauri -- dev --config '{"build":{"devUrl":"http://127.0.0.1:1431","beforeDevCommand":"npm run dev -- --host 127.0.0.1 --port 1431 --strictPort"}}'
```

Configure Desktop with the Service endpoint and token from the Service window.

Headless service mode is still available for tests:

```bash
cargo run --manifest-path apps/service/Cargo.toml -- --auth-token sf_dev_token --port 18422
```
