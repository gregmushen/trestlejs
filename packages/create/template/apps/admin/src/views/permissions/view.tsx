import { useRef, useState } from "react";

import { PlusIcon } from "@phosphor-icons/react";

import { api, errorMessage, type AuthorityPlane, type CatalogPermissionJson, type ExplainResponse } from "../../api";
import { useAdminCommands } from "../../shell/commands";
import { useConfirmAction } from "../../shell/ConfirmAction";
import { useAdmin, useAdminQuery, useInvalidate } from "../../shell/context";
import { Badge, Banner, Button, Checkbox, ClipboardText, Combobox, Input, Select, Tabs, Textarea } from "../../shell/kumo";
import { AdminCreateDialog, AdminDetailDrawer, AdminFacts, keyFromName, useSelectedDetail } from "../../shell/resource";
import { OrganizationPicker, UserPicker } from "../../shell/pickers";
import { PlaneBadge, planeDescription } from "../../shell/roles";
import { AdminCode, AdminCopy, AdminDataTable, AdminFilter, AdminForm, AdminPageHeader, AdminQueryState, AdminSection, AdminStatus, formatDate } from "../../shell/ui";
import { useViewSearch } from "../../shell/url-state";

type Option = { value: string; label: string };

function CodePicker(props: { label: string; options: readonly Option[]; value: string; onChange: (value: string) => void }) {
  const selected = props.options.find((option) => option.value === props.value) ?? null;
  return <Combobox label={props.label} items={props.options as Option[]} value={selected as Option} isItemEqualToValue={(item: Option, value: Option) => item.value === value.value} onValueChange={(next) => props.onChange((next as Option | null)?.value ?? "")}>
    <Combobox.TriggerValue className="w-full" placeholder="Search" />
    <Combobox.Content><Combobox.Input placeholder="Search" /><Combobox.Empty>No matches.</Combobox.Empty><Combobox.List>{(option: Option) => <Combobox.Item key={option.value} value={option}>{option.label}</Combobox.Item>}</Combobox.List></Combobox.Content>
  </Combobox>;
}

function AccessExplorer(props: { permissions: readonly Option[] }) {
  const [organizationId, setOrganizationId] = useState("");
  const [principalType, setPrincipalType] = useState<"user" | "service_account">("user");
  const [principalId, setPrincipalId] = useState("");
  const [permission, setPermission] = useState("");
  const [result, setResult] = useState<ExplainResponse>();
  const [error, setError] = useState<string>();
  const serviceAccounts = useAdminQuery(["service-accounts", organizationId], () => api.serviceAccounts(organizationId), { enabled: principalType === "service_account" && Boolean(organizationId) });
  const ready = Boolean(organizationId && principalId && permission);
  const explain = async () => {
    if (!ready) { setError("Choose an organization, an identity, and a permission."); return; }
    try { setError(undefined); setResult(await api.explainAccess({ organizationId, principal: { type: principalType, id: principalId }, permission })); }
    catch (failure) { setError(errorMessage(failure)); }
  };
  return <AdminSection title="Effective Access Explorer" description="Evaluates the real policy against current assignments and entitlements. It never executes the protected action. Mod+Enter explains.">
    <div id="access-explorer" tabIndex={-1} className="outline-none">
      <AdminForm label="Explain access" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={() => void explain()}>
        <OrganizationPicker value={organizationId} onChange={(value) => { setOrganizationId(value); setPrincipalId(""); }} />
        <Select label="Identity type" hideLabel={false} value={principalType} onValueChange={(value) => { setPrincipalType(value as "user" | "service_account"); setPrincipalId(""); }}>
          <Select.Option value="user">User</Select.Option><Select.Option value="service_account">Service account</Select.Option>
        </Select>
        {principalType === "user"
          ? <UserPicker label="Identity" value={principalId} onChange={setPrincipalId} {...(organizationId ? { organizationId } : {})} />
          : <CodePicker label="Identity" options={(serviceAccounts.data?.serviceAccounts ?? []).map((account) => ({ value: account.id, label: account.name }))} value={principalId} onChange={setPrincipalId} />}
        <CodePicker label="Permission" options={props.permissions} value={permission} onChange={setPermission} />
        <div className="flex items-end"><Button type="submit" variant="primary" disabled={!ready}>Explain</Button></div>
      </AdminForm>
    </div>
    {error && <p role="alert" className="mt-3 text-sm text-kumo-danger">{error}</p>}
    {result && <div className="mt-4 flex flex-col gap-2" aria-live="polite">
      <p><AdminStatus variant={result.decision.allowed ? "success" : "destructive"}>{result.decision.allowed ? "ALLOWED" : `DENIED · ${result.decision.reason}`}</AdminStatus></p>
      <pre className="overflow-x-auto rounded-lg bg-kumo-recessed p-4 text-xs leading-relaxed text-kumo-default ring ring-kumo-hairline">{result.explanation}</pre>
      <ClipboardText text={result.explanation.split("\n")[0] ?? ""} textToCopy={result.explanation} />
    </div>}
  </AdminSection>;
}

