import { useQuery } from "@tanstack/react-query";

import { adminApi, type AdminSession, type PlatformApiKey } from "../api";
import { ActionButton } from "./action";

export function MachineAccessView() {
  const session = useQuery({ queryKey: ["admin-session"], queryFn: () => adminApi<AdminSession>("/api/admin/session") });
  const keys = useQuery({ queryKey: ["admin-api-keys"], queryFn: () => adminApi<{ keys: PlatformApiKey[] }>("/api/admin/security/api-keys") });
  if (keys.error) return <p role="alert" className="text-destructive">{keys.error.message}</p>;
  if (!keys.data) return <p>Loading…</p>;
  const canRevoke = Boolean(session.data?.permissions.includes("platform.api_keys.revoke"));
  return <section>
    <h1 className="text-2xl font-semibold">Machine access</h1>
    <p className="mt-1 text-sm text-muted">Service-account API keys across organizations. Only public prefixes are shown; tokens and verifiers never leave the database. Organizations mint and rotate their own keys. Revoke one here only when it is compromised.</p>
    {keys.data.keys.length === 0 ? <p className="mt-6 text-sm text-muted">No API keys.</p>
      : <table className="mt-6 w-full text-left text-sm">
        <thead><tr className="text-muted"><th className="py-2">Key</th><th>Service account</th><th>Organization</th><th>Scopes</th><th>Environment</th><th>Status</th><th /></tr></thead>
        <tbody>{keys.data.keys.map((key) => {
          const expired = key.expiresAt !== null && new Date(key.expiresAt) <= new Date();
          return <tr key={key.id} className="border-t border-border">
            <td className="py-2"><code className="text-xs">{key.displayPrefix}</code><div className="text-xs text-muted">{key.name}</div></td>
            <td>{key.serviceAccountName}</td><td>{key.organizationId}</td><td className="text-xs">{key.scopes.join(", ")}</td><td>{key.environment}</td>
            <td>{key.revokedAt ? `Revoked: ${key.revocationReason}` : expired ? "Expired" : key.expiresAt ? `Active until ${new Date(key.expiresAt).toLocaleDateString()}` : "Active"}</td>
            <td>{!key.revokedAt && <ActionButton label="Revoke" path={`/api/admin/security/api-keys/${encodeURIComponent(key.organizationId)}/${encodeURIComponent(key.id)}/revoke`} invalidate="admin-api-keys" allowed={canRevoke} />}</td>
          </tr>;
        })}</tbody>
      </table>}
  </section>;
}
