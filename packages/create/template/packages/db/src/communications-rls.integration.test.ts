import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const prefix = `com-${Date.now()}`;
const orgA = `${prefix}-a`;
const orgB = `${prefix}-b`;

async function as<T>(role: "trestle_app" | "trestle_platform", organizationId: string | undefined, work: (transaction: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return await sql!.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${role}`);
    if (organizationId) await transaction`select set_config('app.organization_id', ${organizationId}, true)`;
    return await work(transaction);
  }) as T;
}

const tenantTables = ["webhook_endpoint", "webhook_delivery", "webhook_attempt", "notification", "notification_delivery", "notification_preference"] as const;

suite("forced RLS and grants for webhooks, notifications, and support sessions", () => {
  beforeAll(async () => {
    for (const organization of [orgA, orgB]) {
      await sql!`insert into webhook_endpoint (id, organization_id, name, url, url_display, events, secret_ciphertext, secret_fingerprint, created_by) values (${`${organization}-e`}, ${organization}, 'Hook', 'https://example.com/hook?token=abc', 'https://example.com/hook?…', '{api_key.created}', 'v1:iv:ciphertext', 'abcd1234', 'test')`;
      await sql!`insert into webhook_endpoint (id, organization_id, name, url, url_display, events, state, secret_ciphertext, secret_fingerprint, created_by) values (${`${organization}-paused`}, ${organization}, 'Paused', 'https://example.com/p', 'https://example.com/p', '{api_key.created}', 'paused', 'v1:iv:ciphertext', 'abcd1234', 'test')`;
      await sql!`insert into webhook_delivery (id, organization_id, endpoint_id, event_id, event_name, event_version, payload, status, correlation_id) values (${`${organization}-d`}, ${organization}, ${`${organization}-e`}, 'evt-1', 'api_key.created', 1, '{"secret-ish": true}', 'failed', 'c')`;
      await sql!`insert into webhook_delivery (id, organization_id, endpoint_id, event_id, event_name, event_version, payload, correlation_id) values (${`${organization}-due`}, ${organization}, ${`${organization}-e`}, 'evt-2', 'api_key.created', 1, '{}', 'c')`;
      await sql!`insert into webhook_delivery (id, organization_id, endpoint_id, event_id, event_name, event_version, payload, correlation_id) values (${`${organization}-held`}, ${organization}, ${`${organization}-paused`}, 'evt-3', 'api_key.created', 1, '{}', 'c')`;
      await sql!`insert into webhook_delivery (id, organization_id, endpoint_id, event_id, event_name, event_version, payload, status, correlation_id, test) values (${`${organization}-t`}, ${organization}, ${`${organization}-e`}, 'evt-test', 'webhook.test', 1, '{}', 'succeeded', 'c', true)`;
      await sql!`insert into webhook_attempt (organization_id, delivery_id, response_code, failure_category, duration_ms) values (${organization}, ${`${organization}-d`}, 500, 'endpoint_error', 12)`;
      await sql!`insert into notification (id, organization_id, user_id, type, title, body, correlation_id) values (${`${organization}-n`}, ${organization}, 'user-1', 'security.api_key_created', 'Private title', 'Private body', 'c')`;
      await sql!`insert into notification_delivery (id, organization_id, notification_id, user_id, channel, status, preference_source, correlation_id) values (${`${organization}-nd`}, ${organization}, ${`${organization}-n`}, 'user-1', 'email', 'pending', 'default', 'c')`;
      await sql!`insert into notification_preference (organization_id, user_id, type, channel, enabled, updated_by) values (${organization}, '*', 'security.api_key_created', 'email', true, 'test')`;
    }
    await sql!`insert into support_session (id, operator_id, organization_id, reason, profile, permissions, expires_at) values (${`${prefix}-s`}, 'op', ${orgA}, 'ticket', 'read_only', '{"organization":[],"application":[],"denied":[]}', now() + interval '10 minutes')`;
  });

  afterAll(async () => {
    for (const table of ["notification_preference", "notification_delivery", "notification", "webhook_attempt", "webhook_delivery", "webhook_endpoint", "support_session"]) await sql!.unsafe(`delete from ${table} where organization_id like $1`, [`${prefix}%`]);
    await sql!.end();
  });

  it("isolates every communications table by tenant context", async () => {
    for (const table of tenantTables) {
      const organizations = await as("trestle_app", orgA, (transaction) => transaction.unsafe(`select distinct organization_id from ${table} where organization_id like $1`, [`${prefix}%`]));
      expect(organizations.map((row) => row.organization_id), table).toEqual([orgA]);
      expect(await as("trestle_app", undefined, (transaction) => transaction.unsafe(`select 1 from ${table} where organization_id like $1`, [`${prefix}%`])), `${table} without tenant context`).toHaveLength(0);
    }
    await expect(as("trestle_app", orgA, (transaction) => transaction`insert into notification_preference (organization_id, user_id, type, channel, enabled, updated_by) values (${orgB}, 'x', 't', 'email', true, 'x')`)).rejects.toThrow();
    expect((await as("trestle_app", orgA, (transaction) => transaction`update webhook_endpoint set state = 'disabled' where organization_id = ${orgB}`)).count).toBe(0);
  });

  it("never lets the platform role read URLs, signing secrets, payloads, or message content", async () => {
    const endpoints = await as("trestle_platform", undefined, (transaction) => transaction`select id, url_display, secret_fingerprint from webhook_endpoint where organization_id like ${`${prefix}%`}`);
    expect(endpoints).toHaveLength(4);
    for (const column of ["url", "secret_ciphertext", "previous_secret_ciphertext"]) await expect(as("trestle_platform", undefined, (transaction) => transaction.unsafe(`select ${column} from webhook_endpoint`)), column).rejects.toThrow(/permission denied/u);
    await expect(as("trestle_platform", undefined, (transaction) => transaction`select payload from webhook_delivery`)).rejects.toThrow(/permission denied/u);
    for (const column of ["title", "body", "link"]) await expect(as("trestle_platform", undefined, (transaction) => transaction.unsafe(`select ${column} from notification`)), column).rejects.toThrow(/permission denied/u);
    await expect(as("trestle_platform", undefined, (transaction) => transaction`insert into webhook_delivery (id, organization_id, endpoint_id, event_id, event_name, event_version, payload, correlation_id) values ('x', ${orgA}, ${`${orgA}-e`}, 'e', 'n', 1, '{}', 'c')`)).rejects.toThrow(/permission denied/u);
    await expect(as("trestle_app", orgA, (transaction) => transaction`select 1 from support_session`)).rejects.toThrow(/permission denied/u);
  });

  it("replays through the narrow function only when the delivery is eligible", async () => {
    const replay = (id: string, replayId: string) => as("trestle_platform", undefined, (transaction) => transaction`select trestle_replay_webhook_delivery(${id}, ${replayId}, 'corr') as organization_id`);
    expect((await replay(`${orgA}-d`, `${prefix}-r1`))[0]?.organization_id).toBe(orgA);
    expect((await replay(`${orgA}-t`, `${prefix}-r2`))[0]?.organization_id).toBeNull();
    const [copy] = await sql!`select organization_id, replay_of, status, payload from webhook_delivery where id = ${`${prefix}-r1`}`;
    expect(copy).toMatchObject({ organization_id: orgA, replay_of: `${orgA}-d`, status: "pending", payload: { "secret-ish": true } });
    await sql!`delete from webhook_delivery where id = ${`${prefix}-r1`}`;
  });

  it("finds due work across tenants without exposing it to the platform role", async () => {
    const due = await as("trestle_app", undefined, (transaction) => transaction`select * from trestle_due_webhook_deliveries(100)`);
    const ours = due.filter((row) => String(row.organization_id).startsWith(prefix)).map((row) => row.id).sort();
    // Deliveries to paused endpoints wait; completed ones are not due.
    expect(ours).toEqual([`${orgA}-due`, `${orgB}-due`]);
    const emails = await as("trestle_app", undefined, (transaction) => transaction`select * from trestle_due_notification_deliveries(100)`);
    expect(emails.filter((row) => String(row.organization_id).startsWith(prefix))).toHaveLength(2);
    await expect(as("trestle_platform", undefined, (transaction) => transaction`select * from trestle_due_webhook_deliveries(1)`)).rejects.toThrow(/permission denied/u);
  });
});
