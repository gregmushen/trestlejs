import { createHmac } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it, vi } from "vitest";

import worker, { app } from "./index.js";

const databaseUrl = process.env.TRESTLE_SYSTEM_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const sql = databaseUrl ? postgres(databaseUrl, { max: 2, prepare: false }) : undefined;
const organizationIds: string[] = [];
const eventIds: string[] = [];
const subscriptionIds: string[] = [];
const secret = "whsec_billing_webhook_integration";

type Queue = { send(body: unknown): Promise<void> };
const remoteEnvironment = (queue?: Queue) => ({ DATABASE_URL: databaseUrl!, DATABASE_DRIVER: "postgres-js" as const, STRIPE_WEBHOOK_SECRET: secret,
  STRIPE_SECRET_KEY: "sk_test_reconciliation", STRIPE_MODE: "test" as const, ...(queue ? { TRESTLE_EVENTS: queue } : {}),
  BETTER_AUTH_SECRET: "billing-integration-test-secret-long-enough", BETTER_AUTH_URL: "http://localhost:42069", APP_ENV: "local" as const });
const stripeSubscription = (subscriptionId: string, organizationId: string, status = "active", plan = "pro") => new Response(JSON.stringify({ id: subscriptionId, object: "subscription",
  customer: "cus_test_atomic", status, cancel_at_period_end: false, items: { data: [] }, metadata: { organizationId, plan } }), { status: 200, headers: { "content-type": "application/json" } });

async function deliver(input: { eventId: string; organizationId?: string; plan?: string; kind?: "subscription" | "checkout" | "invoice_paid" | "invoice_failed"; remote?: boolean; subscriptionId?: string; customerId?: string; queue?: Queue; databaseUrl?: string }) {
  const subscriptionId = input.subscriptionId ?? `sub_${input.eventId}`;
  subscriptionIds.push(subscriptionId);
  const metadata = { ...(input.organizationId ? { organizationId: input.organizationId } : {}), ...(input.plan ? { plan: input.plan } : {}) };
  const checkout = input.kind === "checkout";
  const invoice = input.kind === "invoice_paid" || input.kind === "invoice_failed";
  const payload = JSON.stringify({ id: input.eventId, object: "event", api_version: "2026-08-27.basil", created: Math.floor(Date.now() / 1000), data: {
    object: checkout ? { id: `cs_${input.eventId}`, object: "checkout.session", mode: "subscription", customer: input.customerId ?? "cus_test_atomic", subscription: subscriptionId, payment_status: "paid", metadata }
      : invoice ? { id: `in_${input.eventId}`, object: "invoice", customer: input.customerId ?? "cus_test_atomic",
        amount_paid: 2500, amount_due: 3000, currency: "usd",
        parent: { type: "subscription_details", subscription_details: { subscription: subscriptionId, metadata } } }
      : { id: subscriptionId, object: "subscription", customer: "cus_test_atomic", status: "active", cancel_at_period_end: true, items: { data: [{ current_period_start: 1_790_000_000, current_period_end: 1_792_592_000 }] }, metadata },
  }, livemode: false, pending_webhooks: 1, request: null, type: checkout ? "checkout.session.completed"
    : input.kind === "invoice_paid" ? "invoice.paid" : input.kind === "invoice_failed" ? "invoice.payment_failed"
      : "customer.subscription.created" });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex")}`;
  return app.request("/webhooks/stripe", { method: "POST", headers: { "stripe-signature": signature, "content-type": "application/json" }, body: payload }, {
    DATABASE_URL: input.databaseUrl ?? databaseUrl!, DATABASE_DRIVER: "postgres-js", STRIPE_WEBHOOK_SECRET: secret,
    ...(input.remote ? { STRIPE_SECRET_KEY: "sk_test_reconciliation", STRIPE_MODE: "test" as const } : {}),
    ...(input.queue ? { TRESTLE_EVENTS: input.queue } : {}),
    BETTER_AUTH_SECRET: "billing-integration-test-secret-long-enough", BETTER_AUTH_URL: "http://localhost:42069", APP_ENV: "local",
  });
}

