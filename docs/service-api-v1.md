# ShipFlow Service API v1

ShipFlow Service exposes an authenticated local or LAN HTTP API for ShipFlow Desktop and optional internal clients. Desktop is only a client of the service: source selection, external API credentials, bearer-token ownership, lookup cache, persistent lookup store, and direct lookup backpressure all belong to ShipFlow Service.

New integrations should use the versioned `/v1` contract. Unversioned legacy routes are not served.

## Authentication

All routes require a bearer token:

```http
Authorization: Bearer <service-token>
```

The token is created only from the ShipFlow Service settings window when the user clicks `Generate` or confirms `Regenerate`. The app does not rotate or replace it automatically.

Clients may send an optional request id:

```http
x-shipflow-request-id: sf_req_client_001
```

If the header is omitted, the service generates one. The request id is returned in `meta.requestId` for `/v1` responses.

## OpenAPI Discovery

```http
GET /v1/openapi.json
```

The OpenAPI endpoint returns an authenticated OpenAPI 3.1 JSON document for the current service port. It is intended for internal clients, agent tooling, Postman, Insomnia, Swagger Editor, and generated client experiments.

This endpoint returns the raw OpenAPI document, not the normal `/v1` response envelope, so tools can import it directly.

Authentication is still required:

```bash
curl \
  -H "Authorization: Bearer sf_dev_token" \
  "http://127.0.0.1:18422/v1/openapi.json"
```

Local agent setup:

```text
Base URL: http://127.0.0.1:18422
OpenAPI: http://127.0.0.1:18422/v1/openapi.json
Auth: Bearer <ShipFlow Service Token>
```

When LAN mode is enabled, the document includes a templated LAN server URL:

```text
http://{serviceHost}:18422
```

LAN agent setup:

```text
Base URL: http://<service-host-ip>:18422
OpenAPI: http://<service-host-ip>:18422/v1/openapi.json
Auth: Bearer <ShipFlow Service Token>
```

Do not hard-code the service token in another repository. Pass it through a local secret store, environment variable, or that project's connector settings.

Troubleshooting:

- `200 OK`: OpenAPI discovery is active and the token is accepted.
- `401 Unauthorized`: the route exists, but the bearer token is missing or invalid.
- `404 Not Found`: the request is reaching an older service binary or the wrong port.

## Status Route

ShipFlow Service exposes only the versioned `/v1` API surface. Use `GET /v1/status` for health and product identity checks.

```json
{
  "schemaVersion": "shipflow.service.status.v1",
  "requestId": "sf_req_...",
  "data": {
    "service": "running",
    "product": "shipflow-service",
    "mode": "local",
    "bindAddress": "127.0.0.1",
    "port": 18422
  }
}
```

## Response Envelope

Successful `/v1` responses use this envelope:

```json
{
  "meta": {
    "apiVersion": "v1",
    "schemaVersion": "shipflow.tracking.detail.v1",
    "requestId": "sf_req_client_001",
    "generatedAt": "2026-05-04T00:00:00.123Z"
  },
  "data": {},
  "warnings": []
}
```

Error responses use the same metadata shape and put the user-facing failure message under `error.message`:

```json
{
  "meta": {
    "apiVersion": "v1",
    "schemaVersion": "shipflow.service.error.v1",
    "requestId": "sf_req_client_001",
    "generatedAt": "2026-05-04T00:00:00.123Z"
  },
  "error": {
    "message": "Bearer token is invalid."
  },
  "warnings": []
}
```

Common status codes:

- `200 OK`: request succeeded
- `400 Bad Request`: invalid lookup input
- `401 Unauthorized`: missing or invalid bearer token
- `404 Not Found`: lookup target was not found
- `502 Bad Gateway`: upstream tracking source failed

## Status

```http
GET /v1/status
```

Schema version:

```text
shipflow.service.status.v1
```

Example response:

