import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  auditExceedsThreshold,
  existingLogPaths,
  parseRuntimeLog,
  runtimeRiskFindings,
  summarizeRuntimeLogs,
} from "./audit-runtime-log.mjs";

test("summarizes structured runtime events without requiring raw messages", () => {
  const parsed = parseRuntimeLog(
    [
      '[2026-07-24T00:00:00.000Z] [INFO] [Lifecycle] event=app_launch data={"platform":"darwin"} | session=11111111-1111-4111-8111-111111111111 sequence=1',
      '[2026-07-24T00:00:01.000Z] [INFO] [Diagnostics] event=runtime_heartbeat data={"aggregateWorkingSetKb":2048,"mainRssBytes":1048576} | session=11111111-1111-4111-8111-111111111111 sequence=2',
      '[2026-07-24T00:00:02.000Z] [ERROR] [Renderer] event=renderer_process_gone data={"reason":"crashed"} | session=11111111-1111-4111-8111-111111111111 sequence=3',
    ].join("\n"),
  );
  const summary = summarizeRuntimeLogs([parsed]);

  assert.equal(summary.totals.entries, 3);
  assert.equal(summary.totals.desktopEntries, 3);
  assert.equal(summary.totals.nativeEntries, 0);
  assert.equal(summary.totals.sessions, 1);
  assert.equal(summary.totals.errors, 1);
  assert.equal(summary.peaks.mainRssBytes, 1_048_576);
  assert.equal(summary.peaks.aggregateWorkingSetBytes, 2_097_152);
  assert.deepEqual(runtimeRiskFindings(summary), [
    { severity: "HIGH", event: "renderer_process_gone", count: 1 },
  ]);
});

test("summarizes native Service events and flags server errors", () => {
  const parsed = parseRuntimeLog(
    [
      "[ShipFlowLifecycle] service_ready pid=123 platform=windows arch=x86_64",
      "[ShipFlowDiagnostics] uptimeSec=60 rssBytes=10485760 ingressActive=2",
      "[ShipFlowHttp] request_completed requestId=test method=GET route=/v1/track/:shipment_id status=503 durationMs=250",
      "[ShipFlowIPC] request_completed requestId=test method=workspace.lookup result=error durationMs=25",
    ].join("\n"),
  );
  const summary = summarizeRuntimeLogs([parsed]);

  assert.equal(summary.totals.desktopEntries, 0);
  assert.equal(summary.totals.nativeEntries, 4);
  assert.equal(summary.totals.nativeHttpServerErrors, 1);
  assert.equal(summary.totals.nativeRequestErrors, 1);
  assert.equal(summary.peaks.serviceRssBytes, 10_485_760);
  assert.deepEqual(runtimeRiskFindings(summary), [
    { severity: "MEDIUM", event: "native_http_5xx", count: 1 },
    { severity: "MEDIUM", event: "native_request_errors", count: 1 },
  ]);
});

test("counts malformed structured lines without treating normal text as corruption", () => {
  const parsed = parseRuntimeLog(
    "[ShipFlow broken structured line\nStarting ShipFlow Service\n",
  );
  const summary = summarizeRuntimeLogs([parsed]);

  assert.equal(summary.totals.entries, 0);
  assert.equal(summary.totals.malformedLines, 1);
  assert.equal(summary.totals.unstructuredLines, 1);
  assert.deepEqual(runtimeRiskFindings(summary), [
    { severity: "LOW", event: "malformed_log_lines", count: 1 },
  ]);
});

test("does not flag a requested workspace host shutdown as a runtime risk", () => {
  const parsed = parseRuntimeLog(
    [
      '[2026-07-24T00:00:00.000Z] [INFO] [WorkspaceHost] event=workspace_host_stop_requested data={"pid":42,"windowLabel":"main"} | session=11111111-1111-4111-8111-111111111111 sequence=1',
      '[2026-07-24T00:00:00.010Z] [INFO] [WorkspaceHost] event=workspace_host_exited data={"detail":"signal SIGTERM","pid":42,"windowLabel":"main"} | session=11111111-1111-4111-8111-111111111111 sequence=2',
    ].join("\n"),
  );
  const summary = summarizeRuntimeLogs([parsed]);

  assert.equal(summary.totals.expectedWorkspaceHostExits, 1);
  assert.equal(summary.totals.unexpectedWorkspaceHostExits, 0);
  assert.deepEqual(runtimeRiskFindings(summary), []);
});

test("flags an unrequested workspace host exit", () => {
  const parsed = parseRuntimeLog(
    '[2026-07-24T00:00:00.000Z] [ERROR] [WorkspaceHost] event=workspace_host_exited data={"detail":"code 1","expected":false,"pid":42,"windowLabel":"main"} | session=11111111-1111-4111-8111-111111111111 sequence=1',
  );
  const summary = summarizeRuntimeLogs([parsed]);

  assert.equal(summary.totals.expectedWorkspaceHostExits, 0);
  assert.equal(summary.totals.unexpectedWorkspaceHostExits, 1);
  assert.deepEqual(runtimeRiskFindings(summary), [
    { severity: "MEDIUM", event: "workspace_host_exited", count: 1 },
  ]);
});

test("does not flag an expected managed Service shutdown", () => {
  const parsed = parseRuntimeLog(
    [
      '[2026-07-24T00:00:00.000Z] [INFO] [ServiceAgent] event=service_process_exited data={"detail":"code 0","expected":true,"pid":42} | session=11111111-1111-4111-8111-111111111111 sequence=1',
      '[2026-07-24T00:00:01.000Z] [ERROR] [ServiceAgent] event=service_process_exited data={"detail":"code 1","expected":false,"pid":43} | session=11111111-1111-4111-8111-111111111111 sequence=2',
    ].join("\n"),
  );
  const summary = summarizeRuntimeLogs([parsed]);

  assert.equal(summary.totals.expectedServiceProcessExits, 1);
  assert.equal(summary.totals.unexpectedServiceProcessExits, 1);
  assert.deepEqual(runtimeRiskFindings(summary), [
    { severity: "MEDIUM", event: "service_process_exited", count: 1 },
  ]);
});

test("keeps multiple explicit log inputs isolated from sibling discovery", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "shipflow-log-audit-"),
  );
  try {
    const selectedDesktop = path.join(directory, "shipflow-desktop-2.log");
    const selectedService = path.join(directory, "shipflow-service.log");
    const staleDesktop = path.join(directory, "shipflow-desktop.log");
    await Promise.all([
      writeFile(selectedDesktop, "selected desktop"),
      writeFile(selectedService, "selected service"),
      writeFile(staleDesktop, "stale desktop"),
    ]);

    const resolved = await existingLogPaths([
      selectedDesktop,
      selectedService,
    ]);

    assert.deepEqual(resolved.sort(), [
      selectedDesktop,
      selectedService,
    ].sort());
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("fails only when a finding reaches the requested quality-gate threshold", () => {
  const findings = [
    { severity: "LOW", event: "malformed_log_lines", count: 1 },
    { severity: "MEDIUM", event: "native_http_5xx", count: 1 },
  ];

  assert.equal(auditExceedsThreshold(findings, "HIGH"), false);
  assert.equal(auditExceedsThreshold(findings, "MEDIUM"), true);
  assert.equal(auditExceedsThreshold(findings, "LOW"), true);
  assert.equal(auditExceedsThreshold(findings, null), false);
  assert.throws(
    () => auditExceedsThreshold(findings, "CRITICAL"),
    /Unknown audit severity threshold/,
  );
});
