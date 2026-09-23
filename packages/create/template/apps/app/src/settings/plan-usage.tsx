import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { formatDate, tenantApi, tenantKey, useTenantAccess, type TenantCapabilityDocument } from "./api";

function describeValue(values: Record<string, boolean | number | string | null>): string {
  return Object.entries(values).map(([name, value]) => `${name}: ${value === null ? "unlimited" : String(value)}`).join(" · ");
}

/** Customer-safe plan, capability, limit, and contract transparency (spec §12). */
export function PlanAndUsage() {
  const access = useTenantAccess();
  const organizationId = access.data?.organizationId;
  const document = useQuery({ queryKey: tenantKey(organizationId, "plan-usage"), enabled: Boolean(organizationId), queryFn: () => tenantApi<TenantCapabilityDocument>("/api/tenant/plan-usage") });
  if (access.error || document.error) return <section className="card p-8"><p className="text-red-700">{(access.error ?? document.error)!.message}</p></section>;
  if (!document.data) return <p className="text-slate-600">Loading plan…</p>;
  const plan = document.data;
  return <section className="space-y-6">
    <div className="card p-8">
      <p className="eyebrow">Plan and usage</p>
      <h1 className="mt-2 text-3xl font-semibold">{plan.plan ? plan.plan.name : "No active plan"}</h1>
      {plan.plan && <p className="mt-2 text-slate-600">Status: {plan.plan.status} · {plan.plan.cancelAtPeriodEnd ? "cancels" : "renews"} {formatDate(plan.plan.renewsAt)}</p>}
      <Link to="/settings/billing" className="button mt-4">{plan.plan ? "Change plan" : "Choose a plan"}</Link>
      {plan.scheduledChanges.map((change) => <p key={change.toPlan} className="mt-2 text-sm text-amber-700">Scheduled change to {change.toPlan} on {formatDate(change.effectiveAt)}</p>)}
    </div>
    {plan.limits.length > 0 && <div className="card p-8">
      <h2 className="text-lg font-semibold">Limits and consumption</h2>
      <ul className="mt-4 space-y-4">{plan.limits.map((limit) => {
        const ceiling = limit.limit ?? limit.included;
        const percent = ceiling > 0 ? Math.min(100, Math.round((limit.used / ceiling) * 100)) : 0;
        return <li key={limit.code}>
          <div className="flex justify-between text-sm"><span className="font-medium">{limit.name}</span><span>{limit.used.toLocaleString()} of {limit.limit === null ? `${limit.included.toLocaleString()} included (no hard limit)` : ceiling.toLocaleString()}</span></div>
          <div className="mt-2 h-2 rounded-full bg-slate-100" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}><div className="h-2 rounded-full bg-brand-500" style={{ width: `${percent}%` }} /></div>
          <p className="mt-1 text-xs text-slate-500">Resets {formatDate(limit.resetsAt)}</p>
        </li>;
      })}</ul>
    </div>}
    <div className="card p-8">
      <h2 className="text-lg font-semibold">Included capabilities</h2>
      <ul className="mt-4 divide-y divide-slate-100">{plan.capabilities.filter((capability) => capability.enabled).map((capability) => <li key={capability.code} className="py-3">
        <p className="font-medium">{capability.name}</p>
        <p className="text-sm text-slate-600">{capability.description}{Object.keys(capability.values).length > 0 && ` — ${describeValue(capability.values)}`}</p>
        <p className="text-xs text-slate-500">{capability.source === "contract" ? "Included by your contract" : `Included with ${capability.includedWith ?? "your plan"}`}</p>
      </li>)}</ul>
    </div>
    {plan.contractualOverrides.length > 0 && <div className="card p-8"><h2 className="text-lg font-semibold">Contract terms</h2><ul className="mt-3 space-y-2 text-sm">{plan.contractualOverrides.map((override) => <li key={override.code}>{override.name} — effective {formatDate(override.effectiveAt)}{override.expiresAt ? `, until ${formatDate(override.expiresAt)}` : ""}</li>)}</ul></div>}
    {plan.upgrades.length > 0 && <div className="card p-8"><h2 className="text-lg font-semibold">Available on other plans</h2><ul className="mt-3 space-y-2 text-sm">{plan.upgrades.map((upgrade) => <li key={upgrade.code}>{upgrade.name} — available on {upgrade.availableOn.join(", ")}</li>)}</ul></div>}
  </section>;
}
