import { Link } from "@tanstack/react-router";

import { api } from "../../api";
import type { SequenceRunRow } from "../../main-backend";
import { useAdminCommands } from "../../shell/commands";
import { useConfirmAction, type ConfirmConfig } from "../../shell/ConfirmAction";
import { useAdmin, useAdminQuery, useInvalidate, useTenantScope } from "../../shell/context";
import { Select } from "../../shell/kumo";
import { OrganizationPicker } from "../../shell/pickers";
import { useSelectedDetail } from "../../shell/resource";
import { AdminCode, AdminDataTable, AdminPageHeader, AdminQueryState, AdminSection, AdminStatus, formatDate } from "../../shell/ui";
import { useViewSearch } from "../../shell/url-state";
import { engineLabel } from "../jobs/engines";

const statuses = ["active", "completed", "exited", "failed"] as const;
const statusVariant = { active: "success", completed: "neutral", exited: "warning", failed: "destructive" } as const;
const linkClass = "text-sm font-medium text-kumo-link underline-offset-2 hover:underline";

/**
 * Email sequences (`defineSequence`): per sequence, active runs, sends,
 * exits by reason, failures, and suppressions hit; and the runs themselves,
 * filterable by organization, sequence, and status, with masked recipients.
 * Individual runs' engine history lives in the engine's dashboard (on
 * Cloudflare, the Workflow instance `seq-<run ID>`). With
 * platform.sequences.manage an operator exits an active run (reason, step-up,
 * audited); its next step then sends nothing, whether or not the engine's
 * waiting run is cancelled.
 */
