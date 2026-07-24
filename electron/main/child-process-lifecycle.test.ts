import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  childProcessHasExited,
  observeChildProcessTermination,
  terminateChildProcess,
  waitForChildProcessExit,
} from "./child-process-lifecycle";

describe("child process lifecycle", () => {
  const children = new Set<ChildProcess>();

  afterEach(async () => {
    await Promise.all(
      [...children].map(async (child) => {
        await terminateChildProcess(child, {
          gracefulTimeoutMs: 250,
          forceTimeoutMs: 500,
        });
      }),
    );
    children.clear();
  });

  it("waits for a real child exit", async () => {
    const child = spawn(process.execPath, [
      "-e",
      "setTimeout(() => process.exit(0), 25)",
    ]);
    children.add(child);

    await expect(waitForChildProcessExit(child, 1_000)).resolves.toBe(true);
    expect(childProcessHasExited(child)).toBe(true);
  });

  it("reports a bounded wait timeout without losing process ownership", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    children.add(child);

    await expect(waitForChildProcessExit(child, 25)).resolves.toBe(false);
    expect(childProcessHasExited(child)).toBe(false);
  });

  it("terminates a running child before returning", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    children.add(child);

    await expect(
      terminateChildProcess(child, {
        gracefulTimeoutMs: 1_000,
        forceTimeoutMs: 1_000,
      }),
    ).resolves.toBe(true);
    expect(childProcessHasExited(child)).toBe(true);
  });

  it("observes a spawn error before asynchronous startup work can yield", async () => {
    const child = spawn(
      `${process.execPath}-missing-${Date.now()}`,
      [],
    );
    children.add(child);

    await expect(
      new Promise<string>((resolve) => {
        observeChildProcessTermination(child, (termination) => {
          resolve(termination.kind);
        });
      }),
    ).resolves.toBe("error");
  });

  it("reports only the first terminal child event", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(7)"]);
    children.add(child);
    const terminations: string[] = [];

    await new Promise<void>((resolve) => {
      observeChildProcessTermination(child, (termination) => {
        terminations.push(
          termination.kind === "exit" ? `exit:${termination.code}` : "error",
        );
        resolve();
      });
    });

    expect(terminations).toEqual(["exit:7"]);
  });
});
