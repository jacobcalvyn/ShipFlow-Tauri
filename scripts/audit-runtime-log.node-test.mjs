import assert from "node:assert/strict";
import test from "node:test";
import {
  auditExceedsThreshold,
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
