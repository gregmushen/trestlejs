import { Link } from "@tanstack/react-router";

import { api } from "../../api";
import { useAdminQuery, useTenantScope } from "../../shell/context";
import { OrganizationPicker } from "../../shell/pickers";
import { AdminCode, AdminDataTable, AdminEmpty, AdminPageHeader, AdminQueryState, AdminSection, AdminStatus, formatDate } from "../../shell/ui";
import { useViewSearch } from "../../shell/url-state";

/**
 * One organization's effective entitlements with their provenance: the plan
 * includes a feature, and an active override grants or denies it on top. The
 * same rule decides access at runtime; overrides are changed in Subscriptions.
 */
export default function EntitlementsView() {
  const [scope] = useTenantScope();
  const [search, update] = useViewSearch<{ organization?: string }>();
  const organizationId = search.organization ?? scope;
  const detail = useAdminQuery(["subscription", organizationId], () => api.subscription(organizationId), { enabled: Boolean(organizationId) });
  const features = useAdminQuery(["features"], api.features);
  return <>
    <AdminPageHeader title="Entitlements" description="What one organization can use and why: included by its plan, or granted or denied by an audited override. Change overrides in Subscriptions." />
    <div className="mb-4 max-w-md"><OrganizationPicker value={organizationId} onChange={(id) => update({ organization: id || undefined })} /></div>
    {!organizationId ? <AdminEmpty title="Choose an organization" description="Its effective entitlements and their sources appear here." /> : <AdminQueryState query={detail}>{(data) => {
      const now = Date.now();
      const active = data.overrides.filter((override) => !override.removedAt && Date.parse(override.effectiveAt) <= now && (!override.expiresAt || Date.parse(override.expiresAt) > now));
      const planCodes = new Set(data.effective.map((entry) => entry.code));
      const rows = (features.data?.features ?? []).map((feature) => {
        const override = active.find((entry) => entry.code === feature.code);
        const enabled = override ? override.enabled : planCodes.has(feature.code);
        return { feature, enabled, source: override ? "override" : planCodes.has(feature.code) ? "plan" : "not included", override };
      });
      return <AdminSection title={data.subscription ? `${data.subscription.organizationName ?? organizationId} · ${data.subscription.planVersion ?? data.subscription.plan}` : "No subscription"}
        description={data.subscription ? `${data.subscription.status} · provider ${data.subscription.provider}` : "Without a subscription only overrides can grant features."}
        actions={<Link to={"/commercial/subscriptions" as never} search={{ selected: organizationId, tab: "overrides" } as never} className="text-sm font-medium text-kumo-link underline-offset-2 hover:underline">Manage overrides</Link>}>
        <AdminDataTable caption="Effective entitlements" rows={rows} rowKey={(row) => row.feature.code} columns={[
          { header: "Feature", minWidth: "14rem", cell: (row) => <><p className="font-medium">{row.feature.description}</p><AdminCode>{row.feature.code}</AdminCode></> },
          { header: "Effective", nowrap: true, cell: (row) => <AdminStatus variant={row.enabled ? "success" : "neutral"}>{row.enabled ? "enabled" : "disabled"}</AdminStatus> },
          { header: "Source", nowrap: true, cell: (row) => <AdminStatus variant={row.source === "override" ? "warning" : row.source === "plan" ? "info" : "neutral"}>{row.source}</AdminStatus> },
          { header: "Override", minWidth: "14rem", cell: (row) => row.override ? <>{row.override.enabled ? "granted" : "denied"} · {row.override.reason}<p className="text-xs text-kumo-subtle">{row.override.expiresAt ? `until ${formatDate(row.override.expiresAt)}` : "no expiry"} · by {row.override.author}</p></> : "—" },
        ]} />
      </AdminSection>;
    }}</AdminQueryState>}
  </>;
}
