import { describe, expect, it, vi } from "vitest";

import {
  findSuccessfulQualityRun,
  verifyQualityGate,
} from "./verify-quality-gate.mjs";

const commitSha = "71b5814adc1efa54c88b95f5547072c510a21906";

describe("verify-quality-gate", () => {
  it("selects only a completed successful run for the requested commit", () => {
    const success = {
      id: 3,
      head_sha: commitSha,
      status: "completed",
      conclusion: "success",
    };

    expect(
      findSuccessfulQualityRun(
        [
          { ...success, id: 1, head_sha: "another-commit" },
          { ...success, id: 2, conclusion: "failure" },
          success,
        ],
        commitSha
      )
    ).toBe(success);
  });

  it("queries the quality workflow for the exact commit", async () => {
    const run = {
      id: 29554841319,
      html_url: "https://github.com/example/shipflow/actions/runs/29554841319",
      head_sha: commitSha,
      status: "completed",
      conclusion: "success",
    };
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ workflow_runs: [run] }),
    });

    await expect(
      verifyQualityGate({
        repository: "example/shipflow",
        commitSha,
        token: "test-token",
        fetchImpl,
      })
    ).resolves.toBe(run);

    const [url, options] = fetchImpl.mock.calls[0];
    expect(url.pathname).toBe(
      "/repos/example/shipflow/actions/workflows/quality.yml/runs"
    );
    expect(url.searchParams.get("head_sha")).toBe(commitSha);
    expect(url.searchParams.get("status")).toBe("completed");
    expect(options.headers.Authorization).toBe("Bearer test-token");
  });

  it("fails when the commit has no successful Quality Gate", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        workflow_runs: [
          {
            head_sha: commitSha,
            status: "completed",
            conclusion: "failure",
          },
        ],
      }),
    });

    await expect(
      verifyQualityGate({
        repository: "example/shipflow",
        commitSha,
        token: "test-token",
        fetchImpl,
      })
    ).rejects.toThrow(`Quality Gate has not passed for commit ${commitSha}`);
  });
});
