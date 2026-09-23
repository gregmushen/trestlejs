import { useQuery } from "@tanstack/react-query";

import { adminApi, type Overview } from "../api";

export function OverviewView() {
  const overview = useQuery({ queryKey: ["admin-overview"], queryFn: () => adminApi<Overview>("/api/admin/overview") });
  if (overview.error) return <p role="alert" className="text-destructive">{overview.error.message}</p>;
  if (!overview.data) return <p>Loading…</p>;
  const stats: Array<[string, number]> = [["Organizations", overview.data.organizations], ["Users", overview.data.users], ["Platform operators", overview.data.operators]];
  return <section>
    <h1 className="text-2xl font-semibold">Overview</h1>
    <dl className="mt-6 grid gap-4 sm:grid-cols-3">
      {stats.map(([label, value]) => <div key={label} className="rounded-xl border border-border bg-surface p-4"><dt className="text-sm text-muted">{label}</dt><dd className="mt-1 text-2xl font-semibold">{value}</dd></div>)}
    </dl>
    <h2 className="mt-8 text-lg font-semibold">Recent audit events</h2>
    {overview.data.recentAudit.length === 0 ? <p className="mt-2 text-sm text-muted">No audit events yet.</p>
      : <table className="mt-2 w-full text-left text-sm">
        <thead><tr className="text-muted"><th className="py-2">Event</th><th>Actor</th><th>Organization</th><th>Outcome</th><th>When</th></tr></thead>
        <tbody>{overview.data.recentAudit.map((event) => <tr key={`${event.correlationId}-${event.name}-${event.occurredAt}`} className="border-t border-border">
          <td className="py-2"><code className="text-xs">{event.name}</code></td><td>{event.actorType}</td><td>{event.organizationId ?? "platform"}</td><td>{event.outcome}</td><td>{new Date(event.occurredAt).toLocaleString()}</td>
        </tr>)}</tbody>
      </table>}
  </section>;
}
