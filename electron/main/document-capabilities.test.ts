import path from "node:path";
import { describe, expect, it } from "vitest";
import { DocumentPathCapabilities } from "./document-capabilities";

describe("workspace document path capabilities", () => {
  it("only permits paths explicitly granted by a native selection", () => {
    const allowedPath = path.resolve("allowed.shipflow");
    const deniedPath = path.resolve("denied.shipflow");
    const capabilities = new DocumentPathCapabilities();

    expect(() => capabilities.require(allowedPath)).toThrow(/not authorized/i);
    expect(capabilities.authorize(allowedPath)).toBe(allowedPath);
    expect(capabilities.require(allowedPath)).toBe(allowedPath);
    expect(() => capabilities.require(deniedPath)).toThrow(/not authorized/i);
  });
});
