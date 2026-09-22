import { describe, expect, it, vi } from "vitest";
import { reconcileStripeCatalog, validateStripeCatalog } from "../src/stripe-sync.js";

const catalog = validateStripeCatalog({ schemaVersion: 1, currency: "usd", plans: { pro: { version: 1, name: "Pro", unitAmount: 4900, interval: "month" } } });

describe("Stripe catalog reconciliation", () => {
  it("plans missing resources without mutation", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;
    expect(await reconcileStripeCatalog("sk_test_redacted", catalog, false, request)).toMatchObject({ items: [{ plan: "pro", classification: "create" }], prices: {} });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("creates once and converges by stable lookup key", async () => {
    const responses = [new Response(JSON.stringify({ data: [] })), new Response(JSON.stringify({ id: "prod_1" })), new Response(JSON.stringify({ id: "price_1" }))];
    const request = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;
    const report = await reconcileStripeCatalog("sk_test_redacted", catalog, true, request);
    expect(report.prices).toEqual({ pro: "price_1" });
    expect(report.items[0]).toMatchObject({ classification: "already_correct", lookupKey: "trestle_pro_v1" });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("blocks immutable price drift instead of mutating history", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "price_old", currency: "usd", unit_amount: 3900, recurring: { interval: "month" } }] }))) as unknown as typeof fetch;
    expect((await reconcileStripeCatalog("sk_test_redacted", catalog, true, request)).items[0]).toMatchObject({ classification: "blocked" });
  });
});
