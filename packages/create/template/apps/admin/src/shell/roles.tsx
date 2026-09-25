import type { AuthorityPlane, RoleJson } from "../api";
import { Badge } from "./kumo";
import { AdminCode, AdminDataTable, AdminSection } from "./ui";

export const planeDescription: Record<AuthorityPlane, string> = {
  organization: "Account administration: members, invitations, billing, and API-key administration. Never product-domain or platform authority.",
  application: "Product-domain actions. Assigned per organization, independently of organization roles.",
  platform: "Operating the SaaS across tenants. Assigned to users only; never implies tenant membership or application authority.",
};

/** Plane identity stays explicit wherever roles or permissions appear. */
const planeVariant: Readonly<Record<AuthorityPlane, "blue" | "purple" | "orange">> = { organization: "blue", application: "purple", platform: "orange" };

export function PlaneBadge(props: { plane: AuthorityPlane }) {
  return <Badge variant={planeVariant[props.plane]}>{props.plane}</Badge>;
}

/** The shared role-catalog layout for every plane. */
export function RoleCatalog({ plane, roles, primary }: { plane: AuthorityPlane; roles: readonly RoleJson[]; primary?: boolean }) {
  return <AdminSection title={<span className="flex items-center gap-2">{`${plane[0]!.toUpperCase()}${plane.slice(1)} role definitions`}<PlaneBadge plane={plane} /></span>} description={planeDescription[plane]}>
    <AdminDataTable caption={`${plane} roles`} rows={roles} rowKey={(role) => role.key} primary={primary ?? true} columns={[
      { header: "Role", cell: (role) => <><p className="font-medium">{role.name} {role.custom && <Badge variant="info">custom</Badge>}</p><p className="text-kumo-subtle">{role.key}</p></> },
      { header: "Description", cell: (role) => role.description },
      { header: "Permissions", cell: (role) => <ul className="flex flex-wrap gap-1">{role.permissions.map((code) => <li key={code}><AdminCode>{code}</AdminCode></li>)}</ul> },
    ]} />
  </AdminSection>;
}
