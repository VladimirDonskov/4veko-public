import { defineConfig } from "@playwright/test";

// This suite requires the ERP session gateway, Spring and its real worker.
export default defineConfig({
  testDir: "./e2e-platform",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000", trace: "retain-on-failure" },
});
