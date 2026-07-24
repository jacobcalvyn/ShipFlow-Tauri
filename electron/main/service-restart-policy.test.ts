import { describe, expect, it } from "vitest";
import {
  SERVICE_CRASH_WINDOW_MS,
  SERVICE_RESTART_DELAYS_MS,
  ServiceRestartPolicy,
} from "./service-restart-policy";

describe("ServiceRestartPolicy", () => {
  it("uses bounded exponential restart delays", () => {
    const policy = new ServiceRestartPolicy();
    const startedAt = 10_000;

    expect(
      SERVICE_RESTART_DELAYS_MS.map((_, index) =>
        policy.registerCrash(startedAt + index),
      ),
    ).toEqual(
      SERVICE_RESTART_DELAYS_MS.map((delayMs, index) => ({
        attempt: index + 1,
        delayMs,
      })),
    );
    expect(policy.registerCrash(startedAt + SERVICE_RESTART_DELAYS_MS.length)).toBeNull();
  });

  it("allows recovery after the crash window passes", () => {
    const policy = new ServiceRestartPolicy();
    for (let index = 0; index <= SERVICE_RESTART_DELAYS_MS.length; index += 1) {
      policy.registerCrash(index);
    }

    expect(policy.registerCrash(SERVICE_CRASH_WINDOW_MS + 10)).toEqual({
      attempt: 1,
      delayMs: SERVICE_RESTART_DELAYS_MS[0],
    });
  });

  it("resets after an intentional lifecycle change", () => {
    const policy = new ServiceRestartPolicy();
    policy.registerCrash(1);
    policy.registerCrash(2);
    policy.reset();

    expect(policy.registerCrash(3)).toEqual({
      attempt: 1,
      delayMs: SERVICE_RESTART_DELAYS_MS[0],
    });
  });
});
