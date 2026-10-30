import { defineConfig } from "@playwright/test";

const firefox = process.env.STUDIO_TEST_BROWSER === "firefox";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: process.env.STUDIO_TEST_URL || "http://127.0.0.1:5173",
    browserName: firefox ? "firefox" : "chromium",
    channel: firefox ? undefined : "chrome",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