```json
{
  "meta": {
    "apiVersion": "v1",
    "schemaVersion": "shipflow.service.status.v1",
    "requestId": "sf_req_...",
    "generatedAt": "2026-05-04T00:00:00.123Z"
  },
  "data": {
    "service": "running",
    "product": "shipflow-service",
    "mode": "local",
    "bindAddress": "127.0.0.1",
    "port": 18422
  },
  "warnings": []
}
```

Desktop uses this endpoint as an identity check before sending shipment, bag, or manifest IDs to the configured service.

## Capabilities

```http
GET /v1/capabilities
```

Schema version:

```text
shipflow.service.capabilities.v1
```

Example response:

```json
{
  "meta": {
    "apiVersion": "v1",
    "schemaVersion": "shipflow.service.capabilities.v1",
    "requestId": "sf_req_...",
    "generatedAt": "2026-05-04T00:00:00.123Z"
  },
  "data": {
    "product": "shipflow-service",
    "apiVersion": "v1",
    "auth": "bearer",
    "forceRefreshHeader": "x-shipflow-force-refresh",
    "routes": [
      "GET /v1/openapi.json",
      "GET /v1/status",
      "GET /v1/capabilities",
      "GET /v1/track/:shipment_id",
      "GET /v1/track/:shipment_id/html",
      "GET /v1/bag/:bag_id",
      "GET /v1/manifest/:manifest_id"
    ]
  },
  "warnings": []
}
```

## Lookups

```http
GET /v1/track/:shipment_id
GET /v1/track/:shipment_id/html
GET /v1/bag/:bag_id
GET /v1/manifest/:manifest_id
```

Lookup schema versions:

- `shipflow.tracking.detail.v1`
- `shipflow.tracking.bag.v1`
- `shipflow.tracking.manifest.v1`

The `data` object is the normalized response shape used by Desktop. Shipment tracking can use the active Service source, either internal POS scraping or the configured external ShipFlow API. Bag and manifest lookup paths currently use the internal POS scraper.

For the internal POS scraper, `detail_lacak_banyak.php` remains the primary tracking source for shipment status, SLA, history, POD, bagging, manifest, delivery, names, and addresses. ShipFlow Service may call `https://lacak-mitra.posindonesia.co.id/lacak_barcode.php?id=<shipment_id>` only as a best-effort contact enrichment source for missing sender/recipient phone numbers. `lacak-mitra` data must not overwrite primary tracking fields.

Tracking responses may include optional contact enrichment metadata:

```json
{
  "contact_enrichment": {
    "source": "lacak_mitra",
    "status": "cache_hit",
    "sender_phone_present": true,
    "recipient_phone_present": true
  }
}
```

Supported enrichment statuses are `cache_hit`, `fetched`, `missing`, `failed`, and `skipped`. A `failed` or `missing` enrichment status does not make the tracking lookup fail if the primary PID tracking lookup succeeded.

`GET /v1/track/:shipment_id/html` returns the raw upstream tracking page HTML in an envelope:

```json
{
  "meta": {
    "apiVersion": "v1",
    "schemaVersion": "shipflow.tracking.html.v1",
    "requestId": "sf_req_...",
    "generatedAt": "2026-05-04T00:00:00.123Z"
  },
  "data": {
    "url": "https://pid.posindonesia.co.id/lacak/admin/detail_lacak_banyak.php?id=UDI2MDQxMDAwNjUxMDk%3D",
    "html": "<html>...</html>"
  },
  "warnings": []
}
```

The HTML endpoint is intended for diagnostics and parser experiments. It is available only when the Service uses the default POS scraper source, and it is fetched directly instead of using the Service lookup cache.

For normalized lookup endpoints, use the optional force-refresh header to bypass the service cache when the user explicitly requests a fresh lookup:

```http
x-shipflow-force-refresh: true
```

Example:

```bash
curl \
  -H "Authorization: Bearer sf_dev_token" \
  -H "x-shipflow-force-refresh: true" \
  "http://127.0.0.1:18422/v1/track/P2603310114291"
```

## Upstream Lookup Backpressure

Bulk tracking is intentionally driven through bounded direct `GET /v1/track/:shipment_id` requests. ShipFlow Service applies a shared 15-permit concurrency gate to every Service route that can perform upstream scraping: direct tracking, raw tracking HTML, bag lookup, and manifest lookup.

