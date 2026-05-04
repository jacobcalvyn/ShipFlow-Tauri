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
    "generatedAt": "1777850000.123Z"
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
    "generatedAt": "1777850000.123Z"
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
    "generatedAt": "1777850000.123Z"
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
    "generatedAt": "1777850000.123Z"
  },
  "data": {
    "product": "shipflow-service",
    "apiVersion": "v1",
    "auth": "bearer",
    "forceRefreshHeader": "x-shipflow-force-refresh",
    "routes": [
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

`shipmentIds` are trimmed and empty IDs are ignored. The service returns `400 Bad Request` if no valid ID remains.

Start response:

```json
{
  "meta": {
    "apiVersion": "v1",
    "schemaVersion": "shipflow.service.job.v1",
    "requestId": "sf_req_...",
    "generatedAt": "1777850000.123Z"
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
  "createdAt": "1777850000.123Z",
  "updatedAt": "1777850001.456Z"
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
  "createdAt": "1777850000.123Z",
  "updatedAt": "1777850002.789Z",
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

Manual refresh flows should send:

```http
x-shipflow-force-refresh: true
```

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
