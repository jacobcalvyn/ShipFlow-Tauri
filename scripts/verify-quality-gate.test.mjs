import { describe, expect, it, vi } from "vitest";

import {
  findLatestRelevantQualityRun,
  findSuccessfulQualityRun,
  verifyQualityGate,
} from "./verify-quality-gate.mjs";

const commitSha = "71b5814adc1efa54c88b95f5547072c510a21906";
const qualityEvent = "push";

function qualityRun(overrides = {}) {
  return {
    id: 1,
    run_number: 1,
    run_attempt: 1,
    event: qualityEvent,
    head_sha: commitSha,
    status: "completed",
    conclusion: "success",
    ...overrides,
  };
}

describe("verify-quality-gate", () => {
  it("selects only the latest successful run for the requested commit and event", () => {
    const success = qualityRun({ id: 3, run_number: 3 });

    expect(
      findSuccessfulQualityRun(
        [
          { ...success, id: 1, head_sha: "another-commit" },
          { ...success, id: 2, event: "pull_request" },
          success,
        ],
        commitSha,
        qualityEvent,
      ),
    ).toBe(success);
  });

  it("does not accept an older success when the latest run failed", () => {
    const olderSuccess = qualityRun({ id: 10, run_number: 10 });
    const latestFailure = qualityRun({
      id: 11,
      run_number: 11,
      conclusion: "failure",
    });

    expect(
      findLatestRelevantQualityRun(
        [olderSuccess, latestFailure],
        commitSha,
        qualityEvent,
      ),
    ).toBe(latestFailure);
    expect(
      findSuccessfulQualityRun(
        [olderSuccess, latestFailure],
        commitSha,
        qualityEvent,
      ),
    ).toBeUndefined();
  });

  it("queries the quality workflow for the exact commit", async () => {
    const run = qualityRun({
      id: 29554841319,
      run_number: 28,
      html_url: "https://github.com/example/shipflow/actions/runs/29554841319",
    });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ workflow_runs: [run] }),
    });

    await expect(
      verifyQualityGate({
        repository: "example/shipflow",
        commitSha,
        token: "test-token",
        qualityEvent,
        fetchImpl,
      }),
    ).resolves.toBe(run);

    const [url, options] = fetchImpl.mock.calls[0];
    expect(url.pathname).toBe(
      "/repos/example/shipflow/actions/workflows/quality.yml/runs"
    );
    expect(url.searchParams.get("head_sha")).toBe(commitSha);
    expect(url.searchParams.get("event")).toBe(qualityEvent);
    expect(url.searchParams.has("status")).toBe(false);
    expect(options.headers.Authorization).toBe("Bearer test-token");
  });

  it("waits for an unregistered or active run until it succeeds", async () => {
    const success = qualityRun({
      id: 4,
      run_number: 4,
      html_url: "https://github.com/example/shipflow/actions/runs/4",
    });
    const responses = [
      [],
      [
        qualityRun({
          id: 2,
          run_number: 2,
          status: "queued",
          conclusion: null,
        }),
      ],
      [
        qualityRun({
          id: 3,
          run_number: 3,
          status: "in_progress",
          conclusion: null,
        }),
      ],
      [success],
    ];
    const fetchImpl = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ workflow_runs: responses.shift() }),
    }));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const onWait = vi.fn();

    await expect(
      verifyQualityGate({
        repository: "example/shipflow",
        commitSha,
        token: "test-token",
        qualityEvent,
        fetchImpl,
        sleepImpl,
        pollIntervalMs: 10,
        timeoutMs: 50,
        onWait,
      }),
    ).resolves.toBe(success);

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleepImpl).toHaveBeenCalledTimes(3);
    expect(sleepImpl).toHaveBeenCalledWith(10);
    expect(onWait).toHaveBeenCalledTimes(3);
  });

  it("waits for the latest active run instead of accepting an older success", async () => {
    const olderSuccess = qualityRun({ id: 20, run_number: 20 });
    const latestQueued = qualityRun({
      id: 21,
      run_number: 21,
      status: "queued",
      conclusion: null,
    });
    const latestSuccess = { ...latestQueued, status: "completed", conclusion: "success" };
    const responses = [
      [olderSuccess, latestQueued],
      [olderSuccess, latestSuccess],
    ];
    const fetchImpl = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ workflow_runs: responses.shift() }),
    }));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    await expect(
      verifyQualityGate({
        repository: "example/shipflow",
        commitSha,
        token: "test-token",
        qualityEvent,
        fetchImpl,
        sleepImpl,
        pollIntervalMs: 10,
        timeoutMs: 20,
      }),
    ).resolves.toEqual(latestSuccess);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledOnce();
  });

  it("fails immediately when the latest state is terminal failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        workflow_runs: [
          qualityRun({
            conclusion: "failure",
          }),
        ],
      }),
    });
    const sleepImpl = vi.fn();

    await expect(
      verifyQualityGate({
        repository: "example/shipflow",
        commitSha,
        token: "test-token",
        qualityEvent,
        fetchImpl,
        sleepImpl,
      }),
    ).rejects.toThrow(
      `Latest Quality Gate ${qualityEvent} run failed for commit ${commitSha}`,
    );

    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it("retries transient network and HTTP failures", async () => {
    const success = qualityRun({ id: 30, run_number: 30 });
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket reset"))
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        text: async () => "Bad Gateway",
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ workflow_runs: [success] }),
      });
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    await expect(
      verifyQualityGate({
        repository: "example/shipflow",
        commitSha,
        token: "test-token",
        qualityEvent,
        fetchImpl,
        sleepImpl,
        pollIntervalMs: 10,
        timeoutMs: 30,
      }),
    ).resolves.toBe(success);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleepImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-transient GitHub API failures", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "Resource not accessible by integration",
    });
    const sleepImpl = vi.fn();

    await expect(
      verifyQualityGate({
        repository: "example/shipflow",
        commitSha,
        token: "test-token",
        qualityEvent,
        fetchImpl,
        sleepImpl,
      }),
    ).rejects.toThrow("GitHub Actions API returned 403");

    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it("times out when the Quality Gate never starts", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ workflow_runs: [] }),
    });
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    await expect(
      verifyQualityGate({
        repository: "example/shipflow",
        commitSha,
        token: "test-token",
        qualityEvent,
        fetchImpl,
        sleepImpl,
        pollIntervalMs: 10,
        timeoutMs: 20,
      }),
    ).rejects.toThrow(
      `Timed out after 20ms waiting for Quality Gate on commit ${commitSha}`,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleepImpl).toHaveBeenCalledTimes(2);
  });
});
