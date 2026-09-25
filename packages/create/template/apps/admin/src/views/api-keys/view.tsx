import { PlusIcon } from "@phosphor-icons/react";
import { useMemo, useRef, useState } from "react";

import { api, maskedKeyPrefix, type ApiKeyMetadata, type IssuedKey } from "../../api";
import { useAdminCommands } from "../../shell/commands";
import { useConfirmAction, type ConfirmConfig } from "../../shell/ConfirmAction";
import { useAdmin, useAdminQuery, useInvalidate, useTenantScope } from "../../shell/context";
import { Button, Input } from "../../shell/kumo";
import { CreateApiKeyDialog, IssuedKeyDialog, ScopePicker } from "../../shell/machine-access";
import { OrganizationPicker } from "../../shell/pickers";
import { AdminDetailDrawer, AdminFacts, useSelectedDetail } from "../../shell/resource";
import { AdminCode, AdminDataTable, AdminEmpty, AdminFilter, AdminPageHeader, AdminQueryState, AdminSection, AdminStatus, formatDate } from "../../shell/ui";
import { useViewSearch } from "../../shell/url-state";

function OverlayField(props: { valueRef: { current: number } }) {
  const [value, setValue] = useState(String(props.valueRef.current));
  return <Input label="Previous key keeps working for (hours, 0-168)" type="number" min={0} max={168} value={value} onChange={(event) => { setValue(event.target.value); props.valueRef.current = Math.min(168, Math.max(0, Number(event.target.value) || 0)); }} />;
}

