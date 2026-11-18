import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://veko:veko_dev_password@localhost:5433/veko_test",
    },
  },
});