type PermissionDraft = { name: string; code: string; codeEdited: boolean; description: string; plane: "organization" | "application"; principals: string[]; entitlement: string };
const emptyPermission: PermissionDraft = { name: "", code: "", codeEdited: false, description: "", plane: "application", principals: ["user"], entitlement: "" };
const suggestedCode = (name: string, plane: "organization" | "application") => `${plane === "organization" ? "organization" : "custom"}.${keyFromName(name) || "permission"}`;

function PrincipalChoice(props: { plane: "organization" | "application"; value: string[]; onChange: (value: string[]) => void; disabled?: boolean }) {
  const toggle = (principal: string, on: boolean) => props.onChange(on ? [...new Set([...props.value, principal])] : props.value.filter((value) => value !== principal));
  return <fieldset className="flex flex-col gap-1"><legend className="mb-1 text-sm font-medium text-kumo-default">Allowed principals</legend>
    <label className="flex items-center gap-2 text-sm"><Checkbox checked={props.value.includes("user")} disabled={props.disabled ?? false} onCheckedChange={(on) => toggle("user", Boolean(on))} aria-label="Users" />Users</label>
    <label className="flex items-center gap-2 text-sm"><Checkbox checked={props.value.includes("api_key")} disabled={(props.disabled ?? false) || props.plane === "organization"} onCheckedChange={(on) => toggle("api_key", Boolean(on))} aria-label="API keys" />API keys {props.plane === "organization" && <span className="text-xs text-kumo-subtle">(application permissions only)</span>}</label>
  </fieldset>;
}

