import { defineConfig, devices } from "@playwright/test";

const databaseUrl = process.env.TRESTLE_BROWSER_DATABASE_URL;
if (!databaseUrl) throw new Error("Set TRESTLE_BROWSER_DATABASE_URL to a migrated, isolated local PostgreSQL database");

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:42069", trace: "retain-on-failure" },
  webServer: [
    {
      name: "Worker",
      command: "pnpm --filter ./apps/worker exec wrangler dev --port 8787",
      url: "http://localhost:8787/api/health",
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        DATABASE_URL: databaseUrl,
        DATABASE_DRIVER: "postgres-js",
        BETTER_AUTH_SECRET: "browser-test-secret-with-at-least-thirty-two-characters",
        BETTER_AUTH_URL: "http://localhost:8787",
      },
    },
    {
      name: "App",
      command: "pnpm --filter ./apps/app dev",
      url: "http://localhost:42069/sign-in",
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
