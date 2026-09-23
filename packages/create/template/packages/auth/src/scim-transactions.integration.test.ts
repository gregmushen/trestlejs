import { describe, expect, it } from "vitest";

import { runScimTransactionTest } from "./scim-transactions.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const environment = { DATABASE_URL: connectionString ?? "", BETTER_AUTH_SECRET: "scim-transaction-test-secret-0123456789", BETTER_AUTH_URL: "http://localhost:42069", APP_ENV: "local" as const };

suite("SCIM transaction compatibility", () => {
  it("provisions, updates, and deactivates in native transactions with the Trestle projection", async () => {
    const result = await runScimTransactionTest({ ...environment, DATABASE_DRIVER: "postgres-js" });
    expect(result).toMatchObject({ driver: "postgres-js", passed: true, operations: ["create", "update", "deactivate"] });
  }, 60_000);

  it("refuses a driver without interactive transactions instead of passing", async () => {
    const result = await runScimTransactionTest({ ...environment, DATABASE_DRIVER: "neon-http" });
    expect(result).toMatchObject({ driver: "neon-http", passed: false, operations: [] });
    expect(result.failure).toMatch(/interactive transactions/u);
  });
});
