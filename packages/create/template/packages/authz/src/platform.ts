import { AccessEvaluator } from "./access.js";
import { permissions } from "./permissions.js";
import { platformRoles } from "./role-definitions.js";

/**
 * Platform authority for the optional admin: resolved only from platform-role
 * assignments, with no tenant and no organization or application authority.
 * Selecting an organization in the admin never grants tenant permissions.
 */
export function platformAccess(userId: string, assignments: readonly string[]) {
  const resolved = platformRoles.resolve(assignments);
  return {
    unknownRoles: resolved.unknownRoles,
    access: new AccessEvaluator(permissions, {
      principal: { type: "user", id: userId },
      authority: { platform: resolved.permissions },
      assignments: { platform: [...assignments] },
    }),
  };
}
