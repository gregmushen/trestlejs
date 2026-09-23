import { ResourceListPage } from "../../blocks/resource-list";
import { api, type OrganizationSummary } from "../../api";
import { useAdminCommands } from "../../shell/commands";
import { useConfirmAction } from "../../shell/ConfirmAction";
import { useAdmin, useAdminQuery } from "../../shell/context";
import { Button, Tabs } from "../../shell/kumo";
import { PlaneBadge } from "../../shell/roles";
import { useStartSupportSession } from "../../shell/StartSupportSession";
import { AdminDataTable, AdminEmpty, AdminFilter, AdminPageHeader, AdminQueryState, AdminSection, AdminStatus, formatDate } from "../../shell/ui";
import { useViewSearch } from "../../shell/url-state";
import { OrganizationRegional } from "./regional";

function OrganizationDetail({ organization, onStart }: { organization: OrganizationSummary; onStart: (() => void) | undefined }) {
  const { tenantContext, can } = useAdmin();
  const [search, update] = useViewSearch<{ tab?: string }>();
  const detail = useAdminQuery(["organization", organization.id], () => api.organization(organization.id));
  const active = tenantContext?.organizationId === organization.id;
  const tab = search.tab ?? "members";
  return <AdminSection title={organization.name} description={`Slug ${organization.slug} · created ${formatDate(organization.createdAt)}`}
    actions={active ? <AdminStatus variant="warning">in support session</AdminStatus> : onStart ? <Button variant="secondary" onClick={onStart}>Start support session</Button> : undefined}>
    <Tabs variant="underline" value={tab} onValueChange={(value) => update({ tab: String(value) === "members" ? undefined : String(value) }, { replace: true })}
      tabs={[{ value: "members", label: "Members" }, { value: "summary", label: "Summary" }, ...(can("platform.organizations.regional.read") ? [{ value: "regional", label: "Regional" }] : [])]} />
    <div className="mt-3">
      {tab === "regional" && can("platform.organizations.regional.read") ? <OrganizationRegional organizationId={organization.id} organizationName={organization.name} />
        : tab === "summary" ? <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div><dt className="text-kumo-subtle">Plan</dt><dd>{organization.plan ?? "none"}</dd></div>
        <div><dt className="text-kumo-subtle">Subscription</dt><dd>{organization.status ?? "—"}</dd></div>
        <div><dt className="text-kumo-subtle">Members</dt><dd>{organization.members}</dd></div>
        <div><dt className="text-kumo-subtle">Organization ID</dt><dd className="font-mono text-xs">{organization.id}</dd></div>
      </dl>
        : <AdminQueryState query={detail} isEmpty={(data) => data.members.length === 0} empty="No members.">{(data) => <ul aria-label="Members" className="flex flex-col divide-y divide-kumo-hairline">{data.members.map((member) => <li key={member.userId} className="py-2 text-sm">
          <p className="font-medium">{member.name}</p><p className="text-kumo-subtle">{member.email}</p>
          <p className="mt-1 flex flex-wrap items-center gap-1"><PlaneBadge plane="organization" />{member.organizationRoles.join(", ") || "—"}<span className="mx-1" /><PlaneBadge plane="application" />{member.applicationRoles.join(", ") || "none"}</p>
        </li>)}</ul>}</AdminQueryState>}
    </div>
  </AdminSection>;
}

export default function OrganizationsView() {
  const { can, capability, supportSession, exitSupportSession } = useAdmin();
  const [search] = useViewSearch<{ q?: string; selected?: string }>();
  const organizations = useAdminQuery(["organizations", search.q ?? ""], () => api.organizations(search.q));
  const selected = organizations.data?.organizations.find((organization) => organization.id === search.selected);
  const confirm = useConfirmAction();
  const start = useStartSupportSession();
  const supportAvailable = can("platform.support.enter_tenant") && capability("supportSessions")?.state !== "disabled";
  const startFor = (organization: OrganizationSummary) => () => confirm.open(start.config({ id: organization.id, name: organization.name }));
  const canStart = Boolean(selected && supportAvailable && supportSession?.organizationId !== selected.id);
  useAdminCommands({
    "organizations.start-support-session": { enabled: canStart, ...(selected ? { target: selected.id } : {}), run: () => { if (selected) startFor(selected)(); } },
    "organizations.exit-support-session": { enabled: Boolean(supportSession), run: () => void exitSupportSession() },
  });
  return <>
    <AdminPageHeader title="Organizations" description="Find customers and start an audited, time-boxed support session. Selecting a tenant grants nothing; only the session's support profile does, until it expires." />
    <AdminFilter label="Search organizations" placeholder="Name, slug, or ID" />
    <ResourceListPage detail={selected ? <OrganizationDetail organization={selected} onStart={canStart ? startFor(selected) : undefined} /> : <AdminEmpty title="Select an organization" description="Use j and k to move, Enter to open. Its members, plan, and support actions appear here." />}>
      <AdminQueryState query={organizations} isEmpty={(data) => data.organizations.length === 0} empty="No organizations match.">{(data) => <AdminDataTable caption="Organizations" selectable rows={data.organizations} rowKey={(row) => row.id} rowLabel={(row) => row.name}
        rowActions={(row) => supportAvailable && supportSession?.organizationId !== row.id ? [{ label: "Start support session", hotkey: "e", run: startFor(row) }] : []}
        columns={[
          { header: "Organization", cell: (row) => <><p className="font-medium">{row.name}</p><p className="text-kumo-subtle">{row.slug}</p></> },
          { header: "Members", cell: (row) => row.members },
          { header: "Plan", cell: (row) => row.plan ? <AdminStatus variant="info">{row.plan}</AdminStatus> : "—" },
          { header: "Status", cell: (row) => row.status ? <AdminStatus value={row.status}>{row.status}</AdminStatus> : "—" },
        ]} />}</AdminQueryState>
    </ResourceListPage>
    {confirm.dialog}
  </>;
}
