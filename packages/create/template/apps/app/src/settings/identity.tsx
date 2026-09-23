import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { formatDate, tenantApi, tenantKey, useTenantAccess } from "./api";

type Connection = { id: string; provider: "better_auth" | "workos"; kind: "sso" | "directory"; externalId: string; domain: string | null; state: string; lastEventAt: string | null; lastError: string | null; createdAt: string };
type Mapping = { id: string; provider: "better_auth_scim" | "workos"; connectionId: string; externalGroupId: string; targetPlane: "organization" | "application"; targetRole: string; createdAt: string };
type IdentityStatus = {
  capabilities: { sso: "disabled" | "better-auth" | "workos"; directory: "disabled" | "better-auth-scim" | "workos" };
  readiness: { sso: string | null; directory: string | null };
  scimBaseUrl: string;
  ssoCallbackUrl: string | null;
  ssoProviders: Array<{ providerId: string; issuer: string; domain: string; domainVerified: boolean }>;
  scim: Array<{ connectionId: string; status: string; createdAt: string; credentials: Array<{ credentialId: string; status: string; expiresAt: string; lastUsedAt: string | null }> }>;
  groups: Array<{ id: string; connectionId: string; name: string }>;
  connections: Connection[];
  mappings: Mapping[];
  events: Array<{ id: string; provider: string; type: string; outcome: string; receivedAt: string }>;
  roles: { organization: string[]; application: string[] };
};
type Registered = { providerId: string; callbackUrl: string; domainVerification: { recordName: string; recordValue: string } | null };
type Issued = { connectionId?: string; token: string; expiresAt: string; baseUrl?: string };

const input = "mt-1 w-full rounded-lg border px-3 py-2";

