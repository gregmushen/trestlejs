import { api } from "../../api";
import { useAdminQuery } from "../../shell/context";
import { Grid } from "../../shell/kumo";
import { AdminPageHeader, AdminQueryState, AdminSection, AdminStat, formatBytes } from "../../shell/ui";

const states = ["pending", "ready", "cleaning", "deleted"] as const;

/**
 * Upload lifecycle totals across tenants. The platform role reads lifecycle
 * metadata only, never storage keys, contents, or signed URLs; per-tenant
 * artifacts stay in the customer application.
 */
export default function ArtifactsView() {
  const totals = useAdminQuery(["artifact-totals"], api.artifactTotals, { refetchInterval: 30_000 });
  return <>
    <AdminPageHeader title="Artifacts" description="Upload lifecycle across tenants. Contents, storage keys, and signed URLs are never available here; the maintenance job cleans up stale uploads." />
    <AdminQueryState query={totals}>{(data) => <>
      <Grid variant="4up" gap="base" className="mb-6">
        {states.map((state) => <AdminStat key={state} label={state} value={data.states[state].count} variant={state === "ready" ? "success" : "neutral"} />)}
      </Grid>
      <AdminSection title="Storage by state">
        <dl className="grid gap-3 text-sm sm:grid-cols-4">{states.map((state) => <div key={state}><dt className="text-kumo-subtle">{state}</dt><dd className="font-medium">{formatBytes(data.states[state].bytes)}</dd></div>)}</dl>
      </AdminSection>
      <AdminSection title="Stale uploads" description="Pending for more than a day. The artifact maintenance job removes these.">
        <AdminStat label="Stale pending" value={data.stalePending} variant={data.stalePending ? "warning" : "success"} />
      </AdminSection>
    </>}</AdminQueryState>
  </>;
}
