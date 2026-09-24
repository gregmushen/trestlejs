import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { authClient } from "./auth-client";

const apiOrigin = (import.meta.env.VITE_API_ORIGIN as string | undefined)?.replace(/\/$/u, "") ?? "";

type Endpoint = {
  id: string;
  name: string;
  destinationHost: string;
  state: string;
  health: string;
  provider: string;
  subscriptionCount: number;
  createdAt: string;
  updatedAt: string;
};

type PublicEvent = { type: string; version: number; description: string; available: boolean };
type Subscription = { type: string; version: number };

type Delivery = {
  id: string;
  messageId: string;
  eventType: string;
  eventVersion: number;
  occurredAt: string;
  state: string;
  attemptCount: number;
  nextAttemptAt: string | null;
  terminalReason: string | null;
  createdAt: string;
  completedAt: string | null;
  payloadAvailable: boolean;
  replayOfDeliveryId: string | null;
  activeReplayId: string | null;
  successfulReplayId: string | null;
  replayable: boolean;
  replayUnavailableReason: "not_failed" | "payload_expired" | "resolved" | "endpoint_inactive" | "provider_unavailable" | "replay_pending" | null;
  correlationId: string | null;
};

type Attempt = {
  id: string;
  attemptNumber: number;
  kind: string;
  attemptedAt: string;
  completedAt: string | null;
  responseStatus: number | null;
  resultCategory: string | null;
  outcome: string;
  durationMs: number | null;
  nextRetryAt: string | null;
};

async function inspect<T>(path: string, organizationId: string): Promise<T> {
  const response = await fetch(`${apiOrigin}${path}`, {
    credentials: "include",
    headers: { "x-trestle-tenant": organizationId },
  });
  if (response.status === 403) throw new Error("You do not have permission to inspect this organization's webhooks.");
  if (!response.ok) throw new Error("Webhook inspection is unavailable. Try again shortly.");
  return response.json() as Promise<T>;
}

