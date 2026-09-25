import { EVENT_PROVENANCE_RETENTION_DAYS, eventEnvelopeSchema } from "@__TRESTLE_PROJECT_NAME__/events";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresOutboxStore } from "./outbox.js";

const databaseUrl = process.env.TRESTLE_INBOX_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const day = 86_400_000;
// Retention fixtures live far in the past so that global counts only ever see
// this file's rows, even while other suites share the database.
const epoch = new Date("2000-03-01T00:00:00.000Z");
const cutoff = new Date(epoch.getTime() - EVENT_PROVENANCE_RETENTION_DAYS * day);
const aged = (days: number) => new Date(cutoff.getTime() - days * day);

const executor = `trestle_prune_test_${Date.now()}`;
const executorPassword = `test-${crypto.randomUUID()}`;
const functions = ["trestle_prune_outbox_provenance(timestamp with time zone, integer)", "trestle_count_prunable_outbox_provenance(timestamp with time zone)"];
const admin = databaseUrl ? postgres(databaseUrl, { max: 1, prepare: false }) : undefined;
let executorUrl = "";

function envelope(id = crypto.randomUUID()) {
  return eventEnvelopeSchema.parse({ id, name: "article.published", schemaVersion: 1, occurredAt: new Date().toISOString(), resource: { type: "article", id }, correlationId: id, idempotencyKey: id, payload: { resourceId: id } });
}

