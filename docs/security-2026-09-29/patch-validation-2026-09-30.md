# Patch and Validation Record — 2026-09-30

Base revision: `8bb5c4cb87d29ce14ffe06de8307522d4bc181bf`.
Scope: the four implementation priorities in [remediation-plan.md](./remediation-plan.md).
The changes are in the working tree; this record does not imply a commit, push,
release, or closure of the remaining review items.

## Implemented changes

| Finding | Outcome | Change and evidence |
| --- | --- | --- |
| `FE-SHEET-COMMAND-SCOPE-001` | Fixed for the tested command/document boundary | SQLite owns a persistent document generation. Replacement advances it in the same transaction as restored rows. The host rejects missing/stale generations before serial commands; tracking rechecks inside its separate connection's setup transaction. Renderer scopes survive pagination and queued work, discard old completions, and bind updates to the originating sheet. |
| `CORE-PARSER-CASE-INDEX-001` | Fixed | Eight history helpers now search ASCII tokens with byte-preserving `to_ascii_lowercase()`. Original Unicode field contents remain intact. Full-parser regressions exercise expanding/contracting Unicode characters, decoded entities, nested HTML, mixed ASCII token case, and ASCII controls. |
| `WE-UPSERT-STATUS-001` | Fixed | The edit-specific storage operation preserves status, error, tracking payload link, and row generation when lookup identity is unchanged. A real lookup change clears the old payload and renews row identity. Explicit restore/import state writes keep their existing semantics. |
| `WE-TRACK-INTERRUPTED-001` | Fixed for setup/initial activation failures | Pending writes and initial activation run in one transaction. Status and analytics invalidation are atomic. Setup progress is emitted only after commit; no transaction spans an upstream await. Failed setup rolls back, allowing retry without restarting the window. Existing later-batch failure cleanup remains in place. |

### Document command boundary

The internal RPC protocol adds `workspace.document_generation`. Protected calls
carry `params.documentGeneration`; restore responses return the new generation.
The Electron allowlist and private large-document staging transport carry this
field. Each workspace database keeps its own identity. Seed-only startup keeps
the generation and renderer scopes valid. Failed replacement rolls back native
identity. Ordinary commands remain bound to the displayed document. If a restore
commits but loses its response, querying native identity does not silently rebind
old UI commands; they are rejected until a successful replacement establishes a
new displayed identity. A renderer handoff blocks commands until React commits
the replacement state, including the interval after native restore has returned.

The shared client and callers carry one captured scope across CSV/copy/retrack
pages, document-save pages, selection transfer, duplication, queued row edits,
bulk paste, import commits, and tracking. React delete completions update their
captured sheet. Reused sheet or row IDs cannot establish document identity.
Existing row-generation comparisons still reject late tracking results after a
row is edited, deleted, or recreated.

The Electron regression uses temporary documents A and B sharing `default-sheet`
and `reused-row`, with distinct tracking IDs. It pauses the real restore IPC
handler, invokes an already armed delete from A, then releases restore. B remains
intact. Direct stale clear/delete/query RPCs also fail. A later UI change triggers
autosave, and opening the saved B again preserves its native row contents. The
existing suite also verifies a 1,200-row restore whose payload exceeds 16 MiB.

Unit regressions stop export/copy/retrack after page one of 1,001 rows and replace
the document before the next response. No mixed output or replacement-document
refresh is emitted. Snapshot collection rejects replacement between save pages.
A separate regression simulates a committed restore with a lost response and
proves old UI commands remain rejected while a deliberate replacement retry can
recover. Sheet-switch tests assert that a completed deletion changes the original sheet
and preserves the newly active sheet.

### Parser boundary and original reproduction

The path is POS tracking HTML -> `parse_tracking_html` -> history-summary helpers
-> slices of original UTF-8 text. The required invariant is that search offsets
refer to identical byte boundaries in the original string. All affected tokens
are ASCII; original names, descriptions, locations, and coordinates must remain
unchanged. Using ASCII case conversion at these eight helpers repairs this
boundary without suppressing parser errors or stripping input text.

Before the patch, `cargo test -p shipflow-core unicode_ -- --nocapture` failed the
two new history tests with UTF-8 boundary panics; the existing header test passed.
After the patch, all three pass. The new full-parser matrix includes `İ`, repeated
`İ`, contracting `K`, decimal/hex HTML entities, nested elements, accented and
ASCII recipients, mixed-case protocol tokens, and ordinary ASCII prefixes.
Exact field assertions cover irregularity, bag, manifest, coordinates, delivery
runsheets, and successful delivery. The owning package's 66 tests also preserve
existing successful and rejected-input behavior.

