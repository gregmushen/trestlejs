import type { MeteringProvider, UsageEvent } from "@__TRESTLE_PROJECT_NAME__/integrations";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { usageProvenance, usageReportId, UsageReporter } from "./index.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const admin = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const org = `metering-${Date.now()}`;
const periodStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
const periodEnd = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1));

class RecordingProvider implements MeteringProvider {
  readonly kind = "openmeter" as const;
  readonly received: UsageEvent[] = [];
  failNext = false;
  providerQuantity = 0;
  async ingest(events: readonly UsageEvent[]) {
    if (this.failNext) { this.failNext = false; throw new Error("provider unavailable"); }
    this.received.push(...events);
    this.providerQuantity += events.reduce((total, event) => total + event.quantity, 0);
  }
  async usage(query: { organizationId: string; featureCode: string; start: Date; end: Date }, now: Date) {
    return query.organizationId === org ? { provider: "openmeter" as const, organizationId: org, featureCode: query.featureCode, periodStart: query.start, periodEnd: query.end, quantity: this.providerQuantity, balance: 93, hasAccess: true, observedAt: now } : null;
  }
}

const row = async () => (await admin!`select * from usage_aggregate where organization_id = ${org}`)[0]!;

suite("usage reporting to a metering provider", () => {
  afterAll(async () => { await admin!`delete from usage_aggregate where organization_id = ${org}`; await admin!.end(); });

  it("reports only what the provider has not accepted, with retry-stable IDs, and reconciles its figures", async () => {
    await admin!`insert into usage_aggregate (organization_id, feature_code, period_start, period_end, quantity) values (${org}, 'api.requests', ${periodStart}, ${periodEnd}, 5)`;
    const provider = new RecordingProvider();
    const reporter = new UsageReporter(connectionString!, "postgres-js", provider);

    provider.failNext = true;
    const failed = await reporter.report(500);
    expect(failed.failed).toBeGreaterThanOrEqual(1);
    expect(Number((await row()).reported_quantity)).toBe(0);

    await reporter.report(500);
    const mine = provider.received.filter((event) => event.organizationId === org);
    expect(mine).toEqual([{ id: usageReportId(org, "api.requests", periodStart, 0, 5), organizationId: org, featureCode: "api.requests", quantity: 5, occurredAt: periodStart }]);
    expect(Number((await row()).reported_quantity)).toBe(5);

    await admin!`update usage_aggregate set quantity = quantity + 3 where organization_id = ${org}`;
    await reporter.report(500);
    expect(provider.received.filter((event) => event.organizationId === org).map((event) => event.quantity)).toEqual([5, 3]);

    await reporter.reconcile(new Date(), 500);
    const reconciled = usageProvenance(await row());
    expect(reconciled).toMatchObject({ local: 8, reported: 8, provider: "openmeter", providerBalance: 93, providerHasAccess: true, drift: { outcome: "in_sync" } });

    await admin!`update usage_aggregate set quantity = quantity + 2 where organization_id = ${org}`;
    expect(usageProvenance(await row()).drift).toMatchObject({ local: 10, provider: 8, outcome: "provider_behind" });
  });
});
