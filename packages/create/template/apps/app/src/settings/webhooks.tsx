import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { formatDate, tenantApi, tenantKey, useTenantAccess } from "./api";

type EventType = { name: string; version: number; description: string };
type Endpoint = {
  id: string; name: string; url: string; urlDisplay: string; events: string[]; state: "active" | "paused" | "disabled"; health: "healthy" | "failing" | "untested";
  disabledReason: string | null; consecutiveFailures: number; secret: { fingerprint: string; createdAt: string; previousExpiresAt: string | null };
  verifiedAt: string | null; lastSuccessAt: string | null; lastFailureAt: string | null; createdAt: string;
};
type Delivery = { id: string; eventId: string; event: string; version: number; status: string; attempts: number; nextAttemptAt: string | null; responseCode: number | null; failureCategory: string | null; correlationId: string; test: boolean; replayOf: string | null; createdAt: string };
type Attempt = { id: string; attemptedAt: string; responseCode: number | null; failureCategory: string | null; durationMs: number; providerReference?: string | null };

const healthTone = { healthy: "text-emerald-700", failing: "text-red-700", untested: "text-slate-500" } as const;

/** Shows a signing secret exactly once; only its fingerprint is ever shown again. */
function OneTimeSecret({ secret, onDismiss }: { secret: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  return <div role="alert" className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4">
    <p className="font-semibold">Copy this signing secret now. It will not be shown again.</p>
    <code className="mt-2 block break-all rounded-lg bg-white px-3 py-2 font-mono text-sm">{secret}</code>
    <p className="mt-2 text-xs text-slate-600">Verify each delivery's <code>webhook-signature</code> header with it (Standard Webhooks, HMAC-SHA256).</p>
    <div className="mt-3 flex gap-3"><button className="button" onClick={async () => { await navigator.clipboard.writeText(secret); setCopied(true); }}>{copied ? "Copied" : "Copy"}</button><button className="text-sm font-semibold text-slate-600" onClick={onDismiss}>I have stored it</button></div>
  </div>;
}

function EventPicker({ eventTypes, selected, onChange }: { eventTypes: EventType[]; selected: string[]; onChange: (events: string[]) => void }) {
  return <fieldset className="space-y-1"><legend className="text-sm font-semibold">Events</legend>
    {eventTypes.map((type) => <label key={type.name} className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={selected.includes(type.name)} onChange={(event) => onChange(event.target.checked ? [...selected, type.name] : selected.filter((name) => name !== type.name))} />
      <span><code>{type.name}</code> <span className="text-slate-500">v{type.version} · {type.description}</span></span></label>)}
  </fieldset>;
}

function Attempts({ organizationId, delivery }: { organizationId: string | undefined; delivery: Delivery }) {
  const attempts = useQuery({ queryKey: tenantKey(organizationId, "webhook-delivery", delivery.id), queryFn: () => tenantApi<{ attempts: Attempt[] }>(`/api/tenant/webhook-deliveries/${encodeURIComponent(delivery.id)}`) });
  return <ul className="mt-1 space-y-0.5 text-xs text-slate-600">{attempts.data?.attempts.map((attempt) => <li key={attempt.id}>{formatDate(attempt.attemptedAt)}: {attempt.providerReference ? `accepted by Svix (${attempt.providerReference})` : attempt.responseCode ? `HTTP ${attempt.responseCode}` : "no response"}{attempt.failureCategory ? ` · ${attempt.failureCategory}` : ""} · {attempt.durationMs} ms</li>)}</ul>;
}

function EndpointDetail({ organizationId, endpoint, eventTypes, permissions, onChanged }: { organizationId: string | undefined; endpoint: Endpoint; eventTypes: EventType[]; permissions: string[]; onChanged: () => void }) {
  const client = useQueryClient();
  const detailKey = tenantKey(organizationId, "webhooks", endpoint.id);
  const detail = useQuery({ queryKey: detailKey, queryFn: () => tenantApi<{ endpoint: Endpoint; deliveries: Delivery[] }>(`/api/tenant/webhooks/${encodeURIComponent(endpoint.id)}`), refetchInterval: 5_000 });
  const [secret, setSecret] = useState<string>();
  const [error, setError] = useState<string>();
  const [expanded, setExpanded] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [disableReason, setDisableReason] = useState("");
  const [draft, setDraft] = useState({ name: endpoint.name, url: endpoint.url, events: [...endpoint.events] });
  const canManage = permissions.includes("organization.webhooks.manage");
  const refresh = () => { void client.invalidateQueries({ queryKey: detailKey }); onChanged(); };
  const action = useMutation({
    mutationFn: async (input: { path: string; method?: string; body?: unknown }) => await tenantApi<{ secret?: string; delivery?: Delivery }>(`/api/tenant/webhooks/${encodeURIComponent(endpoint.id)}${input.path}`, { method: input.method ?? "POST", ...(input.body === undefined ? {} : { body: input.body }) }),
    onSuccess: (result) => { if (result?.secret) setSecret(result.secret); setError(undefined); refresh(); },
    onError: (failure) => setError(failure.message),
  });
  const replay = useMutation({ mutationFn: (id: string) => tenantApi(`/api/tenant/webhook-deliveries/${encodeURIComponent(id)}/replay`, { method: "POST" }), onSuccess: refresh, onError: (failure) => setError(failure.message) });
  const current = detail.data?.endpoint ?? endpoint;
  return <div className="mt-4 rounded-xl border border-slate-200 p-4">
    {secret && <OneTimeSecret secret={secret} onDismiss={() => setSecret(undefined)} />}
    <dl className="grid gap-2 text-sm sm:grid-cols-2">
      <div><dt className="text-slate-500">URL</dt><dd className="break-all">{current.url}</dd></div>
      <div><dt className="text-slate-500">Signing secret</dt><dd>fingerprint <code>{current.secret.fingerprint}</code>, created {formatDate(current.secret.createdAt)}{current.secret.previousExpiresAt && new Date(current.secret.previousExpiresAt) > new Date() ? `; previous secret also signs until ${formatDate(current.secret.previousExpiresAt)}` : ""}</dd></div>
      <div><dt className="text-slate-500">Verified</dt><dd>{current.verifiedAt ? formatDate(current.verifiedAt) : "not yet; send a test event"}</dd></div>
      <div><dt className="text-slate-500">Subscribed events</dt><dd>{current.events.map((name) => <code key={name} className="mr-1">{name}@{eventTypes.find((type) => type.name === name)?.version ?? 1}</code>)}</dd></div>
      {current.disabledReason && <div className="sm:col-span-2"><dt className="text-slate-500">Disabled because</dt><dd>{current.disabledReason}</dd></div>}
    </dl>
    {canManage && <div className="mt-4 flex flex-wrap gap-2">
      {current.state === "active" && <button className="button" disabled={action.isPending} onClick={() => action.mutate({ path: "/test" })}>Send test event</button>}
      {current.state === "active" && <button className="button-secondary" onClick={() => action.mutate({ path: "/pause" })}>Pause</button>}
      {current.state !== "active" && <button className="button-secondary" onClick={() => action.mutate({ path: "/resume" })}>{current.state === "paused" ? "Resume" : "Re-enable"}</button>}
      {current.state !== "disabled" && <button className="button-secondary" onClick={() => setDisabling(!disabling)}>Disable</button>}
      <button className="button-secondary" onClick={() => setEditing(!editing)}>{editing ? "Cancel edit" : "Edit"}</button>
      {permissions.includes("organization.webhooks.rotate_secret") && <button className="button-secondary" onClick={() => action.mutate({ path: "/rotate-secret", body: { overlapHours: 24 } })}>Rotate secret</button>}
      <button className="text-sm font-semibold text-red-600" onClick={() => action.mutate({ path: "", method: "DELETE" })}>Delete</button>
    </div>}
    {disabling && <form className="mt-4 flex gap-2" onSubmit={(event) => { event.preventDefault(); action.mutate({ path: "/disable", body: { reason: disableReason } }); setDisabling(false); setDisableReason(""); }}>
      <input aria-label="Reason for disabling" className="min-w-0 flex-1 rounded-lg border px-3 py-2" required maxLength={500} placeholder="Why disable this endpoint?" value={disableReason} onChange={(event) => setDisableReason(event.target.value)} />
      <button className="button" type="submit" disabled={!disableReason.trim()}>Disable endpoint</button>
    </form>}
    {editing && <form className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); action.mutate({ path: "", method: "PATCH", body: draft }); setEditing(false); }}>
      <input aria-label="Endpoint name" className="w-full rounded-lg border px-3 py-2" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
      <input aria-label="Endpoint URL" className="w-full rounded-lg border px-3 py-2" value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} />
      <EventPicker eventTypes={eventTypes} selected={draft.events} onChange={(events) => setDraft({ ...draft, events })} />
      <button className="button" type="submit">Save endpoint</button>
    </form>}
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    <h3 className="mt-6 font-semibold">Recent deliveries</h3>
    {detail.data?.deliveries.length === 0 && <p className="mt-2 text-sm text-slate-600">No deliveries yet.</p>}
    <ul className="mt-2 divide-y divide-slate-100">{detail.data?.deliveries.map((delivery) => <li key={delivery.id} className="py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button className="text-left" onClick={() => setExpanded(expanded === delivery.id ? undefined : delivery.id)}>
          <code>{delivery.event}</code>{delivery.test && <span className="ml-2 rounded bg-blue-50 px-1.5 text-xs text-blue-700">test</span>}{delivery.replayOf && <span className="ml-2 rounded bg-slate-100 px-1.5 text-xs">replay</span>}
          <span className={`ml-2 font-medium ${delivery.status === "succeeded" ? "text-emerald-700" : delivery.status === "failed" ? "text-red-700" : "text-slate-600"}`}>{delivery.status}</span>
          <span className="ml-2 text-slate-500">{delivery.attempts} attempt{delivery.attempts === 1 ? "" : "s"}{delivery.responseCode ? ` · HTTP ${delivery.responseCode}` : ""}{delivery.failureCategory ? ` · ${delivery.failureCategory}` : ""}{delivery.nextAttemptAt ? ` · retry ${formatDate(delivery.nextAttemptAt)}` : ""}</span>
        </button>
        <span className="flex items-center gap-3 text-xs text-slate-500"><span title="Correlation ID" className="font-mono">{delivery.correlationId.slice(0, 12)}</span>{formatDate(delivery.createdAt)}
          {permissions.includes("organization.webhooks.replay") && !delivery.test && current.state === "active" && (delivery.status === "failed" || delivery.status === "succeeded") && <button className="font-semibold text-brand-500" onClick={() => replay.mutate(delivery.id)}>Replay</button>}</span>
      </div>
      {expanded === delivery.id && <Attempts organizationId={organizationId} delivery={delivery} />}
    </li>)}</ul>
  </div>;
}

