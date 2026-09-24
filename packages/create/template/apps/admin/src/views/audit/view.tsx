import { useNavigate } from "@tanstack/react-router";

import { api, type AuditEvent } from "../../api";
import { useAdminCommands } from "../../shell/commands";
import { useAdmin, useAdminQuery, useTenantScope } from "../../shell/context";
import { Button, Input } from "../../shell/kumo";
import { OrganizationPicker } from "../../shell/pickers";
import { AdminDetailDrawer, AdminFacts } from "../../shell/resource";
import { AdminCode, AdminCopy, AdminDataTable, AdminFilter, AdminPageHeader, AdminQueryState, AdminStatus, formatDate, useAdminToast } from "../../shell/ui";
import { useViewSearch } from "../../shell/url-state";

const pageSize = 50;
const actorLabel = (event: AuditEvent) => event.actorEmail ?? (event.actorType === "system" ? event.actor.replace(/^system:/u, "system: ") : event.actor);

export default function AuditView() {
  const { can } = useAdmin();
  const navigate = useNavigate();
  const toast = useAdminToast();
  const [scope] = useTenantScope();
  const [search, update] = useViewSearch<{ organization?: string; actor?: string; q?: string; correlation?: string; selected?: string; page?: string }>();
  const filters = { organizationId: search.organization ?? scope, actor: search.actor ?? "", name: search.q ?? "", correlation: search.correlation ?? "" };
  const page = search.page ?? "1";
  const events = useAdminQuery(["audit", filters, page], () => api.audit({
    ...(filters.organizationId ? { organizationId: filters.organizationId } : {}), ...(filters.actor ? { actor: filters.actor } : {}), ...(filters.name ? { name: filters.name } : {}), ...(filters.correlation ? { correlation: filters.correlation } : {}),
    page, pageSize: String(pageSize),
  }));
  // The selected event may be on another page; the drawer loads it by ID.
  const detail = useAdminQuery(["audit-event", search.selected ?? ""], () => api.auditEvent(search.selected!), { enabled: Boolean(search.selected) });
  const selected = detail.data?.event;
  const copy = (value: string) => { void navigator.clipboard.writeText(value).then(() => toast.success("Correlation ID copied", value), (error) => toast.failure("Could not copy", error)); };
  const openSession = (id: string) => void navigate({ to: "/support/sessions" as never, search: { selected: id } as never });
  useAdminCommands({
    "audit.copy-correlation": { enabled: Boolean(selected?.correlationId), ...(selected ? { target: selected.id } : {}), run: () => { if (selected?.correlationId) copy(selected.correlationId); } },
    "audit.open-support-session": { enabled: Boolean(selected?.supportSessionId) && can("platform.support_sessions.use"), ...(selected ? { target: selected.id } : {}), run: () => { if (selected?.supportSessionId) openSession(selected.supportSessionId); } },
  });
  // Filters change the result set, so they return to the first page.
  const filter = (next: Record<string, string | undefined>) => update({ ...next, page: undefined }, { replace: true });
  return <>
    <AdminPageHeader title="Audit" description="Append-only, correlated history of sensitive changes. Summaries are redacted; audit is never a secret-recovery mechanism." />
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <div className="w-full sm:w-64"><OrganizationPicker value={filters.organizationId} onChange={(id) => filter({ organization: id || undefined })} /></div>
      <div className="w-full sm:w-56"><Input label="Actor" placeholder="User ID or email" value={filters.actor} onChange={(event) => filter({ actor: event.target.value || undefined })} /></div>
      <AdminFilter className="w-full sm:w-56" label="Event name" placeholder="access.api_key" />
      <div className="w-full sm:w-64"><Input label="Correlation ID" value={filters.correlation} onChange={(event) => filter({ correlation: event.target.value || undefined })} /></div>
    </div>
    <AdminQueryState query={events} isEmpty={(data) => data.events.length === 0} empty="No audit events match.">{(data) => <>
      <p className="mb-2 text-xs text-kumo-subtle">{data.total.toLocaleString()} event{data.total === 1 ? "" : "s"}</p>
      <AdminDataTable caption="Audit events" selectable rows={data.events} rowKey={(row) => row.id} rowLabel={(row) => row.name} server={{ totalCount: data.total, pageSize: data.pageSize }}
        rowActions={(row) => [
          { label: "Inspect", run: () => update({ selected: row.id }) },
          ...(row.correlationId ? [{ label: "Copy correlation ID", hotkey: "c", run: () => copy(row.correlationId!) }] : []),
          ...(row.supportSessionId && can("platform.support_sessions.use") ? [{ label: "Open support session", hotkey: "s", run: () => openSession(row.supportSessionId!) }] : []),
        ]}
        columns={[
          { header: "When", nowrap: true, cell: (row) => formatDate(row.occurredAt) },
          { header: "Event", minWidth: "14rem", cell: (row) => <AdminCode>{row.name}</AdminCode> },
          { header: "Actor", minWidth: "12rem", cell: (row) => <span className="break-all">{actorLabel(row)}{row.supportSessionId && <> <AdminStatus variant="warning">support</AdminStatus></>}</span> },
          { header: "Organization", minWidth: "10rem", cell: (row) => row.organizationId ? row.organizationName ?? row.organizationId : <AdminStatus variant="neutral">platform</AdminStatus> },
          { header: "Result", nowrap: true, cell: (row) => <AdminStatus variant={row.outcome === "succeeded" ? "success" : "destructive"}>{row.outcome ?? "—"}</AdminStatus> },
          { header: "Correlation", nowrap: true, priority: "low", cell: (row) => row.correlationId ? <span className="font-mono text-xs" title={row.correlationId}>{row.correlationId.slice(0, 12)}…</span> : "—" },
        ]} />
    </>}</AdminQueryState>
    <AdminDetailDrawer open={Boolean(search.selected)} onClose={() => update({ selected: undefined })} title={selected?.name ?? "Audit event"} subtitle={selected ? formatDate(selected.occurredAt) : undefined}
      actions={selected ? <>
        {selected.correlationId && <Button variant="secondary" onClick={() => update({ correlation: selected.correlationId, selected: undefined, page: undefined })}>All events in this correlation</Button>}
        {selected.supportSessionId && can("platform.support_sessions.use") && <Button variant="secondary" onClick={() => openSession(selected.supportSessionId!)}>Support session</Button>}
      </> : undefined}>
      <AdminQueryState query={detail}>{({ event }) => <AdminFacts items={[
        ["Event", <AdminCode key="e">{event.name}</AdminCode>],
        ["Result", <AdminStatus key="r" variant={event.outcome === "succeeded" ? "success" : "destructive"}>{event.outcome ?? "—"}</AdminStatus>],
        ["Actor", `${event.actorType ?? ""} ${actorLabel(event)}`.trim()],
        ["Organization", event.organizationId ? `${event.organizationName ?? ""} (${event.organizationId})`.trim() : "platform"],
        ["Target", <AdminCode key="t">{event.target ?? "—"}</AdminCode>],
        ["Reason", event.reason ?? "—"],
        ["Environment", event.environment ?? "—"],
        ["Correlation", event.correlationId ? <AdminCopy key="c" value={event.correlationId} label="correlation ID" /> : "—"],
        ...(event.supportSessionId ? [["Support session", <AdminCopy key="s" value={event.supportSessionId} label="support session ID" />] as const] : []),
      ]} />}</AdminQueryState>
    </AdminDetailDrawer>
  </>;
}
