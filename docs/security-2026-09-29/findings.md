# Security And Correctness Findings — 2026-09-29

Reassessed: **2026-09-30**. Source revision:
`8bb5c4cb87d29ce14ffe06de8307522d4bc181bf`.
Patch proposals and acceptance criteria: [remediation plan](./remediation-plan.md).

## Implementation update — 2026-09-30

The four prioritized findings (`FE-SHEET-COMMAND-SCOPE-001`,
`CORE-PARSER-CASE-INDEX-001`, `WE-UPSERT-STATUS-001`, and
`WE-TRACK-INTERRUPTED-001`) now have working-tree patches and local regression
verification. See [patch validation](./patch-validation-2026-09-30.md) for exact
scope, commands, results, and limitations. The Windows updater release gate
remains open. The source assessment below records the pre-patch revision;
its line numbers and "later patch" recommendations describe that revision.

## Scope of the original assessment

Read-only review of ShipFlow Desktop as it exists in this tree: the Electron
shell, the Rust service, the workspace host and engine, the POS parser and
upstream clients, and the React workspace. No source file was changed while
the review was done. The reassessment read source, tests, runtime documentation,
and installed dependency code. It did not run tests, builds, the application,
network exploit probes, or installer verification. The document-switch
data-loss sequence below is traced from the call path and was not executed in
the app. Existing tests are evidence of intended behavior, not new passing
test results. This documentation update does not implement any remediation.

The product boundary used here is the one in `docs/runtime-architecture.md`:
one Electron app plus `shipflow-service` and `shipflow-workspace-host`. React
is presentation. Operational data stays in Rust.

## Assessment and priority

All 26 original IDs are retained for traceability. They are not 26 confirmed
security vulnerabilities. The original high/medium/low grouping mixed user
data loss, security impact, performance, and intentional product behavior.
This table supersedes those severity labels.

- **Source-supported defect:** the incorrect operation or failure path is
  visible in code; runtime reproduction is still required before closure.
- **Conditional risk:** the mechanism exists, but exploitation or exposure
  depends on the stated actor, configuration, environment, or artifact.
- **Contract/hardening review:** decide the supported behavior or security
  requirement before treating the observation as a defect.
- **Intended behavior:** no vulnerability is established by the supplied claim.
- **P1:** address first for data integrity or parser reliability.
  **P2:** follow-up fixes or validation. **P3:** lower-priority hardening or
  requirement decisions. A release gate must pass before the affected release,
  regardless of its position in this backlog. These are not CVSS ratings.

