import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import { createDatabase, session, user } from "./index.js";
import { recordAssurance, sessionAssurance } from "./assurance.js";

const url = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite("session assurance", () => {
  it("records, upgrades, and cascades how a session was authenticated", async () => {
    const database = createDatabase(url!, "postgres-js");
    const run = crypto.randomUUID();
    const userId = `assurance-user-${run}`;
    const sessionId = `assurance-session-${run}`;
    const now = new Date();
    await database.insert(user).values({ id: userId, name: "Assurance", email: `${userId}@example.test`, emailVerified: true, createdAt: now, updatedAt: now });
    await database.insert(session).values({ id: sessionId, userId, token: `token-${run}`, expiresAt: new Date(now.getTime() + 3_600_000), createdAt: now, updatedAt: now });
    try {
      await recordAssurance(database, { sessionId, userId, level: "password", method: "password" });
      expect(await sessionAssurance(database, sessionId)).toMatchObject({ sessionId, level: "password", method: "password" });
      await recordAssurance(database, { sessionId, userId, level: "mfa", method: "totp" });
      expect(await sessionAssurance(database, sessionId)).toMatchObject({ level: "mfa", method: "totp" });
      expect(await sessionAssurance(database, "missing")).toBeNull();
      // Assurance never outlives its session.
      await database.delete(session).where(eq(session.id, sessionId));
      expect(await sessionAssurance(database, sessionId)).toBeNull();
    } finally {
      await database.delete(user).where(eq(user.id, userId));
    }
  });

  it("keeps the tenant role from writing account-security events", async () => {
    const admin = postgres(url!, { max: 1, prepare: false });
    const asApp = async (work: (transaction: postgres.TransactionSql) => Promise<unknown>) => await admin.begin(async (transaction) => {
      await transaction`set local role trestle_app`;
      return await work(transaction);
    });
    try {
      // Only the runtime login may execute the SECURITY DEFINER writer.
      await expect(asApp(async (transaction) => await transaction`select trestle_record_security_event('security.x.y', 'u', 'c', 'local')`)).rejects.toThrow(/permission denied/u);
      // Nor can it forge an organization-less security.* row directly: RLS rejects it.
      await expect(asApp(async (transaction) => await transaction`insert into audit_event (name, schema_version, actor_type, actor_id, organization_id, target_type, target_id, summary, outcome, environment, correlation_id) values ('security.x.y', '1', 'user', 'u', null, 'user', 'u', '{}'::jsonb, 'succeeded', 'local', 'c')`)).rejects.toThrow(/row-level security/u);
    } finally {
      await admin.end();
    }
  });
});