/** A SCIM bearer token, shown once. Only its status and expiry are ever shown again. */
function OneTimeToken({ issued, baseUrl, onDismiss }: { issued: Issued; baseUrl: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  return <div role="alert" className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4">
    <p className="font-semibold">Copy this SCIM token now. It will not be shown again.</p>
    <p className="mt-2 text-sm">Base URL <code className="break-all">{issued.baseUrl ?? baseUrl}</code></p>
    <code className="mt-2 block break-all rounded-lg bg-white px-3 py-2 font-mono text-sm">{issued.token}</code>
    <p className="mt-2 text-xs text-slate-600">Enter both in your identity provider's SCIM provisioning settings. Expires {formatDate(issued.expiresAt)}.</p>
    <div className="mt-3 flex gap-3"><button className="button" onClick={async () => { await navigator.clipboard.writeText(issued.token); setCopied(true); }}>{copied ? "Copied" : "Copy token"}</button><button className="text-sm font-semibold text-slate-600" onClick={onDismiss}>I have stored it</button></div>
  </div>;
}

function Readiness({ message }: { message: string | null }) {
  return message ? <p role="status" className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{message}</p> : null;
}

/** Settings -> Identity: enterprise SSO, directory provisioning, and group-to-role mappings (docs/INTEGRATION_STRATEGY.md §5). */
export function IdentitySettings() {
  const access = useTenantAccess();
  const organizationId = access.data?.organizationId;
  const permissions = access.data?.permissions ?? [];
  const canManage = permissions.includes("organization.identity.manage");
  const client = useQueryClient();
  const key = tenantKey(organizationId, "identity");
  const status = useQuery({ queryKey: key, enabled: Boolean(organizationId) && permissions.includes("organization.identity.read"), queryFn: () => tenantApi<IdentityStatus>("/api/tenant/identity"), retry: false });
  const refresh = () => void client.invalidateQueries({ queryKey: key });
  const [error, setError] = useState<string>();
  const [issued, setIssued] = useState<Issued>();
  const [registered, setRegistered] = useState<Registered>();
  const [sso, setSso] = useState({ providerId: "", issuer: "", domain: "", clientId: "", clientSecret: "", discoveryEndpoint: "" });
  const [workosOrganization, setWorkosOrganization] = useState("");
  const [workosDirectory, setWorkosDirectory] = useState("");
  const [mapping, setMapping] = useState({ connectionId: "", externalGroupId: "", targetPlane: "application" as "organization" | "application", targetRole: "" });

  const act = <T, V = void>(work: (variables: V) => Promise<T>, done?: (result: T) => void) => ({ mutationFn: work, onSuccess: (result: T) => { setError(undefined); done?.(result); refresh(); }, onError: (failure: Error) => setError(failure.message) });
  const register = useMutation(act(() => tenantApi<Registered>("/api/tenant/identity/sso", { method: "POST", body: { ...sso, ...(sso.discoveryEndpoint ? {} : { discoveryEndpoint: undefined }) } }), (result) => { setRegistered(result); setSso({ providerId: "", issuer: "", domain: "", clientId: "", clientSecret: "", discoveryEndpoint: "" }); }));
  const verifyDomain = useMutation(act((providerId: string) => tenantApi(`/api/tenant/identity/sso/${encodeURIComponent(providerId)}/verify-domain`, { method: "POST" })));
  const removeProvider = useMutation(act((providerId: string) => tenantApi(`/api/tenant/identity/sso/${encodeURIComponent(providerId)}`, { method: "DELETE" })));
  const bindOrganization = useMutation(act(() => tenantApi("/api/tenant/identity/workos/organization", { method: "POST", body: { organizationId: workosOrganization.trim() } }), () => setWorkosOrganization("")));
  const bindDirectory = useMutation(act(() => tenantApi("/api/tenant/identity/workos/directory", { method: "POST", body: { directoryId: workosDirectory.trim() } }), () => setWorkosDirectory("")));
  const unbind = useMutation(act((connection: Connection) => tenantApi(`/api/tenant/identity/workos/${connection.kind}/${encodeURIComponent(connection.externalId)}`, { method: "DELETE" })));
  const createScim = useMutation(act(() => tenantApi<Issued>("/api/tenant/identity/scim", { method: "POST" }), setIssued));
  const rotateScim = useMutation(act((connectionId: string) => tenantApi<Issued>(`/api/tenant/identity/scim/${encodeURIComponent(connectionId)}/rotate`, { method: "POST" }), setIssued));
  const decommission = useMutation(act((connectionId: string) => tenantApi(`/api/tenant/identity/scim/${encodeURIComponent(connectionId)}/decommission`, { method: "POST" })));
  const addMapping = useMutation(act(() => tenantApi("/api/tenant/identity/mappings", { method: "POST", body: { provider: status.data?.capabilities.directory === "workos" ? "workos" : "better_auth_scim", ...mapping } }), () => setMapping({ ...mapping, externalGroupId: "", targetRole: "" })));
  const removeMapping = useMutation(act((id: string) => tenantApi(`/api/tenant/identity/mappings/${encodeURIComponent(id)}`, { method: "DELETE" })));

  if (access.error) return <section className="card p-8"><p className="text-red-700">{access.error.message}</p></section>;
  if (access.data && !permissions.includes("organization.identity.read")) return <section className="card p-8"><h1 className="text-2xl font-semibold">Identity</h1><p className="mt-2 text-slate-600">Your organization role does not include identity settings. Ask an owner or administrator.</p></section>;
  if (status.error) return <section className="card p-8"><h1 className="text-2xl font-semibold">Identity</h1><p className="mt-2 text-slate-600">{status.error.message}</p></section>;
  const data = status.data;
  if (!data) return <section className="card p-8"><p className="text-slate-500">Loading identity settings…</p></section>;
  const directoryConnections = data.connections.filter((connection) => connection.kind === "directory");
  const groupsFor = data.groups.filter((group) => group.connectionId === mapping.connectionId);
  const roleOptions = mapping.targetPlane === "organization" ? data.roles.organization : data.roles.application;
  const local = ["localhost", "127.0.0.1"].includes(window.location.hostname);

  return <section className="space-y-6">
    <div className="card p-8">
      <p className="eyebrow">Security</p>
      <h1 className="mt-2 text-3xl font-semibold">Identity</h1>
      <p className="mt-2 text-slate-600">Let people sign in with your identity provider and keep membership in sync with your directory. Directory groups can grant organization and application roles; they never grant platform access, and removing a group removes only the roles it granted.</p>
      {error && <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {issued && <OneTimeToken issued={issued} baseUrl={data.scimBaseUrl} onDismiss={() => setIssued(undefined)} />}
    </div>

    {data.capabilities.sso !== "disabled" && <div className="card p-8" aria-labelledby="sso-heading">
      <h2 id="sso-heading" className="text-xl font-semibold">Single sign-on</h2>
      <p className="mt-1 text-sm text-slate-600">{data.capabilities.sso === "workos" ? "Through WorkOS. Only domains WorkOS has verified route sign-in to this organization." : "OpenID Connect with your identity provider. Sign-in is routed by email domain."}</p>
      <Readiness message={data.readiness.sso} />
      {data.capabilities.sso === "better-auth" && <>
        <table className="mt-4 w-full text-left text-sm">
          <thead><tr className="text-slate-500"><th className="py-2">Provider</th><th>Domain</th><th>Issuer</th><th>Domain</th><th /></tr></thead>
          <tbody>{data.ssoProviders.map((provider) => <tr key={provider.providerId} className="border-t border-slate-100">
            <td className="py-2 font-medium">{provider.providerId}</td><td>{provider.domain}</td><td className="break-all text-xs text-slate-500">{provider.issuer}</td>
            <td>{provider.domainVerified ? <span className="text-emerald-700">verified</span> : canManage ? <button className="text-sm font-semibold text-brand-500" onClick={() => verifyDomain.mutate(provider.providerId)}>Verify domain</button> : "unverified"}</td>
            <td className="text-right">{canManage && <button className="text-sm font-semibold text-red-700" onClick={() => removeProvider.mutate(provider.providerId)}>Remove</button>}</td>
          </tr>)}</tbody>
        </table>
        {data.ssoProviders.length === 0 && <p className="mt-3 text-sm text-slate-600">No identity provider yet.</p>}
        {registered && <div role="status" className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm">
          <p className="font-semibold">Registered {registered.providerId}.</p>
          <p className="mt-1">Redirect URI for your identity provider: <code className="break-all">{registered.callbackUrl}</code></p>
          {registered.domainVerification && <p className="mt-1">Prove the domain with a DNS TXT record <code className="break-all">{registered.domainVerification.recordName}</code> = <code className="break-all">{registered.domainVerification.recordValue}</code>, then choose Verify domain.</p>}
        </div>}
        {canManage && <form className="mt-6 grid gap-3 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); register.mutate(); }}>
          <label className="block text-sm font-medium">Provider ID<input className={input} required placeholder="acme-okta" value={sso.providerId} onChange={(event) => setSso({ ...sso, providerId: event.target.value })} /></label>
          <label className="block text-sm font-medium">Email domain<input className={input} required placeholder="acme.com" value={sso.domain} onChange={(event) => setSso({ ...sso, domain: event.target.value.toLowerCase() })} /></label>
          <label className="block text-sm font-medium sm:col-span-2">Issuer URL<input className={input} required type="url" placeholder="https://acme.okta.com" value={sso.issuer} onChange={(event) => setSso({ ...sso, issuer: event.target.value })} /></label>
          <label className="block text-sm font-medium">Client ID<input className={input} required value={sso.clientId} onChange={(event) => setSso({ ...sso, clientId: event.target.value })} /></label>
          <label className="block text-sm font-medium">Client secret<input className={input} required type="password" autoComplete="off" value={sso.clientSecret} onChange={(event) => setSso({ ...sso, clientSecret: event.target.value })} /></label>
          <label className="block text-sm font-medium sm:col-span-2">Discovery URL <span className="font-normal text-slate-500">(optional)</span><input className={input} type="url" placeholder="https://acme.okta.com/.well-known/openid-configuration" value={sso.discoveryEndpoint} onChange={(event) => setSso({ ...sso, discoveryEndpoint: event.target.value })} /></label>
          <p className="text-xs text-slate-500 sm:col-span-2">The client secret goes to the identity service and is never shown again.{local ? " Locally, domains are trusted without DNS proof." : ""}</p>
          <div className="sm:col-span-2"><button className="button" type="submit" disabled={register.isPending}>Add identity provider</button></div>
        </form>}
      </>}
      {data.capabilities.sso === "workos" && <>
        <ul className="mt-4 space-y-2 text-sm">{data.connections.filter((connection) => connection.provider === "workos" && connection.kind === "sso").map((connection) => <li key={connection.id} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
          <span><code>{connection.externalId}</code> · {connection.domain} · {connection.state}</span>
          {canManage && <button className="text-sm font-semibold text-red-700" onClick={() => unbind.mutate(connection)}>Unbind</button>}
        </li>)}</ul>
        {data.ssoCallbackUrl && <p className="mt-3 text-xs text-slate-500">Redirect URI in WorkOS: <code className="break-all">{data.ssoCallbackUrl}</code></p>}
        {canManage && <form className="mt-4 flex gap-3" onSubmit={(event) => { event.preventDefault(); bindOrganization.mutate(); }}>
          <label className="block flex-1 text-sm font-medium">WorkOS organization ID<input className={input} required placeholder="org_01H…" value={workosOrganization} onChange={(event) => setWorkosOrganization(event.target.value)} /></label>
          <button className="button self-end" type="submit" disabled={bindOrganization.isPending}>Bind</button>
        </form>}
      </>}
    </div>}

    {data.capabilities.directory !== "disabled" && <div className="card p-8" aria-labelledby="directory-heading">
      <h2 id="directory-heading" className="text-xl font-semibold">Directory provisioning</h2>
      <p className="mt-1 text-sm text-slate-600">{data.capabilities.directory === "workos" ? "WorkOS Directory Sync sends user and group changes to this application." : "Your identity provider creates, updates, and deactivates members through SCIM 2.0."}</p>
      <Readiness message={data.readiness.directory} />
      {data.capabilities.directory === "better-auth-scim" && <>
        <table className="mt-4 w-full text-left text-sm">
          <thead><tr className="text-slate-500"><th className="py-2">Connection</th><th>Status</th><th>Credential</th><th>Last used</th><th /></tr></thead>
          <tbody>{data.scim.map((connection) => {
            const credential = connection.credentials.find((candidate) => candidate.status === "active") ?? connection.credentials[0];
            return <tr key={connection.connectionId} className="border-t border-slate-100">
              <td className="py-2 font-mono text-xs">{connection.connectionId}</td><td>{connection.status}</td>
              <td>{credential ? `${credential.status}, expires ${formatDate(credential.expiresAt)}` : "none"}</td><td>{formatDate(credential?.lastUsedAt)}</td>
              <td className="space-x-3 text-right">{canManage && connection.status === "active" && <><button className="text-sm font-semibold text-brand-500" onClick={() => rotateScim.mutate(connection.connectionId)}>Rotate token</button><button className="text-sm font-semibold text-red-700" onClick={() => decommission.mutate(connection.connectionId)}>Decommission</button></>}</td>
            </tr>;
          })}</tbody>
        </table>
        {data.scim.length === 0 && <p className="mt-3 text-sm text-slate-600">No SCIM connection yet.</p>}
        {canManage && <button className="button mt-4" disabled={createScim.isPending || Boolean(data.readiness.directory)} onClick={() => createScim.mutate()}>Create SCIM connection</button>}
      </>}
      {data.capabilities.directory === "workos" && <>
        <ul className="mt-4 space-y-2 text-sm">{directoryConnections.map((connection) => <li key={connection.id} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
          <span><code>{connection.externalId}</code> · {connection.state} · last event {formatDate(connection.lastEventAt)}{connection.lastError ? ` · ${connection.lastError}` : ""}</span>
          {canManage && <button className="text-sm font-semibold text-red-700" onClick={() => unbind.mutate(connection)}>Unbind</button>}
        </li>)}</ul>
        {canManage && <form className="mt-4 flex gap-3" onSubmit={(event) => { event.preventDefault(); bindDirectory.mutate(); }}>
          <label className="block flex-1 text-sm font-medium">WorkOS directory ID<input className={input} required placeholder="directory_01H…" value={workosDirectory} onChange={(event) => setWorkosDirectory(event.target.value)} /></label>
          <button className="button self-end" type="submit" disabled={bindDirectory.isPending}>Bind</button>
        </form>}
        <h3 className="mt-6 text-sm font-semibold">Recent directory events</h3>
        <ul className="mt-2 space-y-1 text-xs text-slate-600">{data.events.map((event) => <li key={event.id}>{formatDate(event.receivedAt)} · {event.type} · {event.outcome}</li>)}</ul>
        {data.events.length === 0 && <p className="mt-1 text-xs text-slate-500">None yet.</p>}
      </>}

      <h3 className="mt-8 text-lg font-semibold">Group mappings</h3>
      <p className="mt-1 text-sm text-slate-600">Members of a mapped group receive the role. Changes apply on the directory's next update for each member.</p>
      <table className="mt-3 w-full text-left text-sm">
        <thead><tr className="text-slate-500"><th className="py-2">Group</th><th>Grants</th><th>Connection</th><th /></tr></thead>
        <tbody>{data.mappings.map((entry) => <tr key={entry.id} className="border-t border-slate-100">
          <td className="py-2">{data.groups.find((group) => group.id === entry.externalGroupId)?.name ?? <code>{entry.externalGroupId}</code>}</td>
          <td>{entry.targetPlane} · <strong>{entry.targetRole}</strong></td><td className="font-mono text-xs">{entry.connectionId}</td>
          <td className="text-right">{canManage && <button className="text-sm font-semibold text-red-700" onClick={() => removeMapping.mutate(entry.id)}>Remove</button>}</td>
        </tr>)}</tbody>
      </table>
      {data.mappings.length === 0 && <p className="mt-2 text-sm text-slate-600">No mappings. Provisioned members join with the member role.</p>}
      {canManage && directoryConnections.length > 0 && <form className="mt-4 grid gap-3 sm:grid-cols-4" onSubmit={(event) => { event.preventDefault(); addMapping.mutate(); }}>
        <label className="block text-sm font-medium">Connection<select className={input} required value={mapping.connectionId} onChange={(event) => setMapping({ ...mapping, connectionId: event.target.value, externalGroupId: "" })}><option value="">Choose…</option>{directoryConnections.map((connection) => <option key={connection.id} value={connection.externalId}>{connection.externalId}</option>)}</select></label>
        <label className="block text-sm font-medium">Group{groupsFor.length > 0
          ? <select className={input} required value={mapping.externalGroupId} onChange={(event) => setMapping({ ...mapping, externalGroupId: event.target.value })}><option value="">Choose…</option>{groupsFor.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select>
          : <input className={input} required placeholder="Group ID" value={mapping.externalGroupId} onChange={(event) => setMapping({ ...mapping, externalGroupId: event.target.value })} />}</label>
        <label className="block text-sm font-medium">Plane<select className={input} value={mapping.targetPlane} onChange={(event) => setMapping({ ...mapping, targetPlane: event.target.value as "organization" | "application", targetRole: "" })}><option value="application">Application</option><option value="organization">Organization</option></select></label>
        <label className="block text-sm font-medium">Role<select className={input} required value={mapping.targetRole} onChange={(event) => setMapping({ ...mapping, targetRole: event.target.value })}><option value="">Choose…</option>{roleOptions.map((role) => <option key={role} value={role}>{role}</option>)}</select></label>
        <div className="sm:col-span-4"><button className="button" type="submit" disabled={addMapping.isPending}>Add mapping</button></div>
      </form>}
    </div>}

    {data.capabilities.sso === "disabled" && data.capabilities.directory === "disabled" && <div className="card p-8"><p className="text-slate-600">Enterprise identity is not enabled. Declare it in <code>.trestle/project.yaml</code> with <code>pnpm exec trestle setup</code>.</p></div>}
  </section>;
}
