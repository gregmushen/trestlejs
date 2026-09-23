import { ResourceListPage } from "../../blocks/resource-list";
import { api, type UserSummary } from "../../api";
import { useAdminCommands } from "../../shell/commands";
import { useConfirmAction, type ConfirmConfig } from "../../shell/ConfirmAction";
import { useAdmin, useAdminQuery, useInvalidate } from "../../shell/context";
import { Button } from "../../shell/kumo";
import { PlaneBadge } from "../../shell/roles";
import { AdminDataTable, AdminEmpty, AdminFilter, AdminPageHeader, AdminQueryState, AdminSection, AdminStatus, formatDate } from "../../shell/ui";
import { useViewSearch } from "../../shell/url-state";

export default function UsersView() {
  const { can } = useAdmin();
  const invalidate = useInvalidate();
  const [search] = useViewSearch<{ q?: string; selected?: string }>();
  const users = useAdminQuery(["users", search.q ?? ""], () => api.users(search.q));
  const selected = users.data?.users.find((user) => user.id === search.selected);
  const confirm = useConfirmAction();
  const suspension = (user: UserSummary): ConfirmConfig => user.banned
    ? { title: `Restore ${user.email}`, confirmLabel: "Restore user", scope: [`Allow ${user.email} to sign in again`], onConfirm: (reason) => api.restoreUser(user.id, reason), onDone: () => void invalidate("users") }
    : { title: `Suspend ${user.email}`, confirmLabel: "Suspend user", destructive: true, scope: [`Block sign-in for ${user.email}`, "Revoke every active session"], onConfirm: (reason) => api.suspendUser(user.id, reason), onDone: () => void invalidate("users") };
  const revoke = (user: UserSummary): ConfirmConfig => ({ title: `Revoke sessions for ${user.email}`, confirmLabel: "Revoke sessions", destructive: true, scope: [`Sign ${user.email} out everywhere`], onConfirm: (reason) => api.revokeSessions(user.id, reason) });
  useAdminCommands({
    "users.suspend": { enabled: Boolean(selected) && can("platform.users.suspend"), ...(selected ? { target: selected.id } : {}), confirm: () => { if (selected) confirm.open(suspension(selected)); } },
    "users.revoke-sessions": { enabled: Boolean(selected) && can("platform.sessions.revoke"), ...(selected ? { target: selected.id } : {}), confirm: () => { if (selected) confirm.open(revoke(selected)); } },
  });
  const actions = (user: UserSummary) => [
    ...(can("platform.users.suspend") ? [{ label: user.banned ? "Restore user" : "Suspend user", hotkey: "s", destructive: !user.banned, run: () => confirm.open(suspension(user)) }] : []),
    ...(can("platform.sessions.revoke") ? [{ label: "Revoke sessions", hotkey: "r", destructive: true, run: () => confirm.open(revoke(user)) }] : []),
  ];
  return <>
    <AdminPageHeader title="Users" description="Identities and their independent organization, application, and platform assignments. Suspension and session revocation are audited." />
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
        <p className="mt-1 flex flex-wrap items-center gap-1"><PlaneBadge plane="application" />{membership.applicationRoles.join(", ") || "none"}</p>
      </li>)}</ul>}
    </AdminSection> : <AdminEmpty title="Select a user" description="Membership and role detail, suspension, and session revocation appear here." />}>
      <AdminQueryState query={users} isEmpty={(data) => data.users.length === 0} empty="No users match.">{(data) => <AdminDataTable caption="Users" selectable rows={data.users} rowKey={(user) => user.id} rowLabel={(user) => user.email} rowActions={actions} columns={[
        { header: "User", cell: (user) => <><p className="font-medium">{user.name}</p><p className="text-kumo-subtle">{user.email}</p></> },
        { header: "Status", cell: (user) => user.banned ? <AdminStatus variant="destructive">suspended</AdminStatus> : user.emailVerified ? <AdminStatus variant="success">verified</AdminStatus> : <AdminStatus variant="warning">unverified</AdminStatus> },
        { header: "Organizations", cell: (user) => user.memberships.length },
        { header: "Platform roles", cell: (user) => user.platformRoles.join(", ") || "—" },
        { header: "Created", cell: (user) => formatDate(user.createdAt) },
      ]} />}</AdminQueryState>
    </ResourceListPage>
    {confirm.dialog}
  </>;
}
