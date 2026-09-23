import { applicationRoles } from "./role-definitions.js";

/**
 * Explicit, tested relationships between organization membership and
 * application roles. Authority never flows between planes implicitly; these
 * are one-time grants made when membership is created, and removing either
 * assignment later does not affect the other. Change them to suit the product.
 */

/** The user who creates an organization can administer the product in it. */
export const organizationCreatorApplicationRoles: readonly string[] = ["app_admin"];

/**
 * Members who join later start with no application role: an application
 * administrator grants product access explicitly. Listing roles here grants
 * them to every new member, which is an application decision.
 */
export const memberDefaultApplicationRoles: readonly string[] = [];

for (const role of [...organizationCreatorApplicationRoles, ...memberDefaultApplicationRoles]) {
  if (!applicationRoles.get(role)) throw new Error(`Membership policy references unknown application role ${role}`);
}

/** Application roles known to the reviewed catalog; unknown keys are rejected before they are stored. */
export function unknownApplicationRoles(roles: readonly string[]): string[] {
  return roles.filter((role) => !applicationRoles.get(role));
}