export default function EmailSequencesView() {
  const { can } = useAdmin();
  const manage = can("platform.sequences.manage");
  const invalidate = useInvalidate();
  const [scope] = useTenantScope();
  const [search, update] = useViewSearch<{ organization?: string; sequence?: string; status?: string; selected?: string }>();
  const organizationId = search.organization ?? scope;
  const summaries = useAdminQuery(["email-sequences"], api.emailSequences, { refetchInterval: 60_000 });
  const runs = useAdminQuery(["email-sequence-runs", organizationId ?? "", search.sequence ?? "", search.status ?? ""],
    () => api.sequenceRuns({ ...(organizationId ? { organizationId } : {}), ...(search.sequence ? { sequenceId: search.sequence } : {}), ...(search.status ? { status: search.status } : {}) }));
  const rows = runs.data?.runs ?? [];
  const selected = useSelectedDetail(rows, (row) => row.id);
  const confirm = useConfirmAction();
  const exit = (row: SequenceRunRow): ConfirmConfig => ({
    title: "Exit sequence run", confirmLabel: "Exit run", destructive: true,
    scope: [`Stop ${row.sequenceId} for ${row.recipient} (${row.organizationName ?? row.organizationId}) at step ${String(row.currentStep)}`, "No further email in this run is sent; the recipient can be started again only by a new trigger"],
    onConfirm: (reason) => api.exitSequenceRun(row.id, reason),
    onDone: () => { void invalidate("email-sequence-runs"); void invalidate("email-sequences"); }, successMessage: "Sequence run exited",
  });
  useAdminCommands({
    "email-sequences.exit": { enabled: Boolean(manage && selected.row?.status === "active"), ...(selected.row ? { target: selected.row.id } : {}), confirm: () => { if (selected.row) confirm.open(exit(selected.row)); } },
    "email-sequences.refresh": { run: () => { void summaries.refetch(); void runs.refetch(); } },
  });
  return <>
    <AdminPageHeader title="Email sequences" description="Sequences defined in code with defineSequence: how many runs are active, what they sent, and why they ended. Recipients are masked." />
    <AdminQueryState query={summaries} isEmpty={(data) => data.sequences.length === 0} empty="No sequence has started a run yet.">{(data) => <AdminSection title="Sequences"
      description="Sends over the last 24 hours and 7 days; exits by reason (an exit event, an unsubscribe, bounce or complaint, a suppressed recipient at send time, or an operator)."
      actions={data.runtime === "cloudflare" ? <Link to={"/operations/jobs" as never} className={linkClass}>Cloudflare Workflows: see Jobs</Link>
        : data.dashboardUrl ? <a href={data.dashboardUrl} target="_blank" rel="noopener noreferrer" className={linkClass}>Open {data.runtime ? engineLabel(data.runtime) : "engine"} dashboard</a> : null}>
      <AdminDataTable caption="Sequences" rows={data.sequences} rowKey={(row) => row.sequenceId} primary={false} columns={[
        { header: "Sequence", minWidth: "10rem", cell: (row) => <AdminCode>{row.sequenceId}</AdminCode> },
        { header: "Active", nowrap: true, cell: (row) => String(row.active) },
        { header: "Sends 24h / 7d", nowrap: true, cell: (row) => `${String(row.sends.last24h)} / ${String(row.sends.last7d)}` },
        { header: "Exits", minWidth: "12rem", cell: (row) => Object.keys(row.exits).length ? Object.entries(row.exits).map(([reason, total]) => `${reason} ${String(total)}`).join(", ") : "—" },
        { header: "Suppressed", nowrap: true, cell: (row) => row.suppressed ? <AdminStatus variant="warning">{String(row.suppressed)}</AdminStatus> : "0" },
        { header: "Failed", nowrap: true, cell: (row) => row.failed ? <AdminStatus variant="destructive">{String(row.failed)}</AdminStatus> : "0" },
        { header: "Completed", nowrap: true, priority: "low", cell: (row) => String(row.completed) },
      ]} />
    </AdminSection>}</AdminQueryState>
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <div className="w-full max-w-xs"><OrganizationPicker value={organizationId} onChange={(id) => update({ organization: id || undefined })} /></div>
      <div className="w-full sm:w-56"><Select label="Sequence" hideLabel={false} value={search.sequence ?? "all"} onValueChange={(value) => update({ sequence: String(value ?? "all") === "all" ? undefined : String(value) })}>
        <Select.Option value="all">All sequences</Select.Option>{(summaries.data?.sequences ?? []).map((row) => <Select.Option key={row.sequenceId} value={row.sequenceId}>{row.sequenceId}</Select.Option>)}
      </Select></div>
      <div className="w-full sm:w-48"><Select label="Status" hideLabel={false} value={search.status ?? "all"} onValueChange={(value) => update({ status: String(value ?? "all") === "all" ? undefined : String(value) })}>
        <Select.Option value="all">All statuses</Select.Option>{statuses.map((status) => <Select.Option key={status} value={status}>{status}</Select.Option>)}
      </Select></div>
    </div>
    <AdminQueryState query={runs} isEmpty={() => rows.length === 0} empty="No sequence runs match these filters.">{() => <AdminDataTable caption="Sequence runs" selectable rows={rows} rowKey={(row) => row.id} rowLabel={(row) => `${row.sequenceId} ${row.recipient}`}
      rowActions={(row) => manage && row.status === "active" ? [{ label: "Exit run", hotkey: "Shift+E", destructive: true, run: () => confirm.open(exit(row)) }] : []}
      columns={[
        { header: "Recipient", minWidth: "12rem", cell: (row) => <AdminCode>{row.recipient}</AdminCode> },
        { header: "Sequence", nowrap: true, cell: (row) => <AdminCode>{row.sequenceId}</AdminCode> },
        { header: "Organization", minWidth: "10rem", cell: (row) => row.organizationName ?? <AdminCode>{row.organizationId}</AdminCode> },
        { header: "Status", nowrap: true, cell: (row) => <AdminStatus variant={statusVariant[row.status]}>{row.exitReason ? `${row.status}: ${row.exitReason}` : row.status}</AdminStatus> },
        { header: "Step", nowrap: true, cell: (row) => `${String(row.currentStep)} (${String(row.sends)} sent)` },
        { header: "Next", nowrap: true, cell: (row) => row.nextAt && row.status === "active" ? formatDate(row.nextAt) : "—" },
        { header: "Engine run", priority: "low", cell: (row) => row.dashboardUrl ? <a href={row.dashboardUrl} target="_blank" rel="noopener noreferrer" className={linkClass}>{engineLabel(row.engine)}</a>
          : <span>{engineLabel(row.engine)} {row.engineRunId ? <AdminCode>{row.engineRunId}</AdminCode> : null}</span> },
        { header: "Started", nowrap: true, priority: "low", cell: (row) => formatDate(row.createdAt) },
      ]} />}</AdminQueryState>
    {confirm.dialog}
  </>;
}
