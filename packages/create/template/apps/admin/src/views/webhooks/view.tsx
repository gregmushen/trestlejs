import { PlusIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

import { api, type WebhookEndpointSummary } from "../../api";
import { useAdminCommands } from "../../shell/commands";
import { useConfirmAction, type ConfirmConfig } from "../../shell/ConfirmAction";
import { useAdmin, useAdminQuery, useInvalidate, useTenantScope } from "../../shell/context";
import { Banner, Button, Checkbox, Input, Select, Tabs, Textarea } from "../../shell/kumo";
import { OrganizationPicker } from "../../shell/pickers";
import { AdminCreateDialog, AdminDetailDrawer, AdminFacts, OneTimeSecretDialog, useSelectedDetail } from "../../shell/resource";
import { AdminCode, AdminCopy, AdminDataTable, AdminEmpty, AdminFilter, AdminPageHeader, AdminQueryState, AdminStatus, formatDate, type StatusVariant } from "../../shell/ui";
import { useViewSearch } from "../../shell/url-state";
import { ReplayCell } from "./replay";

/** Endpoint health as the delivery pipeline reports it. */
const health = (endpoint: WebhookEndpointSummary) => endpoint.health ?? "unknown";
const healthVariant: Record<string, StatusVariant> = { failed: "destructive", degraded: "warning", healthy: "success", unknown: "neutral" };

function EventChecklist(props: { value: string[]; onChange: (value: string[]) => void; disabled?: boolean }) {
  const types = useAdminQuery(["webhook-event-types"], api.webhookEventTypes);
  return <fieldset className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-lg p-3 ring ring-kumo-hairline"><legend className="sr-only">Events</legend>
    {(types.data?.eventTypes ?? []).map((type) => <label key={type.name} className="flex items-start gap-2 text-sm">
      <Checkbox checked={props.value.includes(type.name)} disabled={props.disabled ?? false} aria-label={type.name} onCheckedChange={(on) => props.onChange(on ? [...new Set([...props.value, type.name])].sort() : props.value.filter((name) => name !== type.name))} />
      <span><AdminCode>{type.name}</AdminCode> <span className="text-xs text-kumo-subtle">v{type.version} · {type.description}</span></span>
    </label>)}
  </fieldset>;
}

function OverlapField(props: { valueRef: { current: number } }) {
  const [value, setValue] = useState(String(props.valueRef.current));
  return <Input label="Previous secret keeps signing for (hours, 0-168)" type="number" min={0} max={168} value={value} onChange={(event) => { setValue(event.target.value); props.valueRef.current = Math.min(168, Math.max(0, Number(event.target.value) || 0)); }} />;
}

function EndpointDrawer(props: { id: string; open: boolean; onClose: () => void; confirm: ReturnType<typeof useConfirmAction>; onChanged: () => void; onSecret: (secret: string, subject: string) => void }) {
  const { can } = useAdmin();
  const manage = can("platform.webhooks.manage");
  const detail = useAdminQuery(["webhook", props.id], () => api.webhook(props.id), { enabled: props.open, refetchInterval: 5_000 });
  const [tab, setTab] = useState("deliveries");
  const [draft, setDraft] = useState<{ name: string; url: string; description: string; timeoutSeconds: string; events: string[] } | null>(null);
  const overlap = useRef(24);
  const endpoint = detail.data?.endpoint;
  useEffect(() => { if (endpoint) setDraft((current) => current ?? { name: endpoint.name, url: "", description: endpoint.description ?? "", timeoutSeconds: String(endpoint.timeoutMs / 1000), events: endpoint.events }); }, [endpoint]);
  const changed = () => { props.onChanged(); void detail.refetch(); };
  const deleted = Boolean(endpoint?.deletedAt);
  const act = (config: Omit<ConfirmConfig, "onDone">) => props.confirm.open({ ...config, onDone: changed });
  const replay = (id: string, event: string) => act({ title: "Replay delivery", confirmLabel: "Replay", scope: [`Send ${event} to ${endpoint?.urlDisplay ?? "the endpoint"} again as a new delivery`], onConfirm: (reason) => api.replayWebhookDelivery(id, reason) });
  return <AdminDetailDrawer open={props.open} onClose={props.onClose} width="lg" title={endpoint?.name ?? "Webhook"} subtitle={endpoint ? <span className="flex items-center gap-2">{endpoint.urlDisplay}<AdminCopy value={endpoint.id} label="endpoint ID" /></span> : undefined}
    actions={endpoint && !deleted && can("platform.webhooks.manage") && endpoint.state !== "disabled" ? <Button variant="secondary-destructive" onClick={() => act({ title: "Emergency disable", confirmLabel: "Disable endpoint", destructive: true, scope: [`Disable ${endpoint.name}`, "deliveries stop until the tenant re-enables it"], onConfirm: (reason) => api.disableWebhook(endpoint.id, reason) })}>Disable</Button> : undefined}>
    <AdminQueryState query={detail}>{(data) => <>
      {deleted && <Banner className="mb-4" variant="secondary" title="Deleted" description={`Deleted ${formatDate(data.endpoint.deletedAt ?? null)}. It receives nothing; its history remains.`} />}
      {data.endpoint.state === "disabled" && !deleted && <Banner className="mb-4" variant="alert" title="Disabled" description={data.endpoint.disabledReason ?? ""} />}
      <AdminFacts items={[["State", <AdminStatus key="s" value={data.endpoint.state}>{data.endpoint.state}</AdminStatus>], ["Health", data.endpoint.health], ["Destination", data.endpoint.urlDisplay], ["Updated", formatDate(data.endpoint.createdAt)]]} />
      <p className="mt-3 text-sm text-kumo-subtle">Platform operators see failed deliveries only. Destinations, signing secrets, and payloads stay with the tenant, who manages the endpoint in the customer app.</p>
      <div className="mt-5"><Tabs variant="segmented" value={tab} onValueChange={(value) => setTab(String(value))} tabs={[{ value: "deliveries", label: `Failed deliveries (${data.deliveries.length})` }]} /></div>
      <div className="mt-4">
        {tab === "deliveries" && (data.deliveries.length ? <AdminDataTable caption="Deliveries" primary={false} rows={data.deliveries} rowKey={(row) => row.id} columns={[
          { header: "Event", minWidth: "10rem", cell: (row) => <><AdminCode>{row.event}</AdminCode>{row.test && <> <AdminStatus variant="info">test</AdminStatus></>}{row.replayOf && <> <AdminStatus variant="neutral">replay</AdminStatus></>}</> },
          { header: "Status", nowrap: true, cell: (row) => <AdminStatus value={row.status}>{row.status}</AdminStatus> },
          { header: "Attempts", nowrap: true, cell: (row) => row.attempts },
          { header: "Reason", minWidth: "10rem", cell: (row) => row.failureCategory ?? "—" },
          { header: "", nowrap: true, cell: (row) => <ReplayCell row={row} canManage={can("platform.webhooks.manage")} onReplay={() => replay(row.id, row.event)} /> },
        ]} /> : <AdminEmpty title="No deliveries yet" />)}
      </div>
    </>}</AdminQueryState>
  </AdminDetailDrawer>;
}

type Draft = { organizationId: string; name: string; url: string; events: string[]; description: string; timeoutSeconds: string };

export default function WebhooksView() {
  const { can, environment } = useAdmin();
  const manage = can("platform.webhooks.manage");
  const invalidate = useInvalidate();
  const [scope] = useTenantScope();
  const [search, update] = useViewSearch<{ organization?: string; state?: string; q?: string; selected?: string; deleted?: string }>();
  const organizationId = search.organization ?? scope;
  const endpoints = useAdminQuery(["webhooks", organizationId, search.state ?? "", search.q ?? "", search.deleted ?? ""], () => api.webhooks({ organizationId, ...(search.state ? { state: search.state } : {}), ...(search.q ? { q: search.q } : {}), ...(search.deleted ? { deleted: "1" } : {}) }), { refetchInterval: 15_000 });
  const rows = endpoints.data?.endpoints ?? [];
  const detail = useSelectedDetail(rows, (row) => row.id);
  const confirm = useConfirmAction();
  const [creating, setCreating] = useState<Draft | null>(null);
  const [secret, setSecret] = useState<{ value: string; subject: string } | null>(null);
  const refresh = () => { void invalidate("webhooks"); void invalidate("webhook"); };
  const start = () => setCreating({ organizationId: organizationId ?? "", name: "", url: "", events: [], description: "", timeoutSeconds: "10" });
  const disable = (endpoint: WebhookEndpointSummary): ConfirmConfig => ({ title: "Disable webhook endpoint", confirmLabel: "Disable endpoint", destructive: true, scope: [`Disable ${endpoint.name} for ${endpoint.organizationName}`, "Deliveries stop until the tenant re-enables it from their settings"], onConfirm: (reason) => api.disableWebhook(endpoint.id, reason), onDone: refresh });
  useAdminCommands({
    "webhooks.disable": { enabled: Boolean(detail.row && detail.row.state !== "disabled" && can("platform.webhooks.manage")), ...(detail.row ? { target: detail.row.id } : {}), confirm: () => { if (detail.row) confirm.open(disable(detail.row)); } },
  });
  const submit = async () => {
    const draft = creating!;
    const input = { organizationId: draft.organizationId, name: draft.name.trim(), url: draft.url.trim(), events: draft.events, description: draft.description.trim() || null, timeoutMs: Math.round(Number(draft.timeoutSeconds || "10") * 1000) };
    setCreating(null);
    confirm.open({
      title: `Create ${input.name}`, confirmLabel: "Create webhook", scope: [`POST ${input.url}`, `events: ${input.events.join(", ")}`, "a signing secret is generated and shown once"],
      onConfirm: async (reason) => await api.createWebhook(input, reason),
      onDone: (result) => { const created = result as { endpoint: { id: string }; secret: string }; refresh(); update({ selected: created.endpoint.id }); setSecret({ value: created.secret, subject: input.name }); },
    });
  };
  return <>
    <AdminPageHeader title="Webhooks" description="Tenant endpoints across organizations and their failed deliveries. Operators can emergency-disable an endpoint or replay a delivery whose payload is still retained and whose source event is inside the 14-day replay window; destinations, secrets, and payloads are never shown."
      actions={<span className="flex flex-wrap items-center gap-2">
        <Select placeholder="All states" aria-label="Filter by state" value={search.state ?? ""} onValueChange={(value) => update({ state: String(value ?? "") || undefined })}>
          <Select.Option value="">All states</Select.Option><Select.Option value="active">active</Select.Option><Select.Option value="paused">paused</Select.Option><Select.Option value="disabled">disabled</Select.Option>
        </Select>
      </span>} />
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <div className="w-full max-w-xs"><OrganizationPicker value={organizationId} onChange={(id) => update({ organization: id || undefined })} /></div>
      <AdminFilter className="w-full max-w-xs" label="Search endpoints" placeholder="Endpoint, URL, or organization" />
    </div>
    <AdminQueryState query={endpoints} isEmpty={(data) => data.endpoints.length === 0} empty="No webhook endpoints match.">{(data) => <AdminDataTable caption="Webhook endpoints" selectable rows={data.endpoints} rowKey={(row) => row.id} rowLabel={(row) => row.name}
      rowActions={(row) => [{ label: "Inspect", run: () => detail.select(row.id) }, ...(can("platform.webhooks.manage") && row.state !== "disabled" ? [{ label: "Emergency disable", hotkey: "d", destructive: true, run: () => confirm.open(disable(row)) }] : [])]}
      columns={[
        { header: "Endpoint", minWidth: "14rem", cell: (row) => <><p className="font-medium">{row.name}</p><p className="text-xs text-kumo-subtle">{row.url}</p></> },
        { header: "Organization", minWidth: "10rem", cell: (row) => row.organizationName },
        { header: "State", nowrap: true, cell: (row) => <AdminStatus value={row.state}>{row.state}</AdminStatus> },
        { header: "Health", nowrap: true, cell: (row) => <AdminStatus variant={healthVariant[health(row)]!}>{health(row)}</AdminStatus> },
        { header: "Failed deliveries", nowrap: true, cell: (row) => row.failed24h },
        { header: "Last failure", nowrap: true, priority: "low", cell: (row) => formatDate(row.lastFailureAt) },
      ]} />}</AdminQueryState>
    {detail.id && <EndpointDrawer key={detail.id} id={detail.id} open={detail.open} onClose={detail.close} confirm={confirm} onChanged={refresh} onSecret={(value, subject) => setSecret({ value, subject })} />}
    {confirm.dialog}
  </>;
}