function PermissionDrawer(props: { permission: CatalogPermissionJson; open: boolean; onClose: () => void; manage: boolean; confirm: ReturnType<typeof useConfirmAction>; onChanged: () => void }) {
  const { permission } = props;
  const editable = props.manage && permission.origin === "runtime" && permission.state !== "invalid";
  const [draft, setDraft] = useState({ name: permission.name, description: permission.description, principals: permission.principals, entitlement: permission.entitlement ?? "" });
  const references = useAdminQuery(["permission-references", permission.code], () => api.permissionReferences(permission.code), { enabled: props.open && permission.origin === "runtime" });
  const dirty = draft.name !== permission.name || draft.description !== permission.description || draft.principals.join() !== permission.principals.join() || draft.entitlement !== (permission.entitlement ?? "");
  const blockers = permission.roles.length + (references.data?.tenantRoles.length ?? 0) + (references.data?.activeKeys ?? 0);
  const act = (action: "deprecate" | "restore") => props.confirm.open({
    title: `${action === "deprecate" ? "Deprecate" : "Restore"} ${permission.code}`, confirmLabel: action === "deprecate" ? "Deprecate" : "Restore", destructive: action === "deprecate",
    scope: action === "deprecate" ? [`${permission.roles.length} roles stop granting it`, "it can no longer be added to roles or API keys"] : ["it can be granted again"],
    onConfirm: (reason) => api.setPermissionState(permission.code, action, reason), onDone: props.onChanged,
  });
  return <AdminDetailDrawer open={props.open} onClose={props.onClose} width="lg" title={permission.name} subtitle={<span className="flex items-center gap-2"><PlaneBadge plane={permission.plane} /><AdminCopy value={permission.code} label="permission code" /></span>}
    actions={editable ? <>
      {permission.state === "active" ? <Button variant="secondary" onClick={() => act("deprecate")}>Deprecate</Button> : <Button variant="secondary" onClick={() => act("restore")}>Restore</Button>}
      <Button variant="secondary-destructive" disabled={permission.state !== "deprecated" || blockers > 0} title={permission.state !== "deprecated" ? "Deprecate it first" : blockers ? "Still referenced" : undefined}
        onClick={() => props.confirm.open({ title: `Delete ${permission.code}`, confirmLabel: "Delete permission", destructive: true, scope: [permission.code, "the definition is removed; audit history remains"], onConfirm: (reason) => api.deletePermission(permission.code, reason), onDone: () => { props.onChanged(); props.onClose(); } })}>Delete</Button>
    </> : undefined}>
    <div className="flex flex-col gap-6 *:mb-0">
      <AdminFacts items={[
        ["Origin", permission.origin === "code" ? "Reviewed source (protected)" : "Runtime catalog"], ["State", <AdminStatus key="state" value={permission.state}>{permission.state}</AdminStatus>],
        ["Principals", permission.principals.join(", ")], ["Entitlement", permission.entitlement ?? "—"], ["Secret-revealing", permission.secret ? "Yes: never granted to support profiles" : "No"],
        ["Created", permission.createdAt ? `${formatDate(permission.createdAt)} by ${permission.createdBy}` : "—"],
      ]} />
      <p className="text-sm text-kumo-default">{permission.description}</p>
      <AdminSection title="Discovered enforcement" description="Routes whose declared policy requires this permission.">
        {permission.enforcedBy.length ? <ul className="flex flex-col gap-1 text-sm">{permission.enforcedBy.map((route) => <li key={route}><AdminCode>{route}</AdminCode></li>)}</ul>
          : <Banner variant="alert" size="sm" title="No discovered enforcement" description={permission.origin === "runtime" ? "No route declares this permission. It grants nothing until application code checks it (ctx.access.require or a route policy)." : "No route policy declares it; it may be checked inside application code."} />}
      </AdminSection>
      <AdminSection title="Granted by roles">
        {permission.roles.length ? <ul className="flex flex-wrap gap-2">{permission.roles.map((role) => <li key={`${role.plane}:${role.key}`}><Badge variant="neutral">{role.name}</Badge></li>)}</ul> : <p className="text-sm text-kumo-subtle">No role grants it.</p>}
        {references.data && (references.data.tenantRoles.length > 0 || references.data.activeKeys > 0) && <p className="mt-2 text-sm text-kumo-subtle">Also referenced by {references.data.tenantRoles.length} organization-defined roles and {references.data.activeKeys} active API keys.</p>}
      </AdminSection>
      {editable && <AdminSection title="Edit">
        <div className="flex flex-col gap-3">
          <p className="text-xs text-kumo-subtle">The code and plane are immutable.</p>
          <Input label="Name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          <Textarea label="Description" rows={2} value={draft.description} onChange={(event: { target: { value: string } }) => setDraft({ ...draft, description: event.target.value })} />
          <PrincipalChoice plane={permission.plane as "organization" | "application"} value={draft.principals} onChange={(principals) => setDraft({ ...draft, principals })} />
          <Input label="Requires entitlement (optional)" value={draft.entitlement} onChange={(event) => setDraft({ ...draft, entitlement: event.target.value })} />
          <div className="flex justify-end"><Button variant="primary" disabled={!dirty || !draft.name.trim() || !draft.description.trim() || !draft.principals.length}
            onClick={() => props.confirm.open({ title: `Update ${permission.code}`, confirmLabel: "Save changes", scope: [`${permission.roles.length} roles grant it`, ...(draft.principals.join() !== permission.principals.join() ? [`principals: ${draft.principals.join(", ")}`] : [])], onConfirm: (reason) => api.updatePermission(permission.code, { ...draft, entitlement: draft.entitlement.trim() || null }, reason), onDone: props.onChanged })}>Review changes</Button></div>
        </div>
      </AdminSection>}
    </div>
  </AdminDetailDrawer>;
}

