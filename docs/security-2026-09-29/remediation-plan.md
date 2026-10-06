# Proposed Remediation Plan — 2026-09-30

Source revision: `8bb5c4cb87d29ce14ffe06de8307522d4bc181bf`.
Assessment: [findings.md](./findings.md).

This document preserves the proposed boundaries and acceptance criteria. The
first four patches have since been implemented; actual checks and remaining
limits are recorded in [patch validation](./patch-validation-2026-09-30.md).
Criteria below are not automatically claims of completed verification. Preserve the
July remediation record at `../security-remediation-2026-07-18.md`.

## Implementation order

| Order | Item | Intended result |
| --- | --- | --- |
| 1 | `FE-SHEET-COMMAND-SCOPE-001` | A command started in document A cannot mutate or export document B. |
| 2 | `CORE-PARSER-CASE-INDEX-001` | Unicode history preserves text and never causes invalid UTF-8 slicing. |
| 3 | `WE-UPSERT-STATUS-001` | Display-only edits preserve a row's existing tracking status and error. |
| 4 | `WE-TRACK-INTERRUPTED-001` | Setup/activation errors have bounded, observable recovery. |
| Release gate | `ELECTRON-WIN-UPDATE-SIG-001` | Generated production updater configuration and runtime signature rejection are verified. |

Keep these changes independently reviewable. An item is closed only when its
original scenario and relevant preserved behavior pass. Compilation alone is
not sufficient. The release gate is mandatory before publishing the affected
updater artifacts, not permission to publish while it remains unresolved.

## 1. Bind commands to a native document generation

**Files and call path:**
`src/features/workspace/useWorkspaceDocumentController.ts` ->
`src/features/workspace/engine-sync.ts` -> workspace-engine client/command
types -> `apps/workspace-host/src/main.rs` ->
`crates/shipflow-workspace-engine/src/storage.rs`.
Command callers include `useWorkspaceCommandsController.ts` and the tracking
controller; active-sheet updates are in `src/features/workspace/actions.ts`.

**Proposed patch:**

1. Maintain an authoritative document generation in native workspace state,
   shared by the serial actor and any separate tracking database connection.
   Advance it atomically with successful document replacement. Failed restores
   roll back both the replacement and generation change; ordinary edits and
   seed-only startup must not unexpectedly invalidate the current document.
2. Return the generation to the renderer. Capture `{documentGeneration,
   sheetId}` when a command starts, and carry it through mutations, tracking,
   and export/copy/retrack page requests. Do not silently substitute the newest
   generation for a stale request.
3. Validate the expected generation in the same transaction or serialized
   critical section as the protected operation. A separate check before a
   later mutation leaves a check/use race. Reject stale requests with an
   explicit error before they touch replacement data.
4. Apply React completion to the captured sheet, only if the document generation
   still matches. Current row-generation checks must remain in force for
   tracking completions. Disabling controls during restore is supplemental UI
   protection, not the native isolation mechanism.
5. For paged collectors, validate every page. If the document changes, discard
   the accumulated export/copy result and report cancellation; never emit a
   partial mixture of documents. Use a consistent native snapshot if that is
   required by the chosen export contract.

**Regression and acceptance:**

- Use two disposable documents with the same `default-sheet` and distinct row
  contents. Pause restore with a deterministic barrier, enqueue an already
  armed delete-all from the old document, and release the barrier. The old
  command must be rejected and the new document's native rows preserved.
- Exercise delete-selected and sheet switching while a completion is pending;
  the completion must not update whichever sheet happens to be active later.
- Pause export/copy/retrack after page one of a dataset larger than 1,000 rows,
  replace the document, and verify no mixed output or new-document refresh.
- Deliver an old tracking result after replacement, including reused row IDs.
  It must not attach data or status to replacement rows.
- Run the UI-to-host scenario with autosave enabled on temporary files. Reopen
  the saved document and compare its rows and payloads. Also cover legitimate
  current-generation commands, failed restore, and window isolation.

## 2. Use byte-preserving matching for parser protocol tokens

**Files:** `crates/shipflow-core/src/parser.rs`, full-parser fixtures/tests,
and the upstream parser call path in `crates/shipflow-core/src/upstream.rs`.

