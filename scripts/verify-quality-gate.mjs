#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

const QUALITY_WORKFLOW = "quality.yml";
const DEFAULT_API_URL = "https://api.github.com";
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 40 * 60_000;
const DEFAULT_QUALITY_EVENT = "push";
const ACTIVE_RUN_STATUSES = new Set([
  "queued",
  "in_progress",
  "requested",
  "waiting",
  "pending",
]);
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function requireValue(value, name) {
  if (!value?.trim()) {
    throw new Error(`${name} is required to verify the Quality Gate.`);
  }
  return value.trim();
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function readPositiveInteger(value, fallback, name) {
  if (!value?.trim()) {
    return fallback;
  }
  return requirePositiveInteger(Number(value), name);
}

function describeRuns(runs) {
  return runs.length
    ? runs
        .map(
          (run) =>
            `#${run.run_number ?? run.id ?? "unknown"} ` +
            `${run.event ?? "unknown-event"} ` +
            `${run.status ?? "unknown"}/${run.conclusion ?? "pending"}`,
        )
        .join(", ")
    : "no runs";
}

function compareQualityRuns(left, right) {
  const runNumberDifference =
    Number(right.run_number ?? 0) - Number(left.run_number ?? 0);
  if (runNumberDifference !== 0) {
    return runNumberDifference;
  }

  const attemptDifference =
    Number(right.run_attempt ?? 0) - Number(left.run_attempt ?? 0);
  if (attemptDifference !== 0) {
    return attemptDifference;
  }

  const createdAtDifference =
    Date.parse(right.created_at ?? "") - Date.parse(left.created_at ?? "");
  if (Number.isFinite(createdAtDifference) && createdAtDifference !== 0) {
    return createdAtDifference;
  }

  return Number(right.id ?? 0) - Number(left.id ?? 0);
}

export function findLatestRelevantQualityRun(
  runs,
  commitSha,
  qualityEvent = DEFAULT_QUALITY_EVENT,
) {
  return runs
    .filter(
      (run) =>
        run.head_sha === commitSha &&
        run.event === qualityEvent,
    )
    .sort(compareQualityRuns)[0];
}

export function findSuccessfulQualityRun(
  runs,
  commitSha,
  qualityEvent = DEFAULT_QUALITY_EVENT,
) {
  const latestRun = findLatestRelevantQualityRun(
    runs,
    commitSha,
    qualityEvent,
  );
  return latestRun?.status === "completed" &&
    latestRun.conclusion === "success"
    ? latestRun
    : undefined;
}

async function readResponseDetails(response) {
  if (typeof response.text !== "function") {
    return "";
  }
  return (await response.text()).trim();
}

export async function verifyQualityGate({
  repository,
  commitSha,
  token,
  qualityEvent = DEFAULT_QUALITY_EVENT,
  apiUrl = DEFAULT_API_URL,
  fetchImpl = fetch,
  sleepImpl = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onWait = () => {},
}) {
  const resolvedRepository = requireValue(repository, "GITHUB_REPOSITORY");
  const resolvedCommitSha = requireValue(commitSha, "GITHUB_SHA");
  const resolvedToken = requireValue(token, "GITHUB_TOKEN");
  const resolvedQualityEvent = requireValue(
    qualityEvent,
    "QUALITY_GATE_EVENT",
  );
  const resolvedPollIntervalMs = requirePositiveInteger(
    pollIntervalMs,
    "pollIntervalMs"
  );
  const resolvedTimeoutMs = requirePositiveInteger(timeoutMs, "timeoutMs");
  const url = new URL(
    `/repos/${resolvedRepository}/actions/workflows/${QUALITY_WORKFLOW}/runs`,
    apiUrl
  );
  url.searchParams.set("head_sha", resolvedCommitSha);
  url.searchParams.set("event", resolvedQualityEvent);
  url.searchParams.set("per_page", "20");

  let elapsedMs = 0;
  const waitForNextPoll = async (description) => {
    if (elapsedMs >= resolvedTimeoutMs) {
      throw new Error(
        `Timed out after ${resolvedTimeoutMs}ms waiting for Quality Gate on commit ${resolvedCommitSha} (${description}).`,
      );
    }

    const waitMs = Math.min(
      resolvedPollIntervalMs,
      resolvedTimeoutMs - elapsedMs,
    );
    onWait(
      `Waiting ${waitMs}ms for Quality Gate on commit ${resolvedCommitSha} (${description}).`,
    );
    await sleepImpl(waitMs);
    elapsedMs += waitMs;
  };

  while (true) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${resolvedToken}`,
          "User-Agent": "shipflow-quality-gate-verifier",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
    } catch (error) {
      await waitForNextPoll(
        `transient GitHub API error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }

    if (!response.ok) {
      const details = await readResponseDetails(response);
      if (TRANSIENT_HTTP_STATUSES.has(response.status)) {
        await waitForNextPoll(
          `transient GitHub API HTTP ${response.status}${
            details ? `: ${details}` : ""
          }`,
        );
        continue;
      }
      throw new Error(
        `GitHub Actions API returned ${response.status}${details ? `: ${details}` : "."}`,
      );
    }

    const payload = await response.json();
    const runs = Array.isArray(payload.workflow_runs)
      ? payload.workflow_runs
      : [];
    const latestRun = findLatestRelevantQualityRun(
      runs,
      resolvedCommitSha,
      resolvedQualityEvent,
    );
    if (
      latestRun?.status === "completed" &&
      latestRun.conclusion === "success"
    ) {
      return latestRun;
    }

    if (latestRun?.status === "completed") {
      throw new Error(
        `Latest Quality Gate ${resolvedQualityEvent} run failed for commit ${resolvedCommitSha} (${describeRuns([latestRun])}).`,
      );
    }

    const relevantRuns = latestRun ? [latestRun] : [];
    const description =
      latestRun && ACTIVE_RUN_STATUSES.has(latestRun.status)
        ? describeRuns(relevantRuns)
        : `${describeRuns(relevantRuns)} for event ${resolvedQualityEvent}`;
    await waitForNextPoll(description);
  }
}

const isMainModule =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMainModule) {
  try {
    const run = await verifyQualityGate({
      repository: process.env.GITHUB_REPOSITORY,
      commitSha: process.env.GITHUB_SHA,
      token: process.env.GITHUB_TOKEN,
      qualityEvent:
        process.env.QUALITY_GATE_EVENT ?? DEFAULT_QUALITY_EVENT,
      apiUrl: process.env.GITHUB_API_URL,
      pollIntervalMs: readPositiveInteger(
        process.env.QUALITY_GATE_POLL_INTERVAL_MS,
        DEFAULT_POLL_INTERVAL_MS,
        "QUALITY_GATE_POLL_INTERVAL_MS"
      ),
      timeoutMs: readPositiveInteger(
        process.env.QUALITY_GATE_TIMEOUT_MS,
        DEFAULT_TIMEOUT_MS,
        "QUALITY_GATE_TIMEOUT_MS"
      ),
      onWait: (message) => console.log(message),
    });
    console.log(`Quality Gate passed: ${run.html_url ?? run.id}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
