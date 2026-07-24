import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOG_LINE_PATTERN =
  /^\[([^\]]+)] \[(INFO|WARN|ERROR)] \[([^\]]+)] (.*?) \| session=([a-f0-9-]+) sequence=(\d+)$/;
const EVENT_PATTERN = /^event=([a-z0-9_]+) data=(\{.*})$/;
const NATIVE_LOG_LINE_PATTERN =
  /^\[(ShipFlow[A-Za-z]+)]\s+(\S+)(?:\s+(.*))?$/;
const NATIVE_FIELD_PATTERN = /([a-zA-Z][a-zA-Z0-9]*)=("[^"]*"|\S+)/g;

function defaultLogPaths() {
  if (process.platform === "darwin") {
    return [
      path.join(
        os.homedir(),
        "Library",
        "Logs",
        "ShipFlow Desktop",
        "shipflow-desktop.log",
      ),
    ];
  }
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return [
      path.join(appData, "ShipFlow Desktop", "logs", "shipflow-desktop.log"),
      path.join(appData, "com.shipflow.desktop", "logs", "shipflow-desktop.log"),
    ];
  }
  const configHome =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return [
    path.join(configHome, "ShipFlow Desktop", "logs", "shipflow-desktop.log"),
    path.join(configHome, "com.shipflow.desktop", "logs", "shipflow-desktop.log"),
  ];
}

function parseEvent(message) {
  const match = EVENT_PATTERN.exec(message);
  if (!match) {
    return null;
  }
  try {
    return { name: match[1], fields: JSON.parse(match[2]) };
  } catch {
    return { name: match[1], fields: null };
  }
}

function parseNativeFields(rawFields = "") {
  const fields = {};
  for (const match of rawFields.matchAll(NATIVE_FIELD_PATTERN)) {
    const rawValue = match[2].replace(/^"(.*)"$/, "$1");
    if (/^-?\d+(?:\.\d+)?$/.test(rawValue)) {
      fields[match[1]] = Number(rawValue);
    } else if (rawValue === "true" || rawValue === "false") {
      fields[match[1]] = rawValue === "true";
    } else {
      fields[match[1]] = rawValue;
    }
  }
  return fields;
}

