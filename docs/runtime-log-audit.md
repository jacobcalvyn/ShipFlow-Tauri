# Runtime Log Audit

## Purpose

This procedure collects comparable macOS and Windows evidence for the Electron
shell, managed Service, Workspace Hosts, renderer, IPC, restart behavior, and
memory use. It does not replace platform signing, notarization, or manual
installer validation.

## Log Contract

The log directory contains two bounded active files and one rotated `.1`
backup for each file:

- `shipflow-desktop.log` contains Electron and renderer lifecycle;
- `shipflow-service.log` is written directly by the Rust Service process and
  remains writable if Electron crashes;
- a unique session ID and monotonic sequence for every Electron launch;
- application, window, renderer, suspend, resume, and shutdown lifecycle;
- managed Service spawn, orphan detection, replacement, readiness, exit,
  restart, and shutdown;
- Workspace Host spawn, readiness, request completion, exit, and stop;
- renderer-to-main and renderer-to-Workspace IPC duration and result;
- Service HTTP and native IPC request correlation, status, and duration;
- 60-second Electron and Service memory/backpressure snapshots.

Open the active file or directory from the native `File` menu. Prefer that menu
over hard-coded paths because Electron resolves the correct per-user location
for each platform.

## Reproduction Run

Perform the same run on a packaged macOS and Windows build:

1. Launch ShipFlow Desktop and confirm only one suite instance is active.
2. Open Service Settings, save a valid configuration, and confirm Service
   status is running.
3. Import a Bag and a Manifest, then track enough rows to exercise queued and
   active work.
4. Open a second workspace window and perform one lookup in each window.
5. Suspend and resume the computer when practical.
6. End the managed Service once to verify bounded automatic restart.
7. Close one workspace window, quit the suite, and confirm no Workspace Host or
   managed Service remains when tray persistence is disabled.
8. Copy `shipflow-desktop.log`, `shipflow-service.log`, and their optional `.1`
   backups before starting another run.

Do not intentionally kill production work. Use an isolated test workspace and
non-sensitive shipment identifiers.

## Analyze

From the repository:

```bash
npm run diagnostics:log -- "/path/to/shipflow-desktop.log"
```

The analyzer automatically includes the adjacent Service log and all available
`.1` backups. To compare explicit platform files:

```bash
npm run diagnostics:log -- \
  "/path/to/mac/shipflow-desktop.log" \
  "/path/to/windows/shipflow-desktop.log"
```

Use `--fail-on=high` in automated smoke checks. The command exits non-zero when
the selected severity threshold is reached:

```bash
npm run diagnostics:log -- \
  --fail-on=high \
  "/path/to/shipflow-desktop.log"
```

Use `--verbose` only locally when the summarized error scopes and events are
insufficient.

## Acceptance Signals

- no `startup_failed`, `renderer_process_gone`, or
  `electron_child_process_gone`;
- no `service_restart_exhausted`;
- each `service_process_started` has a `service_ready` or an explained
  `service_process_exited`;
- each normal quit reaches `native_shutdown_completed` and `app_exit`;
- no repeated `workspace_host_exited` outside an explicit window close;
- HTTP request completion uses the same request ID returned in
  `x-shipflow-request-id` and the JSON envelope;
- a crash-relaunch sequence either records `orphan_service_detected` and
  `orphan_service_stopped` before a replacement `service_ready`, or confirms
  that the prior Service exited with Electron before the replacement becomes
  ready;
- no repeated `native_http_5xx`, `native_request_errors`, or
  `service_memory_warning` findings;
- memory snapshots remain bounded for a repeated workload and return near the
  prior baseline after work drains;
- warnings and errors have a reproducible scope and do not contain credentials.

## CI Evidence

The Quality Gate executes:

- source-level TypeScript, Vitest, Rust, Clippy, and security checks on Linux;
- unpacked packaged smoke tests on `macos-latest` and `windows-latest`;
- single-instance, integrated Service settings, native API health, and Service
  crash-recovery checks.

On a smoke failure, GitHub Actions uploads the Playwright report, screenshots,
and isolated Desktop plus Service runtime logs for 14 days. The packaged smoke
also kills Electron abruptly and verifies that a surviving Service is replaced
through authenticated native IPC, or that a Service terminated by the OS with
its parent is replaced by a healthy process. The same smoke fails when the
runtime-log analyzer reports a high-severity signal. A passing CI run is source
and packaged-runtime evidence, not proof of a signed production installer or
a manual Windows installation.

## Data Handling

Known secret formats are redacted and individual log entries are bounded.
Native operational output may still contain shipment, facility, or employee
identifiers. Review and redact those identifiers before sharing logs outside
the authorized support channel.
