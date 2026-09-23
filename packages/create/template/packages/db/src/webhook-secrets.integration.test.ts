import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { createTenantDatabase } from "./index.js";
import { createWebhookSecretCipher, loadCurrentWebhookSigningSecret, WebhookSecretService } from "./webhook-secrets.js";

const databaseUrl = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const sql = databaseUrl ? postgres(databaseUrl, { max: 1, prepare: false }) : undefined;
const endpointIds: string[] = [];
const tenantDatabase = (organizationId: string) => createTenantDatabase(databaseUrl!, "postgres-js", organizationId);
const masterKey = "test-only-webhook-encryption-key-material-123456";

async function endpoint(organizationId: string): Promise<string> {
  const [record] = await sql!<{ id: string }[]>`insert into webhook_endpoint (organization_id, environment, name, destination_url, state, provider, created_by, updated_by) values (${organizationId}, 'local', 'Secret test', 'https://example.test/hook', 'disabled', 'local', 'test-user', 'test-user') returning id`;
  if (!record) throw new Error("Endpoint fixture failed");
  endpointIds.push(record.id);
  return record.id;
}

function harness(options: { stepUpAt?: Date; deny?: boolean; environment?: "local" | "staging" } = {}) {
  let now = new Date("2026-09-22T12:00:00.000Z");
  const actions: string[] = [];
  const service = new WebhookSecretService({
    tenantDatabase, masterKey, environment: options.environment ?? "local", clock: { now: () => now },
    authority: { authorize: async ({ action }) => {
      actions.push(action);
      if (options.deny) throw new Error("not authorized");
      return { actorId: "test-user", stepUpAt: options.stepUpAt ?? now };
    } },
  });
  return { service, actions, advance(hours: number) { now = new Date(now.getTime() + hours * 60 * 60_000); }, now: () => now };
}

