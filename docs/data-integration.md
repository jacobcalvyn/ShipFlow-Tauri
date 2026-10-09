# Tracking Data Integration

Use the existing tracking, bag, and manifest endpoints to obtain phone numbers
and routing metadata. The Service performs acquisition and persistence for both
the public API and Desktop's native IPC path.

This guide describes the current Desktop implementation. The Extension handoff
informed the source contracts, but Desktop fetches these sources directly. It
does not import Extension snapshots or read `chrome.storage.local`.

## Response contract

| Endpoint | Relevant response fields | Compatibility |
| --- | --- | --- |
| `GET /v1/track/:shipment_id` | `detail.actors.pengirim.telepon`, `detail.actors.penerima.telepon`, `contact_enrichment` | Phone keys already exist; acquisition and cache behavior changed. |
| `GET /v1/bag/:bag_id` | `bag_detail.nomor_kantung`, `bag_detail.lokasi_asal`, `bag_detail.tujuan`, `bag_detail.url` | `bag_detail` is an additive, nullable object. |
| `GET /v1/manifest/:manifest_id` | `manifest_detail`, `items[].lokasi_asal`, `items[].tujuan` | Metadata fields are additive and nullable. |

Examples below show fragments of the API envelope's `data` object. Unshown
fields retain their existing contract. See [Service API v1](./service-api-v1.md)
for authentication, envelopes, errors, and the complete OpenAPI schema.

Use identifiers as strings. Preserve notification-letter suffixes such as
`X13` and koli suffixes such as `.1`. Never join records by party name,
display row number, or office name.

## Source requests

These requests apply to the default POS source. When an external ShipFlow API
is configured, the Service uses its responses and skips local metadata
acquisition.

| Purpose | Source |
| --- | --- |
| Primary shipment data | `GET https://pid.posindonesia.co.id/lacak/admin/detail_lacak_banyak.php?id=<encodedShipmentId>` |
| Phone enrichment | `GET https://lacak-mitra.posindonesia.co.id/lacak_barcode.php?id=<shipmentId>` |
| Phone fallback | `GET https://pid.posindonesia.co.id/lacak/admin/detail_lacak_bagdetil.php?id=<encodedShipmentId>` |
| Bag shipment membership | `GET https://pid.posindonesia.co.id/lacak/admin/detail_lacak_banyak_bag.php?id=<encodedBagId>` |
| Bag label route | `GET https://apiexpos.mile.app/api/v1/print-bag?bag_id=<bagId>_<organizationId>&oid=<encodedOrganizationId>` |
| PID manifest status | `GET https://pid.posindonesia.co.id/lacak/admin/GetManifestR7_detil.php?id=<encodedManifestId>` |
| Resolve R7 to Print | `POST https://posindo.mile.app/api/manifestR7-filter` |
| Manifest metadata and bag routes | `GET https://posindo.mile.app/manifestR7/print?taskId=<taskId>` |

PID identifiers use URL-encoded standard Base64. Lacak Mitra uses the plain
shipment ID as an encoded query parameter. Obtain `taskId` from the list's Print
link; it cannot be calculated from the R7 number.

The current bag-label URL builder uses a fixed POS organization ID. It does not
provide tenant-specific organization configuration.

## Phone acquisition and merge rules

1. Parse the primary PID page. Preserve its valid sender and recipient phones.
2. If either phone is missing, read the contact cache for the exact shipment ID.
3. Reuse complete contacts. Reuse partial contacts during the five-minute cooldown.
4. When retry is due, request Lacak Mitra. Concurrent requests for the same ID share one acquisition.
5. Try PID detail only when Lacak Mitra fails HTTP, I/O, schema, or identity validation.
6. Merge valid results into missing primary fields and persist the contact record.

A valid Lacak Mitra page with missing phones is authoritative for that attempt.
It does not trigger an additional PID request. Each source has a five-second
request budget and a 1 MiB response-body limit.

Both sources must identify the exact requested shipment. A response for
`RY507292681IL` cannot enrich `RY507292681ILX13`. Domestic semicolon fields and
labeled `Tlp Pengirim` / `Tlp Penerima` fields are supported. Empty semicolon
columns keep their position, so an address cannot shift into the phone column.

