import { describe, expect, it } from "vitest";

import { MappingError, reconcileExternalAssignments, validateMapping, type ExternalRoleMapping, type SourcedAssignment } from "./mapping.js";

const roles = { organization: ["owner", "admin", "billing_admin", "member", "viewer"], application: ["app_admin", "app_viewer"] };
const source = { provider: "workos" as const, connectionId: "directory_1" };
const mappings: ExternalRoleMapping[] = [
  { provider: "workos", connectionId: "directory_1", externalGroupId: "engineering", targetPlane: "application", targetRole: "app_admin" },
  { provider: "workos", connectionId: "directory_1", externalGroupId: "finance", targetPlane: "organization", targetRole: "billing_admin" },
  { provider: "workos", connectionId: "directory_2", externalGroupId: "engineering", targetPlane: "application", targetRole: "app_viewer" },
];
const owned = (plane: "organization" | "application", role: string, group: string, connectionId = "directory_1"): SourcedAssignment => ({ plane, role, source: { provider: "workos", connectionId, externalGroupId: group } });

describe("external role mappings", () => {
  it("never maps a directory group to the platform plane or to ownership", () => {
    expect(() => validateMapping({ provider: "workos", connectionId: "c", externalGroupId: "g", targetPlane: "platform", targetRole: "security_admin" }, roles)).toThrow(/Platform roles are never provisioned/u);
    expect(() => validateMapping({ provider: "workos", connectionId: "c", externalGroupId: "g", targetPlane: "organization", targetRole: "owner" }, roles)).toThrow(MappingError);
    expect(() => validateMapping({ provider: "workos", connectionId: "c", externalGroupId: "g", targetPlane: "application", targetRole: "root" }, roles)).toThrow(/not a application role/u);
    expect(() => validateMapping({ provider: "okta", connectionId: "c", externalGroupId: "g", targetPlane: "application", targetRole: "app_admin" }, roles)).toThrow(/provider/u);
    expect(validateMapping({ provider: "better_auth_scim", connectionId: "c", externalGroupId: "g", targetPlane: "application", targetRole: "app_admin" }, roles).targetRole).toBe("app_admin");
  });

  it("grants mapped roles for the user's groups and revokes only assignments this source owns", () => {
    const manual: SourcedAssignment = { plane: "application", role: "app_admin", source: null };
    const otherSource = owned("application", "app_viewer", "engineering", "directory_2");
    const stale = owned("organization", "billing_admin", "finance");
    const changes = reconcileExternalAssignments([manual, otherSource, stale], mappings, source, [{ externalGroupId: "engineering", name: "Engineering" }], true);
    expect(changes.grant).toEqual([owned("application", "app_admin", "engineering")]);
    expect(changes.revoke).toEqual([stale]);
  });

  it("is idempotent and removes every source-owned assignment when the user is deactivated", () => {
    const current = [owned("application", "app_admin", "engineering"), owned("organization", "billing_admin", "finance"), { plane: "organization" as const, role: "admin", source: null }];
    const groups = [{ externalGroupId: "engineering", name: "Engineering" }, { externalGroupId: "finance", name: "Finance" }];
    expect(reconcileExternalAssignments(current, mappings, source, groups, true)).toEqual({ grant: [], revoke: [] });
    const deactivated = reconcileExternalAssignments(current, mappings, source, groups, false);
    expect(deactivated.grant).toEqual([]);
    expect(deactivated.revoke).toEqual(current.slice(0, 2));
  });
});
