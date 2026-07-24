# ShipFlow Service API v1

ShipFlow Service exposes an authenticated local or LAN HTTP API for third-party clients. ShipFlow Desktop and its Workspace Hosts use a separate native IPC transport; the public HTTP endpoint and token are not part of Desktop's internal data path. Source selection, external API credentials, bearer-token ownership, lookup cache, persistent lookup store, and direct lookup backpressure all belong to ShipFlow Service.

New integrations should use the versioned `/v1` contract. Unversioned legacy routes are not served.

## Authentication

All protected routes require a bearer token. `GET /v1/status` is the only
unauthenticated identity probe:

```http
Authorization: Bearer <service-token>
```

The Service settings window creates an initial token automatically for a new Service Runtime config. Existing tokens are not rotated or replaced automatically; rotation happens only when the user confirms `Regenerate`.

Clients may send an optional request id:

```http
x-shipflow-request-id: sf_req_client_001
```

If the header is omitted, the service generates one. The request id is returned in `meta.requestId` for `/v1` responses.

## OpenAPI Discovery

```http
GET /v1/openapi.json
```

The OpenAPI endpoint returns an authenticated OpenAPI 3.1 JSON document for the current service port. It is intended for third-party integrations, agent tooling, Postman, Insomnia, Swagger Editor, and generated client experiments.

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
- `429 Too Many Requests`: the bounded public lookup queue is full
- `503 Service Unavailable`: the lookup queue timed out, the 120-second end-to-end lookup deadline elapsed, or a limiter is unavailable
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

Readiness behavior:

