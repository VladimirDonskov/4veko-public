import { defineConfig, devices } from "@playwright/test";

// Runs against the local dev servers (API on :4000, web on :3000).
// Start them with `npm run dev:api` and `npm run dev:web`, or let
// Playwright start them.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testIgnore: /responsive/ },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /responsive/ },
  ],
  webServer: [
    { command: "npm run dev -w @4veko/api", cwd: "../..", port: 4000, reuseExistingServer: true, timeout: 120_000 },
    { command: "npm run dev -w @4veko/web", cwd: "../..", port: 3000, reuseExistingServer: true, timeout: 120_000 },
  ],
});
