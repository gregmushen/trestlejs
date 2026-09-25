import { randomBytes } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { hashPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";

import { account, createDatabase, user } from "@__TRESTLE_PROJECT_NAME__/db";

const fixtureId = "trestle-staging-fixture-v1";
const fixtureEmail = "trestle-staging-fixture@example.test";
const fixtureName = "Staging Fixture";

/** Rotate a dedicated staging-only credential without using the email adapter.
 * Reusing one account prevents an automatic deploy from accumulating users. */
export async function createStagingFixture(input: { environment: string; databaseUrl: string; githubEnv: string }): Promise<{ email: string; password: string }> {
  if (input.environment !== "staging" || !input.databaseUrl || !input.githubEnv) throw new Error("Staging fixture requires the staging database and GITHUB_ENV");
  const password = `Staging-${randomBytes(24).toString("base64url")}!`;
  const database = createDatabase(input.databaseUrl, "postgres-js");
  await database.transaction(async (transaction) => {
    const [existing] = await transaction.select().from(user).where(eq(user.email, fixtureEmail));
    if (existing && (existing.id !== fixtureId || existing.name !== fixtureName || !existing.emailVerified)) {
      throw new Error("Reserved staging fixture email belongs to a different user");
    }
    if (!existing) await transaction.insert(user).values({ id: fixtureId, name: fixtureName, email: fixtureEmail, emailVerified: true });
    const credentials = await transaction.select().from(account).where(and(eq(account.userId, fixtureId), eq(account.providerId, "credential")));
    if (credentials.length > 1 || (credentials[0] && credentials[0].accountId !== fixtureId)) {
      throw new Error("Reserved staging fixture has an unexpected credential account");
    }
    const hashed = await hashPassword(password);
    if (credentials[0]) await transaction.update(account).set({ password: hashed }).where(eq(account.id, credentials[0].id));
    else await transaction.insert(account).values({ id: fixtureId, accountId: fixtureId, providerId: "credential", userId: fixtureId, password: hashed });
  });
  await appendFile(input.githubEnv, `TRESTLE_STAGING_FIXTURE_EMAIL=${fixtureEmail}\nTRESTLE_STAGING_FIXTURE_PASSWORD=${password}\n`, { mode: 0o600 });
  return { email: fixtureEmail, password };
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  const fixture = await createStagingFixture({
    environment: process.env.TRESTLE_DEPLOY_ENV ?? "",
    databaseUrl: process.env.DATABASE_URL ?? "",
    githubEnv: process.env.GITHUB_ENV ?? "",
  });
  process.stdout.write(`::add-mask::${fixture.password}\n`);
  process.stdout.write("Rotated the verified staging test account without sending email.\n");
}
