import { useRef, useState } from "react";

import { api, type PlatformRoleAssignment, type RoleJson } from "../../api";
import { useAdminCommands } from "../../shell/commands";
import { useConfirmAction, type ConfirmConfig } from "../../shell/ConfirmAction";
import { useAdmin, useAdminQuery, useInvalidate } from "../../shell/context";
import { Button, Select } from "../../shell/kumo";
import { UserPicker } from "../../shell/pickers";
import { RoleCatalog } from "../../shell/roles";
import { AdminDataTable, AdminFilter, AdminPageHeader, AdminQueryState, AdminSection, AdminStatus, formatDate } from "../../shell/ui";
import { useViewSearch } from "../../shell/url-state";

type AssignDraft = { userId: string; role: string };

function AssignFields(props: { roles: readonly RoleJson[]; draft: { current: AssignDraft } }) {
  const [state, setState] = useState(props.draft.current);
  const set = (next: AssignDraft) => { props.draft.current = next; setState(next); };
  return <div className="grid gap-3 sm:grid-cols-2">
    <UserPicker value={state.userId} onChange={(userId) => set({ ...state, userId })} />
    <Select label="Role" hideLabel={false} value={state.role} onValueChange={(role) => set({ ...state, role: String(role) })}>{props.roles.map((role) => <Select.Option key={role.key} value={role.key}>{role.name}</Select.Option>)}</Select>
  </div>;
}

export default function PlatformRolesView() {
  const { can, session } = useAdmin();
  const invalidate = useInvalidate();
  const [search] = useViewSearch<{ q?: string; selected?: string }>();
  const roles = useAdminQuery(["roles"], api.roles);
  const assignments = useAdminQuery(["platform-roles", "history"], () => api.platformRoles(true));
  const confirm = useConfirmAction();
  const draft = useRef<AssignDraft>({ userId: "", role: "platform_operator" });
  const manage = can("platform.roles.manage");
  const q = (search.q ?? "").toLowerCase();
  const rows = (assignments.data?.assignments ?? []).filter((row) => !q || `${row.name ?? ""} ${row.email ?? ""} ${row.role}`.toLowerCase().includes(q));
  const selected = rows.find((row) => row.id === search.selected);
  const revocable = (row: PlatformRoleAssignment) => manage && !row.revokedAt && row.userId !== session.operator.id;
  const assign = (): ConfirmConfig => {
    draft.current = { userId: "", role: "platform_operator" };
    return {
      title: "Assign platform role", confirmLabel: "Assign role", scope: ["Grants platform authority only; no tenant membership or application authority"],
      fields: <AssignFields roles={roles.data?.platform ?? []} draft={draft} />,
      onConfirm: (reason) => draft.current.userId ? api.assignPlatformRole(draft.current.userId, draft.current.role, reason) : Promise.reject(new Error("Choose a user")),
      onDone: () => void invalidate("platform-roles"),
    };
  };
  const revoke = (row: PlatformRoleAssignment): ConfirmConfig => ({ title: "Revoke platform role", confirmLabel: "Revoke role", destructive: true, scope: [`Remove ${row.role} from ${row.email ?? row.userId}`], onConfirm: (reason) => api.revokePlatformRole(row.userId, row.role, reason), onDone: () => void invalidate("platform-roles") });
  useAdminCommands({
    "platform-roles.assign": { enabled: manage, run: () => confirm.open(assign()) },
    "platform-roles.revoke": { enabled: Boolean(selected && revocable(selected)), ...(selected ? { target: selected.id } : {}), confirm: () => { if (selected) confirm.open(revoke(selected)); } },
  });
  return <>
    <AdminPageHeader title="Platform roles" description="Narrow operator roles. Platform authority is granted only by these explicit assignments, with assignment history."
      actions={manage ? <Button variant="primary" onClick={() => confirm.open(assign())}>Assign role</Button> : undefined} />
    <AdminSection title="Assignments and history">
      <AdminFilter label="Filter assignments" placeholder="Operator or role" />
      <AdminQueryState query={assignments} isEmpty={() => rows.length === 0} empty="No platform-role assignments.">{() => <AdminDataTable caption="Platform role assignments" selectable rows={rows} rowKey={(row) => row.id} rowLabel={(row) => `${row.role} for ${row.email ?? row.userId}`}
        rowActions={(row) => revocable(row) ? [{ label: "Revoke role", hotkey: "r", destructive: true, run: () => confirm.open(revoke(row)) }] : []}
        columns={[
          { header: "Operator", cell: (row) => <>{row.name ?? row.userId}<p className="text-kumo-subtle">{row.email}</p></> },
          { header: "Role", cell: (row) => row.role },
          { header: "Granted", cell: (row) => <>{formatDate(row.grantedAt)} by {row.grantedBy}<p className="text-xs text-kumo-subtle">{row.reason}</p></> },
          { header: "Status", cell: (row) => row.revokedAt ? <AdminStatus variant="neutral">{`revoked ${formatDate(row.revokedAt)}`}</AdminStatus> : <AdminStatus variant="success">active</AdminStatus> },
        ]} />}</AdminQueryState>
    </AdminSection>
    <AdminQueryState query={roles}>{(data) => <RoleCatalog plane="platform" roles={data.platform} primary={false} />}</AdminQueryState>
    {confirm.dialog}
  </>;
}
