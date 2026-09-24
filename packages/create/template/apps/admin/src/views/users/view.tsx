import { ResourceListPage } from "../../blocks/resource-list";
import { api, type UserSummary } from "../../api";
import { useAdminQuery } from "../../shell/context";
import { Button } from "../../shell/kumo";
import { PlaneBadge } from "../../shell/roles";
import { AdminDataTable, AdminFilter, AdminPageHeader, AdminQueryState, AdminSection, AdminStatus, formatDate } from "../../shell/ui";
import { useViewSearch } from "../../shell/url-state";

export default function UsersView() {
  const [search] = useViewSearch<{ q?: string; selected?: string }>();
  const users = useAdminQuery(["users", search.q ?? ""], () => api.users(search.q));
  const selected = users.data?.users.find((user) => user.id === search.selected);
  const actions = (_user: UserSummary): Array<{ label: string; destructive?: boolean; run: () => void }> => [];
  return <>
    <AdminPageHeader title="Users" description="Identities across organizations with their organization memberships and platform roles. Read-only: suspension and session revocation are not available yet." />
    <AdminFilter label="Search users" placeholder="Name, email, or ID" />
    <ResourceListPage detail={selected ? <AdminSection title={selected.name} description={selected.email}
      actions={<>{actions(selected).map((action) => <Button key={action.label} variant={action.destructive ? "secondary-destructive" : "secondary"} onClick={action.run}>{action.label}</Button>)}</>}>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div><dt className="text-kumo-subtle">Status</dt><dd>{selected.banned ? <AdminStatus variant="destructive">suspended</AdminStatus> : <AdminStatus variant="success">active</AdminStatus>}</dd></div>
        <div><dt className="text-kumo-subtle">Email</dt><dd>{selected.emailVerified ? "verified" : "unverified"}</dd></div>
        <div><dt className="text-kumo-subtle">Created</dt><dd>{formatDate(selected.createdAt)}</dd></div>
        <div><dt className="text-kumo-subtle">Platform roles</dt><dd className="flex flex-wrap items-center gap-1"><PlaneBadge plane="platform" />{selected.platformRoles.join(", ") || "none"}</dd></div>
      </dl>
      <h3 className="mt-4 text-sm font-semibold">Memberships</h3>
      {selected.memberships.length === 0 ? <p className="text-sm text-kumo-subtle">No organization memberships.</p> : <ul className="mt-1 space-y-2 text-sm">{selected.memberships.map((membership) => <li key={membership.organizationId} className="rounded-md bg-kumo-recessed p-2">
        <p className="font-medium">{membership.organizationName ?? membership.organizationId}</p>
        <p className="flex flex-wrap items-center gap-1"><PlaneBadge plane="organization" />{membership.organizationRoles.join(", ") || "—"}</p>
      </li>)}</ul>}
    </AdminSection> : null}>
      <AdminQueryState query={users} isEmpty={(data) => data.users.length === 0} empty="No users match.">{(data) => <AdminDataTable caption="Users" selectable rows={data.users} rowKey={(user) => user.id} rowLabel={(user) => user.email} rowActions={actions} columns={[
        { header: "User", cell: (user) => <><p className="font-medium">{user.name}</p><p className="text-kumo-subtle">{user.email}</p></> },
        { header: "Status", cell: (user) => user.banned ? <AdminStatus variant="destructive">suspended</AdminStatus> : user.emailVerified ? <AdminStatus variant="success">verified</AdminStatus> : <AdminStatus variant="warning">unverified</AdminStatus> },
        { header: "Organizations", cell: (user) => user.memberships.length },
        { header: "Platform roles", cell: (user) => user.platformRoles.join(", ") || "—" },
        { header: "Created", cell: (user) => formatDate(user.createdAt) },
      ]} />}</AdminQueryState>
    </ResourceListPage>
  </>;
}
