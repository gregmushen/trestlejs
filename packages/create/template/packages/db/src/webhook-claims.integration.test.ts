import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { createTenantDatabase } from "./index.js";
import { claimNativeWebhookDelivery } from "./webhook-claims.js";
import { loadNativeWebhookAttempt } from "./webhook-native.js";
import { dueNativeWebhookWakeups } from "./webhook-recovery.js";
import { settleNativeWebhookAttempt } from "./webhook-settlement.js";

const databaseUrl = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const sql = databaseUrl ? postgres(databaseUrl, { max: 2, prepare: false }) : undefined;
const endpointIds: string[] = [];
const messageIds: string[] = [];
const deliveryIds: string[] = [];
const tenantDatabase = (organizationId: string) => createTenantDatabase(databaseUrl!, "postgres-js", organizationId);
const initialTime = new Date("2026-09-22T12:00:00.000Z");

async function fixture(organizationId: string, options: { provider?: "native" | "local"; state?: "active" | "paused"; dueAt?: Date; endpointId?: string } = {}) {
  const [endpoint] = options.endpointId ? [{ id: options.endpointId }] : await sql!<{ id: string }[]>`insert into webhook_endpoint (organization_id, environment, name, destination_url, state, provider, created_by, updated_by) values (${organizationId}, 'preview', ${crypto.randomUUID()}, 'https://example.com/hook', ${options.state ?? "active"}, ${options.provider ?? "native"}, 'test-user', 'test-user') returning id`;
  if (!endpoint) throw new Error("Endpoint fixture failed");
  const messageId = `whm_claim_${crypto.randomUUID()}`;
  const deliveryId = `whd_claim_${crypto.randomUUID()}`;
  if (!options.endpointId) endpointIds.push(endpoint.id);
  messageIds.push(messageId);
  deliveryIds.push(deliveryId);
  const sourceEventId = crypto.randomUUID();
  await sql!`insert into webhook_message (id, organization_id, source_event_id, public_event_type, public_version, occurred_at, resource_type, resource_id, envelope, payload_size, retention_class, entitlement_decision, status, correlation_id) values (${messageId}, ${organizationId}, ${sourceEventId}, 'article.published', 1, ${initialTime}, 'article', 'article-1', ${sql!.json({ id: messageId })}, 2, 'standard', 'not_required', 'ready', ${crypto.randomUUID()})`;
  await sql!`insert into webhook_delivery (id, organization_id, message_id, endpoint_id, next_attempt_at) values (${deliveryId}, ${organizationId}, ${messageId}, ${endpoint.id}, ${options.dueAt ?? initialTime})`;
  return { endpointId: endpoint.id, deliveryId, sourceEventId };
}

