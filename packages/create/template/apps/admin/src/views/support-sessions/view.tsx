import { useState } from "react";

import { ResourceListPage } from "../../blocks/resource-list";
import { api, type SupportSessionSummary } from "../../api";
import { useAdminCommands } from "../../shell/commands";
import { useConfirmAction, type ConfirmConfig } from "../../shell/ConfirmAction";
import { useAdmin, useAdminQuery, useInvalidate } from "../../shell/context";
import { Button } from "../../shell/kumo";
import { OrganizationPicker } from "../../shell/pickers";
import { AdminCreateDialog } from "../../shell/resource";
import { useStartSupportSession } from "../../shell/StartSupportSession";
import { AdminCode, AdminCopy, AdminDataTable, AdminEmpty, AdminPageHeader, AdminQueryState, AdminSection, AdminStatus, formatDate } from "../../shell/ui";
import { useViewSearch } from "../../shell/url-state";

const stateOf = (session: SupportSessionSummary) => session.endedAt ? session.endReason ?? "ended" : Date.parse(session.expiresAt) <= Date.now() ? "expired" : "active";

function SessionDetail({ id, onRevoke }: { id: string; onRevoke: ((session: SupportSessionSummary) => void) | undefined }) {
  const detail = useAdminQuery(["support-session", id], () => api.supportSession(id));
  return <AdminQueryState query={detail}>{({ session, activity }) => <AdminSection title={`${session.organizationName} · ${session.profile}`} description={`${session.operator.email} · started ${formatDate(session.startedAt)}`}
    actions={onRevoke && !session.endedAt ? <Button variant="secondary-destructive" onClick={() => onRevoke({ ...session, activity: activity.length })}>Revoke session</Button> : undefined}>
    <dl className="grid gap-2 text-sm sm:grid-cols-2">
      <div><dt className="text-kumo-subtle">Reason</dt><dd>{session.reason}{session.ticket ? <> · <AdminCode>{session.ticket}</AdminCode></> : null}</dd></div>
      <div><dt className="text-kumo-subtle">Expires</dt><dd>{formatDate(session.expiresAt)}</dd></div>
      <div><dt className="text-kumo-subtle">Ended</dt><dd>{session.endedAt ? `${formatDate(session.endedAt)} (${session.endReason}${session.revocationReason ? `: ${session.revocationReason}` : ""})` : "active"}</dd></div>
      <div><dt className="text-kumo-subtle">Session</dt><dd><AdminCopy value={session.id} label="session ID" /></dd></div>
    </dl>
    <h3 className="mt-4 text-sm font-semibold">Granted permissions</h3>
    <div className="mt-1 flex flex-wrap gap-1">{[...session.permissions.organization, ...session.permissions.application].map((code) => <AdminStatus key={code} variant="success">{code}</AdminStatus>)}</div>
    <details className="mt-2 text-sm"><summary className="cursor-pointer text-kumo-subtle">{session.permissions.denied.length} permissions denied</summary><div className="mt-1 flex flex-wrap gap-1">{session.permissions.denied.map((code) => <AdminStatus key={code} variant="neutral">{code}</AdminStatus>)}</div></details>
    <h3 className="mt-4 text-sm font-semibold">Correlated activity</h3>
    {activity.length === 0 ? <AdminEmpty title="No recorded activity" /> : <AdminDataTable caption="Support session activity" primary={false} rows={activity} rowKey={(event) => event.id} columns={[
      { header: "When", cell: (event) => formatDate(event.occurredAt) },
      { header: "Event", cell: (event) => <AdminCode>{event.name}</AdminCode> },
      { header: "Target", cell: (event) => <span className="font-mono text-xs">{event.target}</span> },
      { header: "Correlation", cell: (event) => <AdminCopy value={event.correlationId} label="correlation ID" /> },
    ]} />}
  </AdminSection>}</AdminQueryState>;
}

