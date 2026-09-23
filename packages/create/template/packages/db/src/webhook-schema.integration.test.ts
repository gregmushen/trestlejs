import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const sql = databaseUrl ? postgres(databaseUrl, { max: 1, prepare: false }) : undefined;
const ids: string[] = [];

async function endpoint(organizationId: string): Promise<string> {
  const [row] = await sql!<{ id: string }[]>`insert into webhook_endpoint (organization_id, environment, name, destination_url, provider, created_by, updated_by) values (${organizationId}, 'local', ${crypto.randomUUID()}, 'https://example.test/webhook', 'local', 'test-user', 'test-user') returning id`;
  if (!row) throw new Error("Test endpoint was not inserted");
  ids.push(row.id);
  return row.id;
}

suite("outbound webhook endpoint and subscription isolation", () => {
  afterAll(async () => {
    if (ids.length) await sql!`delete from webhook_endpoint where id = any(${ids})`;
    await sql!.end();
  });

  it("forces RLS and creates destinations inert by default", async () => {
    const id = await endpoint("webhook-org-a");
    const [record] = await sql!`select state, health from webhook_endpoint where id=${id}`;
    expect(record).toEqual({ state: "disabled", health: "unknown" });
    const relations = await sql!`select relname, relrowsecurity, relforcerowsecurity from pg_class where relname in ('webhook_endpoint', 'webhook_subscription') order by relname`;
    expect(relations).toEqual([
      { relname: "webhook_endpoint", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "webhook_subscription", relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });

  it("hides both tables without tenant context and rejects cross-tenant writes", async () => {
    const a = await endpoint("webhook-org-a");
    const b = await endpoint("webhook-org-b");
    await sql!`insert into webhook_subscription (organization_id, endpoint_id, public_event_type, public_version, created_by) values ('webhook-org-a', ${a}, 'article.published', 1, 'test-user'), ('webhook-org-b', ${b}, 'article.published', 1, 'test-user')`;
    await sql!.begin(async (transaction) => {
      await transaction`set local role trestle_app`;
      expect(await transaction`select id from webhook_endpoint where id in (${a},${b})`).toHaveLength(0);
      expect(await transaction`select endpoint_id from webhook_subscription where endpoint_id in (${a},${b})`).toHaveLength(0);
      await transaction`select set_config('app.organization_id', 'webhook-org-a', true)`;
      expect((await transaction`select id from webhook_endpoint where id in (${a},${b})`).map((row) => row.id)).toEqual([a]);
      expect((await transaction`select endpoint_id from webhook_subscription where endpoint_id in (${a},${b})`).map((row) => row.endpoint_id)).toEqual([a]);
      expect((await transaction`update webhook_endpoint set state='paused' where id=${b}`).count).toBe(0);
      expect((await transaction`delete from webhook_subscription where endpoint_id=${b}`).count).toBe(0);
    });
    await expect(sql!.begin(async (transaction) => {
      await transaction`set local role trestle_app`;
      await transaction`select set_config('app.organization_id', 'webhook-org-a', true)`;
      await transaction`insert into webhook_subscription (organization_id, endpoint_id, public_event_type, public_version, created_by) values ('webhook-org-b', ${b}, 'article.deleted', 1, 'test-user')`;
    })).rejects.toThrow();
  });

  it("normalizes each public event version and enforces endpoint tenant identity", async () => {
    const id = await endpoint("webhook-org-a");
    await sql!`insert into webhook_subscription (organization_id, endpoint_id, public_event_type, public_version, created_by) values ('webhook-org-a', ${id}, 'article.published', 1, 'test-user'), ('webhook-org-a', ${id}, 'article.published', 2, 'test-user')`;
    expect((await sql!`select public_version from webhook_subscription where endpoint_id=${id} order by public_version`).map((row) => row.public_version)).toEqual([1, 2]);
    await expect(sql!`insert into webhook_subscription (organization_id, endpoint_id, public_event_type, public_version, created_by) values ('webhook-org-a', ${id}, 'article.published', 1, 'test-user')`).rejects.toThrow();
    await expect(sql!`insert into webhook_subscription (organization_id, endpoint_id, public_event_type, public_version, created_by) values ('webhook-org-b', ${id}, 'article.deleted', 1, 'test-user')`).rejects.toThrow();
    await expect(sql!`insert into webhook_subscription (organization_id, endpoint_id, public_event_type, public_version, created_by) values ('webhook-org-a', ${id}, 'article.deleted', 0, 'test-user')`).rejects.toThrow();
  });
});
