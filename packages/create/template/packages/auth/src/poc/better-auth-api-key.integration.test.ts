/**
 * The seven acceptance gates from docs/INTEGRATION_STRATEGY.md §4, run
 * against a real PostgreSQL database. Each test asserts what Better Auth
 * 1.7.5 actually does, so a behavior change in a later release fails here and
 * prompts a re-evaluation. Findings: docs/API_KEY_POC.md.
 */
import { credentialAccess, mintApiKey } from "@__TRESTLE_PROJECT_NAME__/authz";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BetterAuthCredentialVerifier, createApiKeyPocAuth, pocApiKeyDdl, pocApiKeyTableName } from "./better-auth-api-key.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const run = `poc${Date.now()}`;
const organizationId = `${run}-org`;
const ownerId = `${run}-owner`;
const serviceAccount = { id: `${run}-sa`, organizationId, status: "active" as const, authority: new Set(["projects.read"]) };
const request = { now: new Date(), environment: "production" as const, clientIp: "10.0.0.7", serviceAccount, required: "projects.read" };
const issue = { organizationId, serviceAccountId: serviceAccount.id, environment: "production" as const, scopes: ["projects.read", "projects.delete"], expiresAt: null, allowedCidrs: ["10.0.0.0/8"], issuedBy: ownerId };
const rlsRole = `${run}_auth`;

