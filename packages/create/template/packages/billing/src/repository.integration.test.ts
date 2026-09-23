import { LocalBillingAdapter } from "@__TRESTLE_PROJECT_NAME__/integrations";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { Entitlements, PostgresBillingProjectionRepository, PostgresCommercialRepository, planEntitlements, tenantCapabilityDocument, features } from "./index.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const admin = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const org = `billing-${Date.now()}`;

suite("effective-entitlement projection", () => {
  afterAll(async () => {
    for (const table of ["organization_entitlement", "subscription_override", "organization_subscription"]) await admin!.unsafe(`delete from ${table} where organization_id = $1`, [org]);
    await admin!`delete from plan_version where plan = ${`plan${org.slice(-6)}`}`;
    await admin!.end();
  });

  it("records the plan version, provenance, and overrides without consulting a provider", async () => {
    const repository = new PostgresBillingProjectionRepository(connectionString!, "postgres-js");
    const billing = new LocalBillingAdapter(repository, planEntitlements);
    await billing.activate({ organizationId: org, plan: "pro" });
    await admin!`insert into subscription_override (id, organization_id, code, values, reason, author, effective_at) values (${`${org}-ovr`}, ${org}, 'team.members', '{"maximum": 40}', 'Negotiated contract', 'op-1', now() - interval '1 day')`;
    await billing.changePlan({ organizationId: org, plan: "pro", commandId: "refresh" });
    const commercial = new PostgresCommercialRepository(connectionString!, "postgres-js", org);
    const { summary, planVersion } = await commercial.subscription();
    expect(summary).toMatchObject({ plan: "pro", status: "active" });
    expect(summary!.entitlements).toContain("workflows.advanced");
    expect(planVersion).toMatchObject({ plan: "pro", version: 1, state: "active" });
    const rows = await admin!`select entitlement, values, source, inherited_from from organization_entitlement where organization_id = ${org} and entitlement = 'team.members'`;
    expect(rows[0]).toMatchObject({ values: { maximum: 40 }, source: "subscription_override", inherited_from: "pro@1" });
    const document = tenantCapabilityDocument({ catalog: features, subscription: summary, planVersion, effective: (await admin!`select entitlement as code, enabled, values, source, inherited_from as "inheritedFrom", effective_at as "effectiveAt" from organization_entitlement where organization_id = ${org}`).map((row) => ({ ...row, effectiveAt: new Date(row.effectiveAt).toISOString() })) as never });
    expect(JSON.stringify(document)).not.toContain("Negotiated contract");
  });

  it("keeps an existing subscription on its recorded version when a new version activates", async () => {
    await admin!`update organization_subscription set plan_version = 'pro@1' where organization_id = ${org}`;
    const repository = new PostgresBillingProjectionRepository(connectionString!, "postgres-js");
    const current = await repository.get(org);
    await repository.put({ ...current!, status: "active" });
    const [row] = await admin!`select plan_version from organization_subscription where organization_id = ${org}`;
    expect(row?.plan_version).toBe("pro@1");
  });

  it("removes every entitlement when the subscription stops entitling", async () => {
    const repository = new PostgresBillingProjectionRepository(connectionString!, "postgres-js");
    await new LocalBillingAdapter(repository, planEntitlements).cancel({ organizationId: org });
    expect(new Entitlements(new Set((await repository.get(org))!.entitlements)).list()).toEqual([]);
  });
});
