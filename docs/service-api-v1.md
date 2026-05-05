# ShipFlow Service API v1

ShipFlow Service exposes an authenticated local or LAN HTTP API for ShipFlow Desktop and optional internal clients. Desktop is only a client of the service: source selection, external API credentials, bearer-token ownership, lookup cache, persistent lookup store, and batch job execution all belong to ShipFlow Service.

New integrations should use the versioned `/v1` contract. The unversioned routes remain available only for backward compatibility with the current Desktop bridge.

## Authentication

All routes require a bearer token, including the legacy compatibility routes:

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

## Legacy Routes

Legacy routes return the raw payload shape or a simple `{ "error": "..." }` body. They are kept for compatibility and should not be used by new integrations.

```http
GET /health
GET /status
GET /track/:shipment_id
GET /bag/:bag_id
GET /manifest/:manifest_id
```

`/status` still includes the ShipFlow product identity marker:

```json
{
  "service": "running",
  "product": "shipflow-service",
  "mode": "local",
  "bindAddress": "127.0.0.1",
  "port": 18422
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
    "schemaVersion": "shipflow.service.job.v1",
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
- `400 Bad Request`: invalid lookup or job input
- `401 Unauthorized`: missing or invalid bearer token
- `404 Not Found`: lookup target or job id was not found
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
      "GET /v1/bag/:bag_id",
      "GET /v1/manifest/:manifest_id",
      "POST /v1/jobs/track-batch",
      "GET /v1/jobs/:job_id",
      "GET /v1/jobs/:job_id/result",
      "POST /v1/jobs/:job_id/cancel"
    ]
  },
  "warnings": []
}
```

## Lookups

```http
GET /v1/track/:shipment_id
GET /v1/bag/:bag_id
GET /v1/manifest/:manifest_id
```

Lookup schema versions:

- `shipflow.tracking.detail.v1`
- `shipflow.tracking.bag.v1`
- `shipflow.tracking.manifest.v1`

The `data` object is the normalized response shape used by Desktop. Shipment tracking can use the active Service source, either internal POS scraping or the configured external ShipFlow API. Bag and manifest lookup paths currently use the internal POS scraper.

Use the optional force-refresh header to bypass the service cache when the user explicitly requests a fresh lookup:

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

## Batch Tracking Jobs

Batch jobs are an authenticated `/v1` API for service-side background tracking. They are useful when a client wants to submit many shipment IDs and poll progress instead of blocking on one request per row.

Start a batch tracking job:

```http
POST /v1/jobs/track-batch
Content-Type: application/json

{
  "shipmentIds": ["P2603310114291", "P2603310114292"],
  "forceRefresh": false
}
```

`shipmentIds` are trimmed, empty IDs are ignored, and duplicates are collapsed before the job starts. The service returns `400 Bad Request` if no valid ID remains, `413 Payload Too Large` if more than 1,000 IDs are submitted, and `400 Bad Request` if an ID is longer than 128 characters. Completed job records are retained for a short service-runtime window and may be removed after polling; clients should fetch results when a job reaches a terminal status.

Start response:

```json
{
  "meta": {
    "apiVersion": "v1",
    "schemaVersion": "shipflow.service.job.v1",
    "requestId": "sf_req_...",
    "generatedAt": "2026-05-04T00:00:00.123Z"
  },
  "data": {
    "jobId": "job_1777850000123_0",
    "status": "queued",
    "statusEndpoint": "/v1/jobs/job_1777850000123_0",
    "resultEndpoint": "/v1/jobs/job_1777850000123_0/result"
  },
  "warnings": []
}
```

Read job status:

```http
GET /v1/jobs/:job_id
```

Status response data:

```json
{
  "jobId": "job_1777850000123_0",
  "status": "running",
  "total": 2,
  "completed": 1,
  "failed": 0,
  "cancelRequested": false,
  "errorMessage": null,
  "createdAt": "2026-05-04T00:00:00.123Z",
  "updatedAt": "2026-05-04T00:00:01.456Z"
}
```

Read job result:

```http
GET /v1/jobs/:job_id/result
```

Result response data:

```json
{
  "jobId": "job_1777850000123_0",
  "status": "completed",
  "total": 2,
  "completed": 2,
  "failed": 1,
  "cancelRequested": false,
  "errorMessage": null,
  "createdAt": "2026-05-04T00:00:00.123Z",
  "updatedAt": "2026-05-04T00:00:02.789Z",
  "results": [
    {
      "id": "P2603310114291",
      "status": "success",
      "data": {},
      "error": null
    },
    {
      "id": "P2603310114292",
      "status": "error",
      "data": null,
      "error": "Shipment was not found."
    }
  ]
}
```

Request cancellation:

```http
POST /v1/jobs/:job_id/cancel
```

Job status values:

- `queued`
- `running`
- `completed`
- `cancelled`
- `failed`

Job item status values:

- `success`
- `error`
- `cancelled`

Job records are stored in memory for the running service process. Successful lookup payloads may still be available through the lookup cache or persistent lookup store after a service restart, but job history itself is not a durable audit log.

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

## External API Source Performance

When `ShipFlow Service` uses `API ShipFlow Eksternal` as the tracking source, the service still owns the outbound request to the external API. Desktop only calls the local or LAN Service endpoint.

For one-by-one tracking requests:

- Service handles concurrent Desktop requests independently.
- The external `/v1/track/:shipment_id` route is authoritative when the configured external base URL includes `/v1` or `/v1/openapi.json`.
- In that explicit `/v1` mode, a `404` response is returned as the lookup result instead of trying an extra legacy `/track/:shipment_id` fallback.
- If an external API request is still pending after a short delay, Service starts one duplicate hedged request and uses whichever identical request finishes first. This reduces random tail-latency spikes from a single slow socket or upstream worker.

For batch tracking jobs:

- Service can delegate to an external `/v1/jobs/track-batch` endpoint when that endpoint exists.
- If the external batch endpoint is unavailable, Service falls back to capped parallel one-by-one lookups.
- Job status/result APIs stay local to ShipFlow Service, so Desktop and LAN clients do not need to know which upstream strategy was used.

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
- owns Service API v1 batch jobs
