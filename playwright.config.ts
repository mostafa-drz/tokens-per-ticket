import { defineConfig, devices } from "@playwright/test";

/**
 * E2E runs against sample data on port 3100, so it never touches a gateway
 * and won't clash with `pnpm dev` on 3000.
 *   pnpm test:e2e                                  # next dev on :3100
 *   PLAYWRIGHT_BASE_URL=https://… pnpm test:e2e    # a deployed preview
 */
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3100";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: "pnpm dev --port 3100",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        env: { LEDGER_DATA: "sample", LEDGER_REVIEW_MODEL: "", LEDGER_BASIC_AUTH: "" },
      },
});
