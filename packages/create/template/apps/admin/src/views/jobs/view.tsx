import { Link } from "@tanstack/react-router";

import { api } from "../../api";
import type { JobsStatus } from "../../main-backend";
import { useAdminCommands } from "../../shell/commands";
import { useConfirmAction, type ConfirmConfig } from "../../shell/ConfirmAction";
import { useAdmin, useAdminQuery, useInvalidate } from "../../shell/context";
import { Banner, Button, Grid } from "../../shell/kumo";
import { AdminCode, AdminDataTable, AdminPageHeader, AdminQueryState, AdminSection, AdminStat, AdminStatus, formatDate } from "../../shell/ui";
import { JobsCredentials, JobsEditPanel } from "./edit";
import { engineComparison, engineLabel, frequentScheduleNote, hostingLabels } from "./engines";

const linkClass = "text-sm font-medium text-kumo-link underline-offset-2 hover:underline";

/** Settlement waits out a run's full retry schedule, as the Worker's own sweep does. */
const settleAfterMinutes = 30;

/**
 * The environment's job engine, where it runs, and whether dispatch is
 * keeping up. Operators with platform.jobs.manage can switch the engine (a
 * reviewed plan, then an audited override), pause dispatch, settle
 * unconsumed events, and revert to the deployed configuration. Individual
 * runs live in the engine's own dashboard (or, on Cloudflare, the async
 * operations view); credentials show only as set or missing.
 */
