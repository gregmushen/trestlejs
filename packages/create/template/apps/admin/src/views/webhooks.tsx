import { useQuery } from "@tanstack/react-query";

import { adminApi, type AdminSession, type WebhookOperations } from "../api";
import { ActionButton } from "./action";

export function WebhooksView() {
  const session = useQuery({ queryKey: ["admin-session"], queryFn: () => adminApi<AdminSession>("/api/admin/session") });
  const webhooks = useQuery({ queryKey: ["admin-webhooks"], queryFn: () => adminApi<WebhookOperations>("/api/admin/operations/webhooks") });
  if (webhooks.error) return <p role="alert" className="text-destructive">{webhooks.error.message}</p>;
  if (!webhooks.data) return <p>Loading…</p>;
  const canManage = Boolean(session.data?.permissions.includes("platform.webhooks.manage"));
  const path = (organizationId: string, rest: string) => `/api/admin/operations/webhooks/${encodeURIComponent(organizationId)}/${rest}`;
  return <section>
    <h1 className="text-2xl font-semibold">Webhooks</h1>
    <p className="mt-1 text-sm text-muted">Endpoint state and failed deliveries across organizations. Destinations, secrets, and payloads are never shown.</p>
    <h2 className="mt-8 text-lg font-semibold">Failed deliveries</h2>
    {webhooks.data.failedDeliveries.length === 0 ? <p className="mt-2 text-sm text-muted">No dead or exhausted deliveries.</p>
      : <table className="mt-2 w-full text-left text-sm">
        <thead><tr className="text-muted"><th className="py-2">Event</th><th>Organization</th><th>State</th><th>Attempts</th><th>Reason</th><th /></tr></thead>
        <tbody>{webhooks.data.failedDeliveries.map((delivery) => <tr key={delivery.id} className="border-t border-border">
          <td className="py-2"><code className="text-xs">{delivery.eventType}</code></td><td>{delivery.organizationId}</td><td>{delivery.state}</td><td>{delivery.attemptCount}</td><td>{delivery.terminalReason ?? "—"}</td>
          <td>{delivery.replayable
            ? <ActionButton label="Replay" path={path(delivery.organizationId, `deliveries/${encodeURIComponent(delivery.id)}/replay`)} invalidate="admin-webhooks" allowed={canManage} />
            : <span className="text-xs text-muted">Payload expired</span>}</td>
        </tr>)}</tbody>
      </table>}
    <h2 className="mt-8 text-lg font-semibold">Endpoints</h2>
    <table className="mt-2 w-full text-left text-sm">
      <thead><tr className="text-muted"><th className="py-2">Name</th><th>Organization</th><th>Environment</th><th>State</th><th>Health</th><th /></tr></thead>
      <tbody>{webhooks.data.endpoints.map((endpoint) => <tr key={endpoint.id} className="border-t border-border">
        <td className="py-2">{endpoint.name}</td><td>{endpoint.organizationId}</td><td>{endpoint.environment}</td><td>{endpoint.state}</td><td>{endpoint.health}</td>
        <td>{endpoint.state !== "disabled" && <ActionButton label="Disable" path={path(endpoint.organizationId, `endpoints/${endpoint.id}/disable`)} invalidate="admin-webhooks" allowed={canManage} />}</td>
      </tr>)}</tbody>
    </table>
  </section>;
}
