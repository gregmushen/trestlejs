import { Link } from "@tanstack/react-router";

import { api } from "../../api";
import { useAdminQuery } from "../../shell/context";
import { Grid } from "../../shell/kumo";
import { AdminCode, AdminDataTable, AdminPageHeader, AdminQueryState, AdminSection, AdminStat, AdminStatus, formatDate } from "../../shell/ui";
import { engineComparison, engineLabel, frequentScheduleNote, hostingLabels } from "./engines";

const linkClass = "text-sm font-medium text-kumo-link underline-offset-2 hover:underline";

/**
 * The environment's job engine, where it runs, and whether dispatch is
 * keeping up. Read-only: individual runs live in the engine's own dashboard
 * (or, on Cloudflare, the async operations view), and credentials are never
 * shown here.
 */
export default function JobsView() {
  const state = useAdminQuery(["jobs"], api.jobs, { refetchInterval: 30_000 });
  return <>
    <AdminPageHeader title="Jobs" description="The engine that runs committed events and scheduled work for this environment, and how dispatch to it is keeping up." />
    <AdminQueryState query={state}>{(data) => <>
      <AdminSection title="Engine" description={data.source === "unknown" ? "The customer Worker records its engine on its next maintenance sweep." : data.source === "override" ? "Set from admin; it takes precedence over the deployed configuration." : `Declared by the deployed Worker${data.declaredAt ? ` on ${formatDate(data.declaredAt)}` : ""}.`}
        actions={data.runtime === "cloudflare" ? <Link to={"/operations/async" as never} className={linkClass}>Open async operations</Link>
          : data.dashboardUrl ? <a href={data.dashboardUrl} target="_blank" rel="noopener noreferrer" className={linkClass}>Open dashboard</a> : undefined}>
        <dl className="grid gap-3 text-sm sm:grid-cols-4">
          <div><dt className="text-kumo-subtle">Engine</dt><dd className="font-medium">{data.runtime ? engineLabel(data.runtime) : "Unknown"}</dd></div>
          <div><dt className="text-kumo-subtle">Hosting</dt><dd className="font-medium">{data.hosting ? hostingLabels[data.hosting] ?? data.hosting : "Unknown"}</dd></div>
          <div><dt className="text-kumo-subtle">Location</dt><dd className="font-medium">{data.endpoint ? <AdminCode>{data.endpoint}</AdminCode> : data.project ? <AdminCode>{data.project}</AdminCode> : data.runtime === "cloudflare" ? "Cloudflare" : "—"}</dd></div>
          <div><dt className="text-kumo-subtle">Support</dt><dd><AdminStatus variant={data.supportStatus === "supported" ? "success" : data.supportStatus === "experimental" ? "warning" : "neutral"}>{data.supportStatus}</AdminStatus> <span className="text-kumo-subtle">({data.source})</span></dd></div>
        </dl>
      </AdminSection>
      <Grid variant="3up" gap="base" className="mb-6">
        <AdminStat label="Pending" value={data.dispatch.pending} hint="Committed, not yet handed to the engine" />
        <AdminStat label="Unconsumed" value={data.dispatch.unconsumed} hint="Dispatched in the last 14 days, not completed" variant={data.dispatch.unconsumed ? "warning" : "success"} />
        <AdminStat label="Dead" value={data.dispatch.dead} variant={data.dispatch.dead ? "destructive" : "success"} />
      </Grid>
      <AdminSection title="Choosing an engine" description={frequentScheduleNote}>
        <AdminDataTable caption="Engine comparison" rows={engineComparison} rowKey={(row) => row.aspect} primary={false}
          columns={[
            { header: "", cell: (row) => <span className="font-medium">{row.aspect}</span>, nowrap: true },
            { header: "Cloudflare (default)", cell: (row) => row.cloudflare, minWidth: "12rem" },
            { header: "trigger.dev", cell: (row) => row.trigger, minWidth: "12rem" },
            { header: "Inngest", cell: (row) => row.inngest, minWidth: "12rem" },
          ]} />
      </AdminSection>
    </>}</AdminQueryState>
  </>;
}