suite("Better Auth API Key plugin against the Trestle acceptance gates", () => {
  let instanceA: ReturnType<typeof createApiKeyPocAuth>;
  let instanceB: ReturnType<typeof createApiKeyPocAuth>;
  let verifierA: BetterAuthCredentialVerifier;
  let verifierB: BetterAuthCredentialVerifier;

  beforeAll(async () => {
    await sql!.unsafe(pocApiKeyDdl);
    await sql!`insert into "user" (id, name, email, email_verified, created_at, updated_at) values (${ownerId}, 'Owner', ${`${ownerId}@example.test`}, true, now(), now())`;
    await sql!`insert into organization (id, name, slug, created_at) values (${organizationId}, 'POC', ${organizationId}, now())`;
    await sql!`insert into member (id, organization_id, user_id, role, created_at) values (${`${run}-m`}, ${organizationId}, ${ownerId}, 'owner', now())`;
    // Two independent runtimes over the same database, as two Worker instances would be.
    instanceA = createApiKeyPocAuth(connectionString!, "postgres-js");
    instanceB = createApiKeyPocAuth(connectionString!, "postgres-js");
    verifierA = new BetterAuthCredentialVerifier(instanceA, ownerId);
    verifierB = new BetterAuthCredentialVerifier(instanceB, ownerId);
  });

  afterAll(async () => {
    await sql!.unsafe(`drop table if exists ${pocApiKeyTableName}`);
    await sql!.unsafe(`drop owned by ${rlsRole}`).catch(() => undefined);
    await sql!.unsafe(`drop role if exists ${rlsRole}`).catch(() => undefined);
    await sql!`delete from member where organization_id = ${organizationId}`;
    await sql!`delete from organization where id = ${organizationId}`;
    await sql!`delete from "user" where id = ${ownerId}`;
    await sql!.end();
  });

  it("gate 1 FAILS: the key commits in Better Auth's own write, so a failed Trestle audit/outbox write leaves a live key", async () => {
    // Trestle issues keys, audit, and outbox in one transaction. The plugin's
    // create endpoint accepts no outer transaction, so this is the best a wrapper can do.
    let issued: Awaited<ReturnType<BetterAuthCredentialVerifier["issue"]>> | undefined;
    await expect((async () => {
      issued = await verifierA.issue(issue);
      throw new Error("audit write failed");
    })()).rejects.toThrow("audit write failed");
    expect(await verifierA.verify(issued!.token)).not.toBeNull();
  });

  it("gate 2 PASSES: only a SHA-256 digest is stored and no read returns the secret", async () => {
    const issued = await verifierA.issue(issue);
    const [row] = await sql!.unsafe(`select key, start from ${pocApiKeyTableName} where id = $1`, [issued.credentialId]);
    expect(row!.key).not.toBe(issued.token);
    expect(row!.key).toBe(Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(issued.token))).toString("base64url"));
    const verified = await instanceA.api.verifyApiKey({ body: { key: issued.token } });
    expect(JSON.stringify(verified)).not.toContain(issued.token);
  });

  it("gate 3 PASSES with database storage: revocation in one runtime is refused by another immediately", async () => {
    const issued = await verifierA.issue(issue);
    expect(await verifierB.verify(issued.token)).not.toBeNull();
    await verifierA.revoke(issued.credentialId);
    expect(await verifierB.verify(issued.token)).toBeNull();
    // Rotation is issue-then-revoke; the plugin has no bounded overlap or lineage.
    const replacement = await verifierA.issue(issue);
    expect(await verifierB.verify(replacement.token)).not.toBeNull();
  });

  it("gate 4 FAILS: lookup must read the credential table before any tenant is known, so the table cannot be under forced RLS", async () => {
    const issued = await verifierA.issue(issue);
    await sql!.unsafe(`create role ${rlsRole} login password '${rlsRole}'`);
    await sql!.unsafe(`grant usage on schema public to ${rlsRole}`);
    await sql!.unsafe(`grant select, insert, update, delete on ${pocApiKeyTableName}, "user", organization, member, session to ${rlsRole}`);
    await sql!.unsafe(`alter table ${pocApiKeyTableName} enable row level security`);
    await sql!.unsafe(`alter table ${pocApiKeyTableName} force row level security`);
    await sql!.unsafe(`create policy ${rlsRole}_tenant on ${pocApiKeyTableName} to ${rlsRole} using (reference_id = current_setting('app.organization_id', true))`);
    try {
      const url = new URL(connectionString!);
      url.username = rlsRole;
      url.password = rlsRole;
      const isolated = new BetterAuthCredentialVerifier(createApiKeyPocAuth(url.toString(), "postgres-js"), ownerId);
      // Under the same isolation Trestle's api_key table has, the plugin cannot find any key.
      expect(await isolated.verify(issued.token)).toBeNull();
    } finally {
      await sql!.unsafe(`alter table ${pocApiKeyTableName} no force row level security`);
      await sql!.unsafe(`alter table ${pocApiKeyTableName} disable row level security`);
    }
    // Without isolation it works, i.e. the plugin requires a table readable across tenants.
    expect(await verifierA.verify(issued.token)).not.toBeNull();
  });

  it("gate 5 PASSES at the port: plugin scopes are data, and Trestle clamps them to the service account", async () => {
    const issued = await verifierA.issue(issue);
    const verified = await verifierA.verify(issued.token);
    expect(verified?.scopes).toContain("projects.delete");
    const access = credentialAccess(verified!, { ...request, required: "projects.delete" });
    expect(access.allowed).toBe(false);
    expect(access.effective).toEqual(["projects.read"]);
  });

  it("gate 6 FAILS by default: environment and CIDR live in metadata that the plugin's update endpoint lets a key owner rewrite", async () => {
    const issued = await verifierA.issue(issue);
    expect(credentialAccess((await verifierA.verify(issued.token))!, { ...request, clientIp: "203.0.113.9" }).status).toBe("network_denied");
    await instanceA.api.updateApiKey({ body: { keyId: issued.credentialId, userId: ownerId, metadata: { serviceAccountId: serviceAccount.id, environment: "production", allowedCidrs: null, scopes: issue.scopes } } });
    // The restriction is gone without any Trestle policy check, audit, or outbox event.
    expect(credentialAccess((await verifierA.verify(issued.token))!, { ...request, clientIp: "203.0.113.9" }).allowed).toBe(true);
    // Missing constraints do fail closed at the port.
    await instanceA.api.updateApiKey({ body: { keyId: issued.credentialId, userId: ownerId, metadata: { serviceAccountId: serviceAccount.id, scopes: issue.scopes } } });
    expect(credentialAccess((await verifierA.verify(issued.token))!, request).status).toBe("missing_constraints");
    // Disabling the update route closes that path, but the constraint still is not enforced by the credential store.
    const locked = createApiKeyPocAuth(connectionString!, "postgres-js", { disabledPaths: ["/api-key/update"] });
    const response = await locked.handler(new Request("http://localhost:42069/api/auth/api-key/update", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keyId: issued.credentialId, metadata: {} }) }));
    expect(response.status).toBe(404);
  });

  it("gate 7 PASSES: existing Trestle keys verify after re-encoding the stored digest, with no reissue", async () => {
    const minted = await mintApiKey("production");
    const digest = Buffer.from(minted.verifier, "hex").toString("base64url");
    await sql!.unsafe(`insert into ${pocApiKeyTableName} (id, config_id, reference_id, prefix, start, key, enabled, rate_limit_enabled, request_count, created_at, updated_at, metadata)
      values ($1, 'default', $2, 'tr_live', $3, $4, true, false, 0, now(), now(), $5)`, [`${run}-imported`, organizationId, minted.displayPrefix, digest, JSON.stringify({ serviceAccountId: serviceAccount.id, environment: "production", allowedCidrs: ["10.0.0.0/8"], scopes: ["projects.read"] })]);
    const verified = await verifierB.verify(minted.token);
    expect(verified).toMatchObject({ credentialId: `${run}-imported`, serviceAccountId: serviceAccount.id, environment: "production" });
    expect(credentialAccess(verified!, request).allowed).toBe(true);
  });
});
