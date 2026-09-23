import { applicationRoles, organizationRoles } from "./role-definitions.js";

/**
 * Explicit, tested relationships between authority planes. Trestle never lets
 * authority flow between planes implicitly; each relationship here is an
 * application decision and may be changed or removed.
 */
export type BootstrapAssignment = Readonly<{ plane: "organization" | "application"; role: string }>;

/**
 * When a user creates an organization they become its organization Owner and,
 * so that someone can administer the product, its Application administrator.
 * This is a one-time creation grant, not a standing rule that owners are
 * application administrators: removing either assignment later does not
 * affect the other.
 */
export const organizationCreatorAssignments: readonly BootstrapAssignment[] = [
  { plane: "organization", role: "owner" },
  { plane: "application", role: "app_admin" },
];

for (const assignment of organizationCreatorAssignments) {
  const catalog = assignment.plane === "organization" ? organizationRoles : applicationRoles;
  if (!catalog.get(assignment.role)) throw new Error(`Bootstrap policy references unknown ${assignment.plane} role ${assignment.role}`);
}
