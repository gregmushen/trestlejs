import { applicationRoles, organizationRoles } from "@__TRESTLE_PROJECT_NAME__/authz";
import { reconcileExternalAssignments, validateMapping, type ExternalRoleMapping, type SourcedAssignment } from "@__TRESTLE_PROJECT_NAME__/integrations";
import type { BetterAuthPlugin, DBTransactionAdapter } from "better-auth";

/**
 * Better Auth SCIM integration (docs/INTEGRATION_STRATEGY.md §5.1). The SCIM
 * plugin owns the protocol, credentials, and provisioned identities inside
 * one native transaction. Trestle supplies the projection: which Trestle
 * organization receives the user, and which organization- and
 * application-plane roles the configured group mappings grant. Those writes,
 * and their audit and outbox records, commit in the same transaction.
 */

const SOURCE = "better_auth_scim" as const;
const actorId = (connectionId: string) => `${SOURCE}:${connectionId}`;

/** Registers the Trestle tables the projection writes as Better Auth models, so they join the SCIM transaction. */
export function trestleDirectoryModels() {
  return {
    id: "trestle-directory",
    schema: {
      applicationRoleAssignment: {
        fields: {
          organizationId: { type: "string", required: true },
          userId: { type: "string", required: true },
          role: { type: "string", required: true },
          grantedBy: { type: "string", required: true },
          grantedAt: { type: "date", required: true },
          revokedAt: { type: "date", required: false },
          revokedBy: { type: "string", required: false },
          revocationReason: { type: "string", required: false },
          sourceProvider: { type: "string", required: false },
          sourceConnectionId: { type: "string", required: false },
          sourceGroupId: { type: "string", required: false },
        },
      },
      externalRoleMapping: {
        fields: {
          organizationId: { type: "string", required: true },
          provider: { type: "string", required: true },
          connectionId: { type: "string", required: true },
          externalGroupId: { type: "string", required: true },
          targetPlane: { type: "string", required: true },
          targetRole: { type: "string", required: true },
          createdBy: { type: "string", required: true },
          createdAt: { type: "date", required: true },
        },
      },
      auditEvent: {
        fields: {
          occurredAt: { type: "date", required: true },
          name: { type: "string", required: true },
          schemaVersion: { type: "number", required: true },
          actorType: { type: "string", required: true },
          actorId: { type: "string", required: true },
          organizationId: { type: "string", required: false },
          targetType: { type: "string", required: true },
          targetId: { type: "string", required: true },
          summary: { type: "json", required: true },
          outcome: { type: "string", required: true },
          environment: { type: "string", required: true },
          correlationId: { type: "string", required: true },
        },
      },
      outboxMessage: {
        fields: {
          eventName: { type: "string", required: true },
          schemaVersion: { type: "number", required: true },
          occurredAt: { type: "date", required: true },
          resourceType: { type: "string", required: true },
          resourceId: { type: "string", required: true },
          correlationId: { type: "string", required: true },
          idempotencyKey: { type: "string", required: true },
          payload: { type: "json", required: true },
          availableAt: { type: "date", required: true },
        },
      },
    },
  } satisfies BetterAuthPlugin;
}

type Row = Record<string, unknown>;
const orgRank: Readonly<Record<string, number>> = { member: 1, billing_admin: 2, admin: 3 };

/** Role strings carried through the SCIM plugin are "<plane>:<role>". */
export const encodeGrant = (plane: "organization" | "application", role: string) => `${plane}:${role}`;
export function decodeGrant(value: string): { plane: "organization" | "application"; role: string } | null {
  const [plane, role] = value.split(":", 2);
  return (plane === "organization" || plane === "application") && role ? { plane, role } : null;
}

async function mappingsFor(database: Pick<DBTransactionAdapter, "findMany">, organizationId: string, connectionId: string): Promise<ExternalRoleMapping[]> {
  const rows = await database.findMany<Row>({ model: "externalRoleMapping", where: [{ field: "organizationId", value: organizationId }, { field: "provider", value: SOURCE }, { field: "connectionId", value: connectionId }] });
  const known = { organization: organizationRoles.list().map((role) => role.key), application: applicationRoles.list().map((role) => role.key) };
  return rows.flatMap((row) => { try { return [validateMapping(row, known)]; } catch { return []; } });
}

