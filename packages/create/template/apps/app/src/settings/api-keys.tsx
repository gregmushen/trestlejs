import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Link } from "@tanstack/react-router";

import { formatDate, TenantApiError, tenantApi, tenantKey, useTenantAccess } from "./api";

type ServiceAccount = { id: string; name: string; description: string; applicationRoles: string[]; status: "active" | "suspended"; createdAt: string; activeKeys: number };
type KeyMetadata = { id: string; displayPrefix: string; environment: string; scopes: string[]; createdAt: string; expiresAt: string | null; lastUsedAt: string | null; revokedAt: string | null; rotatedTo: string | null; allowedCidrs: string[] | null; rateLimitPerMinute: number | null };
type Minted = { key: KeyMetadata; token: string | null; replayed?: boolean };

/** Shows a newly minted secret exactly once; it is never retrievable again. */
function OneTimeSecret({ minted, onDismiss }: { minted: Minted; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  return <div role="alert" className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4">
    <p className="font-semibold">Copy this API key now. It will not be shown again.</p>
    <code className="mt-2 block break-all rounded-lg bg-white px-3 py-2 font-mono text-sm">{minted.token ?? ""}</code>
    <div className="mt-3 flex gap-3"><button className="button" onClick={async () => { await navigator.clipboard.writeText(minted.token ?? ""); setCopied(true); }}>{copied ? "Copied" : "Copy"}</button><button className="text-sm font-semibold text-slate-600" onClick={onDismiss}>I have stored it</button></div>
  </div>;
}

function Keys({ organizationId, account, canManage, scopes }: { organizationId: string | undefined; account: ServiceAccount; canManage: boolean; scopes: string[] }) {
  const client = useQueryClient();
  const queryKey = tenantKey(organizationId, "service-accounts", account.id, "keys");
  const keys = useQuery({ queryKey, enabled: Boolean(organizationId), queryFn: () => tenantApi<{ keys: KeyMetadata[] }>(`/api/tenant/service-accounts/${encodeURIComponent(account.id)}/keys`) });
  const [selected, setSelected] = useState<string[]>([]);
  const [minted, setMinted] = useState<Minted>();
  const [error, setError] = useState<string>();
  const refresh = () => { void client.invalidateQueries({ queryKey }); void client.invalidateQueries({ queryKey: tenantKey(organizationId, "service-accounts") }); };
  // One request identifier per intended key: a retried submit returns the same key, never a second secret.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const mint = useMutation({ mutationFn: () => tenantApi<Minted>(`/api/tenant/service-accounts/${encodeURIComponent(account.id)}/keys`, { method: "POST", body: { scopes: selected, idempotencyKey: requestId } }), onSuccess: (result) => { if (result.token) setMinted(result); else setError("This key was already created; its secret was shown at the time."); setSelected([]); setRequestId(crypto.randomUUID()); refresh(); }, onError: (failure) => setError(failure.message) });
  const rotate = useMutation({ mutationFn: (id: string) => tenantApi<Minted>(`/api/tenant/api-keys/${encodeURIComponent(id)}/rotate`, { method: "POST", body: { overlapHours: 24 } }), onSuccess: (result) => { setMinted(result); refresh(); }, onError: (failure) => setError(failure.message) });
  const revoke = useMutation({ mutationFn: (id: string) => tenantApi(`/api/tenant/api-keys/${encodeURIComponent(id)}/revoke`, { method: "POST", body: { reason: "Revoked from organization settings" } }), onSuccess: refresh, onError: (failure) => setError(failure.message) });
  return <div className="mt-4">
    {minted && <OneTimeSecret minted={minted} onDismiss={() => setMinted(undefined)} />}
    <table className="mt-3 w-full text-left text-sm">
      <thead><tr className="text-slate-500"><th className="py-2">Key</th><th>Scopes</th><th>Last used</th><th>Status</th><th /></tr></thead>
      <tbody>{keys.data?.keys.map((key) => {
        const status = key.revokedAt ? "revoked" : key.expiresAt && new Date(key.expiresAt) < new Date() ? "expired" : key.rotatedTo ? `rotating until ${formatDate(key.expiresAt)}` : "active";
        return <tr key={key.id} className="border-t border-slate-100">
          <td className="py-2 font-mono">{key.displayPrefix}…</td><td>{key.scopes.join(", ")}</td><td>{formatDate(key.lastUsedAt)}</td><td>{status}</td>
          <td className="space-x-3 text-right">{canManage && !key.revokedAt && !key.rotatedTo && <><button className="text-brand-500" onClick={() => rotate.mutate(key.id)}>Rotate</button><button className="text-red-600" onClick={() => revoke.mutate(key.id)}>Revoke</button></>}</td>
        </tr>;
      })}</tbody>
    </table>
    {canManage && account.status === "active" && <form className="mt-4 space-y-2" onSubmit={(event) => { event.preventDefault(); mint.mutate(); }}>
      <p className="text-sm font-semibold">Mint a key with these scopes</p>
      <div className="flex flex-wrap gap-2">{scopes.map((scope) => <label key={scope} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={selected.includes(scope)} onChange={(event) => setSelected(event.target.checked ? [...selected, scope] : selected.filter((code) => code !== scope))} />{scope}</label>)}</div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <button className="button" disabled={selected.length === 0 || mint.isPending} type="submit">Mint API key</button>
    </form>}
  </div>;
}

/** Tenant-owned service accounts and scoped API keys (spec §8). */
export function ServiceAccounts() {
  const access = useTenantAccess();
  const organizationId = access.data?.organizationId;
  const client = useQueryClient();
  const canManage = (access.data?.permissions.includes("organization.service_accounts.manage") ?? false) && (access.data?.permissions.includes("application.roles.assign") ?? false);
  const canSuspend = access.data?.permissions.includes("organization.service_accounts.manage") ?? false;
  const canMint = access.data?.permissions.includes("organization.api_keys.manage") ?? false;
  const accounts = useQuery({ queryKey: tenantKey(organizationId, "service-accounts"), enabled: Boolean(organizationId), queryFn: () => tenantApi<{ serviceAccounts: ServiceAccount[]; scopes: string[]; applicationRoles: Array<{ key: string; name: string }>; limits: { maxKeys: number | null; activeKeys: number } }>("/api/tenant/service-accounts") });
  const [name, setName] = useState("");
  const [role, setRole] = useState("reader");
  const [error, setError] = useState<string>();
  const create = useMutation({ mutationFn: () => tenantApi("/api/tenant/service-accounts", { method: "POST", body: { name, applicationRoles: [role] } }), onSuccess: () => { setName(""); setError(undefined); void client.invalidateQueries({ queryKey: tenantKey(organizationId, "service-accounts") }); }, onError: (failure) => setError(failure.message) });
  const suspend = useMutation({ mutationFn: (id: string) => tenantApi(`/api/tenant/service-accounts/${encodeURIComponent(id)}/suspend`, { method: "POST", body: { reason: "Suspended from organization settings" } }), onSuccess: () => void client.invalidateQueries({ queryKey: tenantKey(organizationId, "service-accounts") }) });
  const failure = access.error ?? accounts.error;
  if (failure) {
    const missing = failure instanceof TenantApiError && failure.code === "entitlement_required" ? access.data?.capabilities.upgrades.find((upgrade) => upgrade.code === failure.entitlement) : undefined;
    return <section className="card p-8"><h1 className="text-3xl font-semibold">API access</h1>
      <p className="mt-4 text-slate-600">{missing ? `Your plan does not include ${missing.name}. It is available on ${missing.availableOn.join(" and ")}.` : failure.message}</p>
      {failure instanceof TenantApiError && failure.code === "entitlement_required" && <Link to="/settings/billing" className="button mt-4">See plans</Link>}
    </section>;
  }
  return <section className="card p-8">
    <p className="eyebrow">Machine access</p>
    <h1 className="mt-2 text-3xl font-semibold">Service accounts and API keys</h1>
    {accounts.data && <p className="mt-2 text-sm text-slate-600">{accounts.data.limits.activeKeys} of {accounts.data.limits.maxKeys ?? "unlimited"} active keys used</p>}
    {canManage && <form className="mt-6 flex gap-3" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}><input className="min-w-0 flex-1 rounded-xl border border-slate-300 px-4 py-3" placeholder="deploy-bot" value={name} onChange={(event) => setName(event.target.value)} /><select aria-label="Application role" className="rounded-xl border border-slate-300 px-3" value={role} onChange={(event) => setRole(event.target.value)}>{accounts.data?.applicationRoles.map((option) => <option key={option.key} value={option.key}>{option.name}</option>)}</select><button className="button" disabled={!name.trim()} type="submit">Create service account</button></form>}
    <p className="mt-2 text-xs text-slate-500">Service accounts hold application roles only. API-key scopes can narrow that authority but never extend it.</p>
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    <ul className="mt-6 space-y-4">{accounts.data?.serviceAccounts.map((account) => <li key={account.id} className="rounded-xl border border-slate-200 p-5">
      <div className="flex items-center justify-between"><div><p className="font-semibold">{account.name}</p><p className="text-sm text-slate-500">Application roles: {account.applicationRoles.join(", ")} · {account.status}</p></div>{canSuspend && account.status === "active" && <button className="text-sm text-red-600" onClick={() => suspend.mutate(account.id)}>Suspend</button>}</div>
      <Keys organizationId={organizationId} account={account} canManage={canMint} scopes={accounts.data.scopes} />
    </li>)}</ul>
  </section>;
}
