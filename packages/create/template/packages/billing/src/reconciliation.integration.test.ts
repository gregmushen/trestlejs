import { requestBillingSubscriptionReconciliation } from "@__TRESTLE_PROJECT_NAME__/db";
import { BillingProviderUnavailable, BillingSubscriptionNotFound, InMemoryLocalBillingProvider, LocalBillingAdapter, retrieveCurrentLocalSubscription, type LocalProviderSubscription, type NormalizedBillingEvent } from "@__TRESTLE_PROJECT_NAME__/integrations";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { planEntitlements } from "./plans.js";
import { createLocalBillingNotifier, PostgresLocalBillingProvider, reconcileBillingSubscription, type BillingSubscriptionLookup } from "./reconciliation.js";
import { PostgresBillingProjectionRepository } from "./repository.js";

const databaseUrl = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const sql = databaseUrl ? postgres(databaseUrl, { max: 4, prepare: false }) : undefined;
const organizationIds: string[] = [];
const subscriptionIds: string[] = [];
const eventIds: string[] = [];
const driver = "postgres-js" as const;

const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

/** A deterministic stand-in for the provider: its state is canonical, and a
 * lookup can be held open or failed to model slow or unavailable providers. */
class FixtureProvider {
  readonly store = new InMemoryLocalBillingProvider();
  readonly calls: string[] = [];
  private gates: Array<{ wait: Promise<void> }> = [];
  private failures: Error[] = [];
  set(value: Omit<LocalProviderSubscription, "provider">) { return this.store.put({ provider: "stripe", ...value }); }
  /** The next lookup reads current state, then waits until the gate opens before answering. */
  hold(): () => void {
    let open!: () => void;
    this.gates.push({ wait: new Promise<void>((resolve) => { open = resolve; }) });
    return () => open();
  }
  fail(error: Error) { this.failures.push(error); }
  readonly lookup: BillingSubscriptionLookup = async (request) => {
    this.calls.push(request.providerSubscriptionId);
    const failure = this.failures.shift();
    if (failure) throw failure;
    const current = await retrieveCurrentLocalSubscription(this.store, { id: request.providerEventId, type: request.type,
      providerSubscriptionId: request.providerSubscriptionId, occurredAt: request.occurredAt }, "stripe");
    const gate = this.gates.shift();
    if (gate) await gate.wait;
    return current;
  };
}

function tenant() {
  const organizationId = id("billing_rec");
  const providerSubscriptionId = id("sub");
  organizationIds.push(organizationId);
  subscriptionIds.push(providerSubscriptionId);
  return { organizationId, providerSubscriptionId };
}

/** Record a verified notification. `occurredAt` is the provider's event time: the
 * durable request deliberately ignores it, since provider timestamps can tie or arrive out of order. */
async function receive(providerSubscriptionId: string, input: { eventId?: string; type?: NormalizedBillingEvent["type"]; occurredAt?: Date; provider?: string } = {}) {
  const providerEventId = input.eventId ?? id("evt");
  eventIds.push(providerEventId);
  return { providerEventId, result: await requestBillingSubscriptionReconciliation({ databaseUrl: databaseUrl!, driver,
    provider: input.provider ?? "stripe", providerEventId, providerSubscriptionId, type: input.type ?? "SubscriptionUpdated",
    correlationId: `corr-${providerEventId}` }) };
}

function reconcile(provider: FixtureProvider, providerSubscriptionId: string, options: { leaseMs?: number; maxPasses?: number } = {}) {
  return reconcileBillingSubscription({ databaseUrl: databaseUrl!, driver, provider: "stripe", providerSubscriptionId, lookup: provider.lookup, ...options });
}

async function projection(organizationId: string) {
  const [subscription] = await sql!`select provider_subscription_id, plan, status, cancel_at_period_end from organization_subscription where organization_id=${organizationId}`;
  const entitlements = (await sql!`select entitlement from organization_entitlement where organization_id=${organizationId} order by entitlement`).map((row) => row.entitlement as string);
  return { subscription: subscription ?? null, entitlements };
}

async function cursor(providerSubscriptionId: string, provider = "stripe") {
  const [row] = await sql!`select generation, reconciled_generation, lease_token, last_outcome, last_error from billing_subscription_reconciliation where provider=${provider} and provider_subscription_id=${providerSubscriptionId}`;
  return row ? { ...row, generation: Number(row.generation), reconciled_generation: Number(row.reconciled_generation) } : null;
}