- `GET /v1/status` is intentionally unauthenticated so Desktop and launcher code can confirm that the port belongs to ShipFlow Service before sending any bearer token.
- The response must include `product: "shipflow-service"`.
- If an unauthenticated status probe returns `401 Unauthorized`, the request is likely reaching an older Service binary.
- After the status probe passes, clients must call `GET /v1/auth/check` with the configured bearer token before sending lookup requests.
- If `GET /v1/auth/check` returns `404 Not Found`, the request is likely reaching an older Service binary or the wrong port.

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
      "GET /v1/diagnostics",
      "GET /v1/track/:shipment_id",
      "GET /v1/track/:shipment_id/html",
      "GET /v1/bag/:bag_id",
      "GET /v1/manifest/:manifest_id"
    ]
  },
  "warnings": []
}
```

## Runtime Diagnostics

```http
GET /v1/diagnostics
```

This protected endpoint requires the same bearer token as lookup routes. It
reports bounded operational state without exposing credentials, shipment
payloads, or cached contact values:

```json
{
  "meta": {
    "apiVersion": "v1",
    "schemaVersion": "shipflow.service.diagnostics.v1",
    "requestId": "sf_req_...",
    "generatedAt": "2026-07-23T00:00:00.123Z"
  },
  "data": {
    "product": "shipflow-service",
    "uptimeSeconds": 3600,
    "restartCount": 1,
    "rssBytes": 125829120,
    "lookupDeadlineSeconds": 120,
    "lookupCache": {
      "ready": 420,
      "loading": 12,
      "capacity": 10000
    },
    "contactCache": {
      "entries": 900,
      "inFlight": 8,
      "capacity": 20000
    },
    "backpressure": {
      "ingress": {
        "active": 32,
        "available": 96,
        "queued": 0,
        "maxConcurrent": 128,
        "maxQueued": 512
      },
      "public": {
        "active": 20,
        "available": 4,
        "queued": 30,
        "maxConcurrent": 24,
        "maxQueued": 240
      },
      "global": {
        "active": 26,
        "available": 4,
        "queued": 30,
        "maxConcurrent": 30,
        "maxQueued": 300
      },
      "contact": {
        "active": 8,
        "available": 7,
        "queued": 0,
        "maxConcurrent": 15,
        "maxQueued": 150
      }
    }
  },
  "warnings": []
}
```

`rssBytes` can be `null` on unsupported platforms. `restartCount` is the number
of automatic child-process restarts performed by the current Electron suite
session, so it resets when Electron exits. Service logs also emit a bounded
diagnostic snapshot every 60 seconds and report a memory warning when RSS
reaches 512 MiB.

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

The `data` object is the same normalized response shape returned through Desktop's native IPC path. Shipment tracking can use the active Service source, either internal POS scraping or the configured external ShipFlow API. Bag and manifest lookup paths currently use the internal POS scraper.

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

Every HTTP route first passes through a bounded ingress lane with 128 active
request permits, a 512-request queue, and a five-second queue deadline. Request
bodies are capped at 64 KiB. Handler execution is capped at 130 seconds, which
leaves a small response-assembly margin beyond the 120-second lookup deadline.
Ingress overload returns `429` or `503`; a handler deadline returns `504`.

Bulk tracking is intentionally driven through bounded direct `GET /v1/track/:shipment_id` requests. ShipFlow Service applies a shared 30-permit concurrency gate and a 300-request queue to every Service route that can perform upstream scraping: direct tracking, raw tracking HTML, bag lookup, and manifest lookup. Public HTTP traffic has an additional 24-permit lane and a 240-request queue, leaving at least six shared permits available to Desktop's internal IPC traffic. Each primary gate has a 60-second wait limit; a public request that must wait at both gates can therefore wait for up to 120 seconds before its upstream request starts.

Every public and internal lookup also has one 120-second end-to-end deadline
covering queue waits, upstream I/O, parsing, contact enrichment, and response
assembly. The caller receives `503 Service Unavailable` when this deadline
expires. Cancellation releases acquired permits and removes an owned in-flight
cache slot so another request can retry instead of waiting forever.

Phone-number enrichment uses a separate 15-permit gate and a 150-request queue with a 30-second wait limit. Concurrent enrichment requests for the same shipment ID are coalesced into one upstream Lacak Mitra fetch. A contact-enrichment overload does not discard the primary tracking result; the response reports failed enrichment metadata and the contact attempt can be retried after its short failure-cache TTL.

Additional upstream lookup requests wait for the next Service permit instead of creating extra upstream pressure. Runtime logs include `[ShipFlowBackpressure]` when a request waits or is rejected. These queues are bounded in-process queues, not durable jobs: clients should retry `429` and `503` responses with bounded exponential backoff.

## Cache And Persistence

ShipFlow Service keeps an in-memory lookup cache with:

- per-kind cache keys for shipment, bag, and manifest lookups
- in-flight request coalescing
- kind-specific TTL behavior
- short negative-cache protection for repeated failures
- a hard 10,000-entry capacity shared by ready and in-flight entries
- least-recently-used eviction for ready entries when capacity is reached
- periodic expired-entry pruning every 60 seconds

If every cache slot is already an in-flight lookup, a new uncached lookup is
rejected with `503 Service Unavailable` instead of allowing memory growth beyond
the configured capacity. Existing lookups and coalesced waiters continue
normally.

Successful lookup payloads are also persisted into a bounded SQLite WAL database
in local user state. The persistent lookup store:

- stores successful payloads only
- ignores expired entries when loading
- caps payloads at 128 KiB and excludes embedded image data
- compacts itself to a bounded 2,000-entry count
- is used as a warm cache across service restarts
- uses one bounded 1,024-command writer queue and batches up to 128 mutations per transaction
- writes outside the response path so local persistence does not delay the client response
- flushes queued mutations during graceful Service shutdown

Existing `lookup-store.json` data is imported automatically into
`lookup-store.sqlite3`; an in-place JSON migration preserves a
`lookup-store.legacy.json` backup.

Contact enrichment is persisted separately in SQLite with WAL mode. Existing `contact-store.json` data is migrated automatically, successful and missing-contact entries retain the existing long TTL, and transient failures use a short TTL to avoid immediate retry storms.

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
[ShipFlowPerf] service_tracking route=ipc_track id=P2603310114291 source=external_api forceRefresh=false durationMs=812 result=ok
[ShipFlowPerf] service_tracking route=v1 id=P2603310114291 source=external_api forceRefresh=false durationMs=809 result=ok
[ShipFlowPerf] external_api_tracking id=P2603310114291 stage=http durationMs=786 route=v1 status=200 OK
[ShipFlowPerf] external_api_tracking id=P2603310114291 stage=body_read durationMs=1 route=v1 bytes=123456
[ShipFlowPerf] external_api_tracking id=P2603310114291 stage=parse durationMs=0 route=v1 result=ok
```

How to read the stages:

- `service_tracking route=ipc_track` is a Desktop lookup received over native IPC.
- `service_tracking` is the Service-side lookup duration for the active source.
- `external_api_tracking stage=http` is the outbound wait from Service to the external API.
- `body_read` and `parse` separate payload transfer/parsing from upstream wait time.
- `external_api_request stage=hedge_start` means Service started the duplicate hedged external request because the first request had not returned yet.

## Security Notes

- Keep the service in localhost mode unless another trusted device on the local network must call it.
- LAN mode still requires the same bearer token.
- Treat the Service token like an API key; do not put it in screenshots, logs, or shared documents.
- Desktop stores a private IPC endpoint and encrypted internal credential outside renderer state; users do not configure either value.
- Desktop readiness requires an authenticated `service.status` IPC response with the `shipflow-service` product marker.
- The unauthenticated public status probe is used only to detect a stale or unrelated process occupying the configured HTTP port; shipment IDs are never sent to that process.

## Ownership Boundary

ShipFlow Desktop:

- owns sheets, filters, table layout, workspace files, and UI state
- calls ShipFlow Service through managed native IPC
- does not scrape POS directly
- does not own external API credentials

ShipFlow Service:

- owns the active tracking source
- owns the Service API token
- owns internal scraper and external API access
- owns lookup cache and persistent lookup store
- owns direct lookup concurrency and backpressure