Accepted phones contain 7–16 digits and 7–30 total characters. Spaces, `+`,
parentheses, and hyphens are allowed. Preserve accepted formatting and leading
zeros. Empty values, `-`, `0`, all-zero values, and malformed text become `null`.
Phone validity does not establish WhatsApp registration.

A result is complete only when both phones are available. A failed or empty
refresh retains previously valid cached phones. Contact enrichment does not
replace primary names, addresses, status, SLA, history, or POD.

```json
{
  "contact_enrichment": {
    "source": "pid_detail",
    "status": "fetched",
    "sender_phone_present": false,
    "recipient_phone_present": true
  }
}
```

`source` is `lacak_mitra`, `pid_detail`, or `mixed` when retained and newly
acquired phones come from different sources. Public statuses remain
`cache_hit`, `fetched`, `missing`, `failed`, and `skipped`. A partial contact can
report `fetched` or `cache_hit`; inspect both presence flags for completeness.
`skipped` indicates that local enrichment did not run, so its source label does
not establish that a source request occurred.

## Bag origin and destination

The label's `From` and `To` fields describe the bag route. A complete cached
label route takes precedence over manifest-derived routes. If the label route
is incomplete or absent, a complete cached Print row can supply the route.
Otherwise, the Service attempts the label request and can return a known
partial route if acquisition fails.

```json
{
  "bag_detail": {
    "nomor_kantung": "PID108157373",
    "lokasi_asal": "SPP JAYAPURA 99100",
    "tujuan": "LE MUARA TAMI 99351D1",
    "url": "https://posindo.mile.app/manifestR7/print?taskId=8932c2f5a5706c9c8224"
  }
}
```

Use each Print row's `Asal Bag` and `Tujuan Bag`. The manifest header destination
can differ: this bag belongs to a manifest headed to `DC JAYAPURA 9910A`, but
its own destination is `LE MUARA TAMI 99351D1`.

`items[].kantor_kirim` remains the shipment's sending office. It is not the bag
origin. Tracking history uses the same route resolver for `bagging.tujuan`;
`unbagging.lokasi` remains the actual unbagging office. A missing new destination
does not erase an already known destination.

A label request has a 20-second budget. Bag and tracking route enrichment
have a 20-second overall budget, including metadata queue waits. Unavailable
metadata leaves the primary bag or tracking payload usable.

## Manifest acquisition and validation

The current Service resolves Print without a browser login or Extension
session. The list POST sends `X-Requested-With: XMLHttpRequest` and an exact
`numberR7`, with `start=0`, `length=100`, `draw=1`, empty `origin`, and
`inisiasi=notinisiasi`.

The filter requires `date_from` and `date_to`, even for an exact R7 number.
For `P20260929082013165`, both values are `2026-09-29`. The parser accepts an
initial ASCII letter followed by a valid `YYYYMMDD` date. Unsupported formats
remain eligible for PID manifest lookup, but cannot resolve Print metadata
through this filter.

Before storing Print, the Service validates:

- exactly one list row matching the requested R7;
- a Print link on the expected Mile origin with one valid `taskId`;
- the Print R7 number and bag count against the list;
- valid, distinct bag IDs and valid nonnegative weights;
- every product count and weight against the bag rows;
- the total count and weight against all bag rows.

List and Print bodies have an 8 MiB limit. The combined list/Print acquisition
has a 15-second budget. Responses are limited to 10,000 bag items.

```json
{
  "manifest_detail": {
    "nomor_manifest": "P20260929082013165",
    "task_id": "8932c2f5a5706c9c8224",
    "lokasi_asal": "SPP JAYAPURA 99100",
    "tujuan": "DC JAYAPURA 9910A",
    "nomor_smu": null,
    "angkutan": "99000 TERSIER DJJ 01",
    "mode": "DARAT",
    "tanggal": "2026-09-29 08:20:13",
    "jumlah_kantung": 10,
    "total_berat_kg": 12.92,
    "rekap_layanan": [
      { "jenis_layanan": "PKH", "jumlah_kantung": 8, "berat_kg": 11.02 },
      { "jenis_layanan": "EC3", "jumlah_kantung": 2, "berat_kg": 1.9 }
    ],
    "source_url": "https://posindo.mile.app/manifestR7/print?taskId=8932c2f5a5706c9c8224",
    "fetched_at": "2026-10-08T07:17:09.078534Z",
    "cache_status": "fetched",
    "status_source": "pid"
  }
}
```

