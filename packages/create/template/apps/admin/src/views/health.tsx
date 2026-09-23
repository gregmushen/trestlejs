import { useQuery } from "@tanstack/react-query";

import { adminApi, type Health } from "../api";

const stateLabel = { configured: "Configured", not_configured: "Not configured", unknown: "Unknown" } as const;

export function HealthView() {
  const health = useQuery({ queryKey: ["admin-health"], queryFn: () => adminApi<Health>("/api/admin/health") });
  if (health.error) return <p role="alert" className="text-destructive">{health.error.message}</p>;
  if (!health.data) return <p>Loading…</p>;
  const { platformDatabase, application, environment } = health.data;
  return <section>
    <h1 className="text-2xl font-semibold">Health</h1>
    <p className="mt-1 text-sm text-muted">Environment: {environment}. Only configuration state is shown; credential values never leave their environment.</p>
    <ul className="mt-6 space-y-2 text-sm">
      <li>Platform database: {platformDatabase.reachable ? "reachable" : "unreachable"}{!platformDatabase.distinctLogin && environment !== "local" ? " (no distinct admin login configured)" : ""}</li>
      <li>Application Worker: {application.reachable ? "reachable" : "unreachable"}</li>
    </ul>
    <table className="mt-6 w-full text-left text-sm">
      <thead><tr className="text-muted"><th className="py-2">Capability</th><th>State</th><th>Mode</th><th>Setup</th></tr></thead>
      <tbody>{application.capabilities.map((capability) => <tr key={capability.id} className="border-t border-border">
        <td className="py-2">{capability.label}</td><td>{stateLabel[capability.state]}</td><td>{capability.mode ?? "—"}</td>
        <td>{capability.repair ? <code className="text-xs">{capability.repair}</code> : "—"}</td>
      </tr>)}</tbody>
    </table>
  </section>;
}