| ID | Assessment at base revision | Priority and remaining evidence at review time |
| --- | --- | --- |
| `WE-UPSERT-STATUS-001` | Source-supported correctness defect | P1; verify loaded/failed rows through an unchanged-lookup edit. |
| `WE-TRACK-INTERRUPTED-001` | Source-supported failure-handling defect | P2; inject setup and activation failures after committed status writes. |
| `CORE-PARSER-CASE-INDEX-001` | Source-supported parser defect with availability impact | P1; reproduce through the full parser, not only a string helper. |
| `FE-SHEET-COMMAND-SCOPE-001` | Source-supported document isolation gap | P1; deterministically reproduce command/restore ordering and autosave effects. |
| `ELECTRON-IPC-STABLE-001` | Conditional same-user credential risk | P2; validate peer authentication and orphan recovery; no cross-user Windows claim. |
| `SVC-LAN-CLEARTEXT-001` | Conditional transport exposure in supported LAN mode | P2; determine the protected deployment path; local mode remains the default. |
| `SVC-POS-REDIRECT-001` | Conditional redirect risk | P2; malicious redirect control from the fixed POS origin is not established. |
| `WE-UNBOUNDED-DOCUMENT-001` | Source-supported missing input bound | P2; user must open the document; memory exhaustion was not measured. |
| `ELECTRON-WIN-UPDATE-SIG-001` | Conditional risk; installed artifact evidence missing | Release gate; inspect generated publisher configuration before claiming a signed-build bypass. |
| `SSRF-EMBEDDED-V6-001` | Source-supported classifier gap; exploit conditional | P2; verify URL parsing, DNS, routing, and TLS before claiming SSRF or token disclosure. |
| `SVC-FORCE-REFRESH-JOIN-001` | Freshness-contract review | P2; distinguish ordinary-plus-forced from intentionally coalesced forced requests. |
| `ELECTRON-PACKAGED-OVERRIDE-001` | Conditional launch-environment hardening | P3; identify the lower-trust source and preserve supported launch modes. |
| `CORE-PARSER-DELIVERED-SUBSTRING-001` | Source-supported event classification defect | P2; preserve the separately tested latest-effective-update behavior. |
| `WE-HOST-LIFECYCLE-001` | Source-supported lifecycle race | P2; pause startup before spawn and close the window. |
| `SVC-ENV-PROXY-001` | Conditional proxy-policy risk | P3; HTTPS authentication remains; establish environment/proxy trust. |
| `SVC-CACHE-MODE-001` | Missing explicit permission hardening | P3; inspect effective parent permissions, umask, sidecars, and Windows ACLs. |
| `SVC-CLI-ARGV-001` | Conditional manual-launch credential exposure | P3; desktop launch already uses environment variables; process visibility is platform dependent. |
| `SVC-LOOKUP-DOTSEG-001` | Source-supported path normalization gap | P2; reject standalone dot segments; no origin change or cross-host leak established. |
| `SVC-INSECURE-FLAG-001` | Intended trusted-LAN opt-in; help text incomplete | P3 documentation; no demonstrated bypass of the supported policy. |
| `ELECTRON-OPEN-EXTERNAL-001` | Contract/hardening review | P3; HTTP(S)-only navigation is not itself a demonstrated exploit. |
| `ELECTRON-SAFE-STORAGE-001` | Conditional storage-policy risk | P3; inspect actual encryption availability and OS protection. |
| `SVC-STATUS-PUBLIC-001` | Intended public identity probe | No corrective patch established; retain minimal non-sensitive fields. |
| `DEV-VITE-HOST-001` | Narrowed development-only exposure | P3; bare Vite / `dev:web` use the wildcard default; `dev:renderer` explicitly uses loopback. |
| `WE-LIKE-WILDCARD-001` | Filter-contract review | P3 correctness; parameter binding prevents input from becoming SQL syntax. |
| `WE-ANALYTICS-SELECTED-001` | Source-supported efficiency/limit issue | P3; selected rows are filtered after a bounded whole-sheet query. |
| `DATA-AT-REST-001` | Separate confidentiality and durability policy decisions | P3; no application encryption promise or acceptable power-loss policy established. |

Static confidence is high for directly cited assignments, branches, and
configuration. Confidence in a complete exploit is lower where prerequisites
remain unresolved. No runtime validation or completed fix is implied by this
table. Same-user launch control, a malicious upstream redirect, and a public
unauthenticated request are different attacker capabilities.

## Relationship to the 2026-07-18 remediation

`docs/security-remediation-2026-07-18.md` closed thirteen findings against
revision `e75bc0517bd73cda72f58ee9cbec1032ec58358f`. This review did not refile
those items when the control is still present.

| July finding | Current state |
| --- | --- |
| `ELECTRON-PKG-001` | Package-time hash gate is still a package-time check. It does not run at process start. See `ELECTRON-PACKAGED-OVERRIDE-001`. |
| `ELECTRON-FS-001` | Per-window document capabilities still gate dialog-chosen paths. |
| `WE-R01-001` | Cross-sheet row ownership is still rejected before the upsert conflict. |
| `WORKSPACE-IPC-001` | Renderer and host frames are still capped at 16 MiB. |
| `ELECTRON-SSRF-001` | External API probes still pin DNS, block the addresses the classifier understands, and reject redirects. Embedded IPv4-in-IPv6 is a gap: `SSRF-EMBEDDED-V6-001`. |
| `CORE-PARSER-HTML-BOUNDS-001` | Upstream body cap 8 MiB and parsed-item cap 10,000 still hold. |
| `FRONTEND-SYNC-001` | `WorkspaceEngineSyncCoordinator` still publishes only the latest request. Sheet commands are a separate gap: `FE-SHEET-COMMAND-SCOPE-001`. |
| `WE-B3-ROW-CACHE-DOC-001` | Not re-opened. The new sheet-command finding is about the command target, not the row-window cache key. |
| `CORE-PARSER-UNICODE-INDEX-001` | Status-akhir parsing uses ASCII case folding. History helpers do not. See `CORE-PARSER-CASE-INDEX-001`. |
| `WE-R01-002` | Import request, id, and job caps still exist. Persistent import-job commands are rejected by the host. |
| `WE-R01-005` | Retry selection still requires `attempt_count < max_attempts`. |
| `ELECTRON-CONFIG-SECRET-001` | Renderer config still blanks bearer tokens. Copy still requires a native dialog. |
| `ELECTRON-IPC-001` | The July record describes a random nonce. The current endpoint is a stable hash of `userData`, which the architecture doc treats as intentional for orphan recovery. The remaining gap is `ELECTRON-IPC-STABLE-001`. |