async function receipt(providerEventId: string, provider = "stripe") {
  return (await sql!`select status, error from billing_provider_event where provider=${provider} and provider_event_id=${providerEventId}`)[0] ?? null;
}

async function expireLease(providerSubscriptionId: string) {
  await sql!`update billing_subscription_reconciliation set lease_expires_at = now() - interval '1 second' where provider='stripe' and provider_subscription_id=${providerSubscriptionId}`;
}

const active = (organizationId: string, plan = "pro") => ({ organizationId, plan, status: "active" as const, cancelAtPeriodEnd: false, providerCustomerId: "cus_fixture" });

suite("durable billing subscription reconciliation", () => {
  afterAll(async () => {
    if (organizationIds.length) {
      await sql!`delete from organization_entitlement_override where organization_id = any(${organizationIds})`;
      await sql!`delete from organization_entitlement where organization_id = any(${organizationIds})`;
      await sql!`delete from organization_subscription where organization_id = any(${organizationIds})`;
      await sql!`delete from outbox_message where organization_id = any(${organizationIds})`;
      await sql!`delete from billing_local_subscription where organization_id = any(${organizationIds})`;
    }
    if (subscriptionIds.length) {
      await sql!`delete from outbox_message where event_name='billing.subscription.reconciliation_requested' and payload->>'providerSubscriptionId' = any(${subscriptionIds})`;
      await sql!`delete from billing_provider_event where provider_subscription_id = any(${subscriptionIds})`;
      await sql!`delete from billing_subscription_reconciliation where provider_subscription_id = any(${subscriptionIds})`;
      await sql!`delete from billing_subscription_ownership where provider_subscription_id = any(${subscriptionIds})`;
    }
    await sql!.end();
  });

  it("commits a receipt and a tenantless reconciliation request without contacting the provider", async () => {
    const { organizationId, providerSubscriptionId } = tenant();
    const provider = new FixtureProvider();
    await provider.set({ providerSubscriptionId, ...active(organizationId) });
    const { providerEventId, result } = await receive(providerSubscriptionId);
    expect(result).toMatchObject({ duplicate: false, generation: 1 });
    expect(provider.calls).toEqual([]);
    expect(await receipt(providerEventId)).toEqual({ status: "received", error: null });
    expect(await cursor(providerSubscriptionId)).toMatchObject({ generation: 1, reconciled_generation: 0, lease_token: null });
    const requests = await sql!`select event_name, organization_id, resource_type, resource_id, causation_id, correlation_id, payload from outbox_message where idempotency_key=${`billing-reconcile:stripe:${providerEventId}`}`;
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ event_name: "billing.subscription.reconciliation_requested", organization_id: null,
      resource_type: "billing_subscription", resource_id: `stripe:${providerSubscriptionId}`, causation_id: providerEventId,
      correlation_id: `corr-${providerEventId}`, payload: { provider: "stripe", providerSubscriptionId, providerEventId, generation: 1 } });
    expect(JSON.stringify(requests[0]?.payload)).not.toContain(organizationId);
    expect(await projection(organizationId)).toEqual({ subscription: null, entitlements: [] });
  });

  it("records a redelivered receipt once and acknowledges it as a duplicate after reconciliation", async () => {
    const { organizationId, providerSubscriptionId } = tenant();
    const provider = new FixtureProvider();
    await provider.set({ providerSubscriptionId, ...active(organizationId) });
    const first = await receive(providerSubscriptionId);
    const again = await receive(providerSubscriptionId, { eventId: first.providerEventId });
    expect(again.result).toMatchObject({ duplicate: false, generation: 1 });
    expect(await cursor(providerSubscriptionId)).toMatchObject({ generation: 1 });
    expect(await sql!`select id from outbox_message where idempotency_key=${`billing-reconcile:stripe:${first.providerEventId}`}`).toHaveLength(1);
    expect(await reconcile(provider, providerSubscriptionId)).toEqual({ state: "idle", outcomes: ["applied"] });
    expect((await receive(providerSubscriptionId, { eventId: first.providerEventId })).result).toEqual({ duplicate: true });
    expect(await reconcile(provider, providerSubscriptionId)).toEqual({ state: "idle", outcomes: [] });
    expect(provider.calls).toHaveLength(1);
    expect(await sql!`select id from outbox_message where idempotency_key=${`billing:stripe:${first.providerEventId}`}`).toHaveLength(1);
  });

  it("assigns distinct generations to concurrent receipts for one subscription", async () => {
    const { providerSubscriptionId } = tenant();
    const [first, second] = await Promise.all([receive(providerSubscriptionId), receive(providerSubscriptionId)]);
    const generations = [first.result, second.result].map((result) => (result.duplicate ? 0 : result.generation)).sort();
    expect(generations).toEqual([1, 2]);
  });

  for (const order of ["older first", "newer first"] as const) {
    it(`converges on current provider state when events arrive ${order}`, async () => {
      const { organizationId, providerSubscriptionId } = tenant();
      const provider = new FixtureProvider();
      const older = { eventId: id("evt"), type: "SubscriptionActivated" as const, occurredAt: new Date("2026-09-25T00:00:00.000Z") };
      const newer = { eventId: id("evt"), type: "SubscriptionCancelled" as const, occurredAt: new Date("2026-09-25T00:05:00.000Z") };
      // The provider has already moved to the newest state when either notification is handled.
      await provider.set({ providerSubscriptionId, ...active(organizationId), status: "cancelled", cancelAtPeriodEnd: true });
      for (const event of order === "older first" ? [older, newer] : [newer, older]) {
        await receive(providerSubscriptionId, event);
        await reconcile(provider, providerSubscriptionId);
      }
      expect(await projection(organizationId)).toEqual({ subscription: expect.objectContaining({ status: "cancelled" }), entitlements: [] });
      expect(await cursor(providerSubscriptionId)).toMatchObject({ generation: 2, reconciled_generation: 2, lease_token: null });
      expect(await receipt(older.eventId)).toMatchObject({ status: "processed" });
      expect(await receipt(newer.eventId)).toMatchObject({ status: "processed" });
    });
  }

  it("orders by durable generation, not timestamps, when two receipts share a timestamp", async () => {
    const { organizationId, providerSubscriptionId } = tenant();
    const provider = new FixtureProvider();
    const occurredAt = new Date("2026-09-25T01:00:00.000Z");
    await provider.set({ providerSubscriptionId, ...active(organizationId, "starter") });
    const first = await receive(providerSubscriptionId, { occurredAt });
    await provider.set({ providerSubscriptionId, ...active(organizationId, "business") });
    const second = await receive(providerSubscriptionId, { occurredAt });
    expect(await reconcile(provider, providerSubscriptionId)).toEqual({ state: "idle", outcomes: ["applied"] });
    expect((await projection(organizationId)).subscription).toMatchObject({ plan: "business" });
    expect(await receipt(first.providerEventId)).toMatchObject({ status: "superseded" });
    expect(await receipt(second.providerEventId)).toMatchObject({ status: "processed" });
    expect(await sql!`select id from outbox_message where idempotency_key=${`billing:stripe:${first.providerEventId}`}`).toHaveLength(0);
    expect((await sql!`select event_name, correlation_id, payload from outbox_message where idempotency_key=${`billing:stripe:${second.providerEventId}`}`)[0])
      .toMatchObject({ event_name: "billing.subscription.updated", correlation_id: `corr-${second.providerEventId}`, payload: { plan: "business" } });
  });

  it("runs another pass when a receipt arrives while a reconciliation holds the lease", async () => {
    const { organizationId, providerSubscriptionId } = tenant();
    const provider = new FixtureProvider();
    await provider.set({ providerSubscriptionId, ...active(organizationId, "starter") });
    await receive(providerSubscriptionId);
    const release = provider.hold();
    const running = reconcile(provider, providerSubscriptionId);
    await waitFor(() => provider.calls.length === 1);
    await provider.set({ providerSubscriptionId, ...active(organizationId, "pro") });
    const late = await receive(providerSubscriptionId);
    expect(await reconcile(provider, providerSubscriptionId)).toEqual({ state: "busy", outcomes: [] });
    release();
    expect(await running).toEqual({ state: "idle", outcomes: ["applied", "applied"] });
    expect(provider.calls).toHaveLength(2);
    expect((await projection(organizationId)).subscription).toMatchObject({ plan: "pro" });
    expect(await receipt(late.providerEventId)).toMatchObject({ status: "processed" });
    expect(await cursor(providerSubscriptionId)).toMatchObject({ generation: 2, reconciled_generation: 2, lease_token: null });
  });

  it("fences a slow reconciliation after its lease expires and a newer one commits", async () => {
    const { organizationId, providerSubscriptionId } = tenant();
    const provider = new FixtureProvider();
    await provider.set({ providerSubscriptionId, ...active(organizationId, "business") });
    await receive(providerSubscriptionId);
    const release = provider.hold();
    const slow = reconcile(provider, providerSubscriptionId);
    await waitFor(() => provider.calls.length === 1);
    // The provider changes after the slow lookup read it; the slow worker then stalls past its lease.
    await provider.set({ providerSubscriptionId, ...active(organizationId), status: "cancelled", cancelAtPeriodEnd: true });
    await receive(providerSubscriptionId, { type: "SubscriptionCancelled" });
    await expireLease(providerSubscriptionId);
    expect(await reconcile(provider, providerSubscriptionId)).toEqual({ state: "idle", outcomes: ["applied"] });
    release();
    expect(await slow).toEqual({ state: "fenced", outcomes: ["fenced"] });
    expect(await projection(organizationId)).toEqual({ subscription: expect.objectContaining({ status: "cancelled" }), entitlements: [] });
    expect(await cursor(providerSubscriptionId)).toMatchObject({ generation: 2, reconciled_generation: 2, lease_token: null });
  });

  it("keeps the last confirmed projection through provider failure and converges on retry", async () => {
    const { organizationId, providerSubscriptionId } = tenant();
    const provider = new FixtureProvider();
    await provider.set({ providerSubscriptionId, ...active(organizationId, "pro") });
    await receive(providerSubscriptionId);
    await reconcile(provider, providerSubscriptionId);
    const confirmed = await projection(organizationId);
    await provider.set({ providerSubscriptionId, ...active(organizationId), status: "past_due" });
    const failing = await receive(providerSubscriptionId, { type: "SubscriptionPastDue" });
    provider.fail(new BillingProviderUnavailable("private provider response body"));
    await expect(reconcile(provider, providerSubscriptionId)).rejects.toBeInstanceOf(BillingProviderUnavailable);
    expect(await projection(organizationId)).toEqual(confirmed);
    expect(await receipt(failing.providerEventId)).toEqual({ status: "failed", error: "provider_unavailable" });
    expect(await cursor(providerSubscriptionId)).toMatchObject({ generation: 2, reconciled_generation: 1, lease_token: null, last_error: "provider_unavailable" });
    expect(JSON.stringify(await sql!`select * from billing_subscription_reconciliation where provider_subscription_id=${providerSubscriptionId}`)).not.toContain("private provider response body");
    expect(await reconcile(provider, providerSubscriptionId)).toEqual({ state: "idle", outcomes: ["applied"] });
    expect(await projection(organizationId)).toEqual({ subscription: expect.objectContaining({ status: "past_due" }), entitlements: [] });
    expect(await receipt(failing.providerEventId)).toEqual({ status: "processed", error: null });
  });

  it("recovers work abandoned by a crashed reconciler once its lease expires", async () => {
    const { organizationId, providerSubscriptionId } = tenant();
    const provider = new FixtureProvider();
    await provider.set({ providerSubscriptionId, ...active(organizationId) });
    await receive(providerSubscriptionId);
    provider.hold(); // never released: this worker "crashes" while holding the lease
    void reconcile(provider, providerSubscriptionId).catch(() => undefined);
    await waitFor(() => provider.calls.length === 1);
    expect(await reconcile(provider, providerSubscriptionId)).toEqual({ state: "busy", outcomes: [] });
    await expireLease(providerSubscriptionId);
    expect(await reconcile(provider, providerSubscriptionId)).toEqual({ state: "idle", outcomes: ["applied"] });
    expect((await projection(organizationId)).subscription).toMatchObject({ status: "active", plan: "pro" });
  });

  it("commits the subscription and entitlements together or not at all", async () => {
    const { organizationId, providerSubscriptionId } = tenant();
    const provider = new FixtureProvider();
    await provider.set({ providerSubscriptionId, ...active(organizationId, "starter") });
    await receive(providerSubscriptionId);
    await reconcile(provider, providerSubscriptionId);
    const confirmed = await projection(organizationId);
    await provider.set({ providerSubscriptionId, ...active(organizationId, "pro") });
    const event = await receive(providerSubscriptionId);
    // Break the entitlement insert inside the projection transaction.
    await sql!`create or replace function billing_reconciliation_test_reject() returns trigger language plpgsql as $$ begin raise exception 'injected entitlement failure'; end $$`;
    await sql!`create trigger billing_reconciliation_test_reject before insert on organization_entitlement for each row when (new.organization_id = ${sql!.unsafe(`'${organizationId}'`)}) execute function billing_reconciliation_test_reject()`;
    try {
      await expect(reconcile(provider, providerSubscriptionId)).rejects.toThrow();
    } finally {
      await sql!`drop trigger billing_reconciliation_test_reject on organization_entitlement`;
      await sql!`drop function billing_reconciliation_test_reject()`;
    }
    expect(await projection(organizationId)).toEqual(confirmed);
    expect(await sql!`select id from outbox_message where idempotency_key=${`billing:stripe:${event.providerEventId}`}`).toHaveLength(0);
    expect(await cursor(providerSubscriptionId)).toMatchObject({ reconciled_generation: 1, lease_token: null, last_error: "projection_failed" });
    expect(await reconcile(provider, providerSubscriptionId)).toEqual({ state: "idle", outcomes: ["applied"] });
    expect((await projection(organizationId)).subscription).toMatchObject({ plan: "pro" });
  });

  it("applies cancellation, allows replacement, and ignores a delayed event from the replaced subscription", async () => {
    const { organizationId, providerSubscriptionId: oldSubscription } = tenant();
    const replacement = id("sub");
    subscriptionIds.push(replacement);
    const provider = new FixtureProvider();
    await provider.set({ providerSubscriptionId: oldSubscription, ...active(organizationId) });
    await receive(oldSubscription, { type: "SubscriptionActivated" });
    await reconcile(provider, oldSubscription);
    await provider.set({ providerSubscriptionId: oldSubscription, ...active(organizationId), status: "cancelled", cancelAtPeriodEnd: true });
    await receive(oldSubscription, { type: "SubscriptionCancelled" });
    expect(await reconcile(provider, oldSubscription)).toEqual({ state: "idle", outcomes: ["applied"] });
    expect(await projection(organizationId)).toEqual({ subscription: expect.objectContaining({ status: "cancelled" }), entitlements: [] });
    await provider.set({ providerSubscriptionId: replacement, ...active(organizationId, "starter") });
    await receive(replacement, { type: "SubscriptionActivated" });
    expect(await reconcile(provider, replacement)).toEqual({ state: "idle", outcomes: ["applied"] });
    // A late notification for the old subscription; even a stale provider answer must not reactivate it.
    await provider.set({ providerSubscriptionId: oldSubscription, ...active(organizationId, "business") });
    const delayed = await receive(oldSubscription, { type: "SubscriptionUpdated" });
    expect(await reconcile(provider, oldSubscription)).toEqual({ state: "idle", outcomes: ["superseded"] });
    expect((await projection(organizationId)).subscription).toMatchObject({ provider_subscription_id: replacement, plan: "starter", status: "active" });
    expect(await receipt(delayed.providerEventId)).toMatchObject({ status: "superseded" });
  });

  it("handles a deleted provider subscription as canceled and a missing one without touching the projection", async () => {
    const { organizationId, providerSubscriptionId } = tenant();
    const provider = new FixtureProvider();
    await provider.set({ providerSubscriptionId, ...active(organizationId) });
    await receive(providerSubscriptionId, { type: "SubscriptionActivated" });
    await reconcile(provider, providerSubscriptionId);
    const confirmed = await projection(organizationId);
    provider.fail(new BillingSubscriptionNotFound("no such subscription"));
    const missing = await receive(providerSubscriptionId);
    expect(await reconcile(provider, providerSubscriptionId)).toEqual({ state: "idle", outcomes: ["not_found"] });
    expect(await projection(organizationId)).toEqual(confirmed);
    expect(await receipt(missing.providerEventId)).toEqual({ status: "rejected", error: "provider_subscription_not_found" });
    expect((await receive(providerSubscriptionId, { eventId: missing.providerEventId })).result).toEqual({ duplicate: true });
    // customer.subscription.deleted: the provider reports it canceled.
    await provider.set({ providerSubscriptionId, ...active(organizationId), status: "cancelled", cancelAtPeriodEnd: false });
    await receive(providerSubscriptionId, { type: "SubscriptionCancelled" });
    expect(await reconcile(provider, providerSubscriptionId)).toEqual({ state: "idle", outcomes: ["applied"] });
    expect(await projection(organizationId)).toEqual({ subscription: expect.objectContaining({ status: "cancelled" }), entitlements: [] });
  });

  it("never lets an unknown mapping or another tenant's metadata touch a projection", async () => {
    const owner = tenant();
    const victim = tenant();
    const provider = new FixtureProvider();
    await provider.set({ providerSubscriptionId: victim.providerSubscriptionId, ...active(victim.organizationId, "starter") });
    await receive(victim.providerSubscriptionId);
    await reconcile(provider, victim.providerSubscriptionId);
    const victimBefore = await projection(victim.organizationId);
    await provider.set({ providerSubscriptionId: owner.providerSubscriptionId, ...active(owner.organizationId) });
    await receive(owner.providerSubscriptionId);
    await reconcile(provider, owner.providerSubscriptionId);
    const ownerBefore = await projection(owner.organizationId);
    // The provider now claims the owner's subscription belongs to the victim.
    await provider.set({ providerSubscriptionId: owner.providerSubscriptionId, ...active(victim.organizationId, "business") });
    const moved = await receive(owner.providerSubscriptionId);
    expect(await reconcile(provider, owner.providerSubscriptionId)).toEqual({ state: "idle", outcomes: ["ownership_conflict"] });
    expect(await receipt(moved.providerEventId)).toEqual({ status: "rejected", error: "ownership_conflict" });
    // An unmapped plan and a missing organization are rejected, not guessed.
    await provider.set({ providerSubscriptionId: owner.providerSubscriptionId, ...active(owner.organizationId, "enterprise-unknown") });
    const unknownPlan = await receive(owner.providerSubscriptionId);
    expect(await reconcile(provider, owner.providerSubscriptionId)).toEqual({ state: "idle", outcomes: ["unmapped"] });
    expect(await receipt(unknownPlan.providerEventId)).toEqual({ status: "rejected", error: "subscription_unmapped" });
    const orphan = id("sub");
    subscriptionIds.push(orphan);
    await provider.set({ providerSubscriptionId: orphan, plan: "pro", status: "active", cancelAtPeriodEnd: false });
    await receive(orphan);
    expect(await reconcile(provider, orphan)).toEqual({ state: "idle", outcomes: ["unmapped"] });
    expect(await projection(owner.organizationId)).toEqual(ownerBefore);
    expect(await projection(victim.organizationId)).toEqual(victimBefore);
    expect((await sql!`select organization_id from billing_subscription_ownership where provider_subscription_id=${owner.providerSubscriptionId}`)[0]?.organization_id).toBe(owner.organizationId);
  });

  it("preserves platform entitlement overrides across reconciliation", async () => {
    const { organizationId, providerSubscriptionId } = tenant();
    const provider = new FixtureProvider();
    await provider.set({ providerSubscriptionId, ...active(organizationId, "starter") });
    await receive(providerSubscriptionId);
    await reconcile(provider, providerSubscriptionId);
    await sql!`insert into organization_entitlement_override (organization_id, entitlement, enabled, reason, author_id, effective_at) values (${organizationId}, 'support.priority', true, 'contract', 'operator-1', now() - interval '1 minute')`;
    await provider.set({ providerSubscriptionId, ...active(organizationId, "pro") });
    await receive(providerSubscriptionId);
    await reconcile(provider, providerSubscriptionId);
    expect(await sql!`select entitlement, enabled, removed_at from organization_entitlement_override where organization_id=${organizationId}`)
      .toEqual([{ entitlement: "support.priority", enabled: true, removed_at: null }]);
    const summary = await new PostgresBillingProjectionRepository(databaseUrl!, driver).get(organizationId);
    expect(summary?.entitlements).toEqual(expect.arrayContaining(["support.priority", "workflows.advanced"]));
  });

  it("reconciles the local payment adapter through the same durable path", async () => {
    const organizationId = id("billing_local");
    organizationIds.push(organizationId);
    const store = new PostgresLocalBillingProvider(databaseUrl!, driver);
    const repository = new PostgresBillingProjectionRepository(databaseUrl!, driver);
    const notify = createLocalBillingNotifier({ databaseUrl: databaseUrl!, driver, store });
    const billing = new LocalBillingAdapter({ provider: store, repository, plans: planEntitlements, notify });
    const providerSubscriptionId = `sub_local_${organizationId}`;
    subscriptionIds.push(providerSubscriptionId);
    await billing.createCheckoutSession({ organizationId, plan: "starter", requestId: "local-1" });
    expect(await billing.getSubscription(organizationId)).toMatchObject({ provider: "local", providerSubscriptionId, plan: "starter", status: "active" });
    await billing.changePlan({ organizationId, plan: "pro", commandId: "change-1" });
    await billing.failPayment({ organizationId });
    expect(await billing.getSubscription(organizationId)).toMatchObject({ plan: "pro", status: "past_due", entitlements: [] });
    await billing.resumeSubscription({ organizationId, commandId: "resume-1" });
    await billing.cancel({ organizationId });
    expect(await billing.getSubscription(organizationId)).toMatchObject({ status: "cancelled", entitlements: [] });
    const receipts = await sql!`select status, reconciliation_generation from billing_provider_event where provider='local' and provider_subscription_id=${providerSubscriptionId} order by reconciliation_generation`;
    expect(receipts.map((row) => [row.status, Number(row.reconciliation_generation)])).toEqual([["processed", 1], ["processed", 2], ["processed", 3], ["processed", 4], ["processed", 5]]);
    expect(await cursor(providerSubscriptionId, "local")).toMatchObject({ generation: 5, reconciled_generation: 5, lease_token: null });
    expect(await sql!`select id from outbox_message where event_name='billing.subscription.reconciliation_requested' and payload->>'providerSubscriptionId'=${providerSubscriptionId}`).toHaveLength(5);
    expect((await sql!`select event_name from outbox_message where organization_id=${organizationId} order by occurred_at, event_name`).map((row) => row.event_name))
      .toEqual(expect.arrayContaining(["billing.subscription.activated", "billing.subscription.past_due", "billing.subscription.cancelled"]));
  });

  it("orders local adapter changes by durable generation even if a stale local lookup is slow", async () => {
    const organizationId = id("billing_local");
    organizationIds.push(organizationId);
    const providerSubscriptionId = `sub_local_${organizationId}`;
    subscriptionIds.push(providerSubscriptionId);
    const store = new PostgresLocalBillingProvider(databaseUrl!, driver);
    const repository = new PostgresBillingProjectionRepository(databaseUrl!, driver);
    // Record receipts durably, but leave reconciliation to the competing workers below.
    const billing = new LocalBillingAdapter({ provider: store, repository, plans: planEntitlements, notify: async (notification) => {
      eventIds.push(notification.providerEventId);
      await requestBillingSubscriptionReconciliation({ databaseUrl: databaseUrl!, driver, ...notification, correlationId: notification.providerEventId });
    } });
    await billing.activate({ organizationId, plan: "starter" });
    await billing.changePlan({ organizationId, plan: "business", commandId: "change-1" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let staleRead = false;
    const slowLookup: BillingSubscriptionLookup = async (request) => {
      const current = await retrieveCurrentLocalSubscription(store, { id: request.providerEventId, type: request.type, providerSubscriptionId: request.providerSubscriptionId, occurredAt: request.occurredAt });
      staleRead = true;
      await gate;
      return { ...current, plan: "starter" };
    };
    const local = (lookup: BillingSubscriptionLookup) => reconcileBillingSubscription({ databaseUrl: databaseUrl!, driver, provider: "local", providerSubscriptionId, lookup });
    const slow = local(slowLookup);
    await waitFor(() => staleRead);
    await sql!`update billing_subscription_reconciliation set lease_expires_at = now() - interval '1 second' where provider='local' and provider_subscription_id=${providerSubscriptionId}`;
    expect(await local(async (request) => await retrieveCurrentLocalSubscription(store, { id: request.providerEventId, type: request.type, providerSubscriptionId: request.providerSubscriptionId, occurredAt: request.occurredAt })))
      .toEqual({ state: "idle", outcomes: ["applied"] });
    release();
    expect(await slow).toEqual({ state: "fenced", outcomes: ["fenced"] });
    expect(await billing.getSubscription(organizationId)).toMatchObject({ plan: "business", status: "active" });
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
