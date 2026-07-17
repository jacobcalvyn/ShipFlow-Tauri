import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/electron",
  outputDir: "./output/playwright",
  fullyParallel: false,
  reporter: process.env.CI
    ? [
        ["line"],
        ["html", { open: "never", outputFolder: "output/playwright-report" }],
      ]
    : "list",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
