import { randomBytes, randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { hashPassword } from "better-auth/crypto";

import { account, createDatabase, user } from "@__TRESTLE_PROJECT_NAME__/db";

/** Create a credential account without invoking email or adding a test-only HTTP route.
 * Only an isolated preview database may use this fixture. */
export async function createPreviewFixture(input: { environment: string; databaseUrl: string; githubEnv: string }): Promise<{ email: string; password: string }> {
  if (input.environment !== "preview" || !input.databaseUrl || !input.githubEnv) throw new Error("Preview fixture requires an isolated preview database and GITHUB_ENV");
  const id = randomUUID();
  const email = `trestle-preview-${randomBytes(12).toString("hex")}@example.test`;
  const password = `Preview-${randomBytes(24).toString("base64url")}!`;
  const database = createDatabase(input.databaseUrl, "postgres-js");
  await database.transaction(async (transaction) => {
    await transaction.insert(user).values({ id, name: "Preview Fixture", email, emailVerified: true });
    await transaction.insert(account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: await hashPassword(password) });
  });
  // GitHub Actions transports these values to the browser step without placing
  // either the database credential or password on the command line or in logs.
  await appendFile(input.githubEnv, `TRESTLE_PREVIEW_FIXTURE_EMAIL=${email}\nTRESTLE_PREVIEW_FIXTURE_PASSWORD=${password}\n`, { mode: 0o600 });
  return { email, password };
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  const fixture = await createPreviewFixture({
    environment: process.env.TRESTLE_DEPLOY_ENV ?? "",
    databaseUrl: process.env.DATABASE_URL ?? "",
    githubEnv: process.env.GITHUB_ENV ?? "",
  });
  process.stdout.write(`::add-mask::${fixture.password}\n`);
  process.stdout.write("Created a verified preview test account without sending email.\n");
}
