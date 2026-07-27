import { describe, expect, it, vi } from "vitest";
import { SingleFlight } from "./single-flight";

describe("SingleFlight", () => {
  it("shares one in-flight operation across concurrent callers", async () => {
    let resolveOperation!: (value: string) => void;
    const operation = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveOperation = resolve;
        }),
    );
    const singleFlight = new SingleFlight<string>();

    const first = singleFlight.run(operation);
    const second = singleFlight.run(operation);
    await Promise.resolve();

    expect(operation).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);

    resolveOperation("ready");
    await expect(first).resolves.toBe("ready");
  });

  it("allows a new operation after the active operation settles", async () => {
    const operation = vi.fn(async () => "ready");
    const singleFlight = new SingleFlight<string>();

    await singleFlight.run(operation);
    await Promise.resolve();
    await singleFlight.run(operation);

    expect(operation).toHaveBeenCalledTimes(2);
  });
});
