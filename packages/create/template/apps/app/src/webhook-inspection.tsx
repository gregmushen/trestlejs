import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  useEffect(() => { setEndpointId(undefined); setDeliveryId(undefined); }, [session?.user.id, organizationId]);

  const endpoints = useQuery({
    queryKey: ["webhook-inspection", session?.user.id, organizationId, "endpoints"],
    enabled: Boolean(session?.user.id && organizationId),
    retry: false,
    queryFn: () => inspect<{ endpoints: Endpoint[] }>("/api/developer/webhooks/endpoints", organizationId!),
  });
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
  useEffect(() => {
    if (endpoints.error) { setEndpointId(undefined); setDeliveryId(undefined); }
  }, [endpoints.error]);

  return <section className="card p-8">
    <p className="eyebrow">Developer settings</p>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="mt-2 text-3xl font-semibold">Outbound webhooks</h1><p className="mt-2 text-slate-600">Endpoint and delivery status for the selected organization. Message contents and signing secrets are never shown here.</p></div>
      {organizationId && <button className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium" onClick={() => void queryClient.invalidateQueries({ queryKey: ["webhook-inspection", session?.user.id, organizationId] })}>Refresh</button>}
    </div>
    {sessionPending ? <p className="mt-6">Loading your account…</p> : !session ? <p className="mt-6">Sign in to inspect webhooks.</p> : !organizationId ? <p className="mt-6">Select an organization to inspect webhooks.</p> : <>
      <h2 className="mt-8 text-xl font-semibold">Endpoints</h2><p className="mt-1 text-sm text-slate-500">Showing up to 50 most recently created endpoints.</p>
      {endpoints.isPending ? <p className="mt-3">Loading endpoints…</p> : endpoints.error ? <p className="mt-3 text-red-700" role="alert">{endpoints.error.message}</p> : endpoints.data?.endpoints.length ? <ul className="mt-3 space-y-2">{endpoints.data.endpoints.map((endpoint) => <li key={endpoint.id}>
        <button aria-pressed={endpointId === endpoint.id} className="w-full rounded-xl border border-slate-200 p-4 text-left hover:border-brand-500" onClick={() => { setEndpointId(endpoint.id); setDeliveryId(undefined); }}>
          <span className="block font-semibold">{endpoint.name}</span>
          <span className="block text-sm text-slate-600">{endpoint.destinationHost} · {endpoint.state} · {endpoint.health} · {endpoint.subscriptionCount} subscription{endpoint.subscriptionCount === 1 ? "" : "s"}</span>
        </button>
      </li>)}</ul> : <p className="mt-3 text-slate-600">No webhook endpoints for this organization.</p>}

      {endpointId && <div className="mt-8 border-t border-slate-200 pt-6"><h2 className="text-xl font-semibold">Deliveries</h2><p className="mt-1 text-sm text-slate-500">Showing up to 50 most recent deliveries.</p>
        {deliveries.isPending ? <p className="mt-3">Loading deliveries…</p> : deliveries.error ? <p className="mt-3 text-red-700" role="alert">{deliveries.error.message}</p> : deliveries.data?.deliveries.length ? <ul className="mt-3 space-y-2">{deliveries.data.deliveries.map((delivery) => <li key={delivery.id}>
          <button aria-pressed={deliveryId === delivery.id} className="w-full rounded-xl border border-slate-200 p-4 text-left hover:border-brand-500" onClick={() => setDeliveryId(delivery.id)}>
            <span className="block font-semibold">{delivery.eventType} v{delivery.eventVersion}</span>
            <span className="block text-sm text-slate-600">{delivery.state} · {delivery.attemptCount} attempt{delivery.attemptCount === 1 ? "" : "s"} · <UtcTime value={delivery.createdAt} /></span>
          </button>
        </li>)}</ul> : <p className="mt-3 text-slate-600">No deliveries for this endpoint.</p>}
      </div>}

      {deliveryId && <div className="mt-8 border-t border-slate-200 pt-6"><h2 className="text-xl font-semibold">Attempts</h2><p className="mt-1 text-sm text-slate-500">Showing up to 50 most recent attempts.</p>
        {attempts.isPending ? <p className="mt-3">Loading attempts…</p> : attempts.error ? <p className="mt-3 text-red-700" role="alert">{attempts.error.message}</p> : attempts.data?.attempts.length ? <ol className="mt-3 space-y-2">{attempts.data.attempts.map((attempt) => <li className="rounded-xl border border-slate-200 p-4" key={attempt.id}>
          <p className="font-semibold">Attempt {attempt.attemptNumber}: {attempt.outcome}</p>
          <p className="text-sm text-slate-600">{attempt.resultCategory ?? "No result category"} · HTTP {attempt.responseStatus ?? "—"} · <UtcTime value={attempt.attemptedAt} /></p>
        </li>)}</ol> : <p className="mt-3 text-slate-600">No attempts recorded for this delivery.</p>}
      </div>}
    </>}
  </section>;
}
