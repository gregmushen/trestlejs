import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { clearCapturedEmails, listCapturedEmails } from "@__TRESTLE_PROJECT_NAME__/integrations";

import { createAuth } from "./index.js";
import { createStagingFixture } from "./staging-fixture.js";

const databaseUrl = process.env.TRESTLE_RLS_TEST_DATABASE_URL;

describe("persistent staging credential fixture", () => {
  it("rejects preview, production, and local before touching a database", async () => {
    for (const environment of ["preview", "production", "local", ""]) {
      await expect(createStagingFixture({ environment, databaseUrl: "postgres://invalid", githubEnv: "/missing" })).rejects.toThrow(/staging database/u);
    }
  });

  it.skipIf(!databaseUrl)("rotates a verified account without email or extra users", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "trestle-staging-fixture-"));
    const githubEnv = path.join(directory, "github-env");
    clearCapturedEmails();
    try {
      const first = await createStagingFixture({ environment: "staging", databaseUrl: databaseUrl!, githubEnv });
      const second = await createStagingFixture({ environment: "staging", databaseUrl: databaseUrl!, githubEnv });
      expect(second.email).toBe(first.email);
      expect(second.password).not.toBe(first.password);
      const envFile = await readFile(githubEnv, "utf8");
      expect(envFile).toContain(`TRESTLE_STAGING_FIXTURE_EMAIL=${second.email}\nTRESTLE_STAGING_FIXTURE_PASSWORD=${second.password}\n`);
      const auth = createAuth({ DATABASE_URL: databaseUrl!, DATABASE_DRIVER: "postgres-js", BETTER_AUTH_SECRET: "staging-fixture-test-secret-at-least-thirty-two-characters", BETTER_AUTH_URL: "http://localhost:8787", EMAIL_DELIVERY_MODE: "local" });
      await expect(auth.api.signInEmail({ body: { email: first.email, password: first.password } })).rejects.toThrow();
      const signedIn = await auth.api.signInEmail({ body: { email: second.email, password: second.password } });
      expect(signedIn.user.id).toBe("trestle-staging-fixture-v1");
      expect(signedIn.user.emailVerified).toBe(true);
      expect(listCapturedEmails()).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