**Proposed patch:** replace Unicode-expanding lowercase search copies with
`to_ascii_lowercase()` wherever an ASCII protocol-token match supplies a byte
offset used against the original string. Cover all eight helpers listed in the
finding, including irregularity, bag, manifest, coordinate, and delivery
parsers. Preserve original names, descriptions, locations, and Unicode bytes
in returned fields. If a non-ASCII token ever needs case-insensitive matching,
use an explicit original-offset mapping for that case.

Do not suppress the panic with a catch-and-return-empty fallback or strip
Unicode from source text. Neither repairs the offset calculation.

**Regression and acceptance:**

- Add a full `parse_tracking_html` fixture with `İ` before searchable tokens
  and an accented recipient such as `Émile`; it must return the complete name
  without panic. Cover the ASCII-recipient variant that previously lost its
  first character, plus ordinary ASCII controls.
- Exercise every changed helper through representative history rows, including
  irregularity status/officer/location and coordinates. Assert field values,
  not just successful parsing.
- Include mixed ASCII token case, multi-byte names, and missing delimiters.
  Existing body/item bounds and successful-delivery classification must hold.
- Where practical, demonstrate the regression failing before the patch and
  passing afterward; retain the actual command and result in validation notes.

## 3. Preserve status on unchanged-lookup edits

**Files:** `crates/shipflow-workspace-engine/src/engine.rs`
(`upsert_sheet_rows`), `storage.rs` (`upsert_sheet_row`), and
`src/features/tracking/useTrackingRuntimeController.ts`
(`handleTrackingInputChange` / `syncTrackingInputDraftToEngine`).

**Proposed patch:** distinguish a display/input edit from an intentional
tracking-state write. On an edit whose normalized lookup ID is unchanged,
preserve stored `row_status`, `error_message`, `tracking_record_id`, and
`row_generation`. Continue updating display text, position, and timestamps.
For a genuinely different lookup, clear obsolete tracking state and advance
the row generation. Audit callers of the shared storage upsert before changing
it: explicit restore/import/refresh state writes must retain their intended
semantics. Scope preservation to the edit operation if callers differ.

**Regression and acceptance:** load or fail a row, then make whitespace,
sanitizer-equivalent, and supported suffix-only edits that resolve to the same
lookup. Assert persisted status, error, payload link, and generation; reload
the native row window and verify grid/analytics behavior. A real lookup change
must reset the old result, and its late completion must remain rejected.
Cover both ordinary updates and append/restore callers to avoid changing their
state semantics accidentally.

## 4. Recover failed refresh setup and activation

**Files:** `crates/shipflow-workspace-engine/src/tracking.rs`
(`refresh_sheet_rows_with_progress`, `activate_tracking_lookup_group`),
`storage.rs` status/analytics-cache writes, and host refresh dispatch.

**Proposed patch:**

- Route setup, initial activation, subsequent activation, and batch failures
  through one explicit error/finalization path instead of early `?` returns
  after non-terminal writes.
- Record recovery ownership before a write can partially succeed. Preserve
  `{documentGeneration, rowId, lookupId, rowGeneration}` so cleanup never marks
  an edited or replaced row failed.
- Make a row status update and its analytics-cache invalidation atomic where
  they share a SQLite connection. Consider an atomic setup transaction so a
  failed setup cannot leave a partly pending batch. Do not hold a database
  transaction across an upstream network await.
- Report the original failure and any cleanup failure. If the database remains
  unavailable, do not claim terminal states were persisted: expose retryable
  failure and retain a bounded recovery path once writes are available. Keep
  startup recovery as a final fallback.

**Regression and acceptance:** inject failure after the first pending write,
during first-group activation, after one loading write, and during analytics
invalidation. Verify persisted terminal state when storage is writable and
truthful errors when it is not. Retry after recovery without restarting the
window. Cover changed/deleted rows, document replacement, normal success, and
deduplicated lookups. Use deterministic fault injection rather than flaky
timing-only lock tests.

## Release gate: inspect Windows updater artifacts first

**Files:** `electron-builder.config.cjs`, updater build workflows,
`scripts/verify-electron-package.mjs`, and generated Windows `app-update.yml`.
The verifier is invoked by `npm run package:verify`.

The installed builder already derives a publisher from signing credentials.
Do not add a guessed publisher name or disable signature checking to close
this item.

**Proposed verification and conditional patch:**