export type DirectoryProjectionOptions = Readonly<{ environment: string; now?: () => Date }>;

/** SCIM projection: membership, organization role, and source-owned application roles for one provisioned user. */
export function scimProjection(options: DirectoryProjectionOptions) {
  const now = options.now ?? (() => new Date());
  return {
    roles: {
      async map(input: { connectionId: string; provisioningDomainId: string; source: { id: string; externalId?: string; displayName: string } }, context: { database: DBTransactionAdapter }) {
        const mappings = await mappingsFor(context.database, input.provisioningDomainId, input.connectionId);
        return mappings.filter((mapping) => mapping.externalGroupId === input.source.id || mapping.externalGroupId === input.source.externalId).map((mapping) => encodeGrant(mapping.targetPlane, mapping.targetRole));
      },
      async exists(input: { role: string }) {
        const grant = decodeGrant(input.role);
        if (!grant) return false;
        return grant.plane === "organization" ? Boolean(organizationRoles.get(grant.role)) && grant.role !== "owner" : Boolean(applicationRoles.get(grant.role));
      },
    },
    async reconcileUser(state: { provisioningDomainId: string; userId: string; active: boolean; sources: readonly { connectionId: string; active: boolean }[]; grants: readonly { source: { id: string }; role: string }[] }, context: { database: DBTransactionAdapter }) {
      const { database } = context;
      const organizationId = state.provisioningDomainId;
      const connectionId = state.sources[0]?.connectionId ?? "unknown";
      const at = now();
      const correlationId = crypto.randomUUID();
      const changes: Array<{ name: string; summary: Record<string, unknown> }> = [];
      const grants = state.grants.flatMap((grant) => { const decoded = decodeGrant(grant.role); return decoded ? [{ ...decoded, group: grant.source.id }] : []; });

      // Organization plane: the directory owns membership it created and the role it set.
      const member = await database.findOne<Row>({ model: "member", where: [{ field: "organizationId", value: organizationId }, { field: "userId", value: state.userId }] });
      const orgGrants = grants.filter((grant) => grant.plane === "organization").sort((a, b) => (orgRank[b.role] ?? 0) - (orgRank[a.role] ?? 0));
      const desiredRole = orgGrants[0]?.role ?? "member";
      const roleSource = orgGrants[0] ? `${actorId(connectionId)}:${orgGrants[0].group}` : actorId(connectionId);
      if (state.active) {
        if (!member) {
          await database.create({ model: "member", data: { organizationId, userId: state.userId, role: desiredRole, roleSource, createdAt: at } });
          changes.push({ name: "directory.member.added", summary: { role: desiredRole } });
        } else if (member.roleSource && (member.role !== desiredRole || member.roleSource !== roleSource)) {
          await database.update({ model: "member", where: [{ field: "id", value: String(member.id) }], update: { role: desiredRole, roleSource } });
          changes.push({ name: "directory.member.role_changed", summary: { from: member.role, to: desiredRole } });
        }
      } else if (member?.roleSource && String(member.roleSource).startsWith(actorId(connectionId))) {
        await database.delete({ model: "member", where: [{ field: "id", value: String(member.id) }] });
        changes.push({ name: "directory.member.removed", summary: { reason: "deactivated" } });
      }

      // Application plane: only assignments this connection owns are granted or revoked.
      const current = await database.findMany<Row>({ model: "applicationRoleAssignment", where: [{ field: "organizationId", value: organizationId }, { field: "userId", value: state.userId }, { field: "revokedAt", value: null }] });
      const owned: SourcedAssignment[] = current.filter((row) => row.sourceProvider === SOURCE && row.sourceConnectionId === connectionId)
        .map((row) => ({ plane: "application", role: String(row.role), source: { provider: SOURCE, connectionId, externalGroupId: String(row.sourceGroupId) } }));
      const desired: ExternalRoleMapping[] = grants.filter((grant) => grant.plane === "application").map((grant) => ({ provider: SOURCE, connectionId, externalGroupId: grant.group, targetPlane: "application", targetRole: grant.role }));
      const plan = reconcileExternalAssignments(owned, desired, { provider: SOURCE, connectionId }, desired.map((mapping) => ({ externalGroupId: mapping.externalGroupId, name: mapping.externalGroupId })), state.active);
      for (const revoke of plan.revoke) {
        const row = current.find((candidate) => candidate.role === revoke.role && candidate.sourceProvider === SOURCE && candidate.sourceConnectionId === connectionId && candidate.sourceGroupId === revoke.source?.externalGroupId);
        if (!row) continue;
        await database.update({ model: "applicationRoleAssignment", where: [{ field: "id", value: String(row.id) }], update: { revokedAt: at, revokedBy: actorId(connectionId), revocationReason: state.active ? "directory group mapping no longer applies" : "directory user deactivated" } });
        changes.push({ name: "directory.role.revoked", summary: { plane: "application", role: revoke.role, group: revoke.source?.externalGroupId } });
      }
      const active = new Set(current.filter((row) => !plan.revoke.some((revoke) => revoke.role === row.role && row.sourceProvider === SOURCE)).map((row) => String(row.role)));
      for (const grant of plan.grant) {
        // An existing manual or other-source assignment of the same role already applies; never duplicate it.
        if (active.has(grant.role)) continue;
        active.add(grant.role);
        await database.create({ model: "applicationRoleAssignment", forceAllowId: true, data: {
          id: crypto.randomUUID(), organizationId, userId: state.userId, role: grant.role, grantedBy: actorId(connectionId), grantedAt: at,
          sourceProvider: SOURCE, sourceConnectionId: connectionId, sourceGroupId: grant.source?.externalGroupId ?? null,
        } });
        changes.push({ name: "directory.role.granted", summary: { plane: "application", role: grant.role, group: grant.source?.externalGroupId } });
      }

      for (const change of changes) {
        await database.create({ model: "auditEvent", forceAllowId: true, data: {
          id: crypto.randomUUID(), occurredAt: at, name: change.name, schemaVersion: 1, actorType: "directory", actorId: actorId(connectionId), organizationId,
          targetType: "user", targetId: state.userId, summary: change.summary, outcome: "succeeded", environment: options.environment, correlationId,
        } });
      }
      if (changes.length) {
        await database.create({ model: "outboxMessage", forceAllowId: true, data: {
          id: crypto.randomUUID(), eventName: "access.directory_user_reconciled", schemaVersion: 1, occurredAt: at, resourceType: "user", resourceId: state.userId, correlationId,
          idempotencyKey: `directory:${connectionId}:${state.userId}:${correlationId}`, payload: { organizationId, userId: state.userId, active: state.active, changes: changes.map((change) => change.name) }, availableAt: at,
        } });
      }
    },
  };
}

/**
 * Links an incoming SCIM user to an existing account only when the
 * organization has a verified SSO domain matching the address. It never
 * links on an unverified email match.
 */
export async function resolveScimUser(input: { provisioningDomainId: string; resource: { primaryEmail: string } }, context: { database: Pick<DBTransactionAdapter, "findOne" | "findMany"> }, requireVerifiedDomain: boolean) {
  const email = input.resource.primaryEmail.toLowerCase();
  const domain = email.split("@")[1] ?? "";
  const existing = await context.database.findOne<Row>({ model: "user", where: [{ field: "email", value: email }] });
  if (!existing) return { action: "create" as const };
  const providers = await context.database.findMany<Row>({ model: "ssoProvider", where: [{ field: "organizationId", value: input.provisioningDomainId }] });
  const trusted = providers.some((provider) => String(provider.domain).toLowerCase() === domain && (!requireVerifiedDomain || provider.domainVerified === true));
  if (!trusted) throw new Error("A user with this email already exists and the organization has no verified SSO domain for it");
  return { action: "link" as const, userId: String(existing.id), profile: "preserve" as const };
}