## Findings

The sections below preserve the original item order. Use the assessment table
above for current status and priority, and the remediation plan for proposed
changes. Conditions are part of each claim.

### Data integrity and parser findings

#### `WE-UPSERT-STATUS-001` — same-lookup upsert clears row status

`upsert_sheet_rows` writes every non-empty display id as
`SheetRowStatus::Empty` and `error_message: None`
(`crates/shipflow-workspace-engine/src/engine.rs`, the production arm near
line 559). On conflict, `tracking_record_id` and `row_generation` change only
when the lookup id changes, but status and error are always overwritten
(`crates/shipflow-workspace-engine/src/storage.rs` lines 2732–2733).

The sheet input sanitizer can leave the lookup id unchanged for a space, a
stripped character, or a trailing `.<digits>` suffix. The tracking controller
upserts that value on each edit and does not start a fetch. A loaded or failed
row becomes empty. The grid maps a non-empty empty-status row to Pending.
Analytics filtered to loaded rows drop it. The tracking JSON remains. The
stored error text is gone.

Later patch direction: on a same-lookup conflict, keep the stored status and
error.

#### `WE-TRACK-INTERRUPTED-001` — a failed refresh setup leaves rows pending or loading

`refresh_sheet_rows_with_progress` commits `Pending` per row
(`crates/shipflow-workspace-engine/src/tracking.rs` near line 334) and then
calls `activate_tracking_lookup_group(...)?` (near line 392). Activation sets
`Loading` through the same compare-and-swap and also uses `?` (function near
line 707). The loop that stores a failed lookup runs only after the batch
await (near line 565).

An error during setup or the first activation returns before that fallback.
`recover_interrupted_tracking_rows` runs from `open_persistent`
(`crates/shipflow-workspace-engine/src/engine.rs` line 207). The long-running
refresh path opens a second SQLite connection and does not run that recovery.
Rows stay non-terminal until another refresh or until that window's host
process opens the database again. `busy_timeout` is 5 seconds. A status update
that commits and then fails while invalidating the analytics cache has the
same shape: the non-terminal status is already committed.

Later patch direction: any path that returns after those writes must mark the
rows already moved to `Pending` or `Loading` as failed, or hold the status
writes until setup succeeds.

#### `CORE-PARSER-CASE-INDEX-001` — history parsers slice with Unicode `to_lowercase()` indexes

`parse_status_akhir` folds with `to_ascii_lowercase()`
(`crates/shipflow-core/src/parser.rs` near line 1054). These history helpers
still take indexes from `str::to_lowercase()` and slice the original string:

- `extract_diterima_oleh`
- `parse_oleh_di`
- `parse_irregularity_detail`
- `extract_bag_id`
- `extract_coordinate`
- `parse_manifest_r7_detail`
- `parse_proses_antaran_status`
- `parse_successful_delivery_status`

`İ` (U+0130) lowercases to `i` plus a combining dot, so the lowercase string
is longer. The original review recorded the following results from a
throwaway program using that index pattern; the 2026-09-30 reassessment did
not rerun it or treat it as a full-parser regression test:

- `Proses DeliveryRunsheet oleh İ di Kantor dan diterima oleh Émile` panics,
  because the index lands inside `É`.
- The same prefix with an ASCII recipient slices `Budi` to `udi`.
- An all-ASCII line still returns `Budi`.

`scrape_pos_tracking` calls `parse_tracking_html` directly
(`crates/shipflow-core/src/upstream.rs` line 146). The service crates have no
`catch_unwind`. The panic is inside the lookup future. The lookup fails. The
trigger is history text in upstream HTML, not a character in the shipment id.
This is the unfinished part of `CORE-PARSER-UNICODE-INDEX-001`.

