import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const STATE_VERSION = 1;
const DEFAULT_CRASH_THRESHOLD = 2;
const DEFAULT_CRASH_WINDOW_MS = 10 * 60_000;
const DEFAULT_CRASH_REPORT_WINDOW_MS = 24 * 60 * 60_000;

export type RendererSafeModeState = {
  version: typeof STATE_VERSION;
  accessViolationTimestampsMs: number[];
  hardwareAccelerationDisabled: boolean;
  lastExitCode: number | null;
  updatedAtMs: number;
};

export type RendererSafeModeUpdate = {
  activated: boolean;
  crashCount: number;
  state: RendererSafeModeState;
};

export function defaultRendererSafeModeState(
  now = Date.now(),
): RendererSafeModeState {
  return {
    version: STATE_VERSION,
    accessViolationTimestampsMs: [],
    hardwareAccelerationDisabled: false,
    lastExitCode: null,
    updatedAtMs: now,
  };
}

export function isWindowsAccessViolationExitCode(exitCode: number) {
  return exitCode === -1_073_741_819 || exitCode === 3_221_225_477;
}

export function loadRendererSafeModeState(
  filePath: string,
  now = Date.now(),
): RendererSafeModeState {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<
      RendererSafeModeState
    >;
    if (
      parsed.version !== STATE_VERSION ||
      !Array.isArray(parsed.accessViolationTimestampsMs) ||
      typeof parsed.hardwareAccelerationDisabled !== "boolean"
    ) {
      return defaultRendererSafeModeState(now);
    }
    return {
      version: STATE_VERSION,
      accessViolationTimestampsMs:
        parsed.accessViolationTimestampsMs.filter(
          (timestamp) =>
            typeof timestamp === "number" && Number.isFinite(timestamp),
        ),
      hardwareAccelerationDisabled: parsed.hardwareAccelerationDisabled,
      lastExitCode:
        typeof parsed.lastExitCode === "number" &&
        Number.isFinite(parsed.lastExitCode)
          ? parsed.lastExitCode
          : null,
      updatedAtMs:
        typeof parsed.updatedAtMs === "number" &&
        Number.isFinite(parsed.updatedAtMs)
          ? parsed.updatedAtMs
          : now,
    };
  } catch {
    return defaultRendererSafeModeState(now);
  }
}

export function persistRendererSafeModeState(
  filePath: string,
  state: RendererSafeModeState,
) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function hasRecentCrashReports(
  crashDumpsPath: string,
  now = Date.now(),
  minimumReports = DEFAULT_CRASH_THRESHOLD,
  reportWindowMs = DEFAULT_CRASH_REPORT_WINDOW_MS,
) {
  try {
    const reportsPath = path.join(crashDumpsPath, "reports");
    let recentReportCount = 0;
    for (const entry of readdirSync(reportsPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".dmp")) {
        continue;
      }
      const modifiedAtMs = statSync(path.join(reportsPath, entry.name)).mtimeMs;
      const ageMs = now - modifiedAtMs;
      if (ageMs >= -60_000 && ageMs < reportWindowMs) {
        recentReportCount += 1;
        if (recentReportCount >= minimumReports) {
          return true;
        }
      }
    }
  } catch {
    // A missing or unreadable Crashpad directory means no bootstrap evidence.
  }
  return false;
}

export function activateRendererSafeMode(
  currentState: RendererSafeModeState,
  now = Date.now(),
): RendererSafeModeState {
  return {
    ...currentState,
    hardwareAccelerationDisabled: true,
    updatedAtMs: now,
  };
}

export function registerRendererAccessViolation(
  currentState: RendererSafeModeState,
  exitCode: number,
  now = Date.now(),
  crashThreshold = DEFAULT_CRASH_THRESHOLD,
  crashWindowMs = DEFAULT_CRASH_WINDOW_MS,
): RendererSafeModeUpdate {
  if (!isWindowsAccessViolationExitCode(exitCode)) {
    return {
      activated: false,
      crashCount: currentState.accessViolationTimestampsMs.length,
      state: currentState,
    };
  }
  const recentCrashes = currentState.accessViolationTimestampsMs
    .filter((timestamp) => now - timestamp >= 0 && now - timestamp < crashWindowMs)
    .concat(now);
  const activated =
    !currentState.hardwareAccelerationDisabled &&
    recentCrashes.length >= crashThreshold;
  return {
    activated,
    crashCount: recentCrashes.length,
    state: {
      version: STATE_VERSION,
      accessViolationTimestampsMs: recentCrashes,
      hardwareAccelerationDisabled:
        currentState.hardwareAccelerationDisabled || activated,
      lastExitCode: exitCode,
      updatedAtMs: now,
    },
  };
}

export function resetRendererSafeModeState(now = Date.now()) {
  return defaultRendererSafeModeState(now);
}

export function shouldDisableHardwareAcceleration(
  platform: NodeJS.Platform,
  state: RendererSafeModeState,
  environmentValue = process.env.SHIPFLOW_DISABLE_HARDWARE_ACCELERATION,
) {
  return (
    platform === "win32" &&
    (state.hardwareAccelerationDisabled ||
      environmentValue?.trim().toLowerCase() === "true" ||
      environmentValue?.trim() === "1")
  );
}