/** Integrations -> Webhooks: tenant outbound webhooks (docs/ADMIN_ADDITIONS_SPEC.md §1). */
export function Webhooks() {
  const access = useTenantAccess();
  const organizationId = access.data?.organizationId;
  const client = useQueryClient();
  const permissions = access.data?.permissions ?? [];
  const listKey = tenantKey(organizationId, "webhooks");
  const list = useQuery({ queryKey: listKey, enabled: Boolean(organizationId) && permissions.includes("organization.webhooks.read"), queryFn: () => tenantApi<{ endpoints: Endpoint[]; eventTypes: EventType[] }>("/api/tenant/webhooks") });
  const [selected, setSelected] = useState<string>();
  const [secret, setSecret] = useState<string>();
  const [form, setForm] = useState({ name: "", url: "", events: [] as string[] });
  const [error, setError] = useState<string>();
  const create = useMutation({
    mutationFn: () => tenantApi<{ endpoint: Endpoint; secret: string }>("/api/tenant/webhooks", { method: "POST", body: form }),
    onSuccess: (result) => { setSecret(result.secret); setSelected(result.endpoint.id); setForm({ name: "", url: "", events: [] }); setError(undefined); void client.invalidateQueries({ queryKey: listKey }); },
    onError: (failure) => setError(failure.message),
  });
  if (access.error) return <section className="card p-8"><p className="text-red-700">{access.error.message}</p></section>;
  if (access.data && !permissions.includes("organization.webhooks.read")) return <section className="card p-8"><h1 className="text-2xl font-semibold">Webhooks</h1><p className="mt-2 text-slate-600">Your organization role does not include webhook access. Ask an owner or administrator.</p></section>;
  const eventTypes = list.data?.eventTypes ?? [];
  const localReceiver = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  return <section className="space-y-6">
    <div className="card p-8">
      <p className="eyebrow">Integrations</p>
      <h1 className="mt-2 text-3xl font-semibold">Webhooks</h1>
      <p className="mt-2 text-slate-600">Send signed events to your systems when things change in this organization. Deliveries retry with backoff and can be replayed.</p>
      {secret && <OneTimeSecret secret={secret} onDismiss={() => setSecret(undefined)} />}
      {list.error && <p role="alert" className="mt-4 text-red-700">{list.error.message}</p>}
      <table className="mt-6 w-full text-left text-sm">
        <thead><tr className="text-slate-500"><th className="py-2">Endpoint</th><th>State</th><th>Health</th><th>Events</th><th>Last success</th><th>Last failure</th></tr></thead>
        <tbody>{list.data?.endpoints.map((endpoint) => <tr key={endpoint.id} className={`cursor-pointer border-t border-slate-100 ${selected === endpoint.id ? "bg-slate-50" : ""}`} onClick={() => setSelected(selected === endpoint.id ? undefined : endpoint.id)}>
          <td className="py-2"><p className="font-medium">{endpoint.name}</p><p className="text-xs text-slate-500">{endpoint.urlDisplay}</p></td>
          <td>{endpoint.state}</td><td className={healthTone[endpoint.health]}>{endpoint.health}</td><td>{endpoint.events.length}</td><td>{formatDate(endpoint.lastSuccessAt)}</td><td>{formatDate(endpoint.lastFailureAt)}</td>
        </tr>)}</tbody>
      </table>
      {list.data?.endpoints.length === 0 && <p className="mt-3 text-sm text-slate-600">No endpoints yet.</p>}
      {selected && list.data?.endpoints.find((endpoint) => endpoint.id === selected) && <EndpointDetail key={selected} organizationId={organizationId} endpoint={list.data.endpoints.find((endpoint) => endpoint.id === selected)!} eventTypes={eventTypes} permissions={permissions} onChanged={() => void client.invalidateQueries({ queryKey: listKey })} />}
    </div>
    {permissions.includes("organization.webhooks.manage") && <form className="card space-y-4 p-8" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
      <h2 className="text-lg font-semibold">Add an endpoint</h2>
      <label className="block text-sm font-medium">Name<input className="mt-1 w-full rounded-lg border px-3 py-2" required maxLength={80} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
      <label className="block text-sm font-medium">URL<input className="mt-1 w-full rounded-lg border px-3 py-2" required placeholder="https://example.com/webhooks/trestle" value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} /></label>
      {localReceiver && <p className="text-xs text-slate-500">Local development: use <button type="button" className="font-mono underline" onClick={() => setForm({ ...form, url: "http://localhost:8787/api/dev/webhook-receiver" })}>http://localhost:8787/api/dev/webhook-receiver</button> (or <code>…/fail</code> to simulate errors).</p>}
      <EventPicker eventTypes={eventTypes} selected={form.events} onChange={(events) => setForm({ ...form, events })} />
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <button className="button" disabled={create.isPending || !form.name || !form.url || form.events.length === 0} type="submit">Create endpoint</button>
    </form>}
  </section>;
}