Later patch direction: case-fold the searchable copy with an ASCII-safe
function, or map every index back through the original byte positions.

#### `FE-SHEET-COMMAND-SCOPE-001` — sheet commands are not bound to a document generation

New workbooks use `default-sheet`
(`src/features/workspace/default-state.ts`). Opening a file keeps the saved
sheet id. `restore_workspace` deletes every sheet in the window engine when
`seed_only` is false, then inserts the opened document
(`crates/shipflow-workspace-engine/src/storage.rs` lines 382–386). One host
serves the window.

`deleteAllRows` captures `targetSheetId`, awaits `clearSheetRows`, then calls
`updateActiveSheet` (`src/features/workspace/useWorkspaceCommandsController.ts`
lines 731–741). `updateActiveSheetInWorkspace` applies the updater to whichever
sheet is active at `setState` time (`src/features/workspace/actions.ts` lines
194–207). `clear_sheet_rows` deletes by sheet id only (storage.rs lines
1205–1210).

Potential loss path supported by the call order, not a runtime reproduction:

1. An open is in flight and has sent `restore_workspace` for another file that
   also uses `default-sheet`.
2. An already armed delete-all sends `clearSheetRows` for that same id before
   the restore has finished. The normal two-step arming remains a prerequisite.
3. The host runs restore, then clear, so the rows just restored are deleted.
4. Autosave is on unless local storage says otherwise
   (`src/features/workspace/persistence.ts` lines 681–686) and writes the
   engine snapshot about 700 ms after the document is dirty.

CSV export, copy-all, and unscoped retrack page through the same sheet id in
windows of 1,000 rows (`collectRustExportRows` and the neighboring collectors).
A restore between pages can mix two documents or refresh the sheet that
replaced the one the user started from.

Later patch direction: use a native-enforced document generation and reject
stale commands before mutation or each paged read. Ignoring a stale React
completion alone cannot undo a native deletion. Apply a valid React follow-up
to the captured sheet id. See the deterministic race scenarios in the plan.

### Network, input, and release concerns

#### `ELECTRON-IPC-STABLE-001` — startup probe sends the internal token to a predictable endpoint

`serviceIpcStableNonce` is
`sha256("managed-service:" + sha256(userData).slice(0, 20)).slice(0, 32)`
(`electron/main/service-agent.ts` line 149). The macOS directory is
`/tmp/shipflow-<uid>-<identity prefix>`. `#prepareIpcRuntime` creates it mode
`0700` and does not record an owner check. `#ensureStarted` calls
`readManagedServiceStatus` on that endpoint before spawn. `requestServiceIpc`
puts `authToken` in the first JSON frame.

The Unix binder requires the parent directory mode to exclude group and other,
then unlinks an existing socket and binds. The metadata check follows
symlinks and does not compare uid. A same-user process that binds the
endpoint first receives the internal credential. The architecture doc says the
endpoint is deterministic so orphan recovery can find it. Same-user code that
can read the child environment can already read the token after a normal
start. This is not a remote authentication bypass.

