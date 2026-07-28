import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activateRendererSafeMode,
  defaultRendererSafeModeState,
  hasRecentCrashReports,
  isWindowsAccessViolationExitCode,
  loadRendererSafeModeState,
  persistRendererSafeModeState,
  registerRendererAccessViolation,
  resetRendererSafeModeState,
  shouldDisableHardwareAcceleration,
  shouldStopAutomaticRendererRecovery,
} from "./renderer-safe-mode";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("renderer safe mode", () => {
  it("recognizes signed and unsigned Windows access violation exit codes", () => {
    expect(isWindowsAccessViolationExitCode(-1_073_741_819)).toBe(true);
    expect(isWindowsAccessViolationExitCode(3_221_225_477)).toBe(true);
    expect(isWindowsAccessViolationExitCode(1)).toBe(false);
  });

  it("activates after two access violations inside the crash window", () => {
    const initial = defaultRendererSafeModeState(100);
    const first = registerRendererAccessViolation(initial, -1_073_741_819, 200);
    const second = registerRendererAccessViolation(
      first.state,
      -1_073_741_819,
      300,
    );

    expect(first.activated).toBe(false);
    expect(first.crashCount).toBe(1);
    expect(second.activated).toBe(true);
    expect(second.crashCount).toBe(2);
    expect(second.state.hardwareAccelerationDisabled).toBe(true);
  });

  it("does not count unrelated exits or stale access violations", () => {
    const initial = defaultRendererSafeModeState(100);
    const unrelated = registerRendererAccessViolation(initial, 1, 200);
    const stale = registerRendererAccessViolation(
      {
        ...initial,
        accessViolationTimestampsMs: [100],
      },
      -1_073_741_819,
      1_101,
      2,
      1_000,
    );

    expect(unrelated.state).toBe(initial);
    expect(stale.crashCount).toBe(1);
    expect(stale.activated).toBe(false);
  });

  it("persists compatibility mode and only applies it to Windows", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "shipflow-safe-mode-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "renderer-safe-mode.json");
    const state = {
      ...defaultRendererSafeModeState(100),
      hardwareAccelerationDisabled: true,
    };

    persistRendererSafeModeState(filePath, state);
    const loaded = loadRendererSafeModeState(filePath, 200);

    expect(loaded.hardwareAccelerationDisabled).toBe(true);
    expect(shouldDisableHardwareAcceleration("win32", loaded)).toBe(true);
    expect(shouldDisableHardwareAcceleration("darwin", loaded)).toBe(false);
    expect(
      shouldDisableHardwareAcceleration(
        "win32",
        resetRendererSafeModeState(300),
        "1",
      ),
    ).toBe(true);
  });

  it("stops automatic recovery when compatibility mode also crashes", () => {
    const activeState = activateRendererSafeMode(
      defaultRendererSafeModeState(1_000),
      1_000,
    );

    expect(
      shouldStopAutomaticRendererRecovery(
        "win32",
        activeState,
        -1_073_741_819,
      ),
    ).toBe(true);
    expect(
      shouldStopAutomaticRendererRecovery("win32", activeState, 1),
    ).toBe(false);
    expect(
      shouldStopAutomaticRendererRecovery(
        "darwin",
        activeState,
        -1_073_741_819,
      ),
    ).toBe(false);
  });

  it("bootstraps compatibility mode from multiple recent Crashpad reports", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "shipflow-crashpad-"));
    temporaryDirectories.push(directory);
    const reportsPath = path.join(directory, "reports");
    mkdirSync(reportsPath);
    writeFileSync(path.join(reportsPath, "first.dmp"), "first");
    writeFileSync(path.join(reportsPath, "second.dmp"), "second");

    expect(hasRecentCrashReports(directory)).toBe(true);
    expect(
      activateRendererSafeMode(defaultRendererSafeModeState())
        .hardwareAccelerationDisabled,
    ).toBe(true);
  });
});