suite("encrypted outbound webhook signing secrets", () => {
  afterAll(async () => {
    if (endpointIds.length) await sql!`delete from webhook_secret_version where endpoint_id = any(${endpointIds})`;
    if (endpointIds.length) await sql!`delete from webhook_endpoint where id = any(${endpointIds})`;
    await sql!.end();
  });

  it("discloses a new secret once while storing only authenticated ciphertext", async () => {
    const endpointId = await endpoint("secrets-create-org");
    const { service, actions } = harness();
    const issued = await service.issue("secrets-create-org", endpointId);
    expect(issued.secret).toMatch(/^whsec_[A-Za-z0-9+/]+=*$/u);
    expect(issued.metadata).toMatchObject({ version: 1, state: "current", expiresAt: null });
    expect(actions).toEqual(["manage"]);
    const [stored] = await sql!<{ ciphertext: string; fingerprint: string }[]>`select ciphertext, fingerprint from webhook_secret_version where endpoint_id=${endpointId}`;
    expect(stored?.ciphertext).toMatch(/^v1:/u);
    expect(stored?.ciphertext).not.toContain(issued.secret);
    expect(stored?.fingerprint).toBe(issued.metadata.fingerprint);
    expect(JSON.stringify(await service.list("secrets-create-org", endpointId))).not.toContain(issued.secret);
    expect(JSON.stringify(await service.list("secrets-create-org", endpointId))).not.toContain(stored!.ciphertext);
    expect(await service.activeForDelivery("secrets-create-org", endpointId)).toEqual([issued.secret]);
    await expect(service.issue("secrets-create-org", endpointId)).rejects.toThrow("already has");
  });

  it("rotates with bounded overlap, expires the previous key, and never reveals it through list", async () => {
    const endpointId = await endpoint("secrets-rotate-org");
    const scope = harness();
    const first = await scope.service.issue("secrets-rotate-org", endpointId);
    const second = await scope.service.rotate("secrets-rotate-org", endpointId);
    expect(second.secret).not.toBe(first.secret);
    expect(second.metadata.version).toBe(2);
    expect(await scope.service.activeForDelivery("secrets-rotate-org", endpointId)).toEqual([first.secret, second.secret]);
    expect(await loadCurrentWebhookSigningSecret({ tenantDatabase, masterKey, environment: "local", organizationId: "secrets-rotate-org", endpointId })).toBe(second.secret);
    expect((await scope.service.list("secrets-rotate-org", endpointId)).map((item) => item.state)).toEqual(["overlapping", "current"]);
    scope.advance(25);
    expect(await scope.service.activeForDelivery("secrets-rotate-org", endpointId)).toEqual([second.secret]);
    expect(await scope.service.eraseExpiredOverlaps("secrets-rotate-org", endpointId)).toBe(1);
    expect(await scope.service.eraseExpiredOverlaps("secrets-rotate-org", endpointId)).toBe(0);
    const third = await scope.service.rotate("secrets-rotate-org", endpointId, 0);
    expect(third.metadata.version).toBe(3);
    const rows = await sql!<{ version: number; state: string; ciphertext: string | null }[]>`select version, state, ciphertext from webhook_secret_version where endpoint_id=${endpointId} order by version`;
    expect(rows.map((row) => ({ version: row.version, state: row.state, erased: row.ciphertext === null }))).toEqual([
      { version: 1, state: "revoked", erased: true },
      { version: 2, state: "revoked", erased: true },
      { version: 3, state: "current", erased: false },
    ]);
    expect(await scope.service.activeForDelivery("secrets-rotate-org", endpointId)).toEqual([third.secret]);
  });

  it("requires recent step-up and an audit reason to revoke the previous key", async () => {
    const endpointId = await endpoint("secrets-revoke-org");
    const stale = harness({ stepUpAt: new Date("2026-09-22T11:50:00.000Z") });
    await stale.service.issue("secrets-revoke-org", endpointId);
    await expect(stale.service.rotate("secrets-revoke-org", endpointId)).rejects.toThrow("step-up");
    const scope = harness();
    const second = await scope.service.rotate("secrets-revoke-org", endpointId);
    await expect(scope.service.revokePrevious("secrets-revoke-org", endpointId, 1, "no")).rejects.toThrow("audit reason");
    expect(await scope.service.revokePrevious("secrets-revoke-org", endpointId, 2, "incorrect current key")).toBe(false);
    expect(await scope.service.revokePrevious("secrets-revoke-org", endpointId, 1, "customer requested immediate revocation")).toBe(true);
    expect(await scope.service.revokePrevious("secrets-revoke-org", endpointId, 1, "duplicate request")).toBe(false);
    expect(await scope.service.activeForDelivery("secrets-revoke-org", endpointId)).toEqual([second.secret]);
    const [revoked] = await sql!<{ ciphertext: string | null; audit_reason: string }[]>`select ciphertext, audit_reason from webhook_secret_version where endpoint_id=${endpointId} and version=1`;
    expect(revoked).toEqual({ ciphertext: null, audit_reason: "customer requested immediate revocation" });
  });

  it("fails closed for unauthorized, cross-tenant, wrong-key, and wrong-environment reads", async () => {
    const endpointId = await endpoint("secrets-owner-org");
    const scope = harness();
    const issued = await scope.service.issue("secrets-owner-org", endpointId);
    await expect(harness({ deny: true }).service.list("secrets-owner-org", endpointId)).rejects.toThrow("not authorized");
    expect(await scope.service.list("another-org", endpointId)).toEqual([]);
    expect(await scope.service.activeForDelivery("another-org", endpointId)).toEqual([]);
    await expect(scope.service.issue("another-org", endpointId)).rejects.toThrow("not found");
    const [stored] = await sql!<{ ciphertext: string }[]>`select ciphertext from webhook_secret_version where endpoint_id=${endpointId}`;
    const wrongKey = await createWebhookSecretCipher("different-webhook-encryption-key-material-1234", "local");
    await expect(wrongKey.decrypt(stored!.ciphertext, "secrets-owner-org", endpointId, 1)).rejects.toThrow("could not be decrypted");
    const wrongEnvironment = await createWebhookSecretCipher(masterKey, "staging");
    await expect(wrongEnvironment.decrypt(stored!.ciphertext, "secrets-owner-org", endpointId, 1)).rejects.toThrow("could not be decrypted");
    const correct = await createWebhookSecretCipher(masterKey, "local");
    await expect(correct.decrypt(stored!.ciphertext, "another-org", endpointId, 1)).rejects.toThrow("could not be decrypted");
    expect(await correct.decrypt(stored!.ciphertext, "secrets-owner-org", endpointId, 1)).toBe(issued.secret);
  });

  it("serializes concurrent issuance and forces tenant RLS on the secret table", async () => {
    const endpointId = await endpoint("secrets-concurrent-org");
    const service = harness().service;
    const outcomes = await Promise.allSettled([service.issue("secrets-concurrent-org", endpointId), service.issue("secrets-concurrent-org", endpointId)]);
    expect(outcomes.map((item) => item.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((await sql!`select id from webhook_secret_version where endpoint_id=${endpointId}`)).toHaveLength(1);
    await sql!.begin(async (transaction) => {
      await transaction`set local role trestle_app`;
      expect(await transaction`select id from webhook_secret_version where endpoint_id=${endpointId}`).toHaveLength(0);
      await transaction`select set_config('app.organization_id', 'secrets-concurrent-org', true)`;
      expect(await transaction`select id from webhook_secret_version where endpoint_id=${endpointId}`).toHaveLength(1);
    });
    expect((await sql!`select relforcerowsecurity from pg_class where relname='webhook_secret_version'`)[0]?.relforcerowsecurity).toBe(true);
  });
});