One independent read-only investigation and one independent candidate review
were performed for this finding. The reviewer found no concrete surviving bypass
or regression; that review was static. No live upstream attack or ability to edit
POS history was established or assumed.

### Persistence and failure injection

Before the edit patch, `display_edits_preserve_tracking_state_until_lookup_changes`
failed because a `Loaded` row became `Empty`. It now passes for loaded and failed
rows, unchanged whitespace/suffix-normalized IDs, payload preservation, and real
lookup changes. Existing restore, append, row-generation, and analytics tests
remain part of the engine suite.

SQLite triggers deterministically reject the second pending write, first loading
write, and second loading write. Each case preserves original persisted statuses
and errors, emits no uncommitted setup progress, and permits a successful retry
through the failure-returning fixture source after removing the trigger. Another
trigger rejects analytics-cache invalidation and proves both status and cache
roll back. Generation tests cover successful restore, seed-only startup, invalid
restore rollback, and a stale tracking binding at transaction entry.

## Verification

Environment: macOS, Node `v24.19.0`, Rust `1.91.1`. Commands ran against local
source and disposable fixtures. Production documents were not opened or changed.

| Gate | Command / check | Result |
| --- | --- | --- |
| Syntax and integration | `npm run build` | Passed: TypeScript and Electron build. |
| Parser trigger and preserved behavior | `cargo test -p shipflow-core unicode_ -- --nocapture`; `cargo test -p shipflow-core --lib` | 3 Unicode tests and all 66 core tests passed. |
| Engine behavior | `cargo test -p shipflow-workspace-engine --lib` | 112 tests passed. The payload-strengthened edit regression was rerun and passed. |
| Repository Rust checks | `cargo test --workspace --all-targets`; `cargo clippy --workspace --all-targets -- -D warnings`; `cargo fmt --all -- --check` | 279 tests passed; Clippy and format passed. |
| Frontend behavior | `npm test` | 414 tests passed in the final full suite, including seed-only startup, the native-to-React handoff, lost restore responses, and empty-row cancellation. |
| Native/UI scenario | `npx playwright test tests/electron/suite-smoke.spec.ts` | Both Electron tests passed, including the command/restore/autosave regression and large staged restore. |
| Security and diagnostics | `npm run security:baseline`; `npm run test:diagnostics`; `git diff --check` | Passed; 8 diagnostics tests passed. |

Focused frontend regression commands also passed:

```sh
npx vitest run src/features/tracking/useTrackingRuntimeController.test.ts src/App.test.tsx -t 'drops an empty-row|cleared|emptied|seeds manual|three sheets isolated'
npx vitest run src/features/workspace-engine/document-scope.test.ts src/App.test.tsx -t 'native document|document|new sheet|three sheets|seeds manual'
```

The initial Electron launch failed inside the macOS sandbox (`SIGABRT` / `EPERM`).
Running the same isolated tests with approved desktop access succeeded. This was
an execution-environment limitation, not evidence of an application defect.
A later Electron run alongside the frontend suite reported `setTypeOfService
EINVAL` and a runner teardown timeout. The final identical Electron build passed
both tests when rerun serially after the other suite finished (20.7 seconds).
The cause of that intermittent runner error was not established; no application
workaround or weakened assertion was added.

## Remaining limits and Windows release gate

No Windows runner, signed Windows artifact, tampered-installer rejection, or live
POS service validation ran in this patch session. CI's current stable Rust version
may differ from the installed local toolchain.

`ELECTRON-WIN-UPDATE-SIG-001` remains open as an artifact/runtime release gate.
The installed builder can derive publisher identity from certificate CN;
`NsisUpdater` skips signature verification if generated `publisherName` is
missing. The current package verification script checks Authenticode when enabled,
but does not establish generated publisher pinning or updater rejection of a
wrong/tampered signer. No guessed publisher identity was added. Complete the
Windows checks in the remediation plan before publishing the affected updater.

Setup rollback cannot make an unavailable disk writable. Persistent storage
failure still returns an error; existing runtime/startup recovery remains the
fallback. Multi-page reads reject document replacement, but do not provide a
snapshot isolated from ordinary edits within the same document. These tests
establish the reported document-replacement boundary, not a new export snapshot
contract or closure of the other 22 review items. The patch does not establish a new transaction contract for overlapping
open/save requests. An uncertain restore may require reopening a document before
ordinary commands can proceed. It must not silently authorize commands against replacement data.
