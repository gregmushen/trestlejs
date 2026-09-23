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

const health = (endpoint: WebhookEndpointSummary) => endpoint.consecutiveFailures >= 5 ? "failing" : !endpoint.lastSuccessAt && !endpoint.lastFailureAt ? "untested" : endpoint.consecutiveFailures > 0 ? "degraded" : "healthy";
const healthVariant: Record<string, StatusVariant> = { failing: "destructive", degraded: "warning", healthy: "success", untested: "neutral" };

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
    actions={endpoint && !deleted ? <>
      {manage && endpoint.state === "active" && <Button variant="secondary" onClick={() => act({ title: `Send a test to ${endpoint.name}`, confirmLabel: "Send test", scope: ["a delivery marked test: true is queued and attempted within seconds"], onConfirm: (reason) => api.webhookAction(endpoint.id, "test", reason) })}>Send test</Button>}
      {manage && endpoint.state === "active" && <Button variant="secondary" onClick={() => act({ title: `Pause ${endpoint.name}`, confirmLabel: "Pause", scope: ["deliveries queue until resumed"], onConfirm: (reason) => api.webhookAction(endpoint.id, "pause", reason) })}>Pause</Button>}
      {manage && endpoint.state !== "active" && <Button variant="secondary" onClick={() => act({ title: `Resume ${endpoint.name}`, confirmLabel: "Resume", scope: ["queued deliveries are attempted again"], onConfirm: (reason) => api.webhookAction(endpoint.id, "resume", reason) })}>Resume</Button>}
      {manage && <Button variant="secondary" onClick={() => { overlap.current = 24; props.confirm.open({ title: `Rotate the signing secret for ${endpoint.name}`, confirmLabel: "Rotate secret", scope: ["a new secret is generated and shown once", "the previous secret keeps signing during the overlap"], fields: <OverlapField valueRef={overlap} />, onConfirm: (reason) => api.rotateWebhookSecret(endpoint.id, overlap.current, reason), onDone: (result) => { changed(); props.onSecret((result as { secret: string }).secret, endpoint.name); } }); }}>Rotate secret</Button>}
      {can("platform.webhooks.disable") && endpoint.state !== "disabled" && <Button variant="secondary-destructive" onClick={() => act({ title: "Emergency disable", confirmLabel: "Disable endpoint", destructive: true, scope: [`Disable ${endpoint.name}`, "queued deliveries are cancelled", "the tenant can re-enable it"], onConfirm: (reason) => api.disableWebhook(endpoint.id, reason) })}>Disable</Button>}
      {manage && <Button variant="secondary-destructive" onClick={() => props.confirm.open({ title: `Delete ${endpoint.name}`, confirmLabel: "Delete endpoint", destructive: true, scope: ["the endpoint is disabled and tombstoned", "queued deliveries are cancelled and workers never send to it again", "delivery and audit history are kept"], onConfirm: (reason) => api.deleteWebhook(endpoint.id, reason), onDone: () => { props.onChanged(); props.onClose(); } })}>Delete</Button>}
    </> : undefined}>
    <AdminQueryState query={detail}>{(data) => <>
      {deleted && <Banner className="mb-4" variant="secondary" title="Deleted" description={`Deleted ${formatDate(data.endpoint.deletedAt ?? null)}. It receives nothing; its history remains.`} />}
      {data.endpoint.state === "disabled" && !deleted && <Banner className="mb-4" variant="alert" title="Disabled" description={data.endpoint.disabledReason ?? ""} />}
      <AdminFacts items={[["State", <AdminStatus key="s" value={data.endpoint.state}>{data.endpoint.state}</AdminStatus>], ["Health", data.endpoint.health], ["Signing secret", <span key="f"><AdminCode>{data.endpoint.secret.fingerprint}</AdminCode> since {formatDate(data.endpoint.secret.createdAt)}{data.endpoint.secret.previousExpiresAt ? `; previous secret until ${formatDate(data.endpoint.secret.previousExpiresAt)}` : ""}</span>],
        ["Timeout", `${data.endpoint.timeoutMs / 1000} s`], ["Events", data.endpoint.events.join(", ")], ["Last success", formatDate(data.endpoint.lastSuccessAt)], ["Last failure", formatDate(data.endpoint.lastFailureAt)]]} />
      <div className="mt-5"><Tabs variant="segmented" value={tab} onValueChange={(value) => setTab(String(value))} tabs={[{ value: "deliveries", label: `Deliveries (${data.deliveries.length})` }, ...(manage && !deleted ? [{ value: "edit", label: "Edit" }] : [])]} /></div>
      <div className="mt-4">
        {tab === "deliveries" && (data.deliveries.length ? <AdminDataTable caption="Deliveries" primary={false} rows={data.deliveries} rowKey={(row) => row.id} columns={[
          { header: "Event", minWidth: "10rem", cell: (row) => <><AdminCode>{row.event}</AdminCode>{row.test && <> <AdminStatus variant="info">test</AdminStatus></>}{row.replayOf && <> <AdminStatus variant="neutral">replay</AdminStatus></>}</> },
          { header: "Status", nowrap: true, cell: (row) => <AdminStatus value={row.status}>{row.status}</AdminStatus> },
          { header: "Attempts", minWidth: "12rem", cell: (row) => <ul className="text-xs">{(data.attempts[row.id] ?? []).map((attempt) => <li key={attempt.attemptedAt}>{formatDate(attempt.attemptedAt)}: {attempt.providerReference ? `accepted by Svix` : attempt.responseCode ? `HTTP ${attempt.responseCode}` : "no response"}{attempt.failureCategory ? ` · ${attempt.failureCategory}` : ""}</li>)}{row.nextAttemptAt && <li className="text-kumo-subtle">next {formatDate(row.nextAttemptAt)}</li>}</ul> },
          { header: "", nowrap: true, cell: (row) => can("platform.webhooks.replay") && !row.test && data.endpoint.state === "active" && !deleted && (row.status === "failed" || row.status === "succeeded") ? <Button size="sm" variant="ghost" onClick={() => replay(row.id, row.event)}>Replay</Button> : null },
        ]} /> : <AdminEmpty title="No deliveries yet" />)}
        {tab === "edit" && draft && <div className="flex flex-col gap-3">
          <Input label="Name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          <Input label="New URL (leave blank to keep the current one)" placeholder={data.endpoint.urlDisplay} value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} />
          <Textarea label="Description" rows={2} value={draft.description} onChange={(event: { target: { value: string } }) => setDraft({ ...draft, description: event.target.value })} />
          <Input label="Timeout (seconds, 1-30)" type="number" min={1} max={30} value={draft.timeoutSeconds} onChange={(event) => setDraft({ ...draft, timeoutSeconds: event.target.value })} />
          <p className="text-sm font-medium">Event subscriptions</p>
          <EventChecklist value={draft.events} onChange={(events) => setDraft({ ...draft, events })} />
          <div className="flex justify-end"><Button variant="primary" disabled={!draft.name.trim() || draft.events.length === 0} onClick={() => act({
            title: `Update ${data.endpoint.name}`, confirmLabel: "Save changes", scope: [...(draft.url.trim() ? [`URL → ${draft.url.trim()}`] : []), `events: ${draft.events.join(", ")}`, `timeout ${draft.timeoutSeconds} s`],
            onConfirm: (reason) => api.updateWebhook(data.endpoint.id, { name: draft.name.trim(), ...(draft.url.trim() ? { url: draft.url.trim() } : {}), events: draft.events, description: draft.description.trim() || null, timeoutMs: Math.round(Number(draft.timeoutSeconds) * 1000) }, reason),
          })}>Review changes</Button></div>
        </div>}
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
  const disable = (endpoint: WebhookEndpointSummary): ConfirmConfig => ({ title: "Disable webhook endpoint", confirmLabel: "Disable endpoint", destructive: true, scope: [`Disable ${endpoint.name} (${endpoint.url}) for ${endpoint.organizationName}`, `Cancel ${endpoint.pending} queued deliveries`, "The tenant can re-enable it from their settings"], onConfirm: (reason) => api.disableWebhook(endpoint.id, reason), onDone: refresh });
  useAdminCommands({
    "webhooks.new": { enabled: manage, run: start },
    "webhooks.disable": { enabled: Boolean(detail.row && detail.row.state !== "disabled" && can("platform.webhooks.disable")), ...(detail.row ? { target: detail.row.id } : {}), confirm: () => { if (detail.row) confirm.open(disable(detail.row)); } },
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
    <AdminPageHeader title="Webhooks" description="Tenant endpoints and their delivery history. URLs are sanitized; existing signing secrets, payloads, and response bodies are never shown."
      actions={<span className="flex flex-wrap items-center gap-2">
        <Select placeholder="All states" aria-label="Filter by state" value={search.state ?? ""} onValueChange={(value) => update({ state: String(value ?? "") || undefined })}>
          <Select.Option value="">All states</Select.Option><Select.Option value="active">active</Select.Option><Select.Option value="paused">paused</Select.Option><Select.Option value="disabled">disabled</Select.Option>
        </Select>
        {manage && <Button variant="primary" icon={<PlusIcon />} onClick={start}>New webhook</Button>}
      </span>} />
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <div className="w-full max-w-xs"><OrganizationPicker value={organizationId} onChange={(id) => update({ organization: id || undefined })} /></div>
      <AdminFilter className="w-full max-w-xs" label="Search endpoints" placeholder="Endpoint, URL, or organization" />
      <label className="flex items-center gap-2 pb-2 text-sm"><Checkbox checked={search.deleted === "1"} onCheckedChange={(on) => update({ deleted: on ? "1" : undefined })} aria-label="Show deleted" />Show deleted</label>
    </div>
    <AdminQueryState query={endpoints} isEmpty={(data) => data.endpoints.length === 0} empty="No webhook endpoints match.">{(data) => <AdminDataTable caption="Webhook endpoints" selectable rows={data.endpoints} rowKey={(row) => row.id} rowLabel={(row) => row.name}
      rowActions={(row) => [{ label: "Inspect", run: () => detail.select(row.id) }, ...(can("platform.webhooks.disable") && row.state !== "disabled" ? [{ label: "Emergency disable", hotkey: "d", destructive: true, run: () => confirm.open(disable(row)) }] : [])]}
      columns={[
        { header: "Endpoint", minWidth: "14rem", cell: (row) => <><p className="font-medium">{row.name}</p><p className="text-xs text-kumo-subtle">{row.url}</p></> },
        { header: "Organization", minWidth: "10rem", cell: (row) => row.organizationName },
        { header: "State", nowrap: true, cell: (row) => <AdminStatus value={row.state}>{row.state}</AdminStatus> },
        { header: "Health", nowrap: true, cell: (row) => <AdminStatus variant={healthVariant[health(row)]!}>{health(row)}</AdminStatus> },
        { header: "Events", nowrap: true, priority: "low", cell: (row) => row.events.length },
        { header: "Failed 24h", nowrap: true, cell: (row) => row.failed24h },
        { header: "Last success", nowrap: true, priority: "low", cell: (row) => formatDate(row.lastSuccessAt) },
      ]} />}</AdminQueryState>
    {detail.id && <EndpointDrawer key={detail.id} id={detail.id} open={detail.open} onClose={detail.close} confirm={confirm} onChanged={refresh} onSecret={(value, subject) => setSecret({ value, subject })} />}
    <AdminCreateDialog open={creating !== null} onClose={() => setCreating(null)} size="lg" title="New webhook" submitLabel="Review and create" description={`HTTPS on a public host${environment === "local" ? " (locally, http://localhost is allowed)" : ""}. Private networks, cloud metadata addresses, and redirects are refused.`}
      disabled={!creating?.organizationId || !creating?.name.trim() || !creating?.url.trim() || !creating?.events.length} onSubmit={submit}>
      {creating && <>
        <OrganizationPicker value={creating.organizationId} onChange={(value) => setCreating({ ...creating, organizationId: value })} />
        <Input label="Name" required value={creating.name} onChange={(event) => setCreating({ ...creating, name: event.target.value })} />
        <Input label="URL" required placeholder="https://example.com/webhooks" value={creating.url} onChange={(event) => setCreating({ ...creating, url: event.target.value })} />
        <p className="text-sm font-medium">Events</p>
        <EventChecklist value={creating.events} onChange={(events) => setCreating({ ...creating, events })} />
        <details className="text-sm"><summary className="cursor-pointer text-kumo-subtle">Optional settings</summary>
          <div className="mt-2 flex flex-col gap-3">
            <Textarea label="Description" rows={2} value={creating.description} onChange={(event: { target: { value: string } }) => setCreating({ ...creating, description: event.target.value })} />
            <Input label="Timeout (seconds, 1-30)" type="number" min={1} max={30} value={creating.timeoutSeconds} onChange={(event) => setCreating({ ...creating, timeoutSeconds: event.target.value })} />
          </div>
        </details>
      </>}
    </AdminCreateDialog>
    <OneTimeSecretDialog secret={secret?.value ?? null} title="Signing secret" filename="webhook-signing-secret.txt" onDone={() => setSecret(null)}
      description={<>New signing secret for <strong>{secret?.subject}</strong>. Verify each delivery's <AdminCode>webhook-signature</AdminCode> header with it (Standard Webhooks, HMAC-SHA256).</>} />
    {confirm.dialog}
  </>;
}