suite("outbox retention and failure redaction", () => {
  // Production calls the prune functions as the migration role. The test
  // database's migration role is a superuser, which ignores forced RLS and
  // table privileges, so a prune it runs proves nothing about the functions.
  // Every prune below instead runs as a fresh login without BYPASSRLS that
  // holds only EXECUTE on the two functions: no table privileges and no
  // policies. Whatever it can see comes from trestle_retention, the functions'
  // owner, never from the caller.
  beforeAll(async () => {
    await admin!.unsafe(`create role "${executor}" login password '${executorPassword}' nosuperuser nocreatedb nocreaterole noinherit nobypassrls`);
    await admin!.unsafe(`grant usage on schema public to "${executor}"`);
    for (const signature of functions) await admin!.unsafe(`grant execute on function ${signature} to "${executor}"`);
    const url = new URL(databaseUrl!);
    url.username = executor;
    url.password = executorPassword;
    executorUrl = url.toString();
  });

  afterAll(async () => {
    await admin!.unsafe(`drop owned by "${executor}"`).catch(() => undefined);
    await admin!.unsafe(`drop role if exists "${executor}"`);
    await admin!.end();
  });

  it("runs pruning with trestle_retention's access, not the caller's", async () => {
    const owners = await admin!<{ name: string; owner: string; definer: boolean; config: string[] | null }[]>`
      select proname as name, pg_get_userbyid(proowner) as owner, prosecdef as definer, proconfig as config
        from pg_proc where proname in ('trestle_prune_outbox_provenance', 'trestle_count_prunable_outbox_provenance') order by proname`;
    expect(owners).toEqual([
      { name: "trestle_count_prunable_outbox_provenance", owner: "trestle_retention", definer: true, config: ["search_path=pg_catalog, pg_temp"] },
      { name: "trestle_prune_outbox_provenance", owner: "trestle_retention", definer: true, config: ["search_path=pg_catalog, pg_temp"] },
    ]);
    const [role] = await admin!<{ rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean; members: number }[]>`
      select rolcanlogin, rolsuper, rolbypassrls, (select count(*)::int from pg_auth_members where roleid = r.oid) as members from pg_roles r where rolname = 'trestle_retention'`;
    // No login can assume the role: its access is reachable only through the functions.
    expect(role).toEqual({ rolcanlogin: false, rolsuper: false, rolbypassrls: false, members: 0 });
    for (const signature of functions) {
      const [execute] = await admin!.unsafe<{ app: boolean; platform: boolean }[]>(`select has_function_privilege('trestle_app', '${signature}', 'EXECUTE') as app, has_function_privilege('trestle_platform', '${signature}', 'EXECUTE') as platform`);
      expect(execute).toEqual({ app: false, platform: false });
    }
    const caller = postgres(executorUrl, { max: 1, prepare: false });
    try {
      for (const table of ["outbox_message", "event_inbox", "webhook_message", "webhook_delivery"]) {
        await expect(caller.unsafe(`select 1 from ${table} limit 1`)).rejects.toThrow("permission denied");
      }
    } finally {
      await caller.end();
    }
  });

  it("grants trestle_retention only what pruning reads and deletes", async () => {
    const [privileges] = await admin!<Record<string, boolean>[]>`
      select has_column_privilege('trestle_retention', 'outbox_message', 'processed_at', 'SELECT') as outbox_select,
             has_table_privilege('trestle_retention', 'outbox_message', 'DELETE') as outbox_delete,
             has_column_privilege('trestle_retention', 'outbox_message', 'payload', 'SELECT') as outbox_payload,
             has_table_privilege('trestle_retention', 'outbox_message', 'INSERT, UPDATE') as outbox_write,
             has_column_privilege('trestle_retention', 'event_inbox', 'leased_until', 'SELECT') as inbox_select,
             has_table_privilege('trestle_retention', 'event_inbox', 'INSERT, UPDATE, DELETE') as inbox_write,
             has_column_privilege('trestle_retention', 'webhook_message', 'source_event_id', 'SELECT') as message_select,
             has_column_privilege('trestle_retention', 'webhook_message', 'envelope', 'SELECT') as message_envelope,
             has_table_privilege('trestle_retention', 'webhook_message', 'INSERT, UPDATE, DELETE') as message_write,
             has_column_privilege('trestle_retention', 'webhook_delivery', 'state', 'SELECT') as delivery_select,
             has_table_privilege('trestle_retention', 'webhook_delivery', 'INSERT, UPDATE, DELETE') as delivery_write`;
    expect(privileges).toEqual({
      outbox_select: true, outbox_delete: true, outbox_payload: false, outbox_write: false,
      inbox_select: true, inbox_write: false,
      message_select: true, message_envelope: false, message_write: false,
      delivery_select: true, delivery_write: false,
    });
  });

  it("retrieves tenant provenance only from the committed record", async () => {
    const sql = postgres(databaseUrl!, { max: 1, prepare: false });
    const store = new PostgresOutboxStore(databaseUrl!);
    const message = envelope();
    const id = message.id;
    try {
      const inserted = await store.append(message, { organizationId: "org-trusted" });
      expect(inserted.organizationId).toBe("org-trusted");
      expect(inserted.message).not.toHaveProperty("organizationId");
      expect((await store.findCommitted(id))?.organizationId).toBe("org-trusted");
      await expect(store.append({ ...message, id: crypto.randomUUID() }, { organizationId: "org-other" })).rejects.toThrow("different organization");
      expect((await sql`select organization_id, payload from outbox_message where id=${id}`)[0]).toEqual({ organization_id: "org-trusted", payload: { resourceId: id } });
      expect(await store.findCommitted(crypto.randomUUID())).toBeNull();
    } finally {
      await sql`delete from outbox_message where id=${id}`;
      await store.close();
      await sql.end();
    }
  });

  describe("provenance retention window", () => {
    const ids: string[] = [];
    const inboxKeys: string[] = [];
    const endpointIds: string[] = [];
    const messageIds: string[] = [];
    let owner: PostgresOutboxStore;

    beforeAll(() => { owner = new PostgresOutboxStore(databaseUrl!); });
    afterAll(async () => {
      if (inboxKeys.length) await admin!`delete from event_inbox where idempotency_key = any(${inboxKeys})`;
      if (messageIds.length) await admin!`delete from webhook_delivery where message_id = any(${messageIds})`;
      if (messageIds.length) await admin!`delete from webhook_message where id = any(${messageIds})`;
      if (endpointIds.length) await admin!`delete from webhook_endpoint where id = any(${endpointIds})`;
      if (ids.length) await admin!`delete from outbox_message where id = any(${ids})`;
      await owner.close();
    });

    const committed = async (processedAt: Date | null, status = "succeeded") => {
      const message = envelope();
      ids.push(message.id);
      await owner.append(message, { organizationId: "org-retention" });
      await admin!`update outbox_message set status=${status}, processed_at=${processedAt} where id=${message.id}`;
      return message;
    };
    const remaining = async () => (await admin!<{ id: string }[]>`select id from outbox_message where id = any(${ids})`).map((row) => row.id);
    const asPruneRole = async <T>(work: (store: PostgresOutboxStore) => Promise<T>) => {
      const store = new PostgresOutboxStore(executorUrl);
      try { return await work(store); } finally { await store.close(); }
    };
    const referenceByDelivery = async (eventId: string, organizationId: string, state: "pending" | "retry" | "dead" | "succeeded" | "exhausted") => {
      const [endpoint] = await admin!<{ id: string }[]>`insert into webhook_endpoint (organization_id, environment, name, destination_url, state, provider, created_by, updated_by) values (${organizationId}, 'local', 'Provenance fixture', 'https://example.test/hook', 'active', 'local', 'test-user', 'test-user') returning id`;
      if (!endpoint) throw new Error("Could not create endpoint fixture");
      const messageId = `whm_prov_${crypto.randomUUID()}`;
      const deliveryId = `whd_prov_${crypto.randomUUID()}`;
      endpointIds.push(endpoint.id); messageIds.push(messageId);
      await admin!`insert into webhook_message (id, organization_id, source_event_id, public_event_type, public_version, occurred_at, resource_type, resource_id, envelope, payload_size, retention_class, entitlement_decision, status, correlation_id) values (${messageId}, ${organizationId}, ${eventId}, 'article.published', 1, now(), 'article', 'article-1', ${admin!.json({})}, 2, 'standard', 'not_required', 'ready', ${crypto.randomUUID()})`;
      await admin!`insert into webhook_delivery (id, organization_id, message_id, endpoint_id, state, next_attempt_at) values (${deliveryId}, ${organizationId}, ${messageId}, ${endpoint.id}, ${state}, now())`;
      return deliveryId;
    };

    it("refuses cutoffs inside the 30-day provenance window, measured with an injected clock", async () => {
      const inside = new Date(cutoff.getTime() + 1);
      await expect(owner.countPrunableSucceeded(inside, epoch)).rejects.toThrow("Outbox retention cutoff is inside the 30-day provenance window");
      await expect(owner.pruneSucceeded(inside, 10, epoch)).rejects.toThrow("Outbox retention cutoff is inside the 30-day provenance window");
      await expect(owner.pruneSucceeded(new Date(), 10)).rejects.toThrow(`use a cutoff at or before`);
      const old = await committed(aged(1));
      // Exactly 30 days before the injected now is the boundary and is allowed.
      await expect(asPruneRole((store) => store.countPrunableSucceeded(cutoff, epoch))).resolves.toBe(1);
      await expect(asPruneRole((store) => store.pruneSucceeded(cutoff, 10, epoch))).resolves.toBe(1);
      expect(await remaining()).not.toContain(old.id);
      await expect(owner.pruneSucceeded(new Date("invalid"), 10, epoch)).rejects.toThrow("Invalid outbox retention parameters");
      await expect(owner.pruneSucceeded(cutoff, 10_001, epoch)).rejects.toThrow("Invalid outbox retention parameters");
    });

    it("prunes only old, unreferenced succeeded records in bounded batches", async () => {
      const oldA = await committed(aged(3));
      const oldB = await committed(aged(2));
      const recent = await committed(new Date(cutoff.getTime() + day));
      const dead = await committed(aged(3), "dead");
      const pending = await committed(null, "pending");
      await asPruneRole(async (store) => {
        expect(await store.countPrunableSucceeded(cutoff, epoch)).toBe(2);
        expect(await store.pruneSucceeded(cutoff, 1, epoch)).toBe(1);
        expect(await remaining()).not.toContain(oldA.id);
        expect(await store.countPrunableSucceeded(cutoff, epoch)).toBe(1);
        expect(await store.pruneSucceeded(cutoff, 10, epoch)).toBe(1);
        expect(await store.countPrunableSucceeded(cutoff, epoch)).toBe(0);
      });
      expect(await remaining()).toEqual(expect.arrayContaining([recent.id, dead.id, pending.id]));
      expect(await remaining()).not.toContain(oldB.id);
    });

    it("keeps provenance an inbox claim may still need within the 14-day replay window", async () => {
      const claimed = await committed(aged(5));
      const released = await committed(aged(5));
      const abandoned = await committed(aged(5));
      const completed = await committed(aged(5));
      // leased_until is the latest claim or release time; released claims stay 'processing' forever.
      for (const [message, status, leasedUntil] of [[claimed, "processing", "now() + interval '1 minute'"], [released, "processing", "now() - interval '13 days'"], [abandoned, "processing", "now() - interval '15 days'"], [completed, "completed", "null"]] as const) {
        inboxKeys.push(message.idempotencyKey);
        await admin!.unsafe(`insert into event_inbox (idempotency_key, event_id, event_name, status, leased_until, attempts) values ($1, $2, $3, $4, ${leasedUntil}, 1)`, [message.idempotencyKey, message.id, message.name, status]);
      }
      await asPruneRole(async (store) => {
        expect(await store.countPrunableSucceeded(cutoff, epoch)).toBe(2);
        expect(await store.pruneSucceeded(cutoff, 10, epoch)).toBe(2);
      });
      const kept = await remaining();
      expect(kept).toEqual(expect.arrayContaining([claimed.id, released.id]));
      expect(kept).not.toContain(abandoned.id);
      expect(kept).not.toContain(completed.id);
      await admin!`delete from outbox_message where id = any(${[claimed.id, released.id]})`;
    });

    it("keeps provenance a non-terminal webhook delivery in another tenant needs, despite forced RLS", async () => {
      const referenced = await committed(aged(4));
      const replay = await committed(aged(4));
      const settled = await committed(aged(4));
      const deliveryId = await referenceByDelivery(referenced.id, "org-provenance-a", "pending");
      await referenceByDelivery(replay.id, "org-provenance-b", "retry");
      for (const state of ["succeeded", "dead", "exhausted"] as const) await referenceByDelivery(settled.id, `org-provenance-${state}`, state);
      await asPruneRole(async (store) => {
        expect(await store.countPrunableSucceeded(cutoff, epoch)).toBe(1);
        expect(await store.pruneSucceeded(cutoff, 10, epoch)).toBe(1);
      });
      expect(await remaining()).toEqual(expect.arrayContaining([referenced.id, replay.id]));
      expect(await remaining()).not.toContain(settled.id);
      await admin!`update webhook_delivery set state='dead', completed_at=now() where id=${deliveryId}`;
      await asPruneRole(async (store) => { expect(await store.pruneSucceeded(cutoff, 10, epoch)).toBe(1); });
      expect(await remaining()).not.toContain(referenced.id);
      await admin!`delete from outbox_message where id=${replay.id}`;
    });

    it("never lets the runtime role or an unrelated login read another tenant's webhook rows", async () => {
      const event = await committed(aged(4));
      await referenceByDelivery(event.id, "org-isolation-a", "pending");
      await referenceByDelivery(event.id, "org-isolation-b", "pending");
      const visible = await admin!.begin(async (transaction) => {
        await transaction`set local role trestle_app`;
        await transaction`select set_config('app.organization_id', 'org-isolation-a', true)`;
        const messages = await transaction<{ organization_id: string }[]>`select organization_id from webhook_message where source_event_id = ${event.id}`;
        const deliveries = await transaction<{ organization_id: string }[]>`select d.organization_id from webhook_delivery d join webhook_message m on m.id = d.message_id where m.source_event_id = ${event.id}`;
        return [...messages, ...deliveries].map((row) => row.organization_id);
      });
      expect(visible).toEqual(["org-isolation-a", "org-isolation-a"]);
      // Only the platform admin and the retention owner hold unconditional
      // read policies; no policy names the migration role or any login.
      const unconditional = await admin!<{ table: string; policy: string; roles: string[] }[]>`
        select tablename as table, policyname as policy, roles::text[] as roles from pg_policies
         where tablename in ('webhook_message', 'webhook_delivery') and qual = 'true' order by tablename, policyname`;
      expect(unconditional).toEqual([
        { table: "webhook_delivery", policy: "webhook_delivery_platform_select", roles: ["trestle_platform"] },
        { table: "webhook_delivery", policy: "webhook_delivery_retention_select", roles: ["trestle_retention"] },
        { table: "webhook_message", policy: "webhook_message_platform_select", roles: ["trestle_platform"] },
        { table: "webhook_message", policy: "webhook_message_retention_select", roles: ["trestle_retention"] },
      ]);
      await admin!`delete from outbox_message where id=${event.id}`;
    });

    it("reports the oldest retained succeeded record", async () => {
      await admin!`delete from outbox_message where id = any(${ids})`;
      const oldest = aged(-2);
      await committed(new Date(cutoff.getTime() + 5 * day));
      await committed(oldest);
      await committed(aged(-10), "dead");
      expect((await owner.oldestRetainedSucceeded())?.toISOString()).toBe(oldest.toISOString());
      await admin!`delete from outbox_message where id = any(${ids})`;
      const none = await owner.oldestRetainedSucceeded();
      expect(none === null || none.getTime() > epoch.getTime()).toBe(true);
    });

    it("never double-counts or fails when two prunes race", async () => {
      const racing = await Promise.all(Array.from({ length: 40 }, async () => await committed(aged(1))));
      const [first, second] = await Promise.all([
        asPruneRole((store) => store.pruneSucceeded(cutoff, 40, epoch)),
        asPruneRole((store) => store.pruneSucceeded(cutoff, 40, epoch)),
      ]);
      expect(first + second).toBe(racing.length);
      expect(await remaining()).toEqual([]);
    });
  });

  it("redacts failure details on dead-lettered records", async () => {
    const sql = postgres(databaseUrl!, { max: 1, prepare: false });
    const store = new PostgresOutboxStore(databaseUrl!);
    const message = envelope();
    try {
      await store.append(message);
      await sql`update outbox_message set status='leased' where id=${message.id}`;
      const error = new Error("sk_sensitive-provider-key");
      error.name = "Secret sk_sensitive-provider-key";
      await store.fail(message.id, error, 1);
      expect((await sql`select status, last_error from outbox_message where id=${message.id}`)[0]).toEqual({ status: "dead", last_error: "Error" });
    } finally {
      await sql`delete from outbox_message where id=${message.id}`;
      await store.close();
      await sql.end();
    }
  });
});
