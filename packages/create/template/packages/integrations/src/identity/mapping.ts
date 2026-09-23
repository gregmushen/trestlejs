import type { DirectoryGroupRef, DirectoryProviderKind } from "./types.js";

/**
 * Maps one external group to one Trestle role. The target plane is explicit
 * and can never be the platform plane: tenant-controlled directories must not
 * grant operator authority.
 */
export type ExternalRoleMapping = Readonly<{
  provider: DirectoryProviderKind;
  connectionId: string;
  externalGroupId: string;
  targetPlane: "organization" | "application";
  targetRole: string;
}>;

/** An assignment together with the source that owns it. Assignments without a source are manual. */
export type SourcedAssignment = Readonly<{
  plane: "organization" | "application";
  role: string;
  source: Readonly<{ provider: DirectoryProviderKind; connectionId: string; externalGroupId: string }> | null;
}>;

export type AssignmentChanges = Readonly<{ grant: SourcedAssignment[]; revoke: SourcedAssignment[] }>;

export class MappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MappingError";
  }
}

/** Rejects mappings a tenant must not be able to store, whatever the stored data claims. */
export function validateMapping(mapping: Readonly<Record<string, unknown>>, knownRoles: Readonly<{ organization: readonly string[]; application: readonly string[] }>): ExternalRoleMapping {
  const plane = mapping.targetPlane;
  if (plane === "platform") throw new MappingError("Platform roles are never provisioned through a tenant directory");
  if (plane !== "organization" && plane !== "application") throw new MappingError("targetPlane must be organization or application");
  const role = String(mapping.targetRole ?? "");
  if (!knownRoles[plane].includes(role)) throw new MappingError(`${role || "(empty)"} is not a ${plane} role`);
  if (plane === "organization" && role === "owner") throw new MappingError("Ownership is never provisioned; transfer it explicitly");
  for (const field of ["provider", "connectionId", "externalGroupId"] as const) {
    if (typeof mapping[field] !== "string" || mapping[field] === "") throw new MappingError(`${field} is required`);
  }
  if (mapping.provider !== "better_auth_scim" && mapping.provider !== "workos") throw new MappingError("provider must be better_auth_scim or workos");
  return { provider: mapping.provider, connectionId: String(mapping.connectionId), externalGroupId: String(mapping.externalGroupId), targetPlane: plane, targetRole: role };
}

const key = (assignment: SourcedAssignment) => `${assignment.plane}:${assignment.role}:${assignment.source ? `${assignment.source.provider}:${assignment.source.connectionId}:${assignment.source.externalGroupId}` : "manual"}`;

/**
 * Computes the assignment changes for one user from their current directory
 * groups. Only assignments owned by this provider connection are revoked;
 * manual assignments and other sources are never touched. An inactive user
 * loses every assignment this source owns.
 */
export function reconcileExternalAssignments(
  current: readonly SourcedAssignment[],
  mappings: readonly ExternalRoleMapping[],
  source: Readonly<{ provider: DirectoryProviderKind; connectionId: string }>,
  groups: readonly DirectoryGroupRef[],
  active: boolean,
): AssignmentChanges {
  const memberOf = new Set(groups.map((group) => group.externalGroupId));
  const desired = active
    ? mappings
      .filter((mapping) => mapping.provider === source.provider && mapping.connectionId === source.connectionId && memberOf.has(mapping.externalGroupId))
      .map((mapping): SourcedAssignment => ({ plane: mapping.targetPlane, role: mapping.targetRole, source: { provider: source.provider, connectionId: source.connectionId, externalGroupId: mapping.externalGroupId } }))
    : [];
  const owned = current.filter((assignment) => assignment.source?.provider === source.provider && assignment.source.connectionId === source.connectionId);
  const ownedKeys = new Set(owned.map(key));
  const desiredKeys = new Set(desired.map(key));
  return {
    grant: desired.filter((assignment) => !ownedKeys.has(key(assignment))),
    revoke: owned.filter((assignment) => !desiredKeys.has(key(assignment))),
  };
}
