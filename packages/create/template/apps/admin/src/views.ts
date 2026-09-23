import { permissions } from "@__TRESTLE_PROJECT_NAME__/authz";
import { features } from "@__TRESTLE_PROJECT_NAME__/billing/model";

import { buildAdminRegistry, navigationGroups, type AdminViewDescriptor } from "./registry";

const modules = import.meta.glob<{ default: AdminViewDescriptor }>("./views/*/admin-view.ts", { eager: true });

/** Default and application-owned views, discovered by file convention and validated once at startup. */
export const adminRegistry = buildAdminRegistry(Object.values(modules).map((module) => module.default), { permissions, features, groups: navigationGroups });