Additional upstream lookup requests wait for the next Service permit instead of creating extra upstream pressure. Runtime logs include `[ShipFlowBackpressure]` when a request had to wait for an upstream lookup permit.

## Cache And Persistence

ShipFlow Service keeps an in-memory lookup cache with:

- per-kind cache keys for shipment, bag, and manifest lookups
- in-flight request coalescing
- kind-specific TTL behavior
- short negative-cache protection for repeated failures

Successful lookup payloads are also persisted into a bounded local user-state lookup store. The persistent store:

- stores successful payloads only
- ignores expired entries when loading
- compacts itself to a bounded entry count
- is used as a warm cache across service restarts
- writes successful payloads outside the response path so local disk persistence does not delay the client response

Manual refresh flows should send:

```http
x-shipflow-force-refresh: true
```

Contact enrichment uses a separate persistent contact cache keyed by exact shipment ID. Once phone numbers are found, later tracking lookups reuse the cached contact values and do not call `lacak-mitra` again for that shipment ID. Logs must report only presence flags such as `sender_phone_present=true`; they must not print raw phone numbers.

## External API Source Performance

When `ShipFlow Service` uses `API ShipFlow Eksternal` as the tracking source, the service still owns the outbound request to the external API. Desktop only calls the local or LAN Service endpoint.

For one-by-one tracking requests:

- Service handles concurrent Desktop requests independently.
- The external `/v1/track/:shipment_id` route is authoritative when the configured external base URL includes `/v1` or `/v1/openapi.json`.
- In that explicit `/v1` mode, a `404` response is returned as the lookup result instead of trying an extra legacy `/track/:shipment_id` fallback.
- If an external API request is still pending after a short delay, Service starts one duplicate hedged request and uses whichever identical request finishes first. This reduces random tail-latency spikes from a single slow socket or upstream worker.

## Runtime Performance Logs

Runtime logs include `[ShipFlowPerf]` timing lines for tracking diagnostics. These lines are safe to share for debugging because they do not include bearer tokens.

Typical stages:

```text
[ShipFlowPerf] desktop_service route=track id=P2603310114291 stage=http durationMs=812 status=200 OK
[ShipFlowPerf] service_tracking route=v1 id=P2603310114291 source=external_api forceRefresh=false durationMs=809 result=ok
[ShipFlowPerf] external_api_tracking id=P2603310114291 stage=http durationMs=786 route=v1 status=200 OK
[ShipFlowPerf] external_api_tracking id=P2603310114291 stage=body_read durationMs=1 route=v1 bytes=123456
[ShipFlowPerf] external_api_tracking id=P2603310114291 stage=parse durationMs=0 route=v1 result=ok
```

How to read the stages:

- `desktop_service stage=http` is the full wait from Desktop to Service for that lookup.
- `service_tracking` is the Service-side lookup duration for the active source.
- `external_api_tracking stage=http` is the outbound wait from Service to the external API.
- `body_read` and `parse` separate payload transfer/parsing from upstream wait time.
- `external_api_request stage=hedge_start` means Service started the duplicate hedged external request because the first request had not returned yet.

## Security Notes

- Keep the service in localhost mode unless another trusted device on the local network must call it.
- LAN mode still requires the same bearer token.
- Treat the Service token like an API key; do not put it in screenshots, logs, or shared documents.
- Desktop should store only the local Service port and bearer token it needs to call the separately installed Service app.
- A successful Desktop connection test means the Service responded to an authenticated status request with the `shipflow-service` product marker.

## Ownership Boundary

ShipFlow Desktop:

- owns sheets, filters, table layout, workspace files, and UI state
- calls ShipFlow Service by localhost port and bearer token
- does not scrape POS directly
- does not own external API credentials

ShipFlow Service:

- owns the active tracking source
- owns the Service API token
- owns internal scraper and external API access
- owns lookup cache and persistent lookup store
- owns direct lookup concurrency and backpressure
