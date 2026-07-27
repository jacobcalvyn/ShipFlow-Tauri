import { describe, expect, it } from "vitest";
import { buildViewMenu } from "./application-menu";

describe("buildViewMenu", () => {
  it("does not expose reload or DevTools in packaged builds", () => {
    const roles = buildViewMenu(true).map((item) => item.role);

    expect(roles).not.toContain("reload");
    expect(roles).not.toContain("toggleDevTools");
  });

  it("keeps development diagnostics in unpackaged builds", () => {
    const roles = buildViewMenu(false).map((item) => item.role);

    expect(roles).toContain("reload");
    expect(roles).toContain("toggleDevTools");
  });
});
