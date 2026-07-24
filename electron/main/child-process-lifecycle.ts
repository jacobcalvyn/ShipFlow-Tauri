import type { ChildProcess } from "node:child_process";

const DEFAULT_GRACEFUL_TIMEOUT_MS = 3_000;
const DEFAULT_FORCE_TIMEOUT_MS = 2_000;

export type ChildProcessTermination =
  | {
      kind: "error";
      error: Error;
    }
  | {
      kind: "exit";
      code: number | null;
      signal: NodeJS.Signals | null;
    };

export function observeChildProcessTermination(
  child: ChildProcess,
  listener: (termination: ChildProcessTermination) => void,
) {
  let handled = false;
  const finish = (termination: ChildProcessTermination) => {
    if (handled) {
      return;
    }
    handled = true;
    child.off("error", handleError);
    child.off("exit", handleExit);
    listener(termination);
  };
  const handleError = (error: Error) => finish({ kind: "error", error });
  const handleExit = (code: number | null, signal: NodeJS.Signals | null) =>
    finish({ kind: "exit", code, signal });

  child.once("error", handleError);
  child.once("exit", handleExit);

  return () => {
    handled = true;
    child.off("error", handleError);
    child.off("exit", handleExit);
  };
}

export function childProcessHasExited(child: ChildProcess) {
  return child.exitCode !== null || child.signalCode !== null;
}

export function waitForChildProcessExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (childProcessHasExited(child)) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.off("exit", handleExit);
      resolve(exited);
    };
    const handleExit = () => finish(true);
    const timeout = setTimeout(() => finish(childProcessHasExited(child)), timeoutMs);
    child.once("exit", handleExit);
  });
}

export async function terminateChildProcess(
  child: ChildProcess,
  options: {
    gracefulTimeoutMs?: number;
    forceTimeoutMs?: number;
  } = {},
) {
  if (childProcessHasExited(child)) {
    return true;
  }

  try {
    child.kill();
  } catch {
    // The process may have exited between the state check and the signal.
  }
  if (
    await waitForChildProcessExit(
      child,
      options.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS,
    )
  ) {
    return true;
  }

  try {
    child.kill("SIGKILL");
  } catch {
    // Windows maps kill to process termination and may already have exited.
  }
  return waitForChildProcessExit(
    child,
    options.forceTimeoutMs ?? DEFAULT_FORCE_TIMEOUT_MS,
  );
}