async function createEndpoint(organizationId: string, input: { name: string; destinationUrl: string; subscriptions: Subscription[] }) {
  const response = await fetch(`${apiOrigin}/api/developer/webhooks/endpoints`, {
    method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-trestle-tenant": organizationId },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(result.error ?? "Webhook endpoint could not be created.");
  }
  return response.json() as Promise<{ endpoint: { id: string; state: string }; signingSecret: string }>;
}

async function changeEndpointState(organizationId: string, endpointId: string, state: "active" | "disabled") {
  const response = await fetch(`${apiOrigin}/api/developer/webhooks/endpoints/${encodeURIComponent(endpointId)}/state`, {
    method: "PATCH", credentials: "include", headers: { "content-type": "application/json", "x-trestle-tenant": organizationId },
    body: JSON.stringify({ state }),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(result.error ?? "Endpoint state could not be changed.");
  }
}

async function updateSubscriptions(organizationId: string, endpointId: string, subscriptions: Subscription[]) {
  const response = await fetch(`${apiOrigin}/api/developer/webhooks/endpoints/${encodeURIComponent(endpointId)}/subscriptions`, {
    method: "PATCH", credentials: "include", headers: { "content-type": "application/json", "x-trestle-tenant": organizationId },
    body: JSON.stringify({ subscriptions }),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(result.error ?? "Webhook subscriptions could not be saved.");
  }
}

async function replayDelivery(organizationId: string, deliveryId: string) {
  const response = await fetch(`${apiOrigin}/api/developer/webhooks/deliveries/${encodeURIComponent(deliveryId)}/replay`, {
    method: "POST", credentials: "include", headers: { "x-trestle-tenant": organizationId },
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(result.error ?? "The delivery could not be queued for replay.");
  }
  return response.json() as Promise<{ state: "queued"; replayDeliveryId: string; created: boolean }>;
}

function WebhookSubscriptions({ organizationId, endpointId, userId, events }: { organizationId: string; endpointId: string; userId: string; events: PublicEvent[] }) {
  const queryClient = useQueryClient();
  const key = ["webhook-inspection", userId, organizationId, "subscriptions", endpointId];
  const current = useQuery({
    queryKey: key, retry: false,
    queryFn: () => inspect<{ subscriptions: Subscription[] }>(`/api/developer/webhooks/endpoints/${encodeURIComponent(endpointId)}/subscriptions`, organizationId),
  });
  const update = useMutation({ mutationFn: (subscriptions: Subscription[]) => updateSubscriptions(organizationId, endpointId, subscriptions),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: key });
      await queryClient.invalidateQueries({ queryKey: ["webhook-inspection", userId, organizationId, "endpoints"] });
    },
  });
  const form = useForm({
    defaultValues: { subscriptions: [] as Subscription[] },
    onSubmit: async ({ value }) => { await update.mutateAsync(value.subscriptions); },
  });
  useEffect(() => { if (current.data?.subscriptions) form.setFieldValue("subscriptions", current.data.subscriptions); }, [current.data, form]);
  const choices = [...events, ...(current.data?.subscriptions ?? []).filter((subscription) => !events.some((event) => event.type === subscription.type && event.version === subscription.version)).map((subscription) => ({ ...subscription, description: "No longer in the public event catalog", available: false }))];
  return <section aria-label="Endpoint subscriptions" className="mt-8 border-t border-slate-200 pt-6">
    <h2 className="text-xl font-semibold">Subscriptions</h2>
    <p className="mt-1 text-sm text-slate-600">Choose the public event versions this endpoint receives. Changes affect future events, not deliveries already created.</p>
    {current.isPending ? <p className="mt-3">Loading subscriptions…</p> : current.error ? <p className="mt-3 text-red-700" role="alert">{current.error.message}</p> : <form className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); void form.handleSubmit().catch(() => undefined); }}>
      <form.Field name="subscriptions">{(field) => <div className="space-y-2">{choices.map((event) => {
        const selected = field.state.value.some((item) => item.type === event.type && item.version === event.version);
        return <label className="flex items-start gap-2 text-sm" key={`${event.type}@${event.version}`}><input type="checkbox" className="mt-1" checked={selected} disabled={!event.available && !selected} onChange={() => field.handleChange(selected ? field.state.value.filter((item) => item.type !== event.type || item.version !== event.version) : [...field.state.value, { type: event.type, version: event.version }])} /><span><span className="font-medium">{event.type} v{event.version}</span> — {event.description}{!event.available && " (unavailable; remove before saving)"}</span></label>;
      })}</div>}</form.Field>
      {update.error && <p className="text-sm text-red-700" role="alert">{update.error.message}</p>}
      {update.isSuccess && <p className="text-sm text-green-700" role="status">Subscriptions saved.</p>}
      <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting, state.values.subscriptions.length] as const}>{([canSubmit, isSubmitting, count]) => <button className="button" disabled={!canSubmit || isSubmitting || count === 0 || update.isPending} type="submit">{isSubmitting || update.isPending ? "Saving…" : "Save subscriptions"}</button>}</form.Subscribe>
    </form>}
  </section>;
}

function UtcTime({ value }: { value: string | null }) {
  if (!value) return <>—</>;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <>—</>;
  return <time dateTime={date.toISOString()}>{date.toISOString().replace("T", " ").replace(/Z$/u, " UTC")}</time>;
}