The Windows pipe name is in the global `\\.\pipe\` namespace and is derived
from the same identity. `reject_remote_clients(true)` is set. This review did
not prove the DACL, so it does not claim that a different local user can
connect.

Later patch direction: prove the peer before sending the internal token, and
reject a parent symlink or a directory owned by another uid.

#### `SVC-LAN-CLEARTEXT-001` — LAN mode is cleartext HTTP on every interface

`ServiceRuntimeMode::Lan` binds `0.0.0.0`. The service has no TLS. Bearer
tokens and shipment payloads are exposed to an observer able to intercept that
HTTP traffic. This does not mean every LAN device automatically sees all
traffic. Local mode stays on
`127.0.0.1`. This is the documented opt-in mode in `docs/service-api-v1.md`,
not a silent bind. There is no CORS middleware. A browser on another origin
cannot read the responses through ordinary cross-origin script access. A
non-browser LAN client with a valid bearer can call protected endpoints;
missing CORS is not a substitute for authentication or transport encryption.

#### `SVC-POS-REDIRECT-001` — the default scraper follows redirects

`tracking_source_redirects_allowed` is true unless the source is External API
(`crates/shipflow-service-runtime/src/http_api.rs` lines 368–370). Reqwest's
default policy allows up to 10 redirects and does not force HTTPS. The
forbidden-address check is not applied to the `Location` target. The first
URL is a fixed POS HTTPS endpoint, so the redirect has to come from that
origin or from something that origin trusts. The external API client disables
redirects and pins DNS.

#### `WE-UNBOUNDED-DOCUMENT-001` — workspace documents and restore files have no byte cap

`readWorkspaceDocument` reads the whole file
(`electron/main/documents.ts` line 98). A large in-memory restore is written
beside the database and then parsed with `serde_json::from_reader` without a
byte limit. The staged restore name must match
`workspace-restore-{uuid}.json` and must look like a regular file at the
metadata check. This is memory use on a file the user opened, not path
traversal.

#### `ELECTRON-WIN-UPDATE-SIG-001` — Windows update verification skips Authenticode when no publisher is configured

`electron-builder.config.cjs` `win` sets the NSIS target and does not explicitly
set `publisherName` or `verifyUpdateCodeSignature`. That absence does **not**
prove that the installed updater has no publisher. In the installed
electron-builder 26.15.3 implementation:

- `WinPackager.isForceCodeSigningVerification` defaults to enabled unless
  `verifyUpdateCodeSignature` is explicitly `false`
  (`node_modules/app-builder-lib/out/winPackager.js`, lines 25–28).
- `WindowsSignToolManager.computedPublisherName` derives a publisher from the
  signing certificate's `commonName` when no explicit publisher is provided
  (`node_modules/app-builder-lib/out/codeSign/windowsSignToolManager.js`,
  lines 18–29).
- `getAppUpdatePublishConfiguration` copies that publisher into the generated
  updater configuration (`node_modules/app-builder-lib/out/publish/PublishManager.js`,
  lines 202–208).

In `electron-updater` 6.8.9,
`NsisUpdater.verifySignature` returns `null` when `publisherName` is missing
(`node_modules/electron-updater/out/NsisUpdater.js` lines 84–90). The caller
treats `null` as success (lines 52–57). The download still checks the SHA-512
from `latest.yml` (`AppUpdater.js` near line 565). `installUpdate` is available
to both window kinds and quits into `quitAndInstall` after download.

Only when the installed updater configuration lacks a publisher does replacing
both trusted release metadata and the installer bypass this publisher check.
Metadata/channel control is a separate prerequisite; replacing the installer
alone still fails its hash check. A signed macOS build follows the macOS
updater path. An ad-hoc macOS package uses identity `"-"` and disables
hardened runtime when no `CSC_LINK` or `CSC_NAME` is present (config lines
53–60). That branch is the unsigned local package, which the July record
already separated from a production-signed release.

This review did not build an installer or inspect an installed/generated
Windows `app-update.yml`. The unsigned-artifact condition is plausible, but a
signed-release signature bypass is **not established**. Verify both artifact
modes before deciding whether configuration changes are necessary.

#### `SSRF-EMBEDDED-V6-001` — the address classifier does not unwrap IPv4 embedded in IPv6

Both classifiers reject selected reserved IPv4/IPv6 ranges and handle mapped
IPv4 forms, with representation-dependent behavior in TypeScript. They do not
explicitly unwrap NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, or IPv4-compatible
`::/96` before applying the IPv4 policy. Not every IPv4 address is forbidden.

- TypeScript: `electron/main/external-api-policy.ts` lines 19–74.
- Rust: `is_forbidden_external_address` in
  `crates/shipflow-service-runtime/src/http_api.rs` lines 229–244.

`64:ff9b::a9fe:a9fe` encodes `169.254.169.254` and is not rejected by the
explicit classifier ranges. That is evidence of a classifier gap, not proof
that a complete request reaches a metadata service. URL hostname
representation, literal detection versus DNS, transition routing, and target
reachability must all be checked. In particular, bracketed URL literals must
be tested through the actual resolver rather than inferred from a raw-address
classifier call.

HTTPS certificate validation remains in place and normally precedes sending
the HTTP bearer header. A token disclosure claim must also establish the
transport prerequisites, such as an explicitly allowed HTTP path or valid TLS
at the target. POD fetches additionally require an allowed POS hostname.
Neither a live SSRF connection nor token disclosure was reproduced.

#### `SVC-FORCE-REFRESH-JOIN-001` — force refresh joins an in-flight lookup

A `Loading` slot always returns `Wait`
(`crates/shipflow-service-runtime/src/lookup_cache.rs` lines 567–578). After
the wait, the caller sets `bypass_ready = false` (lines 378–382). A
`force_refresh` that arrives during an ordinary fetch receives that result,
including an error cached for about 8 seconds, and does not send the upstream
force-refresh header when the existing loader was an ordinary request.

This needs a precise freshness contract. Coalescing concurrent forced requests
is intentional and covered by `coalesces_parallel_forced_refreshes`; its
cancellation recovery has a separate test. Do not remove that behavior as a
blanket fix. The unresolved case is a forced waiter joining an ordinary loader,
especially when an external API serves its own cached result.

Contact and bag-route caches do not take the flag. Their reuse is separately
documented in `docs/service-api-v1.md`, so this is not independently a confirmed
refresh bug. Successful bag routes are bounded by capacity rather than age.

#### `ELECTRON-PACKAGED-OVERRIDE-001` — a packaged app still honors development overrides

These are chosen with no `app.isPackaged` guard:

- `ELECTRON_RENDERER_URL` loads that URL with the preload bridge
  (`electron/main/index.ts` `loadRenderer`, near line 622). `will-navigate`
  trusts that origin only when the path also matches.
- `SHIPFLOW_SERVICE_PATH` and `SHIPFLOW_WORKSPACE_HOST_PATH` are tried before
  the packaged binary.
- `SHIPFLOW_INTERNAL_IPC_ENDPOINT` replaces the socket.

Child processes inherit `process.env` and receive the service tokens as well.
The package hash gate does not run at startup. Using this requires control of
the launch environment.

#### `CORE-PARSER-DELIVERED-SUBSTRING-001` — the substring `delivered` replaces the current runsheet update

In `build_history_summary`, a history line that contains `delivered` and does
not contain the concatenated token `failedtodelivered` replaces the current
runsheet's updates with a `DELIVERED` update and drops `keterangan_status`
(`crates/shipflow-core/src/parser.rs` near line 1383). `not delivered` and
`failed to delivered` take that branch. The header status is unchanged.
`infer_koli_status` still checks failure wording before delivered wording.
POS pages represented in the tests use `FAILEDTODELIVERED` and Indonesian
wording, so a live hit depends on the history text.

When the header status is exactly `DELIVERED` and the last runsheet has no
delivered update, that runsheet's updates are replaced as well (near line
1408). A `FAILEDTODELIVERED` update and its note are removed on that path.

Keeping only the latest effective update per runsheet is separately intentional
and covered by `parse_tracking_html_keeps_only_latest_effective_update_per_runsheet`
(near line 2549). The patch should correct classification and shipment-level
status leakage, not turn the summary into an unbounded event archive. The API
documentation says event status must come from that event, not `status_akhir`.

### Lifecycle, configuration, and behavioral observations

#### `WE-HOST-LIFECYCLE-001` — stop during host startup can leave the child running

`WorkspaceHostClient.stop` kills `#child` only when it is already set, and it
does not latch a disposed flag (`electron/main/workspace-host.ts` near line
235). `#spawnAndWaitUntilReady` awaits path resolution and `mkdir` before
`spawn` (near line 253), then assigns `#child`. A stop in that gap leaves the
later child outside the host map. The child environment contains
`SHIPFLOW_INTERNAL_SERVICE_TOKEN`. The service agent checks a shutting-down
flag before its own spawn. The host does not. The window is those two awaits.

