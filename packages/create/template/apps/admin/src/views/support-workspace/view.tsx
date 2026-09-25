import { Link } from "@tanstack/react-router";

import { api } from "../../api";
import { useAdmin, useAdminQuery } from "../../shell/context";
import { PlaneBadge } from "../../shell/roles";
import { AdminCode, AdminCopy, AdminDataTable, AdminEmpty, AdminPageHeader, AdminQueryState, AdminSection, AdminStatus, formatDate } from "../../shell/ui";

/**
 * What the open support session may read in its organization: profile,
 * members, plan, regional defaults, and recent audit. Every load is recorded
 * on the organization's audit log with the session ID; nothing here writes.
 */
export default function SupportWorkspaceView() {
  const { supportSession } = useAdmin();
  const view = useAdminQuery(["support-workspace", supportSession?.id ?? ""], () => api.supportOrganization(supportSession!.id), { enabled: Boolean(supportSession) });
  if (!supportSession) return <>
    <AdminPageHeader title="Support workspace" description="A read-only view of one organization during an audited support session." />
    <AdminEmpty title="No active support session" description="Start a session from Organizations or Support Sessions; the organization's details appear here while it is open." />
    <p className="mt-3 text-sm"><Link to={"/support/sessions" as never} className="font-medium text-kumo-link underline-offset-2 hover:underline">Go to Support Sessions</Link></p>
  </>;
  return <>
    <AdminPageHeader title={`Support workspace · ${supportSession.organizationName}`} description="Read-only. You remain the actor; each view is recorded on the organization's audit log with this session." />
    <AdminQueryState query={view}>{(data) => <>
      <AdminSection title="Organization">
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div><dt className="text-kumo-subtle">Name</dt><dd>{data.organization?.name ?? "—"}</dd></div>
          <div><dt className="text-kumo-subtle">Slug</dt><dd>{data.organization?.slug ?? "—"}</dd></div>
          <div><dt className="text-kumo-subtle">Plan</dt><dd>{data.subscription ? <><AdminCode>{`${data.subscription.plan}@${data.subscription.planVersion}`}</AdminCode> <AdminStatus value={data.subscription.status}>{data.subscription.status}</AdminStatus></> : "No subscription"}</dd></div>
          <div><dt className="text-kumo-subtle">Session</dt><dd><AdminCopy value={supportSession.id} label="support session ID" /></dd></div>
          {(["language", "locale", "timeZone", "currency"] as const).map((setting) => <div key={setting}><dt className="text-kumo-subtle">{setting === "timeZone" ? "Time zone" : setting[0]!.toUpperCase() + setting.slice(1)}</dt><dd>{data.regional?.[setting] ?? <span className="text-kumo-subtle">application default</span>}</dd></div>)}
        </dl>
      </AdminSection>
      <AdminSection title={`Members (${data.members.length})`}>
        {data.members.length === 0 ? <AdminEmpty title="No members" /> : <AdminDataTable caption="Members" primary={false} rows={data.members} rowKey={(member) => member.userId} columns={[
          { header: "Member", cell: (member) => <><p className="font-medium">{member.name}</p><p className="text-kumo-subtle">{member.email}</p></> },
          { header: "Role", nowrap: true, cell: (member) => <span className="flex items-center gap-1"><PlaneBadge plane="organization" />{member.role}</span> },
          { header: "Joined", nowrap: true, cell: (member) => formatDate(member.joinedAt) },
        ]} />}
      </AdminSection>
      <AdminSection title="Recent audit">
        {data.recentAudit.length === 0 ? <AdminEmpty title="No audit events" /> : <AdminDataTable caption="Recent audit" primary={false} rows={data.recentAudit} rowKey={(event) => `${event.correlationId}:${event.occurredAt}:${event.name}`} columns={[
          { header: "When", nowrap: true, cell: (event) => formatDate(event.occurredAt) },
          { header: "Event", cell: (event) => <AdminCode>{event.name}</AdminCode> },
          { header: "Actor", nowrap: true, cell: (event) => event.actorType },
          { header: "Result", nowrap: true, cell: (event) => <AdminStatus variant={event.outcome === "succeeded" ? "success" : "destructive"}>{event.outcome}</AdminStatus> },
        ]} />}
      </AdminSection>
    </>}</AdminQueryState>
  </>;
}
