#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

const QUALITY_WORKFLOW = "quality.yml";
const DEFAULT_API_URL = "https://api.github.com";

function requireValue(value, name) {
  if (!value?.trim()) {
    throw new Error(`${name} is required to verify the Quality Gate.`);
  }
  return value.trim();
}

export function findSuccessfulQualityRun(runs, commitSha) {
  return runs.find(
    (run) =>
      run.head_sha === commitSha &&
      run.status === "completed" &&
      run.conclusion === "success"
  );
}

export async function verifyQualityGate({
  repository,
  commitSha,
  token,
  apiUrl = DEFAULT_API_URL,
  fetchImpl = fetch,
}) {
  const resolvedRepository = requireValue(repository, "GITHUB_REPOSITORY");
  const resolvedCommitSha = requireValue(commitSha, "GITHUB_SHA");
  const resolvedToken = requireValue(token, "GITHUB_TOKEN");
  const url = new URL(
    `/repos/${resolvedRepository}/actions/workflows/${QUALITY_WORKFLOW}/runs`,
    apiUrl
  );
  url.searchParams.set("head_sha", resolvedCommitSha);
  url.searchParams.set("status", "completed");
  url.searchParams.set("per_page", "20");

  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${resolvedToken}`,
      "User-Agent": "shipflow-quality-gate-verifier",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    const details = (await response.text()).trim();
    throw new Error(
      `GitHub Actions API returned ${response.status}${details ? `: ${details}` : "."}`
    );
  }

  const payload = await response.json();
  const runs = Array.isArray(payload.workflow_runs) ? payload.workflow_runs : [];
  const successfulRun = findSuccessfulQualityRun(runs, resolvedCommitSha);
  if (!successfulRun) {
    const conclusions = runs.length
      ? runs.map((run) => `${run.status}/${run.conclusion ?? "pending"}`).join(", ")
      : "no completed runs";
    throw new Error(
      `Quality Gate has not passed for commit ${resolvedCommitSha} (${conclusions}).`
    );
  }

  return successfulRun;
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
      apiUrl: process.env.GITHUB_API_URL,
    });
    console.log(`Quality Gate passed: ${run.html_url ?? run.id}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