#### `SVC-ENV-PROXY-001` — an environment proxy bypasses the DNS pin

The service builds a reqwest client and never calls `no_proxy()`. Reqwest
0.12 defaults `auto_sys_proxy` to true, and `from_system()` reads
`HTTP_PROXY`, `HTTPS_PROXY`, and `ALL_PROXY` even when the `system-proxy`
crate feature is off. Desktop spawn spreads `process.env` into the service.
Traffic then goes to the proxy, which does its own DNS, so `resolve_to_addrs`
does not pin that hop. POS and external API HTTPS still use rustls-webpki, so
the proxy sees the destination name and not the bearer. An HTTP external API
sends the bearer to the proxy.

#### `SVC-CACHE-MODE-001` — lookup caches are not created mode `0600`

`prepare_database_path` only calls `create_dir_all`
(`crates/shipflow-service-runtime/src/persistent_store.rs` lines 519–526).
The contact store and bag-route store follow the same pattern. A failed
primary open falls back to `temp_dir()` without an explicit mode. Contact
rows are kept for 90 days (`CONTACT_CACHE_TTL_MS` in `contact_cache.rs`).
Logs and the IPC socket are mode `0600`. On macOS, `~/Library` and the
per-user temp directory are normally private already. The code does not
enforce that.

#### `SVC-CLI-ARGV-001` — manual service launch puts tokens in argv