export default function PermissionsView() {
  const { can } = useAdmin();
  const manage = can("platform.access_catalog.manage");
  const [search, update] = useViewSearch<{ plane?: string; q?: string; selected?: string }>();
  const catalog = useAdminQuery(["catalog"], api.catalog);
  const routes = useAdminQuery(["route-policies"], api.routePolicies);
  const invalidate = useInvalidate();
  const confirm = useConfirmAction();
  const [creating, setCreating] = useState<PermissionDraft | null>(null);
  const plane = (search.plane ?? "all") as AuthorityPlane | "all";
  const explorer = useRef<HTMLElement | null>(null);
  const all = catalog.data?.permissions ?? [];
  const detail = useSelectedDetail(all, (permission) => permission.code);
  useAdminCommands({
    "permissions.focus-explorer": { enabled: can("platform.roles.read"), run: () => { explorer.current = document.getElementById("access-explorer"); explorer.current?.scrollIntoView({ block: "start" }); explorer.current?.querySelector<HTMLElement>("button, input")?.focus(); } },
  });
  const q = (search.q ?? "").toLowerCase();
  const tenantCodes = all.filter((permission) => permission.plane !== "platform" && permission.state === "active").map((permission) => ({ value: permission.code, label: `${permission.name} (${permission.code})` }));
  const rows = all.filter((permission) => (plane === "all" || permission.plane === plane) && (!q || `${permission.code} ${permission.name} ${permission.description}`.toLowerCase().includes(q)));
  const refresh = () => void invalidate("catalog");
  const submit = async () => {
    const draft = creating!;
    const input = { code: draft.code.trim(), name: draft.name.trim(), description: draft.description.trim(), plane: draft.plane, principals: draft.principals, entitlement: draft.entitlement.trim() || null };
    setCreating(null);
    confirm.open({ title: `Create ${input.code}`, confirmLabel: "Create permission", scope: [`${input.plane} permission ${input.code}`, `principals: ${input.principals.join(", ")}`, "grants nothing until a role includes it and code checks it"], onConfirm: (reason) => api.createPermission(input, reason), onDone: () => { refresh(); update({ selected: input.code }); } });
  };
  return <>
    <AdminPageHeader title="Permissions" description="Every permission belongs to exactly one plane, and authority never flows between planes. Permissions from reviewed source are protected; runtime permissions are grant-only until code checks them."
      actions={manage ? <Button variant="primary" icon={<PlusIcon />} onClick={() => setCreating(emptyPermission)}>New permission</Button> : undefined} />
    <AdminSection title="Registry">
      <Tabs variant="segmented" value={plane} onValueChange={(value) => update({ plane: String(value) === "all" ? undefined : String(value) })}
        tabs={[{ value: "all", label: "All planes" }, { value: "organization", label: "Organization" }, { value: "application", label: "Application" }, { value: "platform", label: "Platform" }]} />
      {plane !== "all" && <p className="mt-3 text-sm text-kumo-subtle">{planeDescription[plane]}</p>}
      <div className="mt-3"><AdminFilter label="Filter permissions" placeholder="Name, code, or description" /></div>
      <AdminQueryState query={catalog}>{() => <AdminDataTable caption="Permissions" selectable rows={rows} rowKey={(permission) => permission.code} rowLabel={(permission) => permission.name}
        rowActions={(permission) => [{ label: "Inspect", run: () => update({ selected: permission.code }) }]} columns={[
          { header: "Permission", minWidth: "16rem", cell: (permission) => <><p className="font-medium text-kumo-default">{permission.name}</p><p className="font-mono text-xs text-kumo-subtle">{permission.code}</p></> },
          { header: "Plane", nowrap: true, cell: (permission) => <PlaneBadge plane={permission.plane} /> },
          { header: "Origin", nowrap: true, cell: (permission) => permission.origin === "code" ? "Code" : <AdminStatus variant="info">Runtime</AdminStatus> },
          { header: "State", nowrap: true, cell: (permission) => <AdminStatus value={permission.state}>{permission.state}</AdminStatus> },
          { header: "Principals", nowrap: true, priority: "low", cell: (permission) => permission.principals.join(", ") },
          { header: "Roles", nowrap: true, cell: (permission) => permission.roles.length },
          { header: "Enforcement", nowrap: true, cell: (permission) => permission.enforcedBy.length ? `${permission.enforcedBy.length} route${permission.enforcedBy.length === 1 ? "" : "s"}` : <span className="text-kumo-warning">none discovered</span> },
        ]} />}</AdminQueryState>
    </AdminSection>
    {can("platform.roles.read") && <AccessExplorer permissions={tenantCodes} />}
    {detail.row && <PermissionDrawer key={detail.row.code} permission={detail.row} open={detail.open} onClose={detail.close} manage={manage} confirm={confirm} onChanged={refresh} />}
    <AdminCreateDialog open={creating !== null} onClose={() => setCreating(null)} size="lg" title="New permission" submitLabel="Review and create" description="The code and plane cannot change after creation. Platform permissions can only be defined in reviewed source."
      disabled={!creating?.name.trim() || !creating?.code.trim() || !creating?.description.trim() || !creating?.principals.length} onSubmit={async () => { await submit(); }}>
      {creating && <>
        <Select label="Plane" hideLabel={false} value={creating.plane} onValueChange={(value) => { const next = value as "organization" | "application"; setCreating({ ...creating, plane: next, principals: next === "organization" ? creating.principals.filter((principal) => principal !== "api_key") : creating.principals, ...(creating.codeEdited ? {} : { code: suggestedCode(creating.name, next) }) }); }}>
          <Select.Option value="application">Application</Select.Option><Select.Option value="organization">Organization</Select.Option>
        </Select>
        <Input label="Name" autoFocus required value={creating.name} onChange={(event) => setCreating({ ...creating, name: event.target.value, ...(creating.codeEdited ? {} : { code: suggestedCode(event.target.value, creating.plane) }) })} />
        <Input label="Code" required value={creating.code} onChange={(event) => setCreating({ ...creating, code: event.target.value.toLowerCase(), codeEdited: true })} />
        <Textarea label="Description" rows={2} required value={creating.description} onChange={(event: { target: { value: string } }) => setCreating({ ...creating, description: event.target.value })} />
        <PrincipalChoice plane={creating.plane} value={creating.principals} onChange={(principals) => setCreating({ ...creating, principals })} />
        <Input label="Requires entitlement (optional)" placeholder="api.access" value={creating.entitlement} onChange={(event) => setCreating({ ...creating, entitlement: event.target.value })} />
      </>}
    </AdminCreateDialog>
    {confirm.dialog}
    <AdminSection title="Route enforcement discovery" description="Every customer Worker route declares its audience and required authority.">
      <AdminQueryState query={routes}>{(data) => <AdminDataTable caption="Route policies" primary={false} rows={data.routes} rowKey={(route) => `${route.method} ${route.path}`} columns={[
        { header: "Route", cell: (route) => <AdminCode>{route.method} {route.path}</AdminCode> },
        { header: "Audience", cell: (route) => route.audience },
        { header: "Permission", cell: (route) => route.permission ?? (route.public ? "public" : "—") },
        { header: "API keys", cell: (route) => route.acceptsApiKeys ? <AdminStatus variant="info">accepted</AdminStatus> : "—" },
      ]} />}</AdminQueryState>
    </AdminSection>
  </>;
}
