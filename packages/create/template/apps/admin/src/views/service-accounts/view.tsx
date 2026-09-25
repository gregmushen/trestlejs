import { PlusIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import { api, maskedKeyPrefix, type IssuedKey, type ServiceAccount, type ServiceAccountDetail } from "../../api";
import { useAdminCommands } from "../../shell/commands";
import { useConfirmAction, type ConfirmConfig } from "../../shell/ConfirmAction";
import { useAdmin, useAdminQuery, useInvalidate, useTenantScope } from "../../shell/context";
import { Button, Checkbox, Input, Tabs, Textarea } from "../../shell/kumo";
import { CreateApiKeyDialog, IssuedKeyDialog } from "../../shell/machine-access";
import { OrganizationPicker } from "../../shell/pickers";
import { AdminCreateDialog, AdminDetailDrawer, AdminFacts, useSelectedDetail } from "../../shell/resource";
import { AdminCode, AdminCopy, AdminDataTable, AdminEmpty, AdminFilter, AdminPageHeader, AdminQueryState, AdminStatus, formatDate } from "../../shell/ui";
import { useViewSearch } from "../../shell/url-state";

function RolePicker(props: { roles: ServiceAccountDetail["availableRoles"]; value: string[]; onChange: (value: string[]) => void; disabled?: boolean }) {
  return <fieldset className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-lg p-3 ring ring-kumo-hairline"><legend className="sr-only">Application roles</legend>
    {props.roles.map((role) => <label key={role.key} className="flex items-center gap-2 text-sm">
      <Checkbox checked={props.value.includes(role.key)} disabled={props.disabled ?? false} aria-label={role.name} onCheckedChange={(on) => props.onChange(on ? [...new Set([...props.value, role.key])] : props.value.filter((key) => key !== role.key))} />
      <span>{role.name} <span className="font-mono text-xs text-kumo-subtle">{role.key}</span></span>
    </label>)}
  </fieldset>;
}

function AccountDrawer(props: { id: string; open: boolean; onClose: () => void; confirm: ReturnType<typeof useConfirmAction>; onChanged: () => void; onCreateKey: (account: ServiceAccountDetail["account"]) => void }) {
  const { can } = useAdmin();
  const manage = can("platform.machine_access.manage");
  const detail = useAdminQuery(["service-account", props.id], () => api.serviceAccount(props.id), { enabled: props.open });
  const [tab, setTab] = useState("overview");
  const [draft, setDraft] = useState<{ name: string; description: string; roles: string[] } | null>(null);
  useEffect(() => { if (detail.data) setDraft({ name: detail.data.account.name, description: detail.data.account.description, roles: detail.data.account.applicationRoles }); }, [detail.data]);
  const data = detail.data;
  const account = data?.account;
  const changed = () => { props.onChanged(); void detail.refetch(); };
  const live = account && account.status !== "deleted";
  const dirty = Boolean(account && draft && (draft.name !== account.name || draft.description !== account.description || draft.roles.join() !== account.applicationRoles.join()));
  const usageDays = Object.entries(data?.usage ?? {}).sort(([a], [b]) => b.localeCompare(a));
  return <AdminDetailDrawer open={props.open} onClose={props.onClose} width="lg" title={account?.name ?? "Service account"} subtitle={account ? <span className="flex items-center gap-2">{account.organizationName}<AdminCopy value={account.id} label="service account ID" /></span> : undefined}
    actions={account && manage ? <>
      {live && <Button variant="secondary" onClick={() => props.onCreateKey(account)} disabled={account.status !== "active"}>Create API key</Button>}
      {account.status === "active" && can("platform.machine_access.revoke") && <Button variant="secondary" onClick={() => props.confirm.open({ title: `Suspend ${account.name}`, confirmLabel: "Suspend", destructive: true, scope: [`${data?.keys.filter((key) => key.status === "active" || key.status === "rotating").length ?? 0} active keys stop authenticating until reactivated`], onConfirm: (reason) => api.suspendServiceAccount(account.id, reason), onDone: changed })}>Suspend</Button>}
      {account.status === "suspended" && <Button variant="secondary" onClick={() => props.confirm.open({ title: `Reactivate ${account.name}`, confirmLabel: "Reactivate", scope: ["unrevoked keys authenticate again"], onConfirm: (reason) => api.reactivateServiceAccount(account.id, reason), onDone: changed })}>Reactivate</Button>}
      {live && <Button variant="secondary-destructive" onClick={() => props.confirm.open({
        title: `Delete ${account.name}`, confirmLabel: "Delete service account", destructive: true,
        scope: ["authentication stops immediately", `every key is revoked (${data?.keys.filter((key) => !key.revokedAt).length ?? 0} unrevoked)`, "the account remains as a tombstone with its audit history"],
        onConfirm: (reason) => api.deleteServiceAccount(account.id, reason), onDone: changed,
      })}>Delete</Button>}
    </> : undefined}>
    <AdminQueryState query={detail}>{() => account && draft ? <>
      <Tabs variant="segmented" value={tab} onValueChange={(value) => setTab(String(value))} tabs={[{ value: "overview", label: "Overview" }, { value: "access", label: "Roles and permissions" }, { value: "keys", label: `API keys (${data!.keys.length})` }, { value: "usage", label: "Usage" }, { value: "audit", label: "Audit" }]} />
      <div className="mt-5">
        {tab === "overview" && <div className="flex flex-col gap-4">
          <AdminFacts items={[["Status", <AdminStatus key="s" value={account.status}>{account.status}</AdminStatus>], ["Organization", account.organizationName], ["Created", `${formatDate(account.createdAt)} by ${account.createdBy ?? "—"}`],
            ...(account.suspensionReason ? [["Suspended", `${formatDate(account.suspendedAt)}: ${account.suspensionReason}`] as const] : []), ...(account.deletedAt ? [["Deleted", `${formatDate(account.deletedAt)} by ${account.deletedBy}: ${account.deletionReason}`] as const] : [])]} />
          <Input label="Name" disabled={!manage || !live} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          <Textarea label="Description" rows={2} disabled={!manage || !live} value={draft.description} onChange={(event: { target: { value: string } }) => setDraft({ ...draft, description: event.target.value })} />
        </div>}
        {tab === "access" && <div className="flex flex-col gap-4">
          <p className="text-sm font-medium">Application roles</p>
          <RolePicker roles={data!.availableRoles} value={draft.roles} onChange={(roles) => setDraft({ ...draft, roles })} disabled={!manage || !live} />
          <p className="text-sm font-medium">Effective permissions ({data!.effectivePermissions.length})</p>
          <ul className="flex flex-col gap-1 text-sm">{data!.effectivePermissions.map((permission) => <li key={permission.code}><AdminCode>{permission.code}</AdminCode> <span className="text-xs text-kumo-subtle">via {permission.via.join(", ")}</span></li>)}</ul>
          {data!.unknownRoles.length > 0 && <p className="text-sm text-kumo-warning">Roles that no longer exist and grant nothing: {data!.unknownRoles.join(", ")}</p>}
        </div>}
        {tab === "keys" && (data!.keys.length ? <AdminDataTable caption="Keys" primary={false} rows={data!.keys} rowKey={(key) => key.id} columns={[
          { header: "Key", minWidth: "10rem", cell: (key) => <><p className="font-medium">{key.name ?? "Unnamed"}</p><AdminCode>{maskedKeyPrefix(key.displayPrefix)}</AdminCode></> },
          { header: "Scopes", minWidth: "10rem", cell: (key) => key.scopes.join(", ") },
          { header: "Status", nowrap: true, cell: (key) => <AdminStatus value={key.status}>{key.status}</AdminStatus> },
          { header: "Last used", nowrap: true, cell: (key) => formatDate(key.lastUsedAt ?? null) },
        ]} /> : <AdminEmpty title="No API keys" description="Creating a service account never mints a key implicitly." />)}
        {tab === "usage" && (usageDays.length ? <AdminDataTable caption="Daily usage" primary={false} rows={usageDays} rowKey={([day]) => day} columns={[
          { header: "Day", nowrap: true, cell: ([day]) => day }, { header: "Requests", nowrap: true, cell: ([, usage]) => usage.requests.toLocaleString() }, { header: "Denied", nowrap: true, cell: ([, usage]) => usage.denied.toLocaleString() },
        ]} /> : <AdminEmpty title="No requests in the last 30 days" />)}
        {tab === "audit" && (data!.audit.length ? <AdminDataTable caption="Audit" primary={false} rows={data!.audit} rowKey={(event) => event.id} columns={[
          { header: "When", nowrap: true, cell: (event) => formatDate(event.occurredAt) }, { header: "Event", nowrap: true, cell: (event) => <AdminCode>{event.name}</AdminCode> },
          { header: "Actor", minWidth: "8rem", cell: (event) => event.actor }, { header: "Reason", minWidth: "10rem", cell: (event) => event.reason ?? "—" },
        ]} /> : <AdminEmpty title="No audit events" />)}
        {manage && live && (tab === "overview" || tab === "access") && <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" disabled={!dirty} onClick={() => setDraft({ name: account.name, description: account.description, roles: account.applicationRoles })}>Discard</Button>
          <Button variant="primary" disabled={!dirty || !draft.name.trim() || draft.roles.length === 0} onClick={() => props.confirm.open({
            title: `Update ${account.name}`, confirmLabel: "Save changes",
            scope: [...(draft.name !== account.name ? [`name: ${draft.name}`] : []), ...(draft.roles.join() !== account.applicationRoles.join() ? [`roles: ${draft.roles.join(", ")}`, "active keys holding scopes the new roles do not grant must be revoked or replaced first"] : [])],
            onConfirm: (reason) => api.updateServiceAccount(account.id, { name: draft.name.trim(), description: draft.description.trim(), ...(draft.roles.join() !== account.applicationRoles.join() ? { applicationRoles: draft.roles } : {}) }, reason), onDone: changed,
          })}>Review changes</Button>
        </div>}
      </div>
    </> : null}</AdminQueryState>
  </AdminDetailDrawer>;
}

type Draft = { organizationId: string; name: string; description: string; roles: string[] };

export default function ServiceAccountsView() {
  const { can } = useAdmin();
  const manage = can("platform.machine_access.manage");
  const invalidate = useInvalidate();
  const [scope] = useTenantScope();
  const [search, update] = useViewSearch<{ organization?: string; q?: string; selected?: string; deleted?: string }>();
  const organizationId = search.organization ?? scope;
  const accounts = useAdminQuery(["service-accounts", organizationId], () => api.serviceAccounts(organizationId || undefined));
  const q = (search.q ?? "").toLowerCase();
  const rows = (accounts.data?.serviceAccounts ?? []).filter((row) => (search.deleted === "1" || row.status !== "deleted") && (!q || `${row.name} ${row.id} ${row.organizationName ?? ""}`.toLowerCase().includes(q)));
  const detail = useSelectedDetail(rows, (row) => row.id);
  const confirm = useConfirmAction();
  const [creating, setCreating] = useState<Draft | null>(null);
  const [keyFor, setKeyFor] = useState<{ organizationId: string; serviceAccountId?: string } | null>(null);
  const [issued, setIssued] = useState<IssuedKey | null>(null);
  const roleOptions = useAdminQuery(["catalog"], api.catalog, { enabled: creating !== null });
  const refresh = () => { void invalidate("service-accounts"); void invalidate("service-account"); void invalidate("api-keys"); };
  const suspend = (row: ServiceAccount): ConfirmConfig => ({ title: `Suspend ${row.name}`, confirmLabel: "Suspend service account", destructive: true, scope: [`Every API key for ${row.name} stops authenticating immediately`], onConfirm: (reason) => api.suspendServiceAccount(row.id, reason), onDone: refresh });
  useAdminCommands({
  });
  const submit = async () => {
    const draft = creating!;
    setCreating(null);
    confirm.open({
      title: `Create ${draft.name}`, confirmLabel: "Create service account", scope: [`organization ${draft.organizationId}`, `application roles: ${draft.roles.join(", ")}`, "no API key is minted"],
      onConfirm: async (reason) => await api.createServiceAccount({ organizationId: draft.organizationId, name: draft.name.trim(), description: draft.description.trim(), applicationRoles: draft.roles }, reason),
      onDone: (result) => { refresh(); update({ selected: (result as { id: string }).id }); }, successMessage: `Created ${draft.name}`,
    });
  };
  return <>
    <AdminPageHeader title="Service accounts" description="Tenant-owned machine identities. They hold application roles only; organization and platform authority are never available to machines."
      actions={manage ? <Button variant="primary" icon={<PlusIcon />} onClick={() => setCreating({ organizationId: organizationId ?? "", name: "", description: "", roles: [] })}>New service account</Button> : undefined} />
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <div className="w-full max-w-xs"><OrganizationPicker value={organizationId} onChange={(id) => update({ organization: id || undefined })} /></div>
      <AdminFilter className="w-full max-w-xs" label="Filter service accounts" placeholder="Name or ID" />
      <label className="flex items-center gap-2 pb-2 text-sm"><Checkbox checked={search.deleted === "1"} onCheckedChange={(on) => update({ deleted: on ? "1" : undefined })} aria-label="Show deleted" />Show deleted</label>
    </div>
    <AdminQueryState query={accounts} isEmpty={() => rows.length === 0} empty={{ title: "No service accounts", ...(manage ? { description: "Create one to give a system application-role authority in an organization." } : {}) }}>{() => <AdminDataTable caption="Service accounts" selectable rows={rows} rowKey={(row) => row.id} rowLabel={(row) => row.name}
      rowActions={(row) => [{ label: "Inspect", run: () => detail.select(row.id) }, ...(can("platform.machine_access.revoke") && row.status === "active" ? [{ label: "Suspend", hotkey: "s", destructive: true, run: () => confirm.open(suspend(row)) }] : [])]}
      columns={[
        { header: "Service account", minWidth: "14rem", cell: (row) => <><p className="font-medium">{row.name}</p><p className="font-mono text-xs text-kumo-subtle">{row.id}</p></> },
        { header: "Organization", minWidth: "10rem", cell: (row) => row.organizationName ?? row.organizationId },
        { header: "Application roles", minWidth: "10rem", priority: "low", cell: (row) => row.applicationRoles.join(", ") },
        { header: "Status", nowrap: true, cell: (row) => <AdminStatus value={row.status}>{row.status}</AdminStatus> },
        { header: "Created", nowrap: true, cell: (row) => formatDate(row.createdAt) },
      ]} />}</AdminQueryState>
    {detail.id && <AccountDrawer key={detail.id} id={detail.id} open={detail.open} onClose={detail.close} confirm={confirm} onChanged={refresh} onCreateKey={(account) => setKeyFor({ organizationId: account.organizationId, serviceAccountId: account.id })} />}
    <AdminCreateDialog open={creating !== null} onClose={() => setCreating(null)} title="New service account" submitLabel="Review and create"
      description="Creating a service account does not mint a key. Names are unique among active accounts in an organization."
      disabled={!creating?.organizationId || !creating?.name.trim() || !creating?.roles.length} onSubmit={submit}>
      {creating && <>
        <OrganizationPicker value={creating.organizationId} onChange={(value) => setCreating({ ...creating, organizationId: value })} />
        <Input label="Name" required placeholder="deploy-bot" value={creating.name} onChange={(event) => setCreating({ ...creating, name: event.target.value })} />
        <Textarea label="Description (optional)" rows={2} value={creating.description} onChange={(event: { target: { value: string } }) => setCreating({ ...creating, description: event.target.value })} />
        <p className="text-sm font-medium">Application roles</p>
        <RolePicker roles={(roleOptions.data?.roles.application ?? []).filter((role) => !role.archived).map((role) => ({ key: role.key, name: role.name, source: role.source }))} value={creating.roles} onChange={(roles) => setCreating({ ...creating, roles })} />
        <p className="text-xs text-kumo-subtle">Organization-defined roles can be added after creation from the account's detail.</p>
      </>}
    </AdminCreateDialog>
    <CreateApiKeyDialog open={keyFor !== null} onClose={() => setKeyFor(null)} {...(keyFor ? { initial: keyFor } : {})} confirm={confirm} onIssued={(result) => { setIssued(result); refresh(); }} />
    <IssuedKeyDialog issued={issued} onDone={() => setIssued(null)} />
    {confirm.dialog}
  </>;
}