`--auth-token` and `--external-api-token` are stored from argv
(`apps/service/src/main.rs` lines 65–83). A local process list can read them,
and the HTTP port is reachable by other local users when it is bound to
loopback. The desktop launcher does not do this. It passes tokens through
the environment and puts only `--lan` or `--local` and `--port` on argv.

#### `SVC-LOOKUP-DOTSEG-001` — a dot-segment lookup id rewrites the external API path

`normalize_lookup_id` allows `.` (`crates/shipflow-core/src/upstream.rs`
lines 911–920). `build_external_api_lookup_url` passes the id to `Url::join`
(near line 1176). `v1/track/..` resolves to the parent path on the configured
host, and the upstream bearer is still attached. The join does not change
host. POS ids are base64-encoded into the query string.

#### `SVC-INSECURE-FLAG-001` — one flag allows both HTTP and private addresses

`allow_insecure_external_api_http` is set by
`--allow-insecure-external-api-http` and by
`SHIPFLOW_ALLOW_INSECURE_HTTP=true`. The CLI help only mentions HTTP. The
same boolean skips the private-address rejection for RFC1918, CGNAT
`100.64.0.0/10`, and IPv6 ULA (`http_api.rs` lines 326–334). Loopback,
`169.254.0.0/16`, and multicast stay forbidden. The error string already
describes this as trusted LAN access. The Electron probe uses the same
coupling.

This is an explicit supported opt-in, not an established security bypass.
Clarify the CLI help before considering a backward-incompatible split of flags.

#### `ELECTRON-OPEN-EXTERNAL-001` — any http(s) URL can be opened

`open_external_url` is in the shared command list and calls
`shell.openExternal` for any `http:` or `https:` URL, including loopback.
There is no host allowlist.

This alone does not establish an exploit. Inspect the user gesture, link
provenance, and any required destination policy before restricting the feature.

#### `ELECTRON-SAFE-STORAGE-001` — secrets fall back to plaintext

`protectSecret` returns the plaintext value when safeStorage encryption is
unavailable, the value is empty, or package-smoke isolation is on
(`electron/main/service-agent.ts` line 86). The config file is mode `0600`
where chmod works. Windows skips that chmod. The renderer copy of config
still blanks the secrets.

#### `SVC-STATUS-PUBLIC-001` — `GET /v1/status` has no bearer

The route returns service, product, mode, bind address, and port. It is
documented as the public identity probe. It does not return shipment data.
In LAN mode that identity is visible on the network.

The supplied claim describes intended behavior. No corrective authentication
patch is justified without changing the public identity-probe contract.

#### `DEV-VITE-HOST-001` — the standalone renderer dev server listens on every interface

`vite.config.ts` sets `host: "0.0.0.0"` and port 1420. Bare `vite` and
`npm run dev:web` use that default. The earlier claim about `dev:renderer` was
incorrect: `package.json` explicitly runs
`vite --host 127.0.0.1 --port 1420 --strictPort`, overriding the wildcard host.
`electron.vite.config.ts` does not set the same wildcard. This observation does
not establish production installer exposure.

#### `WE-LIKE-WILDCARD-001` — sheet filters do not escape SQL `LIKE` wildcards

Filter values are bound as `%value%` after the column is taken from an
allowlist. A user value that contains `%` or `_` widens the match. This is
not SQL injection.

Whether wildcards should be escaped depends on whether the product promises
literal substring search or intentionally supports pattern input.

#### `WE-ANALYTICS-SELECTED-001` — selected-row analytics still loads the sheet

