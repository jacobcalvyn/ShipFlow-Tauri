import { describe, expect, it, vi } from "vitest";
import {
  applicationLaunchRequestFromArgs,
  ApplicationLaunchQueue,
} from "./launch-request-queue";

describe("ApplicationLaunchQueue", () => {
  it("preserves a document path forwarded by a second application instance", () => {
    expect(
      applicationLaunchRequestFromArgs([
        "ShipFlow",
        "--background",
        "/tmp/demo.shipflow",
      ]),
    ).toEqual({
      kind: "document",
      documentPath: "/tmp/demo.shipflow",
    });
  });

  it("holds launch requests until the application is ready", async () => {
    const dispatch = vi.fn();
    const queue = new ApplicationLaunchQueue(dispatch);
    const request = { kind: "document", documentPath: "/tmp/demo.shipflow" } as const;

    queue.enqueue(request);
    expect(dispatch).not.toHaveBeenCalled();

    queue.markReady();
    await queue.whenIdle();
    expect(dispatch).toHaveBeenCalledWith(request);
  });

  it("deduplicates matching requests queued during startup", async () => {
    const dispatch = vi.fn();
    const queue = new ApplicationLaunchQueue(dispatch);
    const request = { kind: "document", documentPath: "/tmp/demo.shipflow" } as const;

    queue.enqueue(request);
    queue.enqueue(request);
    queue.markReady();
    await queue.whenIdle();

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("dispatches requests immediately after readiness", async () => {
    const dispatch = vi.fn();
    const queue = new ApplicationLaunchQueue(dispatch);
    queue.markReady();

    queue.enqueue({ kind: "service-settings" });
    await queue.whenIdle();

    expect(dispatch).toHaveBeenCalledWith({ kind: "service-settings" });
  });

  it("serializes multiple startup documents without overwriting their order", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const dispatched: string[] = [];
    const queue = new ApplicationLaunchQueue(async (request) => {
      if (request.kind !== "document") {
        return;
      }
      dispatched.push(request.documentPath);
      if (request.documentPath === "/tmp/first.shipflow") {
        await firstBlocked;
      }
    });

    queue.enqueue({ kind: "document", documentPath: "/tmp/first.shipflow" });
    queue.enqueue({ kind: "document", documentPath: "/tmp/second.shipflow" });
    queue.markReady();
    await Promise.resolve();
    await Promise.resolve();

    expect(dispatched).toEqual(["/tmp/first.shipflow"]);

    releaseFirst();
    await queue.whenIdle();
    expect(dispatched).toEqual([
      "/tmp/first.shipflow",
      "/tmp/second.shipflow",
    ]);
  });
});
