import {
  mkdtemp,
  mkdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  inspectCrashDumps,
  summarizeProcessMetrics,
} from "./crash-diagnostics";

describe("crash diagnostics", () => {
  it("summarizes Electron process memory by process type", () => {
    expect(
      summarizeProcessMetrics([
        { type: "Browser", memory: { workingSetSize: 100 } },
        { type: "Tab", memory: { workingSetSize: 200 } },
        { type: "Tab", memory: { workingSetSize: 300 } },
        { type: "GPU", memory: { workingSetSize: 400 } },
      ]),
    ).toEqual({
      aggregateWorkingSetKb: 1_000,
      appProcessCount: 4,
      gpuWorkingSetKb: 400,
      processTypes: "Browser:1,GPU:1,Tab:2",
      rendererWorkingSetKb: 500,
    });
  });

  it("finds the newest local minidump without including unrelated files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "shipflow-crash-test-"));
    try {
      const pending = path.join(root, "pending");
      const older = path.join(root, "older.dmp");
      const newer = path.join(pending, "newer.dmp");
      await mkdir(pending);
      await writeFile(older, "old");
      await writeFile(newer, "newer");
      await writeFile(path.join(pending, "metadata.json"), "{}");
      await utimes(older, new Date(1_000), new Date(1_000));
      await utimes(newer, new Date(2_000), new Date(2_000));

      expect(await inspectCrashDumps(root)).toEqual({
        crashDumpCount: 2,
        latestCrashDumpBytes: 5,
        latestCrashDumpName: path.join("pending", "newer.dmp"),
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
