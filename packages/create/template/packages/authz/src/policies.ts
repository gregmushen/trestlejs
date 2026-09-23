import { applicationRoles } from "./role-definitions.js";

/**
 * Explicit, tested relationships between organization membership and
 * application roles. Authority never flows between planes implicitly; these
 * are one-time grants made when membership is created, and removing either
 * assignment later does not affect the other. Change them to suit the product.
 */

/** The user who creates an organization can administer the product in it. */
export const organizationCreatorApplicationRoles: readonly string[] = ["app_admin"];

/** Members who join later start with product read/write access. Use [] to require an explicit grant. */
export const memberDefaultApplicationRoles: readonly string[] = ["editor"];

for (const role of [...organizationCreatorApplicationRoles, ...memberDefaultApplicationRoles]) {
  if (!applicationRoles.get(role)) throw new Error(`Membership policy references unknown application role ${role}`);
}

/** Application roles known to the reviewed catalog; unknown keys are rejected before they are stored. */
export function unknownApplicationRoles(roles: readonly string[]): string[] {
  return roles.filter((role) => !applicationRoles.get(role));
}