export function parseRuntimeLog(content) {
  const entries = [];
  const nativeEntries = [];
  let malformedLines = 0;
  let unstructuredLines = 0;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const match = LOG_LINE_PATTERN.exec(line);
    if (match) {
      entries.push({
        timestamp: match[1],
        level: match[2],
        scope: match[3],
        message: match[4],
        sessionId: match[5],
        sequence: Number(match[6]),
        event: parseEvent(match[4]),
      });
      continue;
    }
    const nativeMatch = NATIVE_LOG_LINE_PATTERN.exec(line);
    if (nativeMatch) {
      const startsWithFields = nativeMatch[2].includes("=");
      nativeEntries.push({
        scope: nativeMatch[1],
        event: startsWithFields ? "snapshot" : nativeMatch[2],
        fields: parseNativeFields(
          startsWithFields
            ? `${nativeMatch[2]} ${nativeMatch[3] ?? ""}`
            : nativeMatch[3],
        ),
      });
      continue;
    }
    if (line.startsWith("[ShipFlow")) {
      malformedLines += 1;
    } else {
      unstructuredLines += 1;
    }
  }
  return { entries, malformedLines, nativeEntries, unstructuredLines };
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function numericField(entry, field) {
  const value = entry.event?.fields?.[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function summarizeRuntimeLogs(parsedLogs) {
  const entries = parsedLogs.flatMap((parsed) => parsed.entries);
  const nativeEntries = parsedLogs.flatMap((parsed) => parsed.nativeEntries);
  const eventCounts = new Map();
  const nativeEventCounts = new Map();
  const scopeErrorCounts = new Map();
  const sessions = new Set();
  let warnings = 0;
  let errors = 0;
  let malformedLines = 0;
  let unstructuredLines = 0;
  let maxMainRssBytes = 0;
  let maxAggregateWorkingSetKb = 0;
  let maxServiceRssBytes = 0;
  let nativeRequestErrors = 0;
  let nativeHttpServerErrors = 0;

  for (const parsed of parsedLogs) {
    malformedLines += parsed.malformedLines;
    unstructuredLines += parsed.unstructuredLines;
  }
  for (const entry of entries) {
    sessions.add(entry.sessionId);
    if (entry.level === "WARN") {
      warnings += 1;
    }
    if (entry.level === "ERROR") {
      errors += 1;
      increment(scopeErrorCounts, entry.scope);
    }
    if (entry.event) {
      increment(eventCounts, entry.event.name);
    }
    maxMainRssBytes = Math.max(
      maxMainRssBytes,
      numericField(entry, "mainRssBytes") ?? 0,
    );
    maxAggregateWorkingSetKb = Math.max(
      maxAggregateWorkingSetKb,
      numericField(entry, "aggregateWorkingSetKb") ?? 0,
    );
  }
  for (const entry of nativeEntries) {
    increment(nativeEventCounts, `${entry.scope}.${entry.event}`);
    const rssBytes = entry.fields.rssBytes;
    if (typeof rssBytes === "number" && Number.isFinite(rssBytes)) {
      maxServiceRssBytes = Math.max(maxServiceRssBytes, rssBytes);
    }
    if (entry.event === "request_completed" && entry.fields.result === "error") {
      nativeRequestErrors += 1;
    }
    if (
      entry.scope === "ShipFlowHttp" &&
      entry.event === "request_completed" &&
      typeof entry.fields.status === "number" &&
      entry.fields.status >= 500
    ) {
      nativeHttpServerErrors += 1;
    }
  }

  return {
    entries,
    nativeEntries,
    totals: {
      entries: entries.length + nativeEntries.length,
      desktopEntries: entries.length,
      errors,
      malformedLines,
      nativeEntries: nativeEntries.length,
      nativeHttpServerErrors,
      nativeRequestErrors,
      sessions: sessions.size,
      unstructuredLines,
      warnings,
    },
    eventCounts: Object.fromEntries(
      [...eventCounts.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
    scopeErrorCounts: Object.fromEntries(
      [...scopeErrorCounts.entries()].sort(
        ([leftScope, leftCount], [rightScope, rightCount]) =>
          rightCount - leftCount || leftScope.localeCompare(rightScope),
      ),
    ),
    nativeEventCounts: Object.fromEntries(
      [...nativeEventCounts.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    peaks: {
      aggregateWorkingSetBytes: maxAggregateWorkingSetKb * 1024,
      mainRssBytes: maxMainRssBytes,
      serviceRssBytes: maxServiceRssBytes,
    },
  };
}

export function runtimeRiskFindings(summary) {
  const count = (event) => summary.eventCounts[event] ?? 0;
  const findings = [];
  const highRiskEvents = [
    "startup_failed",
    "renderer_process_gone",
    "electron_child_process_gone",
    "service_restart_exhausted",
  ];
  for (const event of highRiskEvents) {
    if (count(event) > 0) {
      findings.push({ severity: "HIGH", event, count: count(event) });
    }
  }
  for (const event of [
    "service_process_exited",
    "service_restart_failed",
    "orphan_service_recovery_failed",
    "workspace_host_exited",
  ]) {
    if (count(event) > 0) {
      findings.push({ severity: "MEDIUM", event, count: count(event) });
    }
  }
  if (summary.totals.nativeHttpServerErrors > 0) {
    findings.push({
      severity: "MEDIUM",
      event: "native_http_5xx",
      count: summary.totals.nativeHttpServerErrors,
    });
  }
  if (summary.totals.nativeRequestErrors > 0) {
    findings.push({
      severity: "MEDIUM",
      event: "native_request_errors",
      count: summary.totals.nativeRequestErrors,
    });
  }
  const memoryWarnings =
    summary.nativeEventCounts["ShipFlowDiagnostics.memory_warning"] ?? 0;
  if (memoryWarnings > 0) {
    findings.push({
      severity: "MEDIUM",
      event: "service_memory_warning",
      count: memoryWarnings,
    });
  }
  if (summary.totals.malformedLines > 0) {
    findings.push({
      severity: "LOW",
      event: "malformed_log_lines",
      count: summary.totals.malformedLines,
    });
  }
  return findings;
}

const SEVERITY_RANK = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
};

export function auditExceedsThreshold(findings, threshold) {
  if (!threshold) {
    return false;
  }
  const thresholdRank = SEVERITY_RANK[threshold];
  if (!thresholdRank) {
    throw new Error(`Unknown audit severity threshold: ${threshold}`);
  }
  return findings.some(
    (finding) => (SEVERITY_RANK[finding.severity] ?? 0) >= thresholdRank,
  );
}

function formatBytes(value) {
  if (!value) {
    return "0 B";
  }
  const units = ["B", "KiB", "MiB", "GiB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

async function existingLogPaths(requestedPaths) {
  const primaryCandidates = requestedPaths.length
    ? requestedPaths.map((candidate) => path.resolve(candidate))
    : defaultLogPaths();
  const candidates = new Set(primaryCandidates);
  for (const candidate of primaryCandidates) {
    const baseName = path.basename(candidate);
    if (baseName === "shipflow-desktop.log") {
      candidates.add(path.join(path.dirname(candidate), "shipflow-service.log"));
    } else if (baseName === "shipflow-service.log") {
      candidates.add(path.join(path.dirname(candidate), "shipflow-desktop.log"));
    }
  }
  const expanded = [];
  for (const candidate of candidates) {
    for (const filePath of [`${candidate}.1`, candidate]) {
      try {
        await access(filePath);
        expanded.push(filePath);
      } catch {
        // A rotated backup is optional.
      }
    }
  }
  return [...new Set(expanded)];
}

async function main() {
  const verbose = process.argv.includes("--verbose");
  const failOnArgument = process.argv
    .slice(2)
    .find((value) => value.startsWith("--fail-on="));
  const failOn = failOnArgument
    ? failOnArgument.slice("--fail-on=".length).toUpperCase()
    : null;
  if (failOn && !(failOn in SEVERITY_RANK)) {
    throw new Error("--fail-on must be one of: low, medium, high.");
  }
  const requestedPaths = process.argv
    .slice(2)
    .filter(
      (value) => value !== "--verbose" && !value.startsWith("--fail-on="),
    );
  const logPaths = await existingLogPaths(requestedPaths);
  if (logPaths.length === 0) {
    throw new Error(
      `No ShipFlow runtime log was found. Provide a path, for example: npm run diagnostics:log -- "/path/to/shipflow-desktop.log"`,
    );
  }
  const parsedLogs = await Promise.all(
    logPaths.map(async (logPath) => parseRuntimeLog(await readFile(logPath, "utf8"))),
  );
  const summary = summarizeRuntimeLogs(parsedLogs);
  const findings = runtimeRiskFindings(summary);

  console.log("ShipFlow Runtime Log Audit");
  console.log(`Files: ${logPaths.join(", ")}`);
  console.log(
    `Entries: ${summary.totals.entries} (Desktop ${summary.totals.desktopEntries}, Service ${summary.totals.nativeEntries}) | Sessions: ${summary.totals.sessions} | Warnings: ${summary.totals.warnings} | Errors: ${summary.totals.errors}`,
  );
  console.log(
    `Peak main RSS: ${formatBytes(summary.peaks.mainRssBytes)} | Peak Service RSS: ${formatBytes(summary.peaks.serviceRssBytes)} | Peak aggregate working set: ${formatBytes(summary.peaks.aggregateWorkingSetBytes)}`,
  );
  console.log(`Risk findings: ${findings.length}`);
  for (const finding of findings) {
    console.log(`- ${finding.severity} ${finding.event}: ${finding.count}`);
  }
  console.log(`Events: ${JSON.stringify(summary.eventCounts)}`);
  console.log(`Native events: ${JSON.stringify(summary.nativeEventCounts)}`);
  console.log(`Error scopes: ${JSON.stringify(summary.scopeErrorCounts)}`);

  if (verbose) {
    const diagnosticEntries = summary.entries
      .filter((entry) => entry.level === "WARN" || entry.level === "ERROR")
      .slice(-50);
    console.log("Recent warning/error entries:");
    for (const entry of diagnosticEntries) {
      console.log(
        `${entry.timestamp} ${entry.level} ${entry.scope} ${entry.event?.name ?? entry.message}`,
      );
    }
  }
  if (auditExceedsThreshold(findings, failOn)) {
    process.exitCode = 2;
  }
}

const currentScript = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (currentScript === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
