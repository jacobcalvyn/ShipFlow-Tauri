# Security Remediation Report - 2026-07-18

## Scope

This report records the remediation of the repository-wide Codex Security scan
performed against revision `e75bc0517bd73cda72f58ee9cbec1032ec58358f`.

- Scan ID: `b24fc7be-ffff-4ed7-88cf-b231b2a00bbf`
- Scan session: `fbae6ba5-2667-479a-88a2-44ed0c611f37`
- Findings: 13 total, including 3 high and 10 medium severity findings
- Product boundary: Electron renderer and main process, Rust Service Agent,
  Rust Workspace Host, workspace persistence, parser and upstream clients,
  packaging, and release workflows

## Remediation Summary

| Finding | Security invariant | Remediation and proof |
| --- | --- | --- |
| `ELECTRON-PKG-001` | Packaged native executables and DLLs must match the built source artifacts, and signed releases must contain valid Authenticode signatures. | The package verifier now checks SHA-256 provenance for native payloads and Authenticode for signed Windows artifacts. Windows release workflows explicitly enable the signed-artifact gate. |
| `ELECTRON-FS-001` | A renderer may read or write only a workspace document selected through a native file dialog for that window. | Per-window document capabilities canonicalize authorized paths and gate open, save, recovery, and new-window operations. Renderer-supplied paths cannot create capabilities. Unit coverage includes traversal and window-isolation cases. |
| `WE-R01-001` | An existing row ID cannot be reassigned to a different sheet. | Workspace storage rejects cross-sheet ownership conflicts before mutation and has a transaction-level regression test. |
| `WORKSPACE-IPC-001` | Renderer-controlled native IPC frames must have a fixed byte limit on both sides of the boundary. | Electron outbound frames, the shared Rust framing library, and Workspace Host stdin reject oversized frames before allocation or dispatch. |
| `ELECTRON-SSRF-001` | External API probes must not reach local, private, metadata, or redirect destinations unless the user explicitly enables the intended local-network mode. | The probe policy requires HTTPS by default, resolves and pins the destination address, blocks restricted networks, disables redirects, and preserves TLS hostname validation. Unit coverage includes private IPv4/IPv6, credentials, redirects, and approved destinations. |
| `CORE-PARSER-HTML-BOUNDS-001` | Upstream responses and parsed table cardinality must remain within deterministic resource bounds. | Upstream body reads are capped, error bodies are separately capped, and parser table rows are limited before workspace materialization. |
| `FRONTEND-SYNC-001` | A native workspace sync may publish only the latest complete document snapshot. | Sync operations are serialized through `WorkspaceEngineSyncCoordinator`; stale completion cannot replace a newer request. Deterministic race coverage verifies latest-only publication. |
| `WE-B3-ROW-CACHE-DOC-001` | Row-window cache entries must belong to the current document generation. | Cache keys include the workspace document generation. Normal row updates retain useful cache entries, while document replacement quarantines entries from the previous generation. |
| `CORE-PARSER-UNICODE-INDEX-001` | Parser normalization must never derive string offsets from Unicode-expanding case conversions. | Case-insensitive parser matching now uses ASCII-safe normalization for protocol tokens, with Unicode regression inputs proving panic-free behavior. |
| `WE-R01-002` | Import request size, source ID count, ID length, and derived job size must be bounded before persistent mutation. | The import engine enforces request, identifier, source-count, and job-item limits before creating or updating a job. Boundary and rejection tests cover accepted and oversized inputs. |
| `WE-R01-005` | Retry execution must stop when an item reaches the configured attempt limit. | Job selection now requires `attempt_count < max_attempts`; regression coverage proves exhausted items are not requeued. |
| `ELECTRON-CONFIG-SECRET-001` | Common renderer configuration reads must not disclose bearer tokens. | Service configuration returned to the renderer is redacted and exposes only configured-state booleans. Blank form fields preserve stored secrets, and public-token copy requires an explicit native confirmation action. |
| `ELECTRON-IPC-001` | A same-user local process must not be able to predict and pre-bind the Service IPC endpoint. | The Service creates a random nonce endpoint inside an owner-only runtime directory, retains the internal token proof, and validates private Unix directory permissions before bind. IPC path length is checked for macOS portability. |

## Preserved Behavior

The patch intentionally preserves these supported flows:

- native file dialogs can still open and save existing ShipFlow workspace files;
- independent workspace windows retain separate document ownership;
- third-party external API configuration still supports intentional endpoints and
  explicit local-network use;
- blank secret inputs do not erase previously stored tokens;
- normal row mutations retain cache reuse, while full document replacement is
  isolated by generation;
- import retry, preview, and job execution continue within explicit limits;
- unsigned development packages remain buildable, while signed release jobs
  enforce the stronger Windows signature policy.

## Validation Evidence

The patched tree passed the following gates:

```text
cargo fmt --all -- --check
npm run typecheck
npm run security:baseline
npm test
cargo test --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
npm run build
npm run test:e2e
npm run package:dir
npm run package:verify
npm test -- electron/main/service-ipc.test.ts
```

The complete frontend suite passed 39 test files and 325 tests before the final
Service IPC portability regression was added. The final focused Service IPC
suite passed all 3 tests, and the Electron smoke test passed against the real
Service Agent and Workspace Host child processes. The smoke test also exposed
and verified the fix for a macOS Unix socket path that exceeded the platform
limit when derived from the long per-user temporary directory.

The Rust workspace test suite, strict Clippy gate, formatter, TypeScript build,
security baseline, Electron package verifier, and macOS packaged application
smoke all passed on the final relevant code paths.

## Remaining Release Evidence

No known code-level finding from this scan remains open. Two platform release
checks remain external evidence requirements rather than code remediation gaps:

1. The next signed Windows GitHub Actions package must demonstrate valid
   Authenticode signatures through the new package gate on a Windows runner.
2. The local macOS package is ad-hoc signed and passed strict bundle verification,
   but Apple notarization remains unavailable until production Apple credentials
   are configured.

These constraints mean the patched tree is security-remediated and runtime
validated, but this report does not claim that a production-signed release has
been published.
