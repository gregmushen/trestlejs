import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { createSqlRunner, tenantConnectionString, type DatabaseDriver } from "@__TRESTLE_PROJECT_NAME__/db";
import { sql } from "drizzle-orm";

import { createAuth, scimManagement, supportsNativeTransactions, type AuthEnvironment } from "./index.js";

/**
 * SCIM transaction compatibility test (docs/INTEGRATION_STRATEGY.md §5.3).
 * Real SCIM 2.0 requests go through Better Auth against the environment's own
 * database and driver: create a user into a group mapped to an application
 * role, update the user, then deactivate them. Each step must commit the SCIM
 * state and Trestle's membership, role, and audit records together. The
 * resources it creates are removed afterwards. `trestle identity verify-scim`
 * runs this file and records the result as evidence.
 */
export type ScimTransactionResult = {
  driver: string;
  passed: boolean;
  operations: Array<"create" | "update" | "deactivate">;
  checkedAt: string;
  failure?: string;
};

type Step = "create" | "update" | "deactivate";

export async function runScimTransactionTest(environment: AuthEnvironment, now: () => Date = () => new Date()): Promise<ScimTransactionResult> {
  const driver: DatabaseDriver = environment.DATABASE_DRIVER ?? "neon-http";
  const operations: Step[] = [];
  const result = (failure?: string): ScimTransactionResult => ({ driver, passed: !failure, operations, checkedAt: now().toISOString(), ...(failure ? { failure: failure.slice(0, 300) } : {}) });
  if (!supportsNativeTransactions(environment)) return result(`${driver} does not provide interactive transactions; Better Auth SCIM refuses to run on it`);

  const auth = createAuth(environment, { capabilities: { passkeys: false, twoFactor: false, sso: "better-auth", directory: "better-auth-scim" } });
  const management = scimManagement(auth);
  if (!management) return result("SCIM is unavailable: SCIM_CREDENTIAL_SECRET is missing for this environment");
  const owner = createSqlRunner(environment.DATABASE_URL, driver);
  const run = `scimcheck${now().getTime()}`;
  const organizationId = `${run}-org`;
  const actorId = `${run}-owner`;
  const base = `${environment.BETTER_AUTH_URL ?? "http://localhost:42069"}/api/auth/scim/v2`;
  let connectionId: string | null = null;
  let provisionedUserId: string | null = null;

  const scim = async (token: string, method: string, path: string, body?: unknown) => {
    const response = await auth.handler(new Request(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/scim+json", accept: "application/scim+json" }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    const text = await response.text();
    if (!response.ok) throw new Error(`SCIM ${method} ${path.split("/")[1]} returned ${response.status}`);
    return text ? JSON.parse(text) as Record<string, unknown> : {};
  };

  try {
    await owner.query(sql`insert into "user" (id, name, email, email_verified, created_at, updated_at) values (${actorId}, 'SCIM check', ${`${actorId}@scim-check.invalid`}, true, now(), now())`);
    await owner.query(sql`insert into organization (id, name, slug, created_at) values (${organizationId}, 'SCIM check', ${organizationId}, now())`);
    const created = await management.createSCIMManagedConnection({ body: { scopes: ["scim.users.read", "scim.users.write", "scim.groups.read", "scim.groups.write"], expiresAt: new Date(now().getTime() + 3_600_000), creationRequestId: crypto.randomUUID(), provisioningDomainId: organizationId, actorId } });
    connectionId = created.connection.connectionId;
    const token = created.token;

    // Group first, mapped to an application role, so user creation exercises the projection.
    const group = await scim(token, "POST", "/Groups", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: "Engineering", externalId: `${run}-eng` });
    await createSqlRunner(tenantConnectionString(environment.DATABASE_URL, organizationId), driver).query(sql`insert into external_role_mapping (organization_id, provider, connection_id, external_group_id, target_plane, target_role, created_by)
      values (${organizationId}, 'better_auth_scim', ${connectionId}, ${String(group.id)}, 'application', 'reader', ${actorId})`);

    const user = await scim(token, "POST", "/Users", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: `ada.${run}@scim-check.invalid`, externalId: `${run}-ada`, name: { givenName: "Ada", familyName: "Lovelace" }, emails: [{ value: `ada.${run}@scim-check.invalid`, primary: true }], active: true });
    await scim(token, "PATCH", `/Groups/${String(group.id)}`, { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "add", path: "members", value: [{ value: String(user.id) }] }] });
    const [linked] = await owner.query(sql`select user_id from scim_user where id = ${String(user.id)}`);
    provisionedUserId = linked ? String(linked.user_id) : null;
    if (!provisionedUserId) throw new Error("the provisioned user has no Better Auth account");
    const [member] = await owner.query(sql`select role, role_source from member where organization_id = ${organizationId} and user_id = ${provisionedUserId}`);
    const [role] = await owner.query(sql`select role from application_role_assignment where organization_id = ${organizationId} and user_id = ${provisionedUserId} and source_provider = 'better_auth_scim' and revoked_at is null`);
    if (!member?.role_source || role?.role !== "reader") throw new Error("the projection did not commit membership and the mapped role with the SCIM user");
    operations.push("create");

    await scim(token, "PATCH", `/Users/${String(user.id)}`, { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "replace", path: "displayName", value: "Ada King" }] });
    const [updated] = await owner.query(sql`select display_name from scim_user where id = ${String(user.id)}`);
    if (updated?.display_name !== "Ada King") throw new Error("the SCIM update did not commit");
    operations.push("update");

    await scim(token, "PATCH", `/Users/${String(user.id)}`, { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "replace", path: "active", value: false }] });
    const [stillMember] = await owner.query(sql`select 1 from member where organization_id = ${organizationId} and user_id = ${provisionedUserId}`);
    const [stillRole] = await owner.query(sql`select 1 from application_role_assignment where organization_id = ${organizationId} and user_id = ${provisionedUserId} and source_provider = 'better_auth_scim' and revoked_at is null`);
    const [audited] = await owner.query(sql`select count(*)::int as count from audit_event where organization_id = ${organizationId} and name like 'directory.%'`);
    if (stillMember || stillRole) throw new Error("deactivation did not remove directory-owned membership and roles");
    if (Number(audited?.count ?? 0) < 3) throw new Error("directory changes were not audited in the provisioning transaction");
    operations.push("deactivate");
    return result();
  } catch (error) {
    return result(error instanceof Error ? error.message : "unknown failure");
  } finally {
    await cleanUp(owner, { organizationId, actorId, connectionId, provisionedUserId, management });
  }
}