function KeyDrawer(props: { id: string; open: boolean; onClose: () => void; confirm: ReturnType<typeof useConfirmAction>; onChanged: () => void; onIssued: (issued: IssuedKey) => void }) {
  const { can } = useAdmin();
  const manage = can("platform.machine_access.manage");
  const detail = useAdminQuery(["api-key", props.id], () => api.apiKey(props.id), { enabled: props.open });
  const overlap = useRef(24);
  const [scopes, setScopes] = useState<string[] | null>(null);
  const key = detail.data?.key;
  const account = detail.data?.serviceAccount;
  const allowed = useAdminQuery(["service-account", key?.serviceAccountId ?? ""], () => api.serviceAccount(key!.serviceAccountId), { enabled: Boolean(props.open && key && scopes !== null) });
  const allowedSet = useMemo(() => allowed.data ? new Set(allowed.data.effectivePermissions.map((permission) => permission.code)) : null, [allowed.data]);
  const usable = key && !key.revokedAt && key.status !== "expired" && !key.rotatedTo;
  const changed = () => { props.onChanged(); void detail.refetch(); };
  const rotate = () => { overlap.current = 24; props.confirm.open({
    title: `Rotate ${key!.name ?? maskedKeyPrefix(key!.displayPrefix)}`, confirmLabel: "Rotate key", scope: ["a new key with the same scopes is issued and shown once", "the current key stops working after the overlap"],
    fields: <OverlayField valueRef={overlap} />, onConfirm: (reason) => api.rotateApiKey(key!.id, overlap.current, reason), onDone: (result) => { changed(); props.onIssued(result as IssuedKey); },
  }); };
  const replace = () => { overlap.current = 24; const next = scopes ?? key!.scopes; props.confirm.open({
    title: "Replace with new scopes", confirmLabel: "Issue replacement", scope: [...next.filter((code) => !key!.scopes.includes(code)).map((code) => `+ ${code}`), ...key!.scopes.filter((code) => !next.includes(code)).map((code) => `- ${code}`), "the active key is never changed: a replacement is issued and shown once"],
    fields: <OverlayField valueRef={overlap} />, onConfirm: (reason) => api.replaceApiKey(key!.id, next, overlap.current, reason), onDone: (result) => { setScopes(null); changed(); props.onIssued(result as IssuedKey); },
  }); };
  return <AdminDetailDrawer open={props.open} onClose={props.onClose} width="lg" title={key?.name ?? (key ? maskedKeyPrefix(key.displayPrefix) : "API key")} subtitle={key ? <AdminCode>{maskedKeyPrefix(key.displayPrefix)}</AdminCode> : undefined}
    actions={key && usable && can("platform.api_keys.revoke") ? <Button variant="secondary-destructive" onClick={() => props.confirm.open({ title: "Revoke API key", confirmLabel: "Revoke key", destructive: true, scope: [`${maskedKeyPrefix(key.displayPrefix)} fails closed immediately`, "the key remains as a historical record", "the owning organization sees the revocation in its audit log"], onConfirm: (reason) => api.revokeApiKey(key.id, reason), onDone: changed })}>Revoke</Button> : undefined}>
    <AdminQueryState query={detail}>{(data) => <div className="flex flex-col gap-6 *:mb-0">
      <AdminFacts items={[
        ["Status", <AdminStatus key="s" value={data.key.status}>{data.key.status}</AdminStatus>], ["Service account", account ? `${account.name} (${account.status})` : data.key.serviceAccountId], ["Organization", data.key.organizationName ?? data.key.organizationId],
        ["Environment", data.key.environment], ["Scopes", data.key.scopes.map((scope) => <AdminCode key={scope}>{scope}</AdminCode>)], ["Networks", data.key.allowedCidrs?.join(", ") ?? "any"],
        ["Expires", formatDate(data.key.expiresAt ?? null)], ["Created", `${formatDate(data.key.createdAt)} by ${data.key.createdBy ?? "—"}`], ["Last used", formatDate(data.key.lastUsedAt ?? null)],
        ...(data.key.revokedAt ? [["Revoked", `${formatDate(data.key.revokedAt)}${data.key.revocationReason ? `: ${data.key.revocationReason}` : ""}`] as const] : []),
      ]} />
      {scopes !== null && usable && <AdminSection title="New scopes" description="Changing scopes issues a replacement key; the active key's authority never changes silently.">
        <ScopePicker allowed={allowedSet} value={scopes} onChange={setScopes} />
        <div className="mt-3 flex justify-end"><Button variant="primary" disabled={scopes.length === 0 || scopes.join() === data.key.scopes.join()} onClick={replace}>Review replacement</Button></div>
      </AdminSection>}
      {data.lineage.length > 0 && <AdminSection title="Lineage"><ul className="flex flex-col gap-1 text-sm">{data.lineage.map((entry) => <li key={entry.id}><AdminCode>{maskedKeyPrefix(entry.displayPrefix)}</AdminCode> {entry.id === data.key.rotatedFrom ? "replaced by this key" : "replaces this key"} · {entry.status}</li>)}</ul></AdminSection>}
      <AdminSection title="Usage (30 days)">{data.usage.length ? <AdminDataTable caption="Key usage" primary={false} rows={data.usage} rowKey={(row) => row.day} columns={[
        { header: "Day", nowrap: true, cell: (row) => row.day }, { header: "Requests", nowrap: true, cell: (row) => row.requests.toLocaleString() }, { header: "Denied", nowrap: true, cell: (row) => row.denied.toLocaleString() },
      ]} /> : <AdminEmpty title="No requests yet" />}</AdminSection>
      <AdminSection title="Audit">{data.audit.length ? <ul className="flex flex-col gap-1 text-sm">{data.audit.map((event) => <li key={event.id}>{formatDate(event.occurredAt)} <AdminCode>{event.name}</AdminCode> {event.actor}{event.reason ? `: ${event.reason}` : ""}</li>)}</ul> : <AdminEmpty title="No audit events" />}</AdminSection>
    </div>}</AdminQueryState>
  </AdminDetailDrawer>;
}

