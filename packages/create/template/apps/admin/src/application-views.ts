import type { AdminView } from "./api-registry";

/** Application-owned admin modules. Every API route added here must also be
 * implemented behind a platform permission and (for mutations) audit/step-up
 * in the admin Worker. A navigation entry is never an authorization check. */
export const applicationAdminViews: AdminView[] = [
  // trestle:admin-module-list
];
