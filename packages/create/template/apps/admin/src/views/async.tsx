import { useQuery } from "@tanstack/react-query";

import { adminApi, type AdminSession, type DeadOutboxEvent } from "../api";
import { ActionButton } from "./action";

export function AsyncView() {
  const session = useQuery({ queryKey: ["admin-session"], queryFn: () => adminApi<AdminSession>("/api/admin/session") });
  const outbox = useQuery({ queryKey: ["admin-outbox"], queryFn: () => adminApi<{ dead: DeadOutboxEvent[] }>("/api/admin/operations/outbox") });
  if (outbox.error) return <p role="alert" className="text-destructive">{outbox.error.message}</p>;
  if (!outbox.data) return <p>Loading…</p>;
  const canRedrive = Boolean(session.data?.permissions.includes("platform.outbox.redrive"));
  return <section>
    <h1 className="text-2xl font-semibold">Async events</h1>
    <p className="mt-1 text-sm text-muted">Dead-lettered outbox events. Redrive returns an event to delivery. Payloads are never shown.</p>
    {outbox.data.dead.length === 0 ? <p className="mt-6 text-sm text-muted">No dead-lettered events.</p>
      : <table className="mt-6 w-full text-left text-sm">
        <thead><tr className="text-muted"><th className="py-2">Event</th><th>Organization</th><th>Attempts</th><th>Last error</th><th>Created</th><th /></tr></thead>
        <tbody>{outbox.data.dead.map((event) => <tr key={event.id} className="border-t border-border">
          <td className="py-2"><code className="text-xs">{event.eventName}</code></td><td>{event.organizationId ?? "—"}</td><td>{event.attempts}</td><td>{event.lastError ?? "—"}</td>
          <td>{new Date(event.createdAt).toLocaleString()}</td>
          <td><ActionButton label="Redrive" path={`/api/admin/operations/outbox/${encodeURIComponent(event.id)}/redrive`} invalidate="admin-outbox" allowed={canRedrive} /></td>
        </tr>)}</tbody>
      </table>}
  </section>;
}
