import { defineConfig } from "@playwright/test";

// Electron E2E: each test launches the built app (out/) against a local OpenRouter mock.
export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/artifacts/test-output",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