`tanggal` preserves the source text. `fetched_at` is the Print acquisition time
in UTC RFC 3339. Reusing a snapshot does not replace its acquisition timestamp.
`cache_status` describes Print acquisition or reuse, not every hit of the outer
lookup cache. An outer cached response can retain its earlier `fetched` value.

### Use Print as the manifest source

| Available sources | Response behavior |
| --- | --- |
| PID and Print | Use Print URL, bag membership, order, products, weights, routes, totals, and metadata. Match PID bag IDs to add only bag links, status, final location, and update date. |
| PID only | Return PID data; Print metadata can be null. |
| Print only | Return Print bags and metadata with `status_source: "unavailable"`; do not infer current bag status. |
| Neither source | Return the PID lookup error. |
| Print refresh fails, retained snapshot exists | Reuse the snapshot with `cache_status: "stale"` and its original `fetched_at`. |

When Print is available, `url` and `manifest_detail.source_url` identify the
Print page. `total_berat`, `items[].berat`, `manifest_detail.total_berat_kg`,
`jumlah_kantung`, and `rekap_layanan` all describe the same validated Print
snapshot. PID-only bags are excluded; Print bags missing from PID retain null
operational fields. Do not treat Print totals or its manifest date as current
tracking status. If no usable Print snapshot exists, PID remains a fallback
with `manifest_detail: null`; its URL identifies that source.