suite("native webhook delivery leases", () => {
  afterAll(async () => {
    if (deliveryIds.length) await sql!`delete from webhook_attempt where delivery_id = any(${deliveryIds})`;
    if (deliveryIds.length) await sql!`delete from webhook_delivery where id = any(${deliveryIds})`;
    if (messageIds.length) await sql!`delete from webhook_message where id = any(${messageIds})`;
    if (endpointIds.length) await sql!`delete from webhook_endpoint where id = any(${endpointIds})`;
    await sql!.end();
  });

  it("lets only one duplicate wake-up claim a due delivery", async () => {
    const { deliveryId } = await fixture("claim-duplicate");
    const input = { organizationId: "claim-duplicate", deliveryId, tenantDatabase, clock: { now: () => initialTime } };
    const results = await Promise.all([claimNativeWebhookDelivery(input), claimNativeWebhookDelivery(input)]);
    expect(results.map((result) => result.state).sort()).toEqual(["leased", "not_due"]);
    const leased = results.find((result) => result.state === "leased");
    expect(leased).toMatchObject({ attemptNumber: 1, leasedUntil: new Date(initialTime.getTime() + 30_000) });
    const [row] = await sql!`select state, lease_token, leased_until, attempt_count from webhook_delivery where id=${deliveryId}`;
    expect(row).toMatchObject({ state: "leased", lease_token: leased?.state === "leased" ? leased.leaseToken : undefined, attempt_count: 0 });
  });

  it("bounds simultaneous leases per endpoint across competing workers", async () => {
    const organizationId = "claim-capacity";
    const first = await fixture(organizationId);
    const deliveries = [first, ...await Promise.all(Array.from({ length: 6 }, () => fixture(organizationId, { endpointId: first.endpointId })))];
    const results = await Promise.all(deliveries.map(({ deliveryId }) => claimNativeWebhookDelivery({
      organizationId, deliveryId, tenantDatabase, clock: { now: () => initialTime },
    })));
    expect(results.filter((result) => result.state === "leased")).toHaveLength(4);
    expect(results.filter((result) => result.state === "capacity")).toHaveLength(3);
    const [active] = await sql!<{ active: number }[]>`select count(*)::int as active from webhook_delivery where endpoint_id=${first.endpointId} and state='leased'`;
    expect(active?.active).toBe(4);
    const winner = results.find((result) => result.state === "leased");
    const waiting = results.findIndex((result) => result.state === "capacity");
    if (winner?.state !== "leased" || waiting < 0) throw new Error("Expected leased and deferred deliveries");
    await settleNativeWebhookAttempt({ organizationId, deliveryId: winner.deliveryId, leaseToken: winner.leaseToken, tenantDatabase,
      clock: { now: () => new Date(initialTime.getTime() + 1) }, result: { kind: "response", status: 204 }, durationMs: 1 });
    expect((await claimNativeWebhookDelivery({ organizationId, deliveryId: deliveries[waiting]!.deliveryId, tenantDatabase,
      clock: { now: () => new Date(initialTime.getTime() + 1) } })).state).toBe("leased");
    await expect(claimNativeWebhookDelivery({ organizationId, deliveryId: deliveries[waiting]!.deliveryId, tenantDatabase,
      clock: { now: () => initialTime }, maxActivePerEndpoint: 0 })).rejects.toThrow("endpoint concurrency limit");
  });

  it("bounds one tenant across competing endpoints without throttling another tenant", async () => {
    const organizationId = "claim-tenant-capacity";
    const deliveries = await Promise.all(Array.from({ length: 5 }, () => fixture(organizationId)));
    const other = await fixture("claim-other-capacity");
    const clock = { now: () => initialTime };
    const claim = (deliveryId: string, tenant = organizationId) => claimNativeWebhookDelivery({
      organizationId: tenant, deliveryId, tenantDatabase, clock, maxActivePerTenant: 2,
    });
    const results = await Promise.all([...deliveries.map(({ deliveryId }) => claim(deliveryId)), claim(other.deliveryId, "claim-other-capacity")]);
    expect(results.slice(0, 5).filter((result) => result.state === "leased")).toHaveLength(2);
    expect(results.slice(0, 5).filter((result) => result.state === "capacity")).toHaveLength(3);
    expect(results[5]?.state).toBe("leased");
    const [active] = await sql!<{ active: number }[]>`select count(*)::int as active from webhook_delivery where organization_id=${organizationId} and state='leased'`;
    expect(active?.active).toBe(2);
    const winner = results.slice(0, 5).find((result) => result.state === "leased");
    const waiting = results.slice(0, 5).findIndex((result) => result.state === "capacity");
    if (winner?.state !== "leased" || waiting < 0) throw new Error("Expected leased and deferred tenant deliveries");
    await settleNativeWebhookAttempt({ organizationId, deliveryId: winner.deliveryId, leaseToken: winner.leaseToken, tenantDatabase,
      clock: { now: () => new Date(initialTime.getTime() + 1) }, result: { kind: "response", status: 204 }, durationMs: 1 });
    expect((await claimNativeWebhookDelivery({ organizationId, deliveryId: deliveries[waiting]!.deliveryId, tenantDatabase,
      clock: { now: () => new Date(initialTime.getTime() + 1) }, maxActivePerTenant: 2 })).state).toBe("leased");
    await expect(claimNativeWebhookDelivery({ organizationId, deliveryId: deliveries[waiting]!.deliveryId, tenantDatabase,
      clock, maxActivePerTenant: 0 })).rejects.toThrow("tenant concurrency limit");
  });

  it("recovers due work and expired leases without crossing tenant or environment", async () => {
    const organizationId = "claim-recovery";
    const due = await fixture(organizationId);
    const future = await fixture(organizationId, { dueAt: new Date(initialTime.getTime() + 60_000) });
    const local = await fixture(organizationId, { provider: "local" });
    const paused = await fixture(organizationId, { state: "paused" });
    const scan = (tenant: string, now: Date) => dueNativeWebhookWakeups({ organizationId: tenant, environment: "preview", tenantDatabase, now });
    expect(await scan("another-tenant", initialTime)).toEqual([]);
    expect(await dueNativeWebhookWakeups({ organizationId, environment: "staging", tenantDatabase, now: initialTime })).toEqual([]);
    expect(await scan(organizationId, initialTime)).toEqual([{ sourceEventId: due.sourceEventId, deliveryId: due.deliveryId }]);
    const first = await claimNativeWebhookDelivery({ organizationId, deliveryId: due.deliveryId, tenantDatabase, clock: { now: () => initialTime }, leaseMs: 1_000 });
    expect(first.state).toBe("leased");
    expect(await scan(organizationId, new Date(initialTime.getTime() + 999))).toEqual([]);
    expect(await scan(organizationId, new Date(initialTime.getTime() + 1_000))).toEqual([{ sourceEventId: due.sourceEventId, deliveryId: due.deliveryId }]);
    await sql!`update webhook_message set payload_deleted_at=${new Date(initialTime.getTime() + 1_000)}, envelope=null where source_event_id=${due.sourceEventId}`;
    expect(await scan(organizationId, new Date(initialTime.getTime() + 1_000))).toEqual([]);
    await expect(dueNativeWebhookWakeups({ organizationId, environment: "preview", tenantDatabase, now: initialTime, limit: 0 })).rejects.toThrow("page size");
    expect(future.deliveryId).not.toBe(due.deliveryId);
    expect(local.deliveryId).not.toBe(due.deliveryId);
    expect(paused.deliveryId).not.toBe(due.deliveryId);
  });

  it("reclaims an expired lease with a new token, never a live one", async () => {
    const { deliveryId } = await fixture("claim-expired");
    const at = (milliseconds: number) => ({ now: () => new Date(initialTime.getTime() + milliseconds) });
    const base = { organizationId: "claim-expired", deliveryId, tenantDatabase, leaseMs: 1_000 };
    const first = await claimNativeWebhookDelivery({ ...base, clock: at(0) });
    expect(first.state).toBe("leased");
    expect(await claimNativeWebhookDelivery({ ...base, clock: at(999) })).toEqual({ state: "not_due" });
    const recovered = await claimNativeWebhookDelivery({ ...base, clock: at(1_000) });
    expect(recovered.state).toBe("leased");
    if (first.state !== "leased" || recovered.state !== "leased") throw new Error("Expected both claims");
    expect(recovered.leaseToken).not.toBe(first.leaseToken);
    expect(recovered.attemptNumber).toBe(1);
  });

  it("fails closed for another tenant, inactive or local endpoints, and future work", async () => {
    const native = await fixture("claim-owner");
    const paused = await fixture("claim-paused", { state: "paused" });
    const local = await fixture("claim-local", { provider: "local" });
    const future = await fixture("claim-future", { dueAt: new Date(initialTime.getTime() + 60_000) });
    const claim = (organizationId: string, deliveryId: string) => claimNativeWebhookDelivery({ organizationId, deliveryId, tenantDatabase, clock: { now: () => initialTime } });
    expect(await claim("other-tenant", native.deliveryId)).toEqual({ state: "not_found" });
    expect(await claim("claim-paused", paused.deliveryId)).toEqual({ state: "inactive" });
    expect(await claim("claim-local", local.deliveryId)).toEqual({ state: "not_native" });
    expect(await claim("claim-future", future.deliveryId)).toEqual({ state: "not_due" });
    expect((await sql!`select state from webhook_delivery where id in (${native.deliveryId},${paused.deliveryId},${local.deliveryId},${future.deliveryId})`).every((row) => row.state === "pending")).toBe(true);
  });

  it("enforces the database lease invariant and rejects invalid clock or duration", async () => {
    const { deliveryId } = await fixture("claim-invalid");
    const base = { organizationId: "claim-invalid", deliveryId, tenantDatabase };
    await expect(claimNativeWebhookDelivery({ ...base, clock: { now: () => initialTime }, leaseMs: 999 })).rejects.toThrow("lease duration");
    await expect(claimNativeWebhookDelivery({ ...base, clock: { now: () => new Date("invalid") } })).rejects.toThrow("clock");
    await expect(sql!`update webhook_delivery set state='leased' where id=${deliveryId}`).rejects.toThrow();
    expect((await sql!`select relforcerowsecurity from pg_class where relname='webhook_delivery'`)[0]?.relforcerowsecurity).toBe(true);
  });

  it("records success atomically without retaining native request bodies or signatures", async () => {
    const { deliveryId } = await fixture("settle-success");
    const claim = await claimNativeWebhookDelivery({ organizationId: "settle-success", deliveryId, tenantDatabase, clock: { now: () => initialTime } });
    if (claim.state !== "leased") throw new Error("Expected lease");
    const input = { organizationId: "settle-success", deliveryId, leaseToken: claim.leaseToken, tenantDatabase, clock: { now: () => new Date(initialTime.getTime() + 250) }, result: { kind: "response" as const, status: 204 }, durationMs: 250 };
    expect(await settleNativeWebhookAttempt(input)).toEqual({ state: "succeeded", attemptId: `${deliveryId}.1`, attemptNumber: 1, nextRetryAt: null });
    expect(await settleNativeWebhookAttempt(input)).toEqual({ state: "stale" });
    expect((await sql!`select state, attempt_count, lease_token, leased_until, next_attempt_at, completed_at from webhook_delivery where id=${deliveryId}`)[0]).toMatchObject({ state: "succeeded", attempt_count: 1, lease_token: null, leased_until: null, next_attempt_at: null, completed_at: new Date(initialTime.getTime() + 250) });
    expect((await sql!`select kind, request_url, request_headers, request_body, simulated_status, response_status, result_category, outcome, duration_ms from webhook_attempt where delivery_id=${deliveryId}`)[0]).toEqual({ kind: "native", request_url: null, request_headers: {}, request_body: null, simulated_status: null, response_status: 204, result_category: "http", outcome: "succeeded", duration_ms: 250 });
  });

  it("retries non-2xx without redirects and treats 410 as terminal", async () => {
    const { deliveryId } = await fixture("settle-retry");
    const first = await claimNativeWebhookDelivery({ organizationId: "settle-retry", deliveryId, tenantDatabase, clock: { now: () => initialTime } });
    if (first.state !== "leased") throw new Error("Expected lease");
    const now = new Date(initialTime.getTime() + 100);
    const retried = await settleNativeWebhookAttempt({ organizationId: "settle-retry", deliveryId, leaseToken: first.leaseToken, tenantDatabase, clock: { now: () => now }, result: { kind: "response", status: 302 }, durationMs: 100 });
    expect(retried).toMatchObject({ state: "retry", attemptNumber: 1 });
    if (retried.state !== "retry" || !retried.nextRetryAt) throw new Error("Expected retry time");
    expect(retried.nextRetryAt.getTime() - now.getTime()).toBeGreaterThanOrEqual(27_000);
    expect(retried.nextRetryAt.getTime() - now.getTime()).toBeLessThanOrEqual(33_000);
    expect(await claimNativeWebhookDelivery({ organizationId: "settle-retry", deliveryId, tenantDatabase, clock: { now: () => now } })).toEqual({ state: "not_due" });
    const second = await claimNativeWebhookDelivery({ organizationId: "settle-retry", deliveryId, tenantDatabase, clock: { now: () => retried.nextRetryAt! } });
    if (second.state !== "leased") throw new Error("Expected second lease");
    expect(second.attemptNumber).toBe(2);
    expect(await settleNativeWebhookAttempt({ organizationId: "settle-retry", deliveryId, leaseToken: second.leaseToken, tenantDatabase, clock: { now: () => new Date(retried.nextRetryAt!.getTime() + 1) }, result: { kind: "response", status: 410 }, durationMs: 1 })).toMatchObject({ state: "dead", attemptNumber: 2, nextRetryAt: null });
    expect((await sql!`select state, terminal_reason from webhook_delivery where id=${deliveryId}`)[0]).toEqual({ state: "dead", terminal_reason: "http_410" });
    expect((await sql!`select response_status, outcome from webhook_attempt where delivery_id=${deliveryId} order by attempt_number`)).toEqual([{ response_status: 302, outcome: "retry" }, { response_status: 410, outcome: "dead" }]);
  });

  it("exhausts bounded failures and refuses a stale or cross-tenant settlement", async () => {
    const { deliveryId } = await fixture("settle-exhausted");
    const base = { organizationId: "settle-exhausted", deliveryId, tenantDatabase, maxAttempts: 2 };
    const first = await claimNativeWebhookDelivery({ ...base, clock: { now: () => initialTime }, leaseMs: 1_000 });
    if (first.state !== "leased") throw new Error("Expected lease");
    const recovered = await claimNativeWebhookDelivery({ ...base, clock: { now: () => new Date(initialTime.getTime() + 1_000) }, leaseMs: 1_000 });
    if (recovered.state !== "leased") throw new Error("Expected recovery");
    expect(await settleNativeWebhookAttempt({ ...base, leaseToken: first.leaseToken, clock: { now: () => new Date(initialTime.getTime() + 1_001) }, result: { kind: "failure", category: "timeout" }, durationMs: 1_000 })).toEqual({ state: "stale" });
    expect(await settleNativeWebhookAttempt({ ...base, organizationId: "another-tenant", leaseToken: recovered.leaseToken, clock: { now: () => new Date(initialTime.getTime() + 1_001) }, result: { kind: "failure", category: "timeout" }, durationMs: 1_000 })).toEqual({ state: "stale" });
    const retry = await settleNativeWebhookAttempt({ ...base, leaseToken: recovered.leaseToken, clock: { now: () => new Date(initialTime.getTime() + 1_001) }, result: { kind: "failure", category: "timeout" }, durationMs: 1_000 });
    if (retry.state !== "retry" || !retry.nextRetryAt) throw new Error("Expected retry");
    const second = await claimNativeWebhookDelivery({ ...base, clock: { now: () => retry.nextRetryAt! } });
    if (second.state !== "leased") throw new Error("Expected next lease");
    expect(await settleNativeWebhookAttempt({ ...base, leaseToken: second.leaseToken, clock: { now: () => new Date(retry.nextRetryAt!.getTime() + 1) }, result: { kind: "failure", category: "blocked_address" }, durationMs: 1 })).toMatchObject({ state: "exhausted", attemptNumber: 2, nextRetryAt: null });
    expect((await sql!`select state, terminal_reason, attempt_count from webhook_delivery where id=${deliveryId}`)[0]).toEqual({ state: "exhausted", terminal_reason: "retry_exhausted:blocked_address", attempt_count: 2 });
    expect((await sql!`select result_category, outcome from webhook_attempt where delivery_id=${deliveryId} order by attempt_number`)).toEqual([{ result_category: "timeout", outcome: "retry" }, { result_category: "blocked_address", outcome: "exhausted" }]);
  });

  it("rejects invalid results before mutation and rolls back a conflicting attempt", async () => {
    const { deliveryId } = await fixture("settle-invalid");
    const claimed = await claimNativeWebhookDelivery({ organizationId: "settle-invalid", deliveryId, tenantDatabase, clock: { now: () => initialTime } });
    if (claimed.state !== "leased") throw new Error("Expected lease");
    const base = { organizationId: "settle-invalid", deliveryId, leaseToken: claimed.leaseToken, tenantDatabase, clock: { now: () => initialTime }, durationMs: 0 };
    await expect(settleNativeWebhookAttempt({ ...base, result: { kind: "response", status: 700 } })).rejects.toThrow("HTTP status");
    await expect(settleNativeWebhookAttempt({ ...base, result: { kind: "failure", category: "network" }, durationMs: -1 })).rejects.toThrow("duration");
    await expect(settleNativeWebhookAttempt({ ...base, leaseToken: "invalid", result: { kind: "response", status: 200 } })).rejects.toThrow("lease token");
    await expect(settleNativeWebhookAttempt({ ...base, result: { kind: "response", status: 200 }, maxAttempts: 8 })).rejects.toThrow("maximum attempt");
    expect((await sql!`select state, attempt_count from webhook_delivery where id=${deliveryId}`)[0]).toEqual({ state: "leased", attempt_count: 0 });
    await sql!`insert into webhook_attempt (id, organization_id, delivery_id, attempt_number, kind, attempted_at, completed_at, request_headers, outcome, duration_ms) values (${`${deliveryId}.1`}, 'settle-invalid', ${deliveryId}, 1, 'native', ${initialTime}, ${initialTime}, ${sql!.json({})}, 'retry', 0)`;
    await expect(settleNativeWebhookAttempt({ ...base, result: { kind: "response", status: 200 } })).rejects.toThrow();
    expect((await sql!`select state, attempt_count from webhook_delivery where id=${deliveryId}`)[0]).toEqual({ state: "leased", attempt_count: 0 });
  });

  it("loads a payload only for the current tenant-bound live lease", async () => {
    const { endpointId, deliveryId } = await fixture("load-native");
    const claimed = await claimNativeWebhookDelivery({ organizationId: "load-native", deliveryId, tenantDatabase, clock: { now: () => initialTime }, leaseMs: 1_000 });
    if (claimed.state !== "leased") throw new Error("Expected lease");
    const base = { organizationId: "load-native", deliveryId, leaseToken: claimed.leaseToken, environment: "preview" as const, tenantDatabase, clock: { now: () => initialTime } };
    expect(await loadNativeWebhookAttempt(base)).toMatchObject({ endpointId, destinationUrl: "https://example.com/hook", body: expect.stringContaining("whm_claim_") });
    expect(await loadNativeWebhookAttempt({ ...base, organizationId: "another-tenant" })).toBeNull();
    expect(await loadNativeWebhookAttempt({ ...base, leaseToken: crypto.randomUUID() })).toBeNull();
    expect(await loadNativeWebhookAttempt({ ...base, environment: "staging" })).toBeNull();
    expect(await loadNativeWebhookAttempt({ ...base, clock: { now: () => new Date(initialTime.getTime() + 1_000) } })).toBeNull();
    await sql!`update webhook_message set envelope=null, payload_deleted_at=${initialTime} where id=(select message_id from webhook_delivery where id=${deliveryId})`;
    expect(await loadNativeWebhookAttempt(base)).toBeNull();
  });
});