async function cleanUp(owner: ReturnType<typeof createSqlRunner>, input: { organizationId: string; actorId: string; connectionId: string | null; provisionedUserId: string | null; management: NonNullable<ReturnType<typeof scimManagement>> }) {
  const ignore = () => undefined;
  if (input.connectionId) await input.management.decommissionSCIMManagedConnection({ body: { connectionId: input.connectionId, provisioningDomainId: input.organizationId, actorId: input.actorId } }).catch(ignore);
  for (const statement of [
    sql`delete from scim_group_member where connection_id = ${input.connectionId ?? ""}`,
    sql`delete from scim_projection_grant where provisioning_domain_id = ${input.organizationId}`,
    sql`delete from scim_group where provisioning_domain_id = ${input.organizationId}`,
    sql`delete from scim_identity_tombstone where provisioning_domain_id = ${input.organizationId}`,
    sql`delete from scim_user where provisioning_domain_id = ${input.organizationId}`,
    sql`delete from scim_subject where user_id = ${input.provisionedUserId ?? ""}`,
    sql`delete from scim_connection_binding where provisioning_domain_id = ${input.organizationId}`,
    sql`delete from scim_managed_connection where provisioning_domain_id = ${input.organizationId}`,
    sql`delete from external_role_mapping where organization_id = ${input.organizationId}`,
    sql`delete from application_role_assignment where organization_id = ${input.organizationId}`,
    sql`delete from member where organization_id = ${input.organizationId}`,
    sql`delete from organization where id = ${input.organizationId}`,
    sql`delete from "user" where id in (${input.actorId}, ${input.provisionedUserId ?? ""})`,
  ]) await owner.query(statement).catch(ignore);
}

// Invoked directly by `trestle identity verify-scim`, which supplies credentials through the environment.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const environment = process.env as unknown as AuthEnvironment;
  const outcome = await runScimTransactionTest(environment);
  if (process.env.TRESTLE_SCIM_RESULT) await writeFile(process.env.TRESTLE_SCIM_RESULT, JSON.stringify(outcome));
  process.stdout.write(`${outcome.passed ? "passed" : `failed: ${outcome.failure ?? "unknown"}`} (${outcome.driver})\n`);
  process.exit(outcome.passed ? 0 : 1);
}