1. On a Windows runner, inspect generated configuration from both unsigned and
   production-signed builds. Record whether the publisher is absent or matches
   the expected signing identity, without recording credentials.
2. Extend the production package/release gate to require the expected publisher
   configuration as well as valid installer/native signatures. Prefer generated
   certificate metadata; use an explicit publisher only if a release policy
   requires it and the identity is verified.
3. Exercise the updater with controlled fixtures: a valid expected-publisher
   package must pass, while unsigned and wrong-publisher packages must fail even
   when their supplied metadata hashes match. Also test a hash mismatch.
4. Keep unsigned development packaging explicit. Decide whether such builds
   should disable automatic installation or use a separate test channel;
   do not silently distribute an unverified production updater configuration.

No signed Windows artifact or updater install was verified in this review.
Missing platform/credential evidence must remain an open release gate.

## Follow-up proposals for the other review items

Each row is a separate retained item, including intentional behavior and
conditional findings. Do not implement a policy change merely to make every
row read as fixed.

| Finding | Suggested patch or decision | Required verification / preserved behavior |
| --- | --- | --- |
| `ELECTRON-IPC-STABLE-001` | Design authenticated peer discovery before sending the internal bearer. Validate Unix directory type/owner without following symlinks; evaluate Windows peer identity and DACL. A same-UID check alone does not defeat the same-user attacker. | A pre-bound fake server receives no bearer; legitimate orphan shutdown/restart still works. Use a reviewed authentication design, not endpoint randomness alone or custom ad hoc crypto. |
| `SVC-LAN-CLEARTEXT-001` | Define TLS termination or another authenticated encrypted deployment path and document it. Keep loopback default and avoid exposing a parallel cleartext backend on every interface when using a local TLS terminator. | Authorized LAN clients still work through the protected path; invalid bearer fails; externally reachable endpoints match the documented transport. |
| `SVC-POS-REDIRECT-001` | Validate every redirect's HTTPS scheme, allowed destination, and resolved addresses, or disable redirects if source compatibility permits. | Allowed POS redirects work; disallowed/local targets and downgrade redirects fail before connection. Preserve the external API's redirect rejection. |
| `WE-UNBOUNDED-DOCUMENT-001` | Set a documented document-byte limit based on supported workloads; enforce bounded reads before JSON allocation in Electron and staged Rust restores. Keep parsed cardinality/depth constraints explicit. | Limit, limit+1, malformed JSON, and oversized files reject before replacement; current data stays intact. Preserve valid large-document restore above the IPC frame threshold, including the existing large-payload fixture. Do not reintroduce a 16 MiB document limit accidentally. |
| `SSRF-EMBEDDED-V6-001` | Define a shared address-policy test matrix for TypeScript and Rust. Parse canonical addresses, classify supported embedded IPv4 forms, or reject unsupported transition ranges explicitly. | Test raw addresses, bracketed URLs, and DNS answers through the full resolver. Retain TLS hostname verification, pinned destinations, and intentional trusted-LAN support; do not probe real metadata endpoints. |
| `SVC-FORCE-REFRESH-JOIN-001` | Specify whether a forced request requires an upstream forced fetch. If so, track in-flight fetch strength/generation and perform at most one forced successor when joining an ordinary fetch cannot satisfy it. | Ordinary+forced, forced+forced, errors, and cancellation produce the agreed freshness without request storms. Preserve persistent-cache bypass on cancellation retry and documented enrichment-cache reuse. |
| `ELECTRON-PACKAGED-OVERRIDE-001` | Gate development renderer/native overrides in packaged builds after identifying intentional smoke/support configuration. Document the supported operator boundary. | Packaged runtime uses bundled code; normal development and isolated package smoke remain usable without a broadly enabled bypass. |
| `CORE-PARSER-DELIVERED-SUBSTRING-001` | Replace loose `delivered` substring fallback with explicit event classification; keep event status independent of shipment-level final status. | Negative wording never becomes delivered; failure notes survive final-status disagreement. Preserve the existing latest-effective-update-per-runsheet contract and successful recipient cases. |
| `WE-HOST-LIFECYCLE-001` | Latch disposal in `stop()`, recheck after startup awaits and before spawn, and reject requests after disposal. | Close/quit at each startup barrier leaves no new child or outstanding promise; ordinary startup and recovery still work. |
| `SVC-ENV-PROXY-001` | Define whether externally supplied proxies are supported. Where direct DNS enforcement is required, use explicit direct transport; otherwise document proxy trust and configure it deliberately. | Inherited proxy variables cannot silently change the agreed trust model. Preserve TLS validation and intentional corporate-network connectivity. |
| `SVC-CACHE-MODE-001` | Enforce private cache directories and database/sidecar permissions on Unix; verify Windows ACL inheritance and fallback storage. | Primary and fallback paths, WAL/SHM files, and existing-cache migration meet the access policy without losing cached data. |
| `SVC-CLI-ARGV-001` | Document existing environment-based token input as the default manual launch method; consider stdin or protected-file input if needed. | Supported launch examples and diagnostics avoid token-bearing argv; never log secret values. Do not describe environment variables as inaccessible to same-user processes. |
| `SVC-LOOKUP-DOTSEG-001` | Reject standalone `.` and `..` before URL joining, keeping permitted dots in real identifiers. | Every exposed lookup path rejects dot segments while normal and multi-koli IDs retain their original URL and origin. |
| `SVC-INSECURE-FLAG-001` | Clarify that the option enables intentional private-LAN destinations and HTTP. Split flags only with an explicit compatibility/migration policy. | Help text matches actual behavior; reserved loopback/metadata/multicast rejection remains. |
| `ELECTRON-OPEN-EXTERNAL-001` | Establish link provenance, user-gesture expectations, and destination policy. Add restrictions only where those requirements justify them. | Non-HTTP schemes remain rejected; legitimate tracking/source links still open. No exploit is claimed solely from the missing host allowlist. |
| `ELECTRON-SAFE-STORAGE-001` | Decide whether unavailable OS encryption should permit storage, require session-only secrets, or block persistence with a visible explanation. Preserve encrypted legacy configuration migration. | Exercise encryption available/unavailable and isolated-smoke cases; no renderer disclosure or silent credential loss. Verify Windows ACLs. |
| `SVC-STATUS-PUBLIC-001` | Preserve the documented public probe. Retain a minimal response schema rather than adding bearer authentication merely to close the observation. | No tokens, shipments, contact values, or sensitive diagnostics appear in the public response; protected routes still require authentication. |
| `DEV-VITE-HOST-001` | Optionally align the Vite default with loopback and require an explicit `--host` for LAN development. The `dev:renderer` script is already loopback-bound. | Inspect bare Vite, `dev:web`, `dev:renderer`, and Electron dev separately; document any intentional LAN opt-in. |
| `WE-LIKE-WILDCARD-001` | If filters promise literal substring search, escape `%`, `_`, and the chosen escape character and use SQL `ESCAPE`. Otherwise document pattern behavior. | Test literal wildcard characters and ordinary text while keeping parameter binding and column allowlists. |
| `WE-ANALYTICS-SELECTED-001` | Apply selection in the native query before materialization, with bounded parameters/batching and explicit selected-source limits. Evaluate a DuckDB memory budget separately. | A small selection from a sheet above 100,000 rows succeeds within bounds; oversized selections still fail explicitly; ordering and aggregate totals remain correct. |
| `DATA-AT-REST-001` | Separate the storage confidentiality threat model from the power-loss durability requirement. Plan encryption/key management or stronger synchronization only against a defined requirement. | Migration, backup/recovery, key unavailability, and power-loss behavior require their own evidence; no destructive in-place conversion or silent loss of accessible documents. |

## Validation records for future patches

For each implemented item, add a dated validation note in this folder with:

- finding ID, patch revision, exact scenario, and pre-patch failure evidence;
- targeted command results and relevant UI/API/native/persistence observations;
- preserved behavior and any changed public contract;
- platform, fixture scope, and unresolved proof gaps;
- a final state of proposed, implemented-unverified, verified, or deferred with
  a reason. Do not mark conditional findings fixed based on unrelated tests.

Run checks appropriate to the touched layer. Rust changes need focused
regressions plus relevant formatting/lint checks; TypeScript/IPC changes need
type checks and relevant tests. Document-scoping changes additionally need the
real Electron-to-host persistence scenario. Packaging changes need artifacts
from the affected platform. Use isolated fixtures and temporary workspace
files for destructive scenarios, never the user's active document.
