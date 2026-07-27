import { describe, expect, it } from "vitest";
import { appUpdateStatus } from "./app-update";

describe("appUpdateStatus", () => {
  it("uses the updater availability decision instead of comparing versions", () => {
    expect(
      appUpdateStatus(
        {
          isUpdateAvailable: false,
          updateInfo: { version: "99.0.0" },
        },
        "1.0.0",
      ),
    ).toMatchObject({
      available: false,
      version: null,
    });
    expect(
      appUpdateStatus(
        {
          isUpdateAvailable: true,
          updateInfo: { version: "1.0.0" },
        },
        "1.0.0",
      ),
    ).toMatchObject({
      available: true,
      version: "1.0.0",
    });
  });
});
