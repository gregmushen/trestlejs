import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const user = `factors-${Date.now()}`;

async function as<T>(role: "trestle_app" | "trestle_platform", work: (transaction: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return await sql!.begin(async (transaction) => { await transaction.unsafe(`set local role ${role}`); return await work(transaction); }) as T;
}

suite("authentication factors and assurance", () => {
  beforeAll(async () => {
    await sql!`insert into "user" (id, name, email, email_verified, created_at, updated_at) values (${user}, 'F', ${`${user}@example.test`}, true, now(), now())`;
    await sql!`insert into two_factor (id, secret, backup_codes, user_id) values (${`${user}-tf`}, 'encrypted-secret', 'encrypted-codes', ${user})`;
    await sql!`insert into passkey (id, name, public_key, user_id, credential_id, counter, device_type, backed_up, created_at) values (${`${user}-pk`}, 'Laptop', 'public-key', ${user}, 'credential', 0, 'singleDevice', false, now())`;
    await sql!`insert into authentication_assurance (session_id, user_id, level, method, verified_at) values (${`${user}-s`}, ${user}, 'phishing_resistant', 'passkey', now())`;
  });
  afterAll(async () => {
    await sql!`delete from audit_event where actor_id = ${user}`.catch(() => undefined);
    await sql!`delete from authentication_assurance where user_id = ${user}`;
    await sql!`delete from "user" where id = ${user}`;
    await sql!.end();
  });

  it("shows operators which factors exist, never secrets, codes, or credential material", async () => {
    expect(await as("trestle_platform", (transaction) => transaction`select verified from two_factor where user_id = ${user}`)).toEqual([{ verified: true }]);
    expect(await as("trestle_platform", (transaction) => transaction`select name, device_type from passkey where user_id = ${user}`)).toEqual([{ name: "Laptop", device_type: "singleDevice" }]);
    expect(await as("trestle_platform", (transaction) => transaction`select level from authentication_assurance where user_id = ${user}`)).toEqual([{ level: "phishing_resistant" }]);
    for (const [table, column] of [["two_factor", "secret"], ["two_factor", "backup_codes"], ["passkey", "public_key"], ["passkey", "credential_id"]] as const) {
      await expect(as("trestle_platform", (transaction) => transaction.unsafe(`select ${column} from ${table}`)), `${table}.${column}`).rejects.toThrow(/permission denied/u);
    }
  });

  it("records account-security events through the narrow function only", async () => {
    await as("trestle_app", (transaction) => transaction`select trestle_record_security_event('security.passkey.added', ${user}, '{}', 'c', 'local')`);
    await as("trestle_app", (transaction) => transaction`select trestle_record_security_event('access.api_key.minted', ${user}, '{}', 'c', 'local')`);
    const events = await sql!`select name, organization_id from audit_event where actor_id = ${user}`;
    expect(events).toEqual([{ name: "security.passkey.added", organization_id: null }]);
    await expect(as("trestle_app", (transaction) => transaction`insert into audit_event (name, actor_type, actor_id, target_type, target_id, outcome, environment, correlation_id) values ('security.x.y', 'user', ${user}, 'user', ${user}, 'succeeded', 'local', 'c')`)).rejects.toThrow();
  });
});
