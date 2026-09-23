import { PlusIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { api, type CatalogPermissionJson, type CatalogRoleJson, type OrganizationMember } from "../api";
import { useConfirmAction } from "./ConfirmAction";
import { useAdmin, useAdminQuery, useInvalidate } from "./context";
import { Badge, Button, Checkbox, Input, Select, Textarea } from "./kumo";
import { OrganizationPicker } from "./pickers";
import { AdminCreateDialog, AdminDetailDrawer, AdminFacts, keyFromName, useSelectedDetail } from "./resource";
import { PlaneBadge, planeDescription } from "./roles";
import { AdminCode, AdminCopy, AdminDataTable, AdminEmpty, AdminPageHeader, AdminQueryState, AdminSection, AdminStatus } from "./ui";

type Plane = "organization" | "application";

const sourceLabel: Record<string, string> = { builtin: "Built-in", catalog: "Catalog", tenant: "Organization-defined" };

/** Permission picker for one plane, grouped by prefix; deprecated and invalid permissions are not offered. */
export function PermissionChecklist(props: { permissions: readonly CatalogPermissionJson[]; value: readonly string[]; onChange: (next: string[]) => void; disabled?: boolean }) {
  const groups = useMemo(() => {
    const map = new Map<string, CatalogPermissionJson[]>();
    for (const permission of props.permissions) {
      const group = permission.code.split(".").slice(0, -1).join(".") || permission.code;
      map.set(group, [...(map.get(group) ?? []), permission]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [props.permissions]);
  const selected = new Set(props.value);
  return <div className="flex max-h-80 flex-col gap-3 overflow-y-auto rounded-lg p-3 ring ring-kumo-hairline">
    {groups.map(([group, members]) => <fieldset key={group} className="flex flex-col gap-1">
      <legend className="mb-1 font-mono text-xs text-kumo-subtle">{group}</legend>
      {members.map((permission) => <label key={permission.code} className="flex items-start gap-2 text-sm">
        <Checkbox checked={selected.has(permission.code)} disabled={props.disabled ?? false}
          onCheckedChange={(checked) => props.onChange(checked ? [...props.value, permission.code].sort() : props.value.filter((code) => code !== permission.code))} aria-label={permission.code} />
        <span className="min-w-0"><span className="font-medium text-kumo-default">{permission.name}</span> <AdminCode>{permission.code}</AdminCode>{permission.origin === "runtime" && <> <Badge variant="info">runtime</Badge></>}
          <span className="block text-xs text-kumo-subtle">{permission.description}</span></span>
      </label>)}
    </fieldset>)}
  </div>;
}

type Draft = { name: string; key: string; keyEdited: boolean; description: string; permissions: string[]; basedOn?: string };
const emptyDraft: Draft = { name: "", key: "", keyEdited: false, description: "", permissions: [] };

/**
 * One plane's role catalog as a managed resource: create, inspect, edit,
 * clone, archive, delete, and see who holds each role
 * (docs/ADMIN_REQUIRED_CHANGES.md §5.1-§5.2). Built-in roles are protected
 * but cloneable; every change previews its impact and records a reason.
 */
export function RoleManager(props: { plane: Plane; title: string; description: string; createRequests?: number; children?: ReactNode }) {
  const { can } = useAdmin();
  const manage = can("platform.access_catalog.manage");
  const assign = can("platform.tenant_access.assign");
  const catalog = useAdminQuery(["catalog"], api.catalog);
  const invalidate = useInvalidate();
  const confirm = useConfirmAction();
  const roles = catalog.data?.roles[props.plane] ?? [];
  const planePermissions = (catalog.data?.permissions ?? []).filter((permission) => permission.plane === props.plane && permission.state === "active");
  const detail = useSelectedDetail(roles, (role) => role.key);
  const [creating, setCreating] = useState<Draft | null>(null);
  const refresh = () => { void invalidate("catalog"); void invalidate("role-assignments"); };

  const startCreate = (from?: CatalogRoleJson) => setCreating(from
    ? { name: `${from.name} (copy)`, key: `${from.key}_copy`.slice(0, 40), keyEdited: true, description: from.description, permissions: from.permissions.filter((code) => planePermissions.some((permission) => permission.code === code)), basedOn: from.key }
    : emptyDraft);
  // The view registers its own "new" command and signals it here.
  useEffect(() => { if (props.createRequests) startCreate(); }, [props.createRequests]); // eslint-disable-line react-hooks/exhaustive-deps
  const submitCreate = async () => {
    const draft = creating!;
    const input = { plane: props.plane, key: draft.key, name: draft.name.trim(), description: draft.description.trim(), permissions: draft.permissions, ...(draft.basedOn ? { basedOn: draft.basedOn } : {}) };
    setCreating(null);
    confirm.open({
      title: `Create ${input.name}`, confirmLabel: "Create role",
      scope: [`${props.plane} role ${input.key}`, `${input.permissions.length} permissions`, ...(draft.basedOn ? [`cloned from ${draft.basedOn}`] : []), "available to every organization"],
      onConfirm: (reason) => api.createRole(input, reason),
      onDone: () => { refresh(); detail.select(input.key); },
      successMessage: `Created ${input.name}`,
    });
  };

  return <>
    <AdminPageHeader title={props.title} description={props.description}
      actions={manage ? <Button variant="primary" icon={<PlusIcon />} onClick={() => startCreate()}>New role</Button> : undefined} />
    <AdminQueryState query={catalog} isEmpty={() => roles.length === 0} empty="No roles are defined in this plane.">{() => <AdminDataTable caption={`${props.plane} roles`} selectable rows={roles} rowKey={(role) => role.key} rowLabel={(role) => role.name}
      rowActions={(role) => [
        { label: "Inspect", run: () => detail.select(role.key) },
        ...(manage ? [{ label: "Clone", run: () => startCreate(role) }] : []),
      ]}
      columns={[
        { header: "Role", minWidth: "14rem", cell: (role) => <><p className="font-medium text-kumo-default">{role.name}</p><p className="font-mono text-xs text-kumo-subtle">{role.key}</p></> },
        { header: "Source", nowrap: true, cell: (role) => <AdminStatus variant={role.source === "builtin" ? "neutral" : "info"}>{sourceLabel[role.source] ?? role.source}</AdminStatus> },
        { header: "Description", minWidth: "16rem", priority: "low", cell: (role) => role.description || "—" },
        { header: "Permissions", nowrap: true, cell: (role) => role.permissions.length },
        { header: "Assigned", nowrap: true, cell: (role) => role.assignments },
        { header: "State", nowrap: true, cell: (role) => role.archived ? <AdminStatus variant="warning">Archived</AdminStatus> : <AdminStatus variant="success">Active</AdminStatus> },
      ]} />}</AdminQueryState>

    <AdminCreateDialog open={creating !== null} onClose={() => setCreating(null)} size="lg" title={creating?.basedOn ? `Clone ${creating.basedOn}` : "New role"} submitLabel="Review and create"
      description={`${planeDescription[props.plane]} The key is derived from the name and cannot change after creation.`}
      disabled={!creating?.name.trim() || !creating?.key} onSubmit={async () => { await submitCreate(); }}>
      {creating && <>
        <Input label="Name" autoFocus required value={creating.name} onChange={(event) => setCreating({ ...creating, name: event.target.value, ...(creating.keyEdited ? {} : { key: keyFromName(event.target.value) }) })} />
        <Input label="Key" required value={creating.key} onChange={(event) => setCreating({ ...creating, key: event.target.value.toLowerCase(), keyEdited: true })} />
        <Textarea label="Description" rows={2} value={creating.description} onChange={(event: { target: { value: string } }) => setCreating({ ...creating, description: event.target.value })} />
        <p className="text-sm font-medium text-kumo-default">Permissions ({creating.permissions.length})</p>
        <PermissionChecklist permissions={planePermissions} value={creating.permissions} onChange={(permissions) => setCreating({ ...creating, permissions })} />
      </>}
    </AdminCreateDialog>

    {detail.row && <RoleDrawer key={detail.row.key} plane={props.plane} role={detail.row} permissions={planePermissions} manage={manage} assign={assign} open={detail.open} onClose={detail.close}
      onClone={() => startCreate(detail.row)} confirm={confirm} onChanged={refresh} />}
    {props.children}
    {confirm.dialog}
  </>;
}

function RoleDrawer(props: { plane: Plane; role: CatalogRoleJson; permissions: readonly CatalogPermissionJson[]; manage: boolean; assign: boolean; open: boolean; onClose: () => void; onClone: () => void; confirm: ReturnType<typeof useConfirmAction>; onChanged: () => void }) {
  const { role, plane } = props;
  const editable = props.manage && role.source === "catalog";
  const [draft, setDraft] = useState({ name: role.name, description: role.description, permissions: role.permissions });
  const dirty = draft.name !== role.name || draft.description !== role.description || draft.permissions.join() !== role.permissions.join();
  const assignments = useAdminQuery(["role-assignments", plane, role.key], () => api.roleAssignments(plane, role.key), { enabled: props.open });
  const save = () => {
    const added = draft.permissions.filter((code) => !role.permissions.includes(code));
    const removed = role.permissions.filter((code) => !draft.permissions.includes(code));
    props.confirm.open({
      title: `Update ${role.name}`, confirmLabel: "Save changes",
      scope: [...added.map((code) => `+ ${code}`), ...removed.map((code) => `- ${code}`), `${role.assignments} principals hold this role and are affected immediately`],
      onConfirm: (reason) => api.updateRole(plane, role.key, draft, reason), onDone: props.onChanged, successMessage: `Updated ${role.name}`,
    });
  };
  const lifecycle = (action: "archive" | "restore") => props.confirm.open({
    title: `${action === "archive" ? "Archive" : "Restore"} ${role.name}`, confirmLabel: action === "archive" ? "Archive role" : "Restore role", destructive: action === "archive",
    scope: action === "archive" ? [`${role.assignments} principals lose this role's permissions until it is restored`, "assignments and history are kept"] : ["the role grants its permissions again"],
    onConfirm: (reason) => api.setRoleArchived(plane, role.key, action, reason), onDone: props.onChanged,
  });
  const remove = () => props.confirm.open({
    title: `Delete ${role.name}`, confirmLabel: "Delete role", destructive: true,
    scope: [`${plane} role ${role.key}`, "the definition is removed; its audit history remains"],
    onConfirm: (reason) => api.deleteRole(plane, role.key, reason), onDone: () => { props.onChanged(); props.onClose(); },
  });
  return <AdminDetailDrawer open={props.open} onClose={props.onClose} width="lg" title={role.name} subtitle={<span className="flex items-center gap-2"><PlaneBadge plane={plane} /><AdminCopy value={role.key} label="role key" /></span>}
    actions={<>
      {props.manage && <Button variant="secondary" onClick={props.onClone}>Clone</Button>}
      {editable && !role.archived && <Button variant="secondary" onClick={() => lifecycle("archive")}>Archive</Button>}
      {editable && role.archived && <Button variant="secondary" onClick={() => lifecycle("restore")}>Restore</Button>}
      {editable && <Button variant="secondary-destructive" disabled={role.assignments > 0} title={role.assignments > 0 ? "Remove every assignment or archive the role instead" : undefined} onClick={remove}>Delete</Button>}
    </>}>
    <div className="flex flex-col gap-6 *:mb-0">
      <AdminFacts items={[["Source", sourceLabel[role.source] ?? role.source], ["State", role.archived ? "Archived: grants nothing" : "Active"], ["Assigned to", `${role.assignments} principals`], ["Cloned from", role.basedOn ?? "—"]]} />
      {role.source === "builtin" && <p className="text-sm text-kumo-subtle">Built-in roles are defined in reviewed source and cannot be edited or deleted here. Clone this role to customize it.</p>}
      <AdminSection title="Definition">
        <div className="flex flex-col gap-3">
          <Input label="Name" disabled={!editable} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          <Textarea label="Description" rows={2} disabled={!editable} value={draft.description} onChange={(event: { target: { value: string } }) => setDraft({ ...draft, description: event.target.value })} />
          <p className="text-sm font-medium text-kumo-default">Permissions ({draft.permissions.length})</p>
          <PermissionChecklist permissions={props.permissions.length ? props.permissions : []} value={draft.permissions} onChange={(permissions) => setDraft({ ...draft, permissions })} disabled={!editable} />
          {editable && <div className="flex justify-end gap-2"><Button variant="secondary" disabled={!dirty} onClick={() => setDraft({ name: role.name, description: role.description, permissions: role.permissions })}>Discard</Button><Button variant="primary" disabled={!dirty || !draft.name.trim()} onClick={save}>Review changes</Button></div>}
        </div>
      </AdminSection>
      <AdminSection title="Assignments" description={plane === "organization" ? "Members holding this role, per organization." : "Users and service accounts holding this role, per organization."}>
        <AdminQueryState query={assignments} isEmpty={(data) => data.assignments.length === 0} empty="Nobody holds this role.">{(data) => <AdminDataTable caption="Role assignments" primary={false} rows={data.assignments} rowKey={(row) => row.id} columns={[
          { header: "Principal", minWidth: "12rem", cell: (row) => <><p className="font-medium">{row.name}</p><p className="text-xs text-kumo-subtle">{row.detail}</p></> },
          { header: "Organization", minWidth: "10rem", cell: (row) => row.organizationName || row.organizationId },
          { header: "", nowrap: true, cell: (row) => props.assign && row.kind !== "service_account" && !role.archived ? <UnassignButton plane={plane} roleKey={role.key} row={row} confirm={props.confirm} onDone={() => { props.onChanged(); void assignments.refetch(); }} /> : row.kind === "service_account" ? <span className="text-xs text-kumo-subtle">Change in Service Accounts</span> : null },
        ]} />}</AdminQueryState>
        {props.assign && !role.archived && <AssignForm plane={plane} role={role} confirm={props.confirm} onDone={() => { props.onChanged(); void assignments.refetch(); }} />}
      </AdminSection>
    </div>
  </AdminDetailDrawer>;
}

async function memberOf(organizationId: string, principalId: string): Promise<OrganizationMember | undefined> {
  return (await api.organization(organizationId)).members.find((member) => member.userId === principalId || member.memberId === principalId);
}

function UnassignButton(props: { plane: Plane; roleKey: string; row: { kind: string; organizationId: string; principalId: string; name: string }; confirm: ReturnType<typeof useConfirmAction>; onDone: () => void }) {
  return <Button size="sm" variant="ghost" onClick={() => props.confirm.open({
    title: `Remove ${props.roleKey} from ${props.row.name}`, confirmLabel: "Remove role", destructive: true,
    scope: [`${props.row.name} loses the ${props.roleKey} role in this organization`],
    onConfirm: async (reason) => {
      const member = await memberOf(props.row.organizationId, props.row.principalId);
      if (!member) throw new Error("That member is no longer in the organization");
      return props.plane === "organization"
        ? await api.setMemberOrganizationRoles(props.row.organizationId, member.memberId, member.organizationRoles.filter((role) => role !== props.roleKey), reason)
        : await api.setUserApplicationRoles(props.row.organizationId, member.userId, member.applicationRoles.filter((role) => role !== props.roleKey), reason);
    },
    onDone: props.onDone,
  })}>Remove</Button>;
}

function AssignForm(props: { plane: Plane; role: CatalogRoleJson; confirm: ReturnType<typeof useConfirmAction>; onDone: () => void }) {
  const [organizationId, setOrganizationId] = useState("");
  const [userId, setUserId] = useState("");
  const organization = useAdminQuery(["organization", organizationId], () => api.organization(organizationId), { enabled: Boolean(organizationId) });
  const members = organization.data?.members ?? [];
  const member = members.find((candidate) => candidate.userId === userId);
  const held = (candidate: OrganizationMember) => (props.plane === "organization" ? candidate.organizationRoles : candidate.applicationRoles).includes(props.role.key);
  return <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
    <OrganizationPicker value={organizationId} onChange={(value) => { setOrganizationId(value); setUserId(""); }} />
    {organizationId && members.length === 0 && !organization.isPending ? <AdminEmpty title="No members" /> :
      <Select label="Member" hideLabel={false} value={userId} onValueChange={(value) => setUserId(String(value ?? ""))} disabled={!organizationId}>
        {members.filter((candidate) => !held(candidate)).map((candidate) => <Select.Option key={candidate.userId} value={candidate.userId}>{candidate.name} ({candidate.email})</Select.Option>)}
      </Select>}
    <Button variant="primary" disabled={!member} onClick={() => member && props.confirm.open({
      title: `Assign ${props.role.name}`, confirmLabel: "Assign role",
      scope: [`${member.name} in ${organization.data?.organization.name ?? organizationId}`, `gains ${props.role.permissions.length} ${props.plane} permissions`],
      onConfirm: (reason) => props.plane === "organization"
        ? api.setMemberOrganizationRoles(organizationId, member.memberId, [...member.organizationRoles, props.role.key], reason)
        : api.setUserApplicationRoles(organizationId, member.userId, [...member.applicationRoles, props.role.key], reason),
      onDone: () => { setUserId(""); void organization.refetch(); props.onDone(); },
      successMessage: `Assigned ${props.role.name} to ${member.name}`,
    })}>Assign</Button>
  </div>;
}