export function WebhookInspection() {
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const { data: activeOrganization } = authClient.useActiveOrganization();
  const organizationId = activeOrganization?.id;
  const queryClient = useQueryClient();
  const [endpointId, setEndpointId] = useState<string>();
  const [deliveryId, setDeliveryId] = useState<string>();
  const [oneTimeSecret, setOneTimeSecret] = useState<string>();
  useEffect(() => { setEndpointId(undefined); setDeliveryId(undefined); setOneTimeSecret(undefined); }, [session?.user.id, organizationId]);

  const publicEvents = useQuery({
    queryKey: ["webhook-inspection", session?.user.id, organizationId, "events"],
    enabled: Boolean(session?.user.id && organizationId), retry: false,
    queryFn: () => inspect<{ events: PublicEvent[] }>("/api/developer/webhooks/events", organizationId!),
  });
  const creation = useMutation({ mutationFn: (input: { name: string; destinationUrl: string; subscriptions: Subscription[] }) => createEndpoint(organizationId!, input) });
  const form = useForm({
    defaultValues: { name: "", destinationUrl: "", subscriptions: [] as Subscription[] },
    onSubmit: async ({ value }) => {
      setOneTimeSecret(undefined);
      const result = await creation.mutateAsync(value);
      setOneTimeSecret(result.signingSecret);
      setEndpointId(result.endpoint.id);
      form.reset();
      await queryClient.invalidateQueries({ queryKey: ["webhook-inspection", session?.user.id, organizationId, "endpoints"] });
    },
  });

  const endpoints = useQuery({
    queryKey: ["webhook-inspection", session?.user.id, organizationId, "endpoints"],
    enabled: Boolean(session?.user.id && organizationId),
    retry: false,
    queryFn: () => inspect<{ endpoints: Endpoint[] }>("/api/developer/webhooks/endpoints", organizationId!),
  });
  const stateChange = useMutation({
    mutationFn: (input: { id: string; state: "active" | "disabled" }) => changeEndpointState(organizationId!, input.id, input.state),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["webhook-inspection", session?.user.id, organizationId, "endpoints"] }); },
  });
  const selectedEndpoint = endpoints.data?.endpoints.find((item) => item.id === endpointId);
  const deliveries = useQuery({
    queryKey: ["webhook-inspection", session?.user.id, organizationId, "deliveries", endpointId],
    enabled: Boolean(session?.user.id && organizationId && endpointId),
    retry: false,
    queryFn: () => inspect<{ deliveries: Delivery[] }>(`/api/developer/webhooks/endpoints/${encodeURIComponent(endpointId!)}/deliveries`, organizationId!),
  });
  const attempts = useQuery({
    queryKey: ["webhook-inspection", session?.user.id, organizationId, "attempts", deliveryId],
    enabled: Boolean(session?.user.id && organizationId && deliveryId),
    retry: false,
    queryFn: () => inspect<{ attempts: Attempt[] }>(`/api/developer/webhooks/deliveries/${encodeURIComponent(deliveryId!)}/attempts`, organizationId!),
  });
  const selectedDelivery = deliveries.data?.deliveries.find((delivery) => delivery.id === deliveryId);
  const replay = useMutation({
    mutationFn: (sourceId: string) => replayDelivery(organizationId!, sourceId),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["webhook-inspection", session?.user.id, organizationId, "deliveries", endpointId] });
      setDeliveryId(result.replayDeliveryId);
    },
  });
  useEffect(() => {
    if (endpoints.error) { setEndpointId(undefined); setDeliveryId(undefined); }
  }, [endpoints.error]);

  return <section className="card p-8">
    <p className="eyebrow">Developer settings</p>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="mt-2 text-3xl font-semibold">Outbound webhooks</h1><p className="mt-2 text-slate-600">Manage endpoint registrations and inspect delivery status for the selected organization. Message contents are not shown here.</p></div>
      {organizationId && <button className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium" onClick={() => void queryClient.invalidateQueries({ queryKey: ["webhook-inspection", session?.user.id, organizationId] })}>Refresh</button>}
    </div>
    {sessionPending ? <p className="mt-6">Loading your account…</p> : !session ? <p className="mt-6">Sign in to inspect webhooks.</p> : !organizationId ? <p className="mt-6">Select an organization to inspect webhooks.</p> : <>
      <div className="mt-8 rounded-xl border border-slate-200 p-5">
        <h2 className="text-xl font-semibold">Create endpoint</h2>
        <p className="mt-1 text-sm text-slate-600">New endpoints start disabled. Their signing secret is shown once after creation; save it securely before leaving this page.</p>
        {publicEvents.isPending ? <p className="mt-3">Loading public events…</p> : publicEvents.error ? <p className="mt-3 text-red-700" role="alert">{publicEvents.error.message}</p> : !publicEvents.data?.events?.some((event) => event.available) ? <p className="mt-3 text-slate-600">No public webhook events are defined yet. Add an application-owned public event projection before registering an endpoint.</p> : <form className="mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); void form.handleSubmit().catch(() => undefined); }}>
          <form.Field name="name">{(field) => <label className="block text-sm font-medium">Endpoint name<input className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" required maxLength={120} value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} /></label>}</form.Field>
          <form.Field name="destinationUrl">{(field) => <label className="block text-sm font-medium">HTTPS destination<input className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" type="url" required placeholder="https://example.com/webhooks" value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} /></label>}</form.Field>
          <fieldset><legend className="text-sm font-medium">Events</legend><form.Field name="subscriptions">{(field) => <div className="mt-2 space-y-2">{publicEvents.data.events.map((event) => {
            const selected = field.state.value.some((item) => item.type === event.type && item.version === event.version);
            return <label className="flex items-start gap-2 text-sm" key={`${event.type}@${event.version}`}><input type="checkbox" className="mt-1" disabled={!event.available} checked={selected} onChange={() => field.handleChange(selected ? field.state.value.filter((item) => item.type !== event.type || item.version !== event.version) : [...field.state.value, { type: event.type, version: event.version }])} /><span><span className="font-medium">{event.type} v{event.version}</span> — {event.description}{!event.available && " (not available on this plan)"}</span></label>;
          })}</div>}</form.Field></fieldset>
          {creation.error && <p className="text-sm text-red-700" role="alert">{creation.error.message}</p>}
          <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting, state.values.subscriptions.length] as const}>{([canSubmit, isSubmitting, count]) => <button className="button" type="submit" disabled={!canSubmit || isSubmitting || count === 0}>{isSubmitting ? "Creating…" : "Create endpoint"}</button>}</form.Subscribe>
        </form>}
        {oneTimeSecret && <div className="mt-5 rounded-lg border border-amber-300 bg-amber-50 p-4" role="status"><p className="font-semibold">Save this signing secret now. It cannot be recovered.</p><code className="mt-2 block break-all select-all">{oneTimeSecret}</code><button className="mt-3 text-sm underline" type="button" onClick={() => { setOneTimeSecret(undefined); creation.reset(); }}>I saved it; hide secret</button></div>}
      </div>
      <h2 className="mt-8 text-xl font-semibold">Endpoints</h2><p className="mt-1 text-sm text-slate-500">Showing up to 50 most recently created endpoints.</p>
      {endpoints.isPending ? <p className="mt-3">Loading endpoints…</p> : endpoints.error ? <p className="mt-3 text-red-700" role="alert">{endpoints.error.message}</p> : endpoints.data?.endpoints?.length ? <ul className="mt-3 space-y-2">{endpoints.data.endpoints.map((endpoint) => <li key={endpoint.id}>
        <button aria-pressed={endpointId === endpoint.id} className="w-full rounded-xl border border-slate-200 p-4 text-left hover:border-brand-500" onClick={() => { setEndpointId(endpoint.id); setDeliveryId(undefined); }}>
          <span className="block font-semibold">{endpoint.name}</span>
          <span className="block text-sm text-slate-600">{endpoint.destinationHost} · {endpoint.state} · {endpoint.health} · {endpoint.subscriptionCount} subscription{endpoint.subscriptionCount === 1 ? "" : "s"}</span>
        </button>
      </li>)}</ul> : <p className="mt-3 text-slate-600">No webhook endpoints for this organization.</p>}

      {selectedEndpoint && <div className="mt-5 flex flex-wrap items-center gap-3"><span className="text-sm text-slate-600">{selectedEndpoint.name} is {selectedEndpoint.state}.</span><button className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium" type="button" disabled={stateChange.isPending} onClick={() => void stateChange.mutateAsync({ id: selectedEndpoint.id, state: selectedEndpoint.state === "active" ? "disabled" : "active" }).catch(() => undefined)}>{selectedEndpoint.state === "active" ? "Disable endpoint" : "Activate endpoint"}</button>{stateChange.error && <span className="text-sm text-red-700" role="alert">{stateChange.error.message}</span>}</div>}

      {selectedEndpoint && publicEvents.data?.events && <WebhookSubscriptions key={selectedEndpoint.id} organizationId={organizationId} endpointId={selectedEndpoint.id} userId={session.user.id} events={publicEvents.data.events} />}

      {endpointId && <div className="mt-8 border-t border-slate-200 pt-6"><h2 className="text-xl font-semibold">Deliveries</h2><p className="mt-1 text-sm text-slate-500">Showing up to 50 most recent deliveries.</p>
        {deliveries.isPending ? <p className="mt-3">Loading deliveries…</p> : deliveries.error ? <p className="mt-3 text-red-700" role="alert">{deliveries.error.message}</p> : deliveries.data?.deliveries?.length ? <ul className="mt-3 space-y-2">{deliveries.data.deliveries.map((delivery) => <li key={delivery.id}>
          <button aria-pressed={deliveryId === delivery.id} className="w-full rounded-xl border border-slate-200 p-4 text-left hover:border-brand-500" onClick={() => setDeliveryId(delivery.id)}>
            <span className="block font-semibold">{delivery.eventType} v{delivery.eventVersion}</span>
            <span className="block text-sm text-slate-600">{delivery.state} · {delivery.attemptCount} attempt{delivery.attemptCount === 1 ? "" : "s"} · <UtcTime value={delivery.createdAt} /></span>
          </button>
        </li>)}</ul> : <p className="mt-3 text-slate-600">No deliveries for this endpoint.</p>}
      </div>}

      {deliveryId && <div className="mt-8 border-t border-slate-200 pt-6"><h2 className="text-xl font-semibold">Attempts</h2><p className="mt-1 text-sm text-slate-500">Showing up to 50 most recent attempts.</p>
        {selectedDelivery?.replayOfDeliveryId && <p className="mt-2 text-sm text-slate-600">Replay of {selectedDelivery.replayOfDeliveryId}. The original delivery and its attempts remain unchanged.</p>}
        {selectedDelivery?.replayable && <button type="button" className="mt-3 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium" disabled={replay.isPending} onClick={() => void replay.mutateAsync(deliveryId).catch(() => undefined)}>{replay.isPending ? "Queuing replay…" : "Replay failed delivery"}</button>}
        {selectedDelivery?.replayUnavailableReason === "replay_pending" && <p className="mt-2 text-sm text-slate-600">A replay is already queued.</p>}
        {selectedDelivery?.replayUnavailableReason === "resolved" && <p className="mt-2 text-sm text-slate-600">A replay of this message has succeeded.</p>}
        {selectedDelivery?.replayUnavailableReason === "payload_expired" && <p className="mt-2 text-sm text-slate-600">The payload is no longer retained, so this delivery cannot be replayed.</p>}
        {selectedDelivery?.replayUnavailableReason === "endpoint_inactive" && <p className="mt-2 text-sm text-slate-600">Activate this endpoint before replaying.</p>}
        {selectedDelivery?.replayUnavailableReason === "provider_unavailable" && <p className="mt-2 text-sm text-slate-600">Webhook delivery is unavailable in this environment.</p>}
        {replay.error && <p className="mt-2 text-sm text-red-700" role="alert">{replay.error.message}</p>}
        {replay.isSuccess && <p className="mt-2 text-sm text-green-700" role="status">Replay queued. This does not mean it has reached the destination.</p>}
        {attempts.isPending ? <p className="mt-3">Loading attempts…</p> : attempts.error ? <p className="mt-3 text-red-700" role="alert">{attempts.error.message}</p> : attempts.data?.attempts?.length ? <ol className="mt-3 space-y-2">{attempts.data.attempts.map((attempt) => <li className="rounded-xl border border-slate-200 p-4" key={attempt.id}>
          <p className="font-semibold">Attempt {attempt.attemptNumber}: {attempt.outcome}</p>
          <p className="text-sm text-slate-600">{attempt.resultCategory ?? "No result category"} · HTTP {attempt.responseStatus ?? "—"} · <UtcTime value={attempt.attemptedAt} /></p>
        </li>)}</ol> : <p className="mt-3 text-slate-600">No attempts recorded for this delivery.</p>}
      </div>}
    </>}
  </section>;
}
