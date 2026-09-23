import { createHmac } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadCheckoutPrices } from "@__TRESTLE_PROJECT_NAME__/data";
import { applicationConnectionString, createSqlRunner } from "@__TRESTLE_PROJECT_NAME__/db";

import { app } from "./index.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const run = `bl${Date.now()}`;
const org = `${run}-org`;
const secret = "whsec_mapping_test";
const environment = { DATABASE_URL: connectionString ?? "", DATABASE_DRIVER: "postgres-js" as const, BETTER_AUTH_SECRET: "test-secret-at-least-32-characters", APP_ENV: "local" as const, STRIPE_WEBHOOK_SECRET: secret, STRIPE_MODE: "test" };
const mapped = `price_${run}m`;
const annual = `price_${run}a`;

/** A subscription event signed the way Stripe signs it. */
async function deliver(id: string, items: Array<{ id: string; price: string }>, metadataPlan: string) {
  const payload = JSON.stringify({
    id, object: "event", type: "customer.subscription.updated", created: Math.floor(Date.now() / 1000),
    data: { object: { id: `sub_${run}`, object: "subscription", customer: `cus_${run}`, status: "active", cancel_at_period_end: false, metadata: { organizationId: org, plan: metadataPlan },
      items: { object: "list", data: items.map((item) => ({ id: item.id, object: "subscription_item", quantity: 1, price: { id: item.price, object: "price" }, current_period_start: 1_800_000_000, current_period_end: 1_802_592_000 })) } } },
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex")}`;
  return await app.request("/webhooks/stripe", { method: "POST", headers: { "stripe-signature": signature, "content-type": "application/json" }, body: payload }, environment);
}

suite("Stripe price mappings", () => {
  beforeAll(async () => {
    await sql!`insert into organization (id, name, slug, created_at) values (${org}, 'Mapped', ${org}, now())`;
    await sql!`insert into billing_provider_mapping (environment, provider, kind, plan, plan_version, offer, external_id, created_by) values
      ('local', 'stripe', 'product', 'pro', null, null, ${`prod_${run}`}, 'test'),
      ('local', 'stripe', 'price', 'pro', 1, 'monthly', ${mapped}, 'test'),
      ('local', 'stripe', 'price', 'pro', 1, 'annual', ${annual}, 'test')`;
  });

  afterAll(async () => {
    await sql!`delete from billing_provider_mapping where external_id like ${`%${run}%`}`;
    for (const table of ["subscription_line", "organization_entitlement", "organization_subscription"]) await sql!.unsafe(`delete from ${table} where organization_id = $1`, [org]);
    await sql!`delete from billing_provider_event where provider_event_id like ${`evt_${run}%`}`;
    await sql!`delete from organization where id = ${org}`;
    await sql!.end();
  });

  it("uses the active version's monthly offer for checkout", async () => {
    const prices = await loadCheckoutPrices(createSqlRunner(applicationConnectionString(connectionString!), "postgres-js"), "local");
    expect(prices.pro).toBe(mapped);
  });

  it("resolves the plan from the mapped price, not checkout metadata, and records lines", async () => {
    expect((await deliver(`evt_${run}1`, [{ id: `si_${run}1`, price: mapped }, { id: `si_${run}2`, price: `price_${run}unknown` }], "starter")).status).toBe(202);
    const [subscription] = await sql!`select plan, plan_version, provider_customer_id, provider_subscription_id from organization_subscription where organization_id = ${org}`;
    expect(subscription).toMatchObject({ plan: "pro", plan_version: "pro@1", provider_customer_id: `cus_${run}`, provider_subscription_id: `sub_${run}` });
    const lines = await sql!`select plan_version, offer, provider_item_id, provider_price_id from subscription_line where organization_id = ${org} order by provider_item_id`;
    expect(lines).toEqual([
      { plan_version: "pro@1", offer: "monthly", provider_item_id: `si_${run}1`, provider_price_id: mapped },
      { plan_version: `unmapped:price_${run}unknown`, offer: null, provider_item_id: `si_${run}2`, provider_price_id: `price_${run}unknown` },
    ]);
  });

  it("replaces lines when the provider reports new items", async () => {
    expect((await deliver(`evt_${run}2`, [{ id: `si_${run}3`, price: annual }], "pro")).status).toBe(202);
    const lines = await sql!`select plan_version, offer from subscription_line where organization_id = ${org}`;
    expect(lines).toEqual([{ plan_version: "pro@1", offer: "annual" }]);
  });
});