export default function SupportSessionsView() {
  const { can, supportSession, exitSupportSession } = useAdmin();
  const invalidate = useInvalidate();
  const [search, update] = useViewSearch<{ tab?: string; selected?: string }>();
  const tab = search.tab ?? "active";
  const sessions = useAdminQuery(["support-sessions", tab], () => api.supportSessions(tab === "active" ? "active" : undefined), { refetchInterval: 15_000 });
  const selected = sessions.data?.sessions.find((session) => session.id === search.selected);
  const confirm = useConfirmAction();
  const revoke = (session: SupportSessionSummary): ConfirmConfig => ({ title: "Revoke support session", confirmLabel: "Revoke", destructive: true, scope: [`End ${session.operator.email}'s session in ${session.organizationName} now`, "Their tenant authority ends on their next request"], onConfirm: (reason) => api.revokeSupportSession(session.id, reason), onDone: () => { void invalidate("support-sessions"); void invalidate("support-session"); } });
  // Operators end their own sessions; revoking another operator's session is not offered yet.
  const canRevoke = false;
  const canStart = can("platform.support_sessions.use");
  const organizations = useAdminQuery(["organizations"], () => api.organizations(""), { enabled: canStart });
  const starter = useStartSupportSession();
  const [choosing, setChoosing] = useState(false);
  const [organizationId, setOrganizationId] = useState("");
  const start = () => { setOrganizationId(""); setChoosing(true); };
  useAdminCommands({
    "support-sessions.start": { enabled: canStart && !supportSession, run: start },
    "support-sessions.exit": { enabled: Boolean(supportSession), run: () => void exitSupportSession() },
  });
  return <>
    <AdminPageHeader title="Support sessions" description="Your support sessions: where, why, for how long, and what was viewed. A session gives read-only access to one organization and never signs you in as a customer."
      tabs={[{ value: "active", label: "Active" }, { value: "history", label: "History" }]} tab={tab} onTabChange={(value) => update({ tab: value === "active" ? undefined : value, selected: undefined })}
      actions={<>{supportSession && <Button variant="secondary" onClick={() => void exitSupportSession()}>Exit your session</Button>}{canStart && !supportSession && <Button variant="primary" onClick={start}>Start a session</Button>}</>} />
    <ResourceListPage detail={search.selected ? <SessionDetail id={search.selected} onRevoke={canRevoke ? (session) => confirm.open(revoke(session)) : undefined} /> : null}>
      <AdminQueryState query={sessions} isEmpty={(data) => data.sessions.length === 0} empty={tab === "active" ? "No active support sessions." : "No support sessions yet."}>{(data) => <AdminDataTable caption="Support sessions" selectable rows={data.sessions} rowKey={(row) => row.id} rowLabel={(row) => `${row.organizationName} by ${row.operator.email}`}
        rowActions={(row) => canRevoke && stateOf(row) === "active" ? [{ label: "Revoke session", hotkey: "r", destructive: true, run: () => confirm.open(revoke(row)) }] : []}
        columns={[
          { header: "Tenant", cell: (row) => <><p className="font-medium">{row.organizationName}</p><p className="text-xs text-kumo-subtle">{row.profile}</p></> },
          { header: "Operator", cell: (row) => row.operator.email },
          { header: "Reason", cell: (row) => row.reason },
          { header: "State", cell: (row) => { const state = stateOf(row); return <AdminStatus variant={state === "active" ? "warning" : state === "revoked" ? "destructive" : "neutral"}>{state}</AdminStatus>; } },
          { header: "Expires", cell: (row) => formatDate(row.expiresAt) },
          { header: "Activity", cell: (row) => row.activity },
        ]} />}</AdminQueryState>
    </ResourceListPage>
    <AdminCreateDialog open={choosing} onClose={() => setChoosing(false)} title="Start a support session" submitLabel="Continue" disabled={!organizationId}
      description="Read-only access to one organization for a set time. You stay the actor; every view is audited on the organization."
      onSubmit={async () => {
        const organization = organizations.data?.organizations.find((item) => item.id === organizationId);
        if (!organization) throw new Error("Choose an organization");
        setChoosing(false);
        confirm.open(starter.config({ id: organization.id, name: organization.name }));
      }}>
      <OrganizationPicker value={organizationId} onChange={setOrganizationId} />
    </AdminCreateDialog>
    {confirm.dialog}
  </>;
}
