import { useQuery } from "@tanstack/react-query";

import { adminApi, type ArtifactOperations } from "../api";

const bytes = (value: number) => value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 ** 2).toFixed(1)} MB`;

export function ArtifactsView() {
  const artifacts = useQuery({ queryKey: ["admin-artifacts"], queryFn: () => adminApi<ArtifactOperations>("/api/admin/operations/artifacts") });
  if (artifacts.error) return <p role="alert" className="text-destructive">{artifacts.error.message}</p>;
  if (!artifacts.data) return <p>Loading…</p>;
  return <section>
    <h1 className="text-2xl font-semibold">Artifacts</h1>
    <p className="mt-1 text-sm text-muted">Upload lifecycle totals across organizations. Storage keys and contents are never shown; artifact maintenance cleans up stale uploads.</p>
    <dl className="mt-6 grid gap-4 sm:grid-cols-4">
      {(Object.entries(artifacts.data.states) as Array<[string, { count: number; bytes: number }]>).map(([state, total]) => <div key={state} className="rounded-xl border border-border bg-surface p-4">
        <dt className="text-sm capitalize text-muted">{state}</dt><dd className="mt-1 text-2xl font-semibold">{total.count}</dd><dd className="text-xs text-muted">{bytes(total.bytes)}</dd>
      </div>)}
    </dl>
    <p className="mt-6 text-sm">Pending uploads older than a day: <strong>{artifacts.data.stalePending}</strong></p>
  </section>;
}
