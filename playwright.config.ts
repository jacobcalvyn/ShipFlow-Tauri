import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./output/playwright",
  fullyParallel: false,
  reporter: process.env.CI
    ? [
        ["line"],
        ["html", { open: "never", outputFolder: "output/playwright-report" }],
      ]
    : "list",
  use: {
    baseURL: "http://127.0.0.1:1420",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 1420 --strictPort",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    url: "http://127.0.0.1:1420",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
