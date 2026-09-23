import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { formatDate, tenantApi, tenantKey, useTenantAccess, type TenantCapabilityDocument } from "./api";

type Subscription = null | { plan: string; status: string; provider: string; currentPeriodEnd?: string; cancelAtPeriodEnd: boolean };

/**
 * Subscription management. Checkout goes through the configured BillingService:
 * the local adapter activates immediately; Stripe redirects to its Checkout.
 */
export function BillingSettings() {
  const access = useTenantAccess();
  const organizationId = access.data?.organizationId;
  const client = useQueryClient();
  const canManage = access.data?.permissions.includes("organization.billing.manage") ?? false;
  const canRead = access.data?.permissions.includes("organization.billing.read") ?? false;
  const subscription = useQuery({ queryKey: tenantKey(organizationId, "subscription"), enabled: Boolean(organizationId) && canRead, queryFn: () => tenantApi<{ subscription: Subscription }>("/api/billing/subscription") });
  const plans = useQuery({ queryKey: tenantKey(organizationId, "plan-usage"), enabled: Boolean(organizationId), queryFn: () => tenantApi<TenantCapabilityDocument>("/api/tenant/plan-usage") });
  const [message, setMessage] = useState<string>();
  const refresh = async () => { await client.invalidateQueries({ queryKey: tenantKey(organizationId) }); await client.invalidateQueries({ queryKey: ["tenant-access"] }); };
  const checkout = useMutation({
    mutationFn: (plan: string) => tenantApi<{ url: string }>("/api/billing/checkout", { method: "POST", body: { plan, requestId: crypto.randomUUID() } }),
    onSuccess: async (result) => {
      if (/^https?:\/\//u.test(result.url) && new URL(result.url).origin !== window.location.origin) { window.location.assign(result.url); return; }
      setMessage("Subscription updated.");
      await refresh();
    },
    onError: (failure) => setMessage(failure.message),
  });
  const portal = useMutation({
    mutationFn: () => tenantApi<{ url: string }>("/api/billing/portal", { method: "POST", body: { requestId: crypto.randomUUID() } }),
    onSuccess: (result) => { if (/^https?:\/\//u.test(result.url)) window.location.assign(result.url); else setMessage("This subscription is managed locally; choose a plan below."); },
    onError: (failure) => setMessage(failure.message),
  });
  if (access.error) return <section className="card p-8"><h1 className="text-3xl font-semibold">Billing</h1><p className="mt-4 text-slate-600">{access.error.message}</p></section>;
  if (access.data && !canRead) return <section className="card p-8"><h1 className="text-3xl font-semibold">Billing</h1><p className="mt-4 text-slate-600">Your organization role does not include billing access. Ask an owner or billing administrator.</p></section>;
  const current = subscription.data?.subscription;
  return <section className="space-y-6">
    <div className="card p-8">
      <p className="eyebrow">Settings</p>
      <h1 className="mt-2 text-3xl font-semibold">Billing</h1>
      {subscription.isPending ? <p className="mt-4 text-slate-600">Loading…</p> : current ? <div className="mt-4 space-y-1 text-slate-700">
        <p>Current plan: <strong>{plans.data?.plan?.name ?? current.plan}</strong> · {current.status}</p>
        <p className="text-sm text-slate-500">{current.cancelAtPeriodEnd ? "Cancels" : "Renews"} {formatDate(current.currentPeriodEnd)} · billed through {current.provider === "local" ? "local development billing" : current.provider}</p>
        {canManage && current.provider !== "local" && <button className="button mt-3" onClick={() => portal.mutate()}>Manage payment details</button>}
      </div> : <p className="mt-4 text-slate-600">No active subscription. Choose a plan to get started.</p>}
      {message && <p role="status" className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{message}</p>}
    </div>
    <div className="grid gap-4 md:grid-cols-3">{plans.data?.availablePlans.map((plan) => {
      const isCurrent = current?.plan === plan.key && current.status !== "cancelled";
      return <article key={plan.key} className={`card flex flex-col p-6 ${isCurrent ? "ring-2 ring-brand-500" : ""}`}>
        <h2 className="text-xl font-semibold">{plan.name}</h2>
        <ul className="mt-3 flex-1 space-y-1 text-sm text-slate-600">{plan.capabilities.map((capability) => <li key={capability}>✓ {capability}</li>)}</ul>
        {isCurrent ? <p className="mt-4 text-sm font-semibold text-brand-500">Current plan</p>
          : canManage ? <button className="button mt-4" disabled={checkout.isPending} onClick={() => checkout.mutate(plan.key)}>{current ? `Switch to ${plan.name}` : `Choose ${plan.name}`}</button>
          : <p className="mt-4 text-sm text-slate-500">Ask a billing administrator to change plans.</p>}
      </article>;
    })}</div>
  </section>;
}