`SelectedRows` reads up to `DEFAULT_MAX_ANALYTICS_SOURCE_ROWS` (100,000)
before filtering the selection in memory. A larger sheet fails closed.
DuckDB identifiers are generated `field_{i}_*` names passed through
`quote_identifier`. There is no DuckDB `memory_limit`. A caller-supplied
pivot limit does not raise the source-row cap.

#### `DATA-AT-REST-001` — workspace data is plaintext

SQLite workspace files, blobs, and the lookup cache are not encrypted at
rest. `synchronous=NORMAL` means the last committed transaction can be lost
if the machine loses power. WAL and `foreign_keys=ON` are on.

These are two separate policy questions: confidentiality against storage
readers, and durability after power loss. OS disk encryption/access controls
were not inspected. Plaintext application storage alone does not prove that a
documented encryption guarantee has been violated.

The hardcoded mile.app organization id in the bag-print URL is a public POS
identifier, not a credential.

## Controls that still hold

- Renderer: `nodeIntegration` false, `contextIsolation` true, `sandbox` true,
  `webSecurity` true, navigation and window-open denied, CSP on both HTML
  entry points, no `dangerouslySetInnerHTML` or `eval` in `src/`.
- Preload command names match the main-process allowlist. Workspace IPC
  methods are filtered again in main. `workspace.restore_file` is sent by
  main, not by the renderer.
- Document reads and writes go through per-window canonical path
  capabilities.
- POD fetches allow only `posindonesia.co.id` and its subdomains, HTTPS, no
  userinfo, pinned DNS, a 5 MiB cap, and no SVG. The grid renders the
  returned data URL.
- Public routes other than `/v1/status` require a bearer compared without
  per-byte short-circuit. Lookup ids are at most 64 characters from
  `[A-Za-z0-9.-]` before they are placed in a URL.
- External API redirects are off. Recognized private ranges require the
  trusted-LAN opt-in; recognized loopback, link-local metadata, and multicast
  destinations remain forbidden even with that flag. The transition-address
  classification gap remains conditional as described above.
- Sheet SQL is parameterized. Dynamic identifiers go through column
  allowlists. DuckDB columns are generated names.
- Tracking results apply only when `lookup_tracking_id` and `row_generation`
  still match. The grid drops a completion whose run id is not active.
- IPC frames are capped at 16 MiB. The service accepts at most 128 internal
  connections.

## Checked and narrowed

These reviewer claims were read against the code and are not separate
findings:

- Unix IPC mode `0700`/`0600` does not let a different user connect. The
  stable-nonce issue stays a same-user pre-bind.
- The Windows updater still checks SHA-512. Electron-builder can generate the
  publisher pin from a signing certificate; missing explicit source config is
  not proof that the installed pin is missing.
- System proxy settings beyond the environment variables require the
  `system-proxy` feature, which this crate does not enable. Environment
  proxies are `SVC-ENV-PROXY-001`.
- The earlier claim that a bracketed IPv6 URL literal necessarily bypasses DNS
  is withdrawn pending full resolver-path validation. A raw classifier result
  does not prove that URL normalization produces the same input.
- `dev:renderer` binds loopback explicitly; bare Vite and `dev:web` remain the
  relevant wildcard-config paths.
- All-force lookup coalescing, enrichment-cache reuse, and the public status
  probe have explicit product or test support and must not be removed merely
  to close an audit item.

## Fix order

Recommended implementation order, expanded in [remediation-plan.md](./remediation-plan.md):

1. `FE-SHEET-COMMAND-SCOPE-001` — bind sheet commands and paged reads to the
   originating document before destructive operations can run.
2. `CORE-PARSER-CASE-INDEX-001` — stop history parsers from slicing with
   Unicode-expanding indexes.
3. `WE-UPSERT-STATUS-001` — keep status and error when the lookup id did not
   change.
4. `WE-TRACK-INTERRUPTED-001` — do not leave rows in `Pending` or `Loading`
   when refresh setup fails.

Verify `ELECTRON-WIN-UPDATE-SIG-001` against generated signed and unsigned
artifacts before an updater release. Then address bounded document input,
delivery classification, host lifecycle, and conditional IPC/network controls.
Contract and hardening observations should not receive behavior-changing
patches until their requirements are clear. No item is marked fixed by this
documentation update.
