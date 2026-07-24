import { describe, expect, it } from "vitest";
import { isTrustedRendererNavigation } from "./renderer-navigation";

describe("isTrustedRendererNavigation", () => {
  it("allows the packaged renderer file with a query string", () => {
    expect(
      isTrustedRendererNavigation(
        "file:///Applications/ShipFlow%20Desktop.app/Contents/Resources/app.asar/out/renderer/index.html?windowKind=workspace",
        undefined,
        "/Applications/ShipFlow Desktop.app/Contents/Resources/app.asar/out/renderer/index.html",
      ),
    ).toBe(true);
  });

  it("rejects a different packaged file", () => {
    expect(
      isTrustedRendererNavigation(
        "file:///tmp/untrusted.html",
        undefined,
        "/Applications/ShipFlow Desktop.app/Contents/Resources/app.asar/out/renderer/index.html",
      ),
    ).toBe(false);
  });

  it("allows the configured development renderer path only", () => {
    expect(
      isTrustedRendererNavigation(
        "http://127.0.0.1:5173/?windowKind=workspace",
        "http://127.0.0.1:5173/",
        "/unused/index.html",
      ),
    ).toBe(true);
    expect(
      isTrustedRendererNavigation(
        "http://127.0.0.1:5173/admin",
        "http://127.0.0.1:5173/",
        "/unused/index.html",
      ),
    ).toBe(false);
  });
});
