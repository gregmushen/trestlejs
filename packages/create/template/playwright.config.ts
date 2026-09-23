import { defineConfig, devices } from "@playwright/test";

const deployed = process.env.TRESTLE_BROWSER_MODE === "deployed";
const databaseUrl = process.env.TRESTLE_BROWSER_DATABASE_URL;
const sitePort = Number(process.env.TRESTLE_BROWSER_SITE_PORT ?? 42068);
if (!Number.isSafeInteger(sitePort) || sitePort < 1024 || sitePort > 65535) throw new Error("TRESTLE_BROWSER_SITE_PORT must be an unprivileged TCP port");
if (!deployed && !databaseUrl) throw new Error("Set TRESTLE_BROWSER_DATABASE_URL to a migrated, isolated local PostgreSQL database");
if (deployed) {
  const origins = ["SITE_URL", "APP_URL", "API_URL"].map((name) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required for deployed browser verification`);
    const url = new URL(value);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
      throw new Error(`${name} must be a bare HTTPS origin`);
    }
    return url.origin;
  });
  if (new Set(origins).size !== origins.length) throw new Error("Deployed site, app, and API origins must be distinct");
}

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: { ...devices["Desktop Chrome"], baseURL: deployed ? process.env.APP_URL! : "http://localhost:42069", trace: "retain-on-failure" },
  ...(deployed ? {} : { webServer: [
    {
      name: "Worker",
      command: "pnpm --filter ./apps/worker exec wrangler dev --port 8787",
      url: "http://localhost:8787/api/health",
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        DATABASE_URL: databaseUrl!,
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
    {
      name: "Site",
      command: `pnpm --filter ./apps/site exec astro dev --port ${sitePort} --ignore-lock`,
      url: `http://localhost:${sitePort}/`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: { SITE_URL: `http://localhost:${sitePort}`, APP_URL: "http://localhost:42069" },
    },
  ] }),
});
