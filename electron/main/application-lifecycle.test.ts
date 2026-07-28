import { describe, expect, it, vi } from "vitest";
import {
  ApplicationQuitCoordinator,
  shouldQuitAfterAllWindowsClosed,
  type QuitAwareWindow,
} from "./application-lifecycle";

function windowState(label: string, isDirty = true): QuitAwareWindow {
  return {
    label,
    isDirty,
    allowClose: false,
    closeRequestPending: false,
  };
}

describe("ApplicationQuitCoordinator", () => {
  it("finalizes immediately when no dirty window exists", async () => {
    const finalize = vi.fn();
    const coordinator = new ApplicationQuitCoordinator({
      windows: () => [windowState("clean", false)],
      requestDecision: vi.fn(),
      finalize,
    });

    coordinator.request("explicit_quit");
    await Promise.resolve();

    expect(finalize).toHaveBeenCalledWith("explicit_quit");
  });

  it("preserves the relaunch reason through dirty-window confirmation", async () => {
    const dirty = windowState("dirty");
    const finalize = vi.fn();
    const coordinator = new ApplicationQuitCoordinator({
      windows: () => [dirty],
      requestDecision: vi.fn(),
      finalize,
    });

    coordinator.request("relaunch");
    expect(finalize).not.toHaveBeenCalled();
    coordinator.resolve(dirty, "discard");
    await Promise.resolve();

    expect(finalize).toHaveBeenCalledWith("relaunch");
  });

  it("requests dirty-window decisions sequentially before finalizing", async () => {
    const first = windowState("first");
    const second = windowState("second");
    const requestDecision = vi.fn();
    const finalize = vi.fn();
    const coordinator = new ApplicationQuitCoordinator({
      windows: () => [first, second],
      requestDecision,
      finalize,
    });

    coordinator.request("update_restart");
    expect(requestDecision).toHaveBeenNthCalledWith(1, first);
    expect(second.closeRequestPending).toBe(false);

    expect(coordinator.resolve(first, "discard")).toBe(true);
    expect(requestDecision).toHaveBeenNthCalledWith(2, second);
    expect(finalize).not.toHaveBeenCalled();

    expect(coordinator.resolve(second, "discard")).toBe(true);
    await Promise.resolve();

    expect(finalize).toHaveBeenCalledWith("update_restart");
    expect(first.allowClose).toBe(true);
    expect(second.allowClose).toBe(true);
  });

  it("cancels the quit and restores previously resolved windows", async () => {
    const first = windowState("first");
    const second = windowState("second");
    const finalize = vi.fn();
    const coordinator = new ApplicationQuitCoordinator({
      windows: () => [first, second],
      requestDecision: vi.fn(),
      finalize,
    });

    coordinator.request("explicit_quit");
    coordinator.resolve(first, "discard");
    coordinator.resolve(second, "cancel");
    await Promise.resolve();

    expect(finalize).not.toHaveBeenCalled();
    expect(first.allowClose).toBe(false);
    expect(coordinator.isPending).toBe(false);
  });

  it("continues when a pending window is destroyed externally", async () => {
    const first = windowState("first");
    const second = windowState("second");
    const requestDecision = vi.fn();
    const finalize = vi.fn();
    const coordinator = new ApplicationQuitCoordinator({
      windows: () => [first, second],
      requestDecision,
      finalize,
    });

    coordinator.request("system_shutdown");
    coordinator.remove(first);
    expect(requestDecision).toHaveBeenLastCalledWith(second);
    coordinator.resolve(second, "discard");
    await Promise.resolve();

    expect(finalize).toHaveBeenCalledWith("system_shutdown");
  });
});

describe("shouldQuitAfterAllWindowsClosed", () => {
  it("keeps the background Service alive when tray lifecycle is enabled", () => {
    expect(shouldQuitAfterAllWindowsClosed(true)).toBe(false);
  });

  it("quits the suite when the last window closes and tray lifecycle is disabled", () => {
    expect(shouldQuitAfterAllWindowsClosed(false)).toBe(true);
  });
});