export default function JobsView() {
  const { can } = useAdmin();
  const invalidate = useInvalidate();
  const state = useAdminQuery(["jobs"], api.jobs, { refetchInterval: 30_000 });
  const confirm = useConfirmAction();
  const manage = can("platform.jobs.manage");
  const data = state.data;
  const revert = (current: JobsStatus): ConfirmConfig => ({
    title: "Revert to deploy config", confirmLabel: "Revert", destructive: true,
    scope: [`Clear the admin override${current.override ? ` (${engineLabel(current.override.runtime)})` : ""} and resume dispatch`, `Dispatch returns to ${current.declared ? engineLabel(current.declared.runtime) : "the deployed engine"} within 30 seconds`],
    onConfirm: (reason) => api.revertJobs(current.overrideVersion, reason), onDone: () => void invalidate("jobs"), successMessage: "Reverted to the deployed configuration",
  });
  const settle = (current: JobsStatus): ConfirmConfig => ({
    title: "Settle unconsumed events", confirmLabel: "Settle now", destructive: true,
    scope: [`Re-dispatch up to 100 events dispatched more than ${String(settleAfterMinutes)} minutes ago that no consumer completed (${String(current.dispatch.unconsumed)} unconsumed)`, "Events at the attempt cap are dead-lettered instead"],
    onConfirm: (reason) => api.settleJobs(settleAfterMinutes, reason), onDone: () => void invalidate("jobs"),
  });
  const pause = (current: JobsStatus): ConfirmConfig => ({
    title: current.settings.dispatchPaused ? "Resume dispatch" : "Pause dispatch", confirmLabel: current.settings.dispatchPaused ? "Resume" : "Pause",
    scope: [current.settings.dispatchPaused ? "The Worker sends pending events again within 30 seconds" : "The Worker stops sending committed events within 30 seconds; they stay pending, nothing is lost"],
    onConfirm: (reason) => api.setJobsPaused(!current.settings.dispatchPaused, current.overrideVersion, reason), onDone: () => void invalidate("jobs"),
  });
  useAdminCommands({
    "jobs.revert": { enabled: manage && Boolean(data?.override || data?.settings.dispatchPaused), confirm: () => { if (data) confirm.open(revert(data)); } },
    "jobs.settle": { enabled: manage && Boolean(data?.runtime), confirm: () => { if (data) confirm.open(settle(data)); } },
    "jobs.pause": { enabled: manage && Boolean(data?.runtime), run: () => { if (data) confirm.open(pause(data)); } },
    "jobs.refresh": { run: () => void state.refetch() },
  });
  return <>
    <AdminPageHeader title="Jobs" description="The engine that runs committed events and scheduled work for this environment, and how dispatch to it is keeping up." />
    <AdminQueryState query={state}>{(data) => <>
      {data.migration && <Banner className="mb-4" variant="alert" title={`Switching from ${engineLabel(data.migration.from)} to ${engineLabel(data.migration.to)}`}
        description={`${String(data.migration.unconsumed)} events dispatched to the previous engine are not completed yet (since ${formatDate(data.migration.since)}). Keep its bindings deployed until they drain; Settle now re-dispatches what it never completed.`} />}
      {data.settings.dispatchPaused && <Banner className="mb-4" variant="alert" title="Dispatch is paused" description={`Committed events stay pending (${String(data.dispatch.pending)} now) until dispatch resumes.`} />}
      <AdminSection title="Engine" description={data.source === "unknown" ? "The customer Worker records its engine on its next maintenance sweep." : data.source === "override" ? `Set from admin${data.override?.at ? ` on ${formatDate(data.override.at)}` : ""}; it takes precedence over the deployed configuration${data.declared ? ` (${engineLabel(data.declared.runtime)})` : ""}.` : `Declared by the deployed Worker${data.declaredAt ? ` on ${formatDate(data.declaredAt)}` : ""}.`}
        actions={<span className="flex flex-wrap items-center gap-3">
          {data.runtime === "cloudflare" ? <Link to={"/operations/async" as never} className={linkClass}>Open async operations</Link>
            : data.dashboardUrl ? <a href={data.dashboardUrl} target="_blank" rel="noopener noreferrer" className={linkClass}>Open dashboard</a> : null}
          {manage && data.runtime && <Button variant="secondary" onClick={() => confirm.open(pause(data))}>{data.settings.dispatchPaused ? "Resume dispatch" : "Pause dispatch"}</Button>}
          {manage && data.runtime && <Button variant="secondary-destructive" onClick={() => confirm.open(settle(data))}>Settle now</Button>}
          {manage && (data.override || data.settings.dispatchPaused) && <Button variant="secondary-destructive" onClick={() => confirm.open(revert(data))}>Revert to deploy config</Button>}
        </span>}>
        <dl className="grid gap-3 text-sm sm:grid-cols-4">
          <div><dt className="text-kumo-subtle">Engine</dt><dd className="font-medium">{data.runtime ? engineLabel(data.runtime) : "Unknown"}</dd></div>
          <div><dt className="text-kumo-subtle">Hosting</dt><dd className="font-medium">{data.hosting ? hostingLabels[data.hosting] ?? data.hosting : "Unknown"}</dd></div>
          <div><dt className="text-kumo-subtle">Location</dt><dd className="font-medium">{data.endpoint ? <AdminCode>{data.endpoint}</AdminCode> : data.project ? <AdminCode>{data.project}</AdminCode> : data.runtime === "cloudflare" ? "Cloudflare" : "—"}</dd></div>
          <div><dt className="text-kumo-subtle">Support</dt><dd><AdminStatus variant={data.supportStatus === "supported" ? "success" : data.supportStatus === "experimental" ? "warning" : "neutral"}>{data.supportStatus}</AdminStatus> <span className="text-kumo-subtle">({data.source})</span></dd></div>
        </dl>
        {data.runtime && <div className="mt-4"><p className="mb-1 text-sm text-kumo-subtle">Credentials (editing secrets from admin is not supported)</p><JobsCredentials credentials={data.credentials} /></div>}
      </AdminSection>
      <Grid variant="3up" gap="base" className="mb-6">
        <AdminStat label="Pending" value={data.dispatch.pending} hint={data.settings.dispatchPaused ? "Held while dispatch is paused" : "Committed, not yet handed to the engine"} variant={data.settings.dispatchPaused && data.dispatch.pending ? "warning" : "neutral"} />
        <AdminStat label="Unconsumed" value={data.dispatch.unconsumed} hint="Dispatched in the last 14 days, not completed" variant={data.dispatch.unconsumed ? "warning" : "success"} />
        <AdminStat label="Dead" value={data.dispatch.dead} variant={data.dispatch.dead ? "destructive" : "success"} />
      </Grid>
      {manage && data.runtime && <JobsEditPanel key={`${String(data.overrideVersion)}:${data.runtime}`} data={data} confirm={confirm} onChanged={() => void invalidate("jobs")} />}
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
    {confirm.dialog}
  </>;
}
