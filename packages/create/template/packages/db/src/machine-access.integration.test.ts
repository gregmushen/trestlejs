import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, createPlatformDatabase, createTenantDatabase } from "./index.js";
import { createServiceAccount, listPlatformApiKeys, platformRevokeApiKey, resolveApiKey, storeApiKey } from "./machine-access.js";
import { outboxApplicationConnectionString } from "./outbox.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const run = `mak${Date.now()}`;
const organizationId = `${run}-org`;
const publicId = `K${String(Date.now()).padStart(15, "0")}`.slice(0, 16);
const verifier = "a".repeat(64);
const audit = { actor: { type: "user" as const, id: `${run}-user` }, environment: "local", correlationId: `${run}-corr` };

async function as<T>(role: "trestle_app" | "trestle_platform", organization: string, work: (transaction: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return await sql!.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${role}`);
    if (role === "trestle_app") await transaction`select set_config('app.organization_id', ${organization}, true)`;
    return await work(transaction);
  }) as T;
}

async function failure(work: Promise<unknown>): Promise<string> {
  try { await work; } catch (error) { return `${(error as Error).message} ${((error as { cause?: Error }).cause?.message ?? "")}`; }
  return "resolved";
}

suite("machine access storage", () => {
  let serviceAccountId = "";

  beforeAll(async () => {
    const tenant = createTenantDatabase(connectionString!, "postgres-js", organizationId);
    serviceAccountId = (await createServiceAccount(tenant, { organizationId, name: "Sync", applicationRoles: ["reader"] }, audit)).id;
    await expect(createServiceAccount(tenant, { organizationId, name: "sync", applicationRoles: ["reader"] }, audit)).rejects.toThrow("already exists");
    await storeApiKey(tenant, { organizationId, serviceAccountId, name: "k", environment: "local", key: { publicId, displayPrefix: `tr_dev_${publicId}`, verifier }, scopes: ["resource.read"] }, audit);
  });

  afterAll(async () => {
    await sql!`delete from audit_event where organization_id = ${organizationId}`;
    await sql!`delete from api_key where organization_id = ${organizationId}`;
    await sql!`delete from service_account where organization_id = ${organizationId}`;
    await sql!.end();
  });

  it("resolves a key by public ID only through the restricted role's resolver", async () => {
    const resolver = createDatabase(outboxApplicationConnectionString(connectionString!), "postgres-js");
    expect(await resolveApiKey(resolver, publicId)).toMatchObject({ organizationId, serviceAccountId, verifier, scopes: ["resource.read"], applicationRoles: ["reader"], serviceAccountStatus: "active", revokedAt: null });
    expect(await resolveApiKey(resolver, "XXXXXXXXXXXXXXXX")).toBeNull();
    expect(await resolveApiKey(resolver, "not a public id")).toBeNull();
    expect(await failure(as("trestle_platform", organizationId, async (transaction) => await transaction`select * from trestle_resolve_api_key(${publicId})`))).toMatch(/permission denied/u);
  });

  it("keeps verifiers, scopes, and owners immutable for tenants and hidden from the platform", async () => {
    expect((await as("trestle_app", "another-org", async (transaction) => await transaction`select id from api_key`)).length).toBe(0);
    for (const statement of [`update api_key set scopes = '{resource.write}'`, `update api_key set verifier = '${"b".repeat(64)}'`, `update service_account set application_roles = '{app_admin}'`, "delete from api_key"]) {
      expect(await failure(as("trestle_app", organizationId, async (transaction) => await transaction.unsafe(statement))), statement).toMatch(/permission denied/u);
    }
    expect(await failure(as("trestle_platform", organizationId, async (transaction) => await transaction`select verifier from api_key limit 1`))).toMatch(/permission denied/u);
    expect(await failure(as("trestle_platform", organizationId, async (transaction) => await transaction`update api_key set expires_at = now()`))).toMatch(/permission denied/u);
  });

  it("lets the platform revoke a key, once, audited on the organization", async () => {
    const platform = createPlatformDatabase(connectionString!, "postgres-js");
    expect((await listPlatformApiKeys(platform, { limit: 200 })).find((key) => key.id === publicId)).toMatchObject({ organizationId, serviceAccountName: "Sync", revokedAt: null });
    const context = { actor: { type: "platform_operator" as const, id: `${run}-op` }, reason: "leaked in a public repository", environment: "local", correlationId: `${run}-corr` };
    await platformRevokeApiKey(platform, { organizationId, keyId: publicId }, context);
    await expect(platformRevokeApiKey(platform, { organizationId, keyId: publicId }, context)).rejects.toThrow("already revoked");
    const resolver = createDatabase(outboxApplicationConnectionString(connectionString!), "postgres-js");
    expect((await resolveApiKey(resolver, publicId))?.revokedAt).toBeInstanceOf(Date);
    const [event] = await sql!`select actor_type, organization_id, reason from audit_event where name = 'platform.api_key.revoked' and target_id = ${publicId}`;
    expect(event).toEqual({ actor_type: "platform_operator", organization_id: organizationId, reason: "leaked in a public repository" });
  });
});