suite("signed Stripe webhook route", () => {
  afterAll(async () => {
    if (organizationIds.length) {
      await sql!`delete from organization_entitlement where organization_id = any(${organizationIds})`;
      await sql!`delete from organization_subscription where organization_id = any(${organizationIds})`;
    }
    if (eventIds.length) await sql!`delete from billing_provider_event where provider='stripe' and provider_event_id = any(${eventIds})`;
    if (eventIds.length) await sql!`delete from outbox_message where idempotency_key = any(${eventIds.map((id) => `billing:stripe:${id}`)})`;
    if (subscriptionIds.length) await sql!`delete from outbox_message where event_name='billing.subscription.reconciliation_requested' and payload->>'providerSubscriptionId' = any(${subscriptionIds})`;
    if (subscriptionIds.length) await sql!`delete from billing_local_subscription where provider='stripe' and provider_subscription_id = any(${subscriptionIds})`;
    if (subscriptionIds.length) await sql!`delete from billing_subscription_reconciliation where provider='stripe' and provider_subscription_id = any(${subscriptionIds})`;
    if (subscriptionIds.length) await sql!`delete from billing_subscription_ownership where provider='stripe' and provider_subscription_id = any(${subscriptionIds})`;
    vi.unstubAllGlobals();
    await sql!.end();
  });

  it("activates entitlements from a signed subscription once and acknowledges duplicates", async () => {
    const organizationId = `billing_route_${crypto.randomUUID().replaceAll("-", "")}`;
    const eventId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
    organizationIds.push(organizationId);
    eventIds.push(eventId);
    const first = await deliver({ eventId, organizationId, plan: "pro" });
    expect(first.status).toBe(202);
    // Local mode runs the same durable reconciliation inline against the local provider state.
    await expect(first.json()).resolves.toEqual({ duplicate: false, reconciliation: "applied" });
    expect((await sql!`select status from billing_provider_event where provider='stripe' and provider_event_id=${eventId}`)[0]?.status).toBe("processed");
    expect(await sql!`select id from outbox_message where idempotency_key=${`billing-reconcile:stripe:${eventId}`}`).toHaveLength(1);
    expect((await sql!`select event_name, correlation_id, organization_id, payload from outbox_message where idempotency_key=${`billing:stripe:${eventId}`}`)[0])
      .toMatchObject({ event_name: "billing.subscription.activated", correlation_id: first.headers.get("x-correlation-id"),
        organization_id: organizationId, payload: { organizationId, status: "active" } });
    const duplicate = await deliver({ eventId, organizationId, plan: "pro" });
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toEqual({ duplicate: true });
    expect(await sql!`select id from outbox_message where idempotency_key=${`billing:stripe:${eventId}`}`).toHaveLength(1);
    expect((await sql!`select plan, status, cancel_at_period_end, current_period_start, current_period_end from organization_subscription where organization_id=${organizationId}`)[0]).toEqual({ plan: "pro", status: "active", cancel_at_period_end: true, current_period_start: new Date(1_790_000_000_000), current_period_end: new Date(1_792_592_000_000) });
    expect((await sql!`select entitlement from organization_entitlement where organization_id=${organizationId} order by entitlement`).map((row) => row.entitlement)).toEqual(["article.basic", "members.unlimited", "workflows.advanced", "workspace.single"]);
  });

  it("rejects a signed subscription lacking tenant or plan metadata without an event receipt", async () => {
    const eventId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
    eventIds.push(eventId);
    const response = await deliver({ eventId });
    expect(response.status).toBe(422);
    expect(await sql!`select provider_event_id from billing_provider_event where provider='stripe' and provider_event_id=${eventId}`).toHaveLength(0);
  });

  it("retries Checkout until subscription ownership exists and never grants access from Checkout alone", async () => {
    const organizationId = `billing_checkout_${crypto.randomUUID().replaceAll("-", "")}`;
    const eventId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
    const subscriptionEventId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
    const subscriptionId = `sub_${crypto.randomUUID().replaceAll("-", "")}`;
    organizationIds.push(organizationId);
    eventIds.push(eventId, subscriptionEventId);
    const early = await deliver({ eventId, organizationId, plan: "pro", kind: "checkout", subscriptionId });
    expect(early.status).toBe(503);
    await expect(early.json()).resolves.toMatchObject({ error: "billing_ownership_unresolved", retryable: true });
    expect(await sql!`select organization_id from organization_subscription where organization_id=${organizationId}`).toHaveLength(0);
    expect(await sql!`select organization_id from organization_entitlement where organization_id=${organizationId}`).toHaveLength(0);
    expect((await sql!`select status, error from billing_provider_event where provider='stripe' and provider_event_id=${eventId}`)[0])
      .toEqual({ status: "failed", error: "ownership_unresolved" });
    expect(await sql!`select id from outbox_message where idempotency_key=${`billing:stripe:${eventId}`}`).toHaveLength(0);
    expect((await deliver({ eventId: subscriptionEventId, organizationId, plan: "pro", subscriptionId })).status).toBe(202);
    const entitlements = await sql!`select entitlement from organization_entitlement where organization_id=${organizationId} order by entitlement`;
    const response = await deliver({ eventId, organizationId, plan: "pro", kind: "checkout", subscriptionId });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ duplicate: false, event: { type: "BillingCheckoutCompleted" } });
    expect((await sql!`select event_name, organization_id, correlation_id, payload from outbox_message where idempotency_key=${`billing:stripe:${eventId}`}`)[0])
      .toMatchObject({ event_name: "billing.checkout.completed", organization_id: organizationId,
        correlation_id: response.headers.get("x-correlation-id"), payload: { organizationId, currentSubscription: true, paymentStatus: "paid" } });
    expect((await deliver({ eventId, organizationId, plan: "pro", kind: "checkout", subscriptionId })).status).toBe(200);
    expect(await sql!`select id from outbox_message where idempotency_key=${`billing:stripe:${eventId}`}`).toHaveLength(1);
    expect(await sql!`select entitlement from organization_entitlement where organization_id=${organizationId} order by entitlement`).toEqual(entitlements);
  });

  it("publishes invoice payment outcomes only for a locally owned subscription", async () => {
    const organizationId = `billing_invoice_${crypto.randomUUID().replaceAll("-", "")}`;
    const wrongOrganizationId = `billing_wrong_${crypto.randomUUID().replaceAll("-", "")}`;
    const subscriptionId = `sub_${crypto.randomUUID().replaceAll("-", "")}`;
    const activatedId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
    const paidId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
    const failedId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
    const wrongId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
    const missingId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
    const customerMismatchId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
    organizationIds.push(organizationId, wrongOrganizationId);
    eventIds.push(activatedId, paidId, failedId, wrongId, missingId, customerMismatchId);
    expect((await deliver({ eventId: paidId, organizationId, kind: "invoice_paid", subscriptionId })).status).toBe(503);
    expect((await deliver({ eventId: activatedId, organizationId, plan: "pro", subscriptionId })).status).toBe(202);
    const entitlements = await sql!`select entitlement from organization_entitlement where organization_id=${organizationId} order by entitlement`;
    expect((await deliver({ eventId: paidId, organizationId, kind: "invoice_paid", subscriptionId })).status).toBe(202);
    expect((await sql!`select event_name, payload from outbox_message where idempotency_key=${`billing:stripe:${paidId}`}`)[0])
      .toMatchObject({ event_name: "billing.invoice.paid", payload: { organizationId, currentSubscription: true, amountMinor: 2500, currency: "usd" } });
    expect((await deliver({ eventId: paidId, organizationId, kind: "invoice_paid", subscriptionId })).status).toBe(200);
    expect((await deliver({ eventId: failedId, organizationId, kind: "invoice_failed", subscriptionId })).status).toBe(202);
    expect((await sql!`select event_name, payload from outbox_message where idempotency_key=${`billing:stripe:${failedId}`}`)[0])
      .toMatchObject({ event_name: "billing.invoice.payment_failed", payload: { organizationId, currentSubscription: true, amountMinor: 3000, currency: "usd" } });
    expect((await deliver({ eventId: wrongId, organizationId: wrongOrganizationId, kind: "invoice_paid", subscriptionId })).status).toBe(503);
    expect((await deliver({ eventId: missingId, kind: "invoice_paid", subscriptionId })).status).toBe(503);
    expect((await deliver({ eventId: customerMismatchId, organizationId, kind: "invoice_paid", subscriptionId,
      customerId: "cus_wrong" })).status).toBe(503);
    for (const id of [wrongId, missingId, customerMismatchId]) {
      expect(await sql!`select id from outbox_message where idempotency_key=${`billing:stripe:${id}`}`).toHaveLength(0);
      expect((await sql!`select status from billing_provider_event where provider_event_id=${id}`)[0]?.status).toBe("failed");
    }
    expect(await sql!`select entitlement from organization_entitlement where organization_id=${organizationId} order by entitlement`).toEqual(entitlements);
    expect(await sql!`select organization_id from organization_subscription where organization_id=${wrongOrganizationId}`).toHaveLength(0);
  });

  it("reconciles a signed but stale active event against the current cancelled Stripe subscription", async () => {
    const organizationId = `billing_route_${crypto.randomUUID().replaceAll("-", "")}`;
    const eventId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
    const subscriptionId = `sub_${crypto.randomUUID().replaceAll("-", "")}`;
    organizationIds.push(organizationId);
    eventIds.push(eventId);
    subscriptionIds.push(subscriptionId);
    const stripeFetch = vi.fn(async (request: RequestInfo | URL) => {
      expect(String(request)).toContain(`/v1/subscriptions/${subscriptionId}`);
      return new Response(JSON.stringify({ id: subscriptionId, object: "subscription", customer: "cus_test_atomic", status: "canceled",
        cancel_at_period_end: true, items: { data: [] }, metadata: { organizationId, plan: "pro" } }),
      { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", stripeFetch);
    try {
      const response = await deliver({ eventId, organizationId, plan: "pro", remote: true, subscriptionId });
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({ duplicate: false, reconciliation: "applied" });
      expect((await sql!`select status from organization_subscription where organization_id=${organizationId}`)[0]?.status).toBe("cancelled");
      expect(await sql!`select entitlement from organization_entitlement where organization_id=${organizationId}`).toHaveLength(0);
      const duplicate = await deliver({ eventId, organizationId, plan: "pro", remote: true, subscriptionId });
      expect(duplicate.status).toBe(200);
      expect(stripeFetch).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it("keeps a provider lookup failure retryable without exposing the provider response", async () => {
    const organizationId = `billing_route_${crypto.randomUUID().replaceAll("-", "")}`;
    const eventId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
    const subscriptionId = `sub_${crypto.randomUUID().replaceAll("-", "")}`;
    organizationIds.push(organizationId);
    eventIds.push(eventId);
    subscriptionIds.push(subscriptionId);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("private provider response body"); }));
    try {
      const response = await deliver({ eventId, organizationId, plan: "pro", remote: true, subscriptionId });
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("private provider response body");
      expect((await sql!`select status, error from billing_provider_event where provider_event_id=${eventId}`)[0])
        .toEqual({ status: "failed", error: "provider_unavailable" });
      expect(await sql!`select organization_id from organization_subscription where organization_id=${organizationId}`).toHaveLength(0);
      // The durable request stays due, so the redelivered webhook runs it again.
      expect((await sql!`select generation::int as generation, reconciled_generation::int as reconciled_generation, lease_token from billing_subscription_reconciliation where provider='stripe' and provider_subscription_id=${subscriptionId}`)[0])
        .toEqual({ generation: 1, reconciled_generation: 0, lease_token: null });
    } finally { vi.unstubAllGlobals(); }
  });

  it("recovers subscription identity from current Stripe state when the signed snapshot lacks metadata", async () => {
    const organizationId = `billing_route_${crypto.randomUUID().replaceAll("-", "")}`;
    const eventId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
    const subscriptionId = `sub_${crypto.randomUUID().replaceAll("-", "")}`;
    organizationIds.push(organizationId);
    eventIds.push(eventId);
    subscriptionIds.push(subscriptionId);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: subscriptionId, object: "subscription", customer: "cus_test_atomic",
      status: "active", cancel_at_period_end: false, items: { data: [] }, metadata: { organizationId, plan: "pro" } }),
    { status: 200, headers: { "content-type": "application/json" } })));
    try {
      const response = await deliver({ eventId, remote: true, subscriptionId });
      expect(response.status).toBe(202);
      expect((await sql!`select plan, status from organization_subscription where organization_id=${organizationId}`)[0])
        .toEqual({ plan: "pro", status: "active" });
    } finally { vi.unstubAllGlobals(); }
  });
  it("commits the receipt and a durable reconciliation request before any Stripe call when a Queue is bound", async () => {
    const organizationId = `billing_queue_${crypto.randomUUID().replaceAll("-", "")}`;
    const eventId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
    const subscriptionId = `sub_${crypto.randomUUID().replaceAll("-", "")}`;
    organizationIds.push(organizationId); eventIds.push(eventId); subscriptionIds.push(subscriptionId);
    const queued: unknown[] = [];
    const queue = { send: async (body: unknown) => { queued.push(body); } };
    const stripeFetch = vi.fn(async () => stripeSubscription(subscriptionId, organizationId));
    vi.stubGlobal("fetch", stripeFetch);
    try {
      const response = await deliver({ eventId, organizationId, plan: "pro", remote: true, subscriptionId, queue });
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({ duplicate: false, queued: true });
      expect(stripeFetch).not.toHaveBeenCalled();
      expect((await sql!`select status from billing_provider_event where provider_event_id=${eventId}`)[0]?.status).toBe("received");
      const [request] = await sql!`select id, organization_id, status from outbox_message where idempotency_key=${`billing-reconcile:stripe:${eventId}`}`;
      expect(request).toMatchObject({ organization_id: null, status: "pending" });
      expect(queued).toEqual([expect.objectContaining({ id: request?.id, name: "billing.subscription.reconciliation_requested" })]);
      expect(await sql!`select organization_id from organization_subscription where organization_id=${organizationId}`).toHaveLength(0);
      const states: string[] = [];
      const message = { body: queued[0], ack: () => states.push("ack"), retry: () => states.push("retry") };
      expect(await worker.queue({ messages: [message] }, remoteEnvironment(queue))).toEqual({ acknowledged: 1, retried: 0 });
      expect(states).toEqual(["ack"]);
      expect(stripeFetch).toHaveBeenCalledTimes(1);
      expect((await sql!`select plan, status from organization_subscription where organization_id=${organizationId}`)[0]).toEqual({ plan: "pro", status: "active" });
      expect((await sql!`select status from billing_provider_event where provider_event_id=${eventId}`)[0]?.status).toBe("processed");
      expect((await sql!`select correlation_id from outbox_message where idempotency_key=${`billing:stripe:${eventId}`}`)[0]?.correlation_id)
        .toBe(response.headers.get("x-correlation-id"));
      // A redelivered Queue message is acknowledged without another provider call.
      expect(await worker.queue({ messages: [{ ...message }] }, remoteEnvironment(queue))).toEqual({ acknowledged: 1, retried: 0 });
      expect(stripeFetch).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it("rejects a forged reconciliation message before it reaches Stripe", async () => {
    const organizationId = `billing_forged_${crypto.randomUUID().replaceAll("-", "")}`;
    const eventId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
    const subscriptionId = `sub_${crypto.randomUUID().replaceAll("-", "")}`;
    const otherSubscriptionId = `sub_${crypto.randomUUID().replaceAll("-", "")}`;
    organizationIds.push(organizationId); eventIds.push(eventId); subscriptionIds.push(subscriptionId, otherSubscriptionId);
    const queued: Array<{ payload: Record<string, unknown> }> = [];
    const queue = { send: async (body: unknown) => { queued.push(body as { payload: Record<string, unknown> }); } };
    const stripeFetch = vi.fn(async () => stripeSubscription(otherSubscriptionId, organizationId));
    vi.stubGlobal("fetch", stripeFetch);
    try {
      expect((await deliver({ eventId, organizationId, plan: "pro", remote: true, subscriptionId, queue })).status).toBe(202);
      const forged = { ...queued[0], payload: { ...queued[0]!.payload, providerSubscriptionId: otherSubscriptionId } };
      const states: string[] = [];
      expect(await worker.queue({ messages: [{ body: forged, ack: () => states.push("ack"), retry: () => states.push("retry") }] }, remoteEnvironment(queue)))
        .toEqual({ acknowledged: 0, retried: 1 });
      expect(states).toEqual(["retry"]);
      expect(stripeFetch).not.toHaveBeenCalled();
      expect(await sql!`select provider_subscription_id from billing_subscription_reconciliation where provider='stripe' and provider_subscription_id=${otherSubscriptionId}`).toHaveLength(0);
    } finally { vi.unstubAllGlobals(); }
  });

  it("does not acknowledge the webhook unless the receipt and request commit together", async () => {
    const organizationId = `billing_commit_${crypto.randomUUID().replaceAll("-", "")}`;
    const eventId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
    const subscriptionId = `sub_${crypto.randomUUID().replaceAll("-", "")}`;
    organizationIds.push(organizationId); eventIds.push(eventId); subscriptionIds.push(subscriptionId);
    const queue = { send: vi.fn(async () => undefined) };
    const stripeFetch = vi.fn(async () => stripeSubscription(subscriptionId, organizationId));
    vi.stubGlobal("fetch", stripeFetch);
    await sql!`create or replace function billing_webhook_test_reject() returns trigger language plpgsql as $$ begin raise exception 'injected outbox failure'; end $$`;
    await sql!`create trigger billing_webhook_test_reject before insert on outbox_message for each row when (new.idempotency_key = ${sql!.unsafe(`'billing-reconcile:stripe:${eventId}'`)}) execute function billing_webhook_test_reject()`;
    try {
      const failed = await deliver({ eventId, organizationId, plan: "pro", remote: true, subscriptionId, queue });
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(await sql!`select provider_event_id from billing_provider_event where provider_event_id=${eventId}`).toHaveLength(0);
      expect(await sql!`select generation from billing_subscription_reconciliation where provider='stripe' and provider_subscription_id=${subscriptionId}`).toHaveLength(0);
      expect(queue.send).not.toHaveBeenCalled();
    } finally {
      await sql!`drop trigger billing_webhook_test_reject on outbox_message`;
      await sql!`drop function billing_webhook_test_reject()`;
    }
    try {
      const unavailable = await deliver({ eventId, organizationId, plan: "pro", remote: true, subscriptionId, queue, databaseUrl: "postgres://postgres:postgres@127.0.0.1:1/unavailable" });
      expect(unavailable.status).toBeGreaterThanOrEqual(500);
      const retried = await deliver({ eventId, organizationId, plan: "pro", remote: true, subscriptionId, queue });
      expect(retried.status).toBe(202);
      expect(stripeFetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it("rejects a Stripe subscription that no longer exists without changing the projection", async () => {
    const organizationId = `billing_missing_${crypto.randomUUID().replaceAll("-", "")}`;
    const eventId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
    const subscriptionId = `sub_${crypto.randomUUID().replaceAll("-", "")}`;
    organizationIds.push(organizationId); eventIds.push(eventId); subscriptionIds.push(subscriptionId);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "resource_missing",
      message: `No such subscription: '${subscriptionId}'`, param: "id" } }), { status: 404, headers: { "content-type": "application/json" } })));
    try {
      const response = await deliver({ eventId, organizationId, plan: "pro", remote: true, subscriptionId });
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({ duplicate: false, reconciliation: "not_found" });
      expect((await sql!`select status, error from billing_provider_event where provider_event_id=${eventId}`)[0])
        .toEqual({ status: "rejected", error: "provider_subscription_not_found" });
      expect(await sql!`select organization_id from organization_subscription where organization_id=${organizationId}`).toHaveLength(0);
      expect((await deliver({ eventId, organizationId, plan: "pro", remote: true, subscriptionId })).status).toBe(200);
    } finally { vi.unstubAllGlobals(); }
  });
});