For example, R7 `P20261008205336248` has 20 Print bags totaling `30.73 kg`,
while PID reports `45 Kg` for the same bag IDs. The combined response uses
`30.73 Kg` and the Print row weights, including `1.45` for `PID108972674`,
instead of PID's `4`. This source selection does not infer why the upstream
weights differ. See the [Print snapshot](https://posindo.mile.app/manifestR7/print?taskId=9675eb69d6c541a3fee4).

## Cache and storage

| Data | Key | Retention and refresh | Store |
| --- | --- | --- | --- |
| Operational tracking / bag / manifest payload | Lookup kind + parser revision for tracking/manifest + normalized ID + source fingerprint | Default TTL: 30 / 60 / 90 seconds | Lookup memory cache and persistent lookup store |
| Complete contacts | Exact shipment ID | 90 days | `contact-store.sqlite3` |
| Partial contacts | Exact shipment ID | Retain known values for 90 days; retry acquisition after five minutes | `contact-store.sqlite3` |
| Missing or failed contacts without known phones | Exact shipment ID | Five minutes | `contact-store.sqlite3` |
| Complete bag label route | Normalized bag ID | No normal age expiry; bounded to 20,000 route records | `bag-route-store.sqlite3` |
| Partial bag route | Normalized bag ID | Keep known offices within the same capacity; retry after five minutes | `bag-route-store.sqlite3` |
| Missing or failed bag route without known offices | Normalized bag ID | Five minutes | `bag-route-store.sqlite3` |
| Validated Print snapshot | Normalized R7 number; snapshot retains `task_id` | Refresh on lookup after 24 hours; retain for 90 days | `manifest_print_cache` in `bag-route-store.sqlite3` |
| Manifest-to-bag route index | R7 number + bag ID | Replaced and expired with its snapshot | `manifest_print_bags` in `bag-route-store.sqlite3` |

Contact records are bounded to 20,000 entries. Print snapshots are bounded to
1,000 records, 64 MiB of serialized payloads, and 8 MiB per snapshot. SQLite
replaces a snapshot and its bag index in one transaction. A failed replacement
cannot remove the previous snapshot or leave a partly replaced index.

A bag can occur in several manifests. When using the Print index, the resolver
selects the latest manifest date, then acquisition time. It reads the bag's own
row route. It does not use the manifest header as a substitute.

Desktop owns its Service stores; Docker owns separate stores under `/data`.
Print shares the existing bag-route database, so the Docker deployment still
uses three cache databases. Container restarts reuse that database. See
[Docker storage and recovery](./docker-service.md#storage-and-recovery).

### Explicit refresh

Use the existing header when the caller requests fresh data:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${SHIPFLOW_API_TOKEN}" \
  -H "x-shipflow-force-refresh: true" \
  "http://127.0.0.1:18422/v1/manifest/P20260929082013165"
```

This bypasses the lookup cache and requests a Print refresh. For tracking and
bag lookups, it also bypasses enrichment-cache reuse and retry cooldowns.
Tracking still skips optional phone acquisition when the fresh primary page
already supplies both phones. Concurrent refreshes share in-flight work.
A forced refresh does not delete valid retained data before acquisition.

## Relationship boundaries

```mermaid
flowchart LR
    R7[Manifest number] --> Task[Print taskId]
    Task --> Bag[Bag IDs and row routes]
    Bag --> Detail[PID bag detail]
    Detail --> Shipment[Full shipment IDs]
    Shipment --> Contacts[Sender and recipient phones]
```

Print supplies the manifest-to-bag relationship. It supplies neither shipment
IDs nor phone numbers. Bag-to-shipment membership comes from PID bag detail;
the Print cache does not create a permanent membership table. Keep phone
acquisition keyed by the full shipment ID.

## Implementation pointers

| Responsibility | Source |
| --- | --- |
| Response models | [Core models](../crates/shipflow-core/src/model.rs) |
| Phone parsing and validation | [Tracking parser](../crates/shipflow-core/src/parser.rs) |
| R7 list resolution and Print validation | [Manifest Print parser and requests](../crates/shipflow-core/src/manifest_print.rs) |
| Phone and manifest acquisition orchestration | [Lookup cache](../crates/shipflow-service-runtime/src/lookup_cache.rs) |
| Phone retention and merge rules | [Contact cache](../crates/shipflow-service-runtime/src/contact_cache.rs) |
| Bag label retention | [Bag route cache](../crates/shipflow-service-runtime/src/bag_route_cache.rs) |
| Snapshot transactions and route index | [Manifest cache](../crates/shipflow-service-runtime/src/manifest_cache.rs) |
| Bag and tracking route enrichment | [Service API handlers](../crates/shipflow-service-runtime/src/http_api.rs) |

## Verification record

The patch was verified on 2026-10-08 through a local native Service with
temporary stores and live POS/Mile sources:

- R7 `P20260929082013165` resolved to `8932c2f5a5706c9c8224`, with 10 bags and 12.92 kg.
- All 10 manifest rows included their origin and destination offices.
- Bag `PID108157373` used its Print destination, `LE MUARA TAMI 99351D1`.
- Tracking `RY507292681ILX13` acquired the recipient phone through PID fallback; the sender phone remained absent.
- Restarting the Service retained the manifest snapshot, original `fetched_at`, and bag route index.

Patch checks passed: 313 Rust tests, 436 frontend tests, Electron build,
Rust formatting, Clippy, and the security baseline. One frontend test was
skipped. These checks preceded this documentation update. This verification
does not establish installed Desktop or Docker deployment acceptance, or
guarantee that every upstream identifier or tenant uses the same contract.

The source-precedence and courier-parser correction was verified on
2026-10-09 through a local native Service with isolated temporary stores:

- R7 `P20261008205336248` used Print task `9675eb69d6c541a3fee4`, with 20 bags, complete row routes, and matching total, item-sum, and summary weights of `30.73 kg`.
- All 20 bags retained matched PID operational status. Restarting the Service reused the persisted Print snapshot and its original acquisition timestamp.
- Shipments `BAC28092647D9E05FDAD` and `P2609110091249` returned courier labels containing only names and IDs; coordinates and original history annotations remained present.
- The relevant 196 Rust tests, Clippy checks, and Service build passed. Regression tests reproduced the incorrect courier labels and source precedence before the correction.

Logs and diagnostics must report phone presence flags rather than raw phone
numbers or credentials.
