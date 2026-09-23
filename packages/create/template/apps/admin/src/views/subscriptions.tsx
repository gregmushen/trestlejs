import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { adminApi, adminPost, type AdminSession, type CommercialDetail, type SubscriptionRow } from "../api";
import { ActionButton } from "./action";

function GrantOverride({ organizationId, catalog }: { organizationId: string; catalog: CommercialDetail["entitlementCatalog"] }) {
  const client = useQueryClient();
  const [entitlement, setEntitlement] = useState(catalog[0]?.code ?? "");
  const [enabled, setEnabled] = useState(true);
  const [expiresAt, setExpiresAt] = useState("");
  const [reason, setReason] = useState("");
  const grant = useMutation({
    mutationFn: () => adminPost(`/api/admin/commercial/subscriptions/${encodeURIComponent(organizationId)}/overrides`, { entitlement, enabled, reason, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null }),
    onSuccess: async () => { setReason(""); await client.invalidateQueries({ queryKey: ["admin-commercial", organizationId] }); },
  });
  const submit = (event: FormEvent) => { event.preventDefault(); grant.mutate(); };
  return <form className="mt-4 flex flex-wrap items-end gap-3 text-sm" onSubmit={submit}>
    <label>Entitlement<select value={entitlement} onChange={(event) => setEntitlement(event.target.value)} className="mt-1 block rounded border border-border px-2 py-1">
      {catalog.map((item) => <option key={item.code} value={item.code}>{item.code}</option>)}
    </select></label>
    <label>Decision<select value={enabled ? "grant" : "deny"} onChange={(event) => setEnabled(event.target.value === "grant")} className="mt-1 block rounded border border-border px-2 py-1">
      <option value="grant">Grant</option><option value="deny">Deny</option>
    </select></label>
    <label>Expires (optional)<input type="date" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} className="mt-1 block rounded border border-border px-2 py-1" /></label>
    <label className="flex-1">Reason (internal, audited)<input required maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} className="mt-1 block w-full rounded border border-border px-2 py-1" /></label>
    <button type="submit" disabled={grant.isPending} className="rounded bg-primary px-3 py-1.5 text-white">Apply override</button>
    {grant.error && <p role="alert" className="w-full text-destructive">{grant.error.message}</p>}
  </form>;
}

function Detail({ organizationId, canManage }: { organizationId: string; canManage: boolean }) {
  const detail = useQuery({ queryKey: ["admin-commercial", organizationId], queryFn: () => adminApi<CommercialDetail>(`/api/admin/commercial/subscriptions/${encodeURIComponent(organizationId)}`) });
  if (detail.error) return <p role="alert" className="text-destructive">{detail.error.message}</p>;
  if (!detail.data) return <p>Loading…</p>;
  const { subscription, planEntitlements, overrides, entitlementCatalog } = detail.data;
  return <div className="mt-6 rounded-xl border border-border bg-surface p-4">
    <p className="text-sm">{subscription ? <>Plan <strong>{subscription.plan}@{subscription.planVersion}</strong> · {subscription.status} · {subscription.provider}{subscription.cancelAtPeriodEnd ? " · cancels at period end" : ""}</> : "No subscription"}</p>
    <p className="mt-1 text-sm text-muted">Plan entitlements: {planEntitlements.length ? planEntitlements.join(", ") : "none"}</p>
    <h3 className="mt-4 font-semibold">Overrides</h3>
    <p className="text-xs text-muted">Customers see only that an entitlement comes from their contract. Reasons and authors stay internal.</p>
    {overrides.length === 0 ? <p className="mt-2 text-sm text-muted">No overrides.</p>
      : <table className="mt-2 w-full text-left text-sm">
        <thead><tr className="text-muted"><th className="py-2">Entitlement</th><th>Decision</th><th>Reason</th><th>Author</th><th>Effective</th><th>Expires</th><th>Status</th><th /></tr></thead>
        <tbody>{overrides.map((override) => <tr key={`${override.entitlement}-${override.effectiveAt}`} className="border-t border-border">
          <td className="py-2"><code className="text-xs">{override.entitlement}</code></td><td>{override.enabled ? "Grant" : "Deny"}</td><td>{override.reason}</td><td>{override.authorId}</td>
          <td>{new Date(override.effectiveAt).toLocaleDateString()}</td><td>{override.expiresAt ? new Date(override.expiresAt).toLocaleDateString() : "—"}</td>
          <td>{override.removedAt ? `Removed: ${override.removalReason}` : "Active"}</td>
          <td>{!override.removedAt && <ActionButton label="Revoke" path={`/api/admin/commercial/subscriptions/${encodeURIComponent(organizationId)}/overrides/${encodeURIComponent(override.entitlement)}/revoke`} invalidate="admin-commercial" allowed={canManage} />}</td>
        </tr>)}</tbody>
      </table>}
    {canManage && <GrantOverride organizationId={organizationId} catalog={entitlementCatalog} />}
  </div>;
}

export function SubscriptionsView() {
  const session = useQuery({ queryKey: ["admin-session"], queryFn: () => adminApi<AdminSession>("/api/admin/session") });
  const list = useQuery({ queryKey: ["admin-subscriptions"], queryFn: () => adminApi<{ subscriptions: SubscriptionRow[] }>("/api/admin/commercial/subscriptions") });
  const [selected, setSelected] = useState<string>();
  if (list.error) return <p role="alert" className="text-destructive">{list.error.message}</p>;
  if (!list.data) return <p>Loading…</p>;
  const canManage = Boolean(session.data?.permissions.includes("platform.entitlements.manage"));
  return <section>
    <h1 className="text-2xl font-semibold">Subscriptions</h1>
    <p className="mt-1 text-sm text-muted">Plans come from the billing provider's projection. Overrides are the only commercial change made here.</p>
    <table className="mt-6 w-full text-left text-sm">
      <thead><tr className="text-muted"><th className="py-2">Organization</th><th>Plan</th><th>Status</th><th>Period ends</th><th /></tr></thead>
      <tbody>{list.data.subscriptions.map((row) => <tr key={row.organizationId} className="border-t border-border">
        <td className="py-2">{row.organizationName}</td><td>{row.plan ? `${row.plan}@${row.planVersion}` : "—"}</td><td>{row.status ?? "none"}</td>
        <td>{row.currentPeriodEnd ? new Date(row.currentPeriodEnd).toLocaleDateString() : "—"}</td>
        <td><button type="button" className="text-sm text-primary underline" onClick={() => setSelected(row.organizationId)}>Details</button></td>
      </tr>)}</tbody>
    </table>
    {selected && <Detail organizationId={selected} canManage={canManage} />}
  </section>;
}