export default function ApiKeysView() {
  const { can } = useAdmin();
  const invalidate = useInvalidate();
  const [scope] = useTenantScope();
  const [search, update] = useViewSearch<{ organization?: string; q?: string; selected?: string }>();
  const organizationId = search.organization ?? scope;
  const keys = useAdminQuery(["api-keys", organizationId], () => api.apiKeys(organizationId || undefined));
  const q = (search.q ?? "").toLowerCase();
  const rows = (keys.data?.apiKeys ?? []).filter((row) => !q || `${row.name ?? ""} ${row.displayPrefix} ${row.scopes.join(" ")} ${row.organizationName ?? ""} ${row.serviceAccountName ?? ""}`.toLowerCase().includes(q));
  const detail = useSelectedDetail(rows, (row) => row.id);
  const confirm = useConfirmAction();
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<IssuedKey | null>(null);
  const canRevoke = can("platform.api_keys.revoke");
  const refresh = () => { void invalidate("api-keys"); void invalidate("api-key"); void invalidate("service-account"); };
  // Only the masked prefix is ever displayed; a key's secret cannot be recovered by anyone.
  const revoke = (row: ApiKeyMetadata): ConfirmConfig => ({ title: "Revoke API key", confirmLabel: "Revoke key", destructive: true, scope: [`Revoke 1 API key ${maskedKeyPrefix(row.displayPrefix)}`, "Requests using it fail closed immediately"], onConfirm: (reason) => api.revokeApiKey(row.id, reason), onDone: refresh });
  useAdminCommands({
    "api-keys.revoke": { enabled: Boolean(detail.row && canRevoke && !detail.row.revokedAt), ...(detail.row ? { target: detail.row.id } : {}), confirm: () => { if (detail.row) confirm.open(revoke(detail.row)); } },
  });
  return <>
    <AdminPageHeader title="API keys" description="Safe metadata across organizations. Nobody can recover a key's secret; security administrators revoke compromised keys, and organizations mint and rotate their own." />
    <div className="mb-4 flex flex-wrap items-end gap-3"><div className="w-full max-w-xs"><OrganizationPicker value={organizationId} onChange={(id) => update({ organization: id || undefined })} /></div><AdminFilter className="w-full max-w-xs" label="Filter keys" placeholder="Name, prefix, scope, or account" /></div>
    <AdminQueryState query={keys} isEmpty={() => rows.length === 0} empty="No API keys.">{() => <AdminDataTable caption="API keys" selectable rows={rows} rowKey={(row) => row.id} rowLabel={(row) => row.name ?? maskedKeyPrefix(row.displayPrefix)}
      rowActions={(row) => [{ label: "Inspect", run: () => detail.select(row.id) }, ...(canRevoke && !row.revokedAt ? [{ label: "Revoke key", hotkey: "r", destructive: true, run: () => confirm.open(revoke(row)) }] : [])]}
      columns={[
        { header: "Key", minWidth: "12rem", cell: (row) => <><p className="font-medium">{row.name ?? "Unnamed key"}</p><AdminCode>{maskedKeyPrefix(row.displayPrefix)}</AdminCode></> },
        { header: "Service account", minWidth: "10rem", cell: (row) => <>{row.serviceAccountName ?? row.serviceAccountId}<p className="text-xs text-kumo-subtle">{row.organizationName ?? row.organizationId}</p></> },
        { header: "Scopes", minWidth: "10rem", priority: "low", cell: (row) => row.scopes.join(", ") },
        { header: "Environment", nowrap: true, cell: (row) => row.environment },
        { header: "Last used", nowrap: true, cell: (row) => formatDate(row.lastUsedAt ?? null) },
        { header: "Status", nowrap: true, cell: (row) => <AdminStatus value={row.status}>{row.status}</AdminStatus> },
      ]} />}</AdminQueryState>
    {detail.id && <KeyDrawer key={detail.id} id={detail.id} open={detail.open} onClose={detail.close} confirm={confirm} onChanged={refresh} onIssued={(result) => { if (result.token) setIssued(result); }} />}
    <IssuedKeyDialog issued={issued} onDone={() => setIssued(null)} />
    {confirm.dialog}
  </>;
}
