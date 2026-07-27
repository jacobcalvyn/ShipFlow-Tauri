import { describe, expect, it } from "vitest";
import {
  isRecoverableRendererExit,
  RendererRecoveryPolicy,
} from "./renderer-recovery";

describe("RendererRecoveryPolicy", () => {
  it("does not recover an intentional clean renderer exit", () => {
    expect(isRecoverableRendererExit("clean-exit")).toBe(false);
    expect(isRecoverableRendererExit("crashed")).toBe(true);
  });

  it("bounds crash-loop recovery attempts", () => {
    const policy = new RendererRecoveryPolicy(2, 1_000);

    expect(policy.registerAttempt(100)).toBe(true);
    expect(policy.registerAttempt(200)).toBe(true);
    expect(policy.registerAttempt(300)).toBe(false);
    expect(policy.registerAttempt(1_200)).toBe(true);
  });
});
