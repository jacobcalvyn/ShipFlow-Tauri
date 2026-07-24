import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readStreamLimited } from "./pod-preview";

describe("POD preview response limits", () => {
  it("assembles a response without buffering beyond the configured limit", async () => {
    const response = Readable.from([Buffer.from("ship"), Buffer.from("flow")]);

    await expect(readStreamLimited(response, 8)).resolves.toEqual(
      Buffer.from("shipflow"),
    );
  });

  it("rejects as soon as streamed response data exceeds the configured limit", async () => {
    const response = Readable.from([Buffer.alloc(4), Buffer.alloc(5)]);

    await expect(readStreamLimited(response, 8)).rejects.toThrow(/too large/i);
  });
});
