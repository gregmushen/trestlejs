import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createDatabase, user } from "@__TRESTLE_PROJECT_NAME__/db";
import { listCapturedEmails, clearCapturedEmails } from "@__TRESTLE_PROJECT_NAME__/integrations";

import { createAuth } from "./index.js";
import { createPreviewFixture } from "./preview-fixture.js";

const databaseUrl = process.env.TRESTLE_RLS_TEST_DATABASE_URL;

describe("isolated preview credential fixture", () => {
  it("rejects staging and production before touching their databases", async () => {
    for (const environment of ["staging", "production", "local", ""]) {
      await expect(createPreviewFixture({ environment, databaseUrl: "postgres://invalid", githubEnv: "/missing" })).rejects.toThrow(/isolated preview/u);
    }
  });

  it.skipIf(!databaseUrl)("signs in as a verified user without sending any email", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "trestle-preview-fixture-"));
    const githubEnv = path.join(directory, "github-env");
    const database = createDatabase(databaseUrl!, "postgres-js");
    let email: string | undefined;
    clearCapturedEmails();
    try {
      const fixture = await createPreviewFixture({ environment: "preview", databaseUrl: databaseUrl!, githubEnv });
      email = fixture.email;
      expect(fixture.email).toMatch(/^trestle-preview-[a-f0-9]{24}@example\.test$/u);
      expect(await readFile(githubEnv, "utf8")).toBe(`TRESTLE_PREVIEW_FIXTURE_EMAIL=${fixture.email}\nTRESTLE_PREVIEW_FIXTURE_PASSWORD=${fixture.password}\n`);
      const auth = createAuth({ DATABASE_URL: databaseUrl!, DATABASE_DRIVER: "postgres-js", BETTER_AUTH_SECRET: "preview-fixture-test-secret-at-least-thirty-two-characters", BETTER_AUTH_URL: "http://localhost:8787", EMAIL_DELIVERY_MODE: "local" });
      const signedIn = await auth.api.signInEmail({ body: { email: fixture.email, password: fixture.password } });
      expect(signedIn.user.email).toBe(fixture.email);
      expect(signedIn.user.emailVerified).toBe(true);
      expect(listCapturedEmails()).toHaveLength(0);
    } finally {
      if (email) await database.delete(user).where(eq(user.email, email));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
