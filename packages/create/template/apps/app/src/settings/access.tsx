import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { tenantApi, tenantKey, useTenantAccess } from "./api";

type Role = { key: string; name: string; description: string; permissions: string[]; custom?: boolean };
type PermissionInfo = { code: string; description: string; group: string; entitlement?: string };
type Member = { memberId: string; userId: string; name: string; email: string; organizationRoles: string[]; applicationRoles: string[] | null };

function RoleToggles({ roles, selected, disabled, onChange }: { roles: Role[]; selected: string[]; disabled: boolean; onChange: (next: string[]) => void }) {
  return <div className="flex flex-wrap gap-2">{roles.map((role) => {
    const checked = selected.includes(role.key);
    return <label key={role.key} title={role.description} className="flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1">
      <input type="checkbox" disabled={disabled} checked={checked} onChange={() => onChange(checked ? selected.filter((key) => key !== role.key) : [...selected, role.key])} />{role.name}
    </label>;
  })}</div>;
}

/**
 * Organization roles govern the account; application roles govern the
 * product. They are assigned independently, and neither implies the other.
 */
export function MembersAndRoles() {
  const access = useTenantAccess();
  const organizationId = access.data?.organizationId;
  const can = (permission: string) => access.data?.permissions.includes(permission) ?? false;
  const client = useQueryClient();
  const members = useQuery({ queryKey: tenantKey(organizationId, "members"), enabled: Boolean(organizationId), queryFn: () => tenantApi<{ members: Member[]; organizationRoles: Role[] }>("/api/tenant/members") });
  const applicationRoles = useQuery({ queryKey: tenantKey(organizationId, "application-roles"), enabled: Boolean(organizationId) && can("application.roles.read"), queryFn: () => tenantApi<{ roles: Role[]; permissions: PermissionInfo[]; customRolesEnabled: boolean }>("/api/tenant/application-roles") });
  const [error, setError] = useState<string>();
  const refresh = () => { setError(undefined); void client.invalidateQueries({ queryKey: tenantKey(organizationId, "members") }); };
  const assignOrganization = useMutation({ mutationFn: ({ memberId, roles }: { memberId: string; roles: string[] }) => tenantApi(`/api/tenant/members/${encodeURIComponent(memberId)}/organization-roles`, { method: "PUT", body: { roles } }), onSuccess: refresh, onError: (failure) => setError(failure.message) });
  const assignApplication = useMutation({ mutationFn: ({ userId, roles }: { userId: string; roles: string[] }) => tenantApi(`/api/tenant/users/${encodeURIComponent(userId)}/application-roles`, { method: "PUT", body: { roles } }), onSuccess: refresh, onError: (failure) => setError(failure.message) });
  if (access.error) return <section className="card p-8"><p className="text-red-700">{access.error.message}</p></section>;
  return <section className="space-y-6">
    <div className="card p-8">
      <p className="eyebrow">Organization</p>
      <h1 className="mt-2 text-3xl font-semibold">Members and roles</h1>
      <p className="mt-2 text-sm text-slate-600">Organization roles manage the account: members, billing, and API keys. Application roles grant product permissions. An organization owner needs an application role to work in the product.</p>
      {error && <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <table className="mt-6 w-full text-left text-sm">
        <thead><tr className="text-slate-500"><th className="py-2">Member</th><th>Organization roles</th><th>Application roles</th></tr></thead>
        <tbody>{members.data?.members.map((member) => <tr key={member.memberId} className="border-t border-slate-100 align-top">
          <td className="py-3"><p className="font-medium">{member.name}</p><p className="text-slate-500">{member.email}</p></td>
          <td className="py-3 pr-4"><RoleToggles roles={members.data.organizationRoles} selected={member.organizationRoles} disabled={!can("organization.roles.assign") || assignOrganization.isPending} onChange={(roles) => assignOrganization.mutate({ memberId: member.memberId, roles })} /></td>
          <td className="py-3">{member.applicationRoles === null || !applicationRoles.data
            ? <span className="text-slate-400">Requires application-role access</span>
            : <RoleToggles roles={applicationRoles.data.roles} selected={member.applicationRoles} disabled={!can("application.roles.assign") || assignApplication.isPending} onChange={(roles) => assignApplication.mutate({ userId: member.userId, roles })} />}</td>
        </tr>)}</tbody>
      </table>
    </div>
    {applicationRoles.data && <CustomApplicationRoles organizationId={organizationId} catalog={applicationRoles.data} canManage={can("application.roles.manage")} />}
  </section>;
}

function CustomApplicationRoles({ organizationId, catalog, canManage }: { organizationId: string | undefined; catalog: { roles: Role[]; permissions: PermissionInfo[]; customRolesEnabled: boolean }; canManage: boolean }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState({ key: "", name: "", permissions: [] as string[] });
  const [error, setError] = useState<string>();
  const refresh = () => client.invalidateQueries({ queryKey: tenantKey(organizationId, "application-roles") });
  const create = useMutation({ mutationFn: () => tenantApi("/api/tenant/application-roles", { method: "POST", body: draft }), onSuccess: () => { setDraft({ key: "", name: "", permissions: [] }); setError(undefined); void refresh(); }, onError: (failure) => setError(failure.message) });
  const remove = useMutation({ mutationFn: (key: string) => tenantApi(`/api/tenant/application-roles/${encodeURIComponent(key)}`, { method: "DELETE" }), onSuccess: () => void refresh(), onError: (failure) => setError(failure.message) });
  const groups = [...new Set(catalog.permissions.map((permission) => permission.group))];
  return <div className="card p-8">
    <h2 className="text-lg font-semibold">Application roles</h2>
    <ul className="mt-4 space-y-3">{catalog.roles.map((role) => <li key={role.key} className="rounded-xl border border-slate-200 p-4">
      <div className="flex items-center justify-between"><p className="font-medium">{role.name} <span className="text-xs text-slate-500">{role.custom ? "custom" : "default"}</span></p>{role.custom && canManage && <button className="text-sm text-red-600" onClick={() => remove.mutate(role.key)}>Delete</button>}</div>
      <p className="text-sm text-slate-600">{role.description}</p>
      <p className="mt-1 text-xs text-slate-500">{role.permissions.join(", ")}</p>
    </li>)}</ul>
    {!catalog.customRolesEnabled && <p className="mt-6 text-sm text-slate-600">Custom application roles are available on plans that include custom roles.</p>}
    {catalog.customRolesEnabled && canManage && <form className="mt-6 space-y-3" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
      <h3 className="font-semibold">Create a custom application role</h3>
      <div className="flex gap-3"><input className="flex-1 rounded-xl border border-slate-300 px-3 py-2" placeholder="key (e.g. auditor)" value={draft.key} onChange={(event) => setDraft({ ...draft, key: event.target.value })} /><input className="flex-1 rounded-xl border border-slate-300 px-3 py-2" placeholder="Name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></div>
      {groups.map((group) => <fieldset key={group}><legend className="text-xs font-semibold uppercase text-slate-500">{group}</legend><div className="flex flex-wrap gap-2">{catalog.permissions.filter((permission) => permission.group === group).map((permission) => <label key={permission.code} title={permission.description} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={draft.permissions.includes(permission.code)} onChange={(event) => setDraft({ ...draft, permissions: event.target.checked ? [...draft.permissions, permission.code] : draft.permissions.filter((code) => code !== permission.code) })} />{permission.code}</label>)}</div></fieldset>)}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <button className="button" disabled={!draft.key || !draft.name || draft.permissions.length === 0 || create.isPending} type="submit">Create role</button>
    </form>}
  </div>;
}
