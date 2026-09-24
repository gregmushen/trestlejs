import { api } from "../../api";
import { planCatalog } from "../../billing-model";
import { useAdminQuery } from "../../shell/context";
import { AdminCode, AdminDataTable, AdminPageHeader, AdminQueryState, AdminSection, AdminStatus } from "../../shell/ui";

/**
 * The application's plans and feature catalog. Both are reviewed source
 * (packages/billing/src/plans.ts); Stripe prices are managed with
 * `trestle payments stripe sync`. This view reads them and never edits them.
 */
export default function PlansView() {
  const catalog = useAdminQuery(["features"], api.features);
  const plans = planCatalog();
  return <>
    <AdminPageHeader title="Plans" description="Plans and features are defined in application source (packages/billing/src/plans.ts). Change them in code, then sync Stripe prices with trestle payments stripe sync." />
    <AdminSection title="Comparison" description="Every feature against each plan's current version.">
      <AdminQueryState query={catalog}>{(data) => <AdminDataTable caption="Plan comparison" rows={data.features} rowKey={(feature) => feature.code} columns={[
        { header: "Feature", minWidth: "14rem", cell: (feature) => <><p className="font-medium">{feature.description}</p><p className="text-xs text-kumo-subtle"><AdminCode>{feature.code}</AdminCode></p></> },
        ...plans.map((plan) => ({ header: `${plan.key} v${plan.version}`, nowrap: true as const, cell: (feature: { code: string }) => plan.entitlements.includes(feature.code) ? <AdminStatus variant="success">included</AdminStatus> : <span className="text-kumo-subtle">—</span> })),
      ]} />}</AdminQueryState>
    </AdminSection>
    <AdminSection title="Plans">
      <AdminDataTable caption="Plans" primary={false} rows={plans} rowKey={(plan) => plan.key} columns={[
        { header: "Plan", cell: (plan) => <AdminCode>{`${plan.key}@${plan.version}`}</AdminCode> },
        { header: "Lifecycle", nowrap: true, cell: (plan) => <AdminStatus variant={plan.lifecycle === "active" ? "success" : plan.lifecycle === "draft" ? "info" : plan.lifecycle === "grandfathered" ? "warning" : "neutral"}>{plan.lifecycle}</AdminStatus> },
        { header: "Entitlements", cell: (plan) => <ul className="flex flex-wrap gap-1">{plan.entitlements.map((code) => <li key={code}><AdminCode>{code}</AdminCode></li>)}</ul> },
      ]} />
    </AdminSection>
    <AdminSection title="Feature catalog">
      <AdminQueryState query={catalog}>{(data) => <AdminDataTable caption="Features" primary={false} rows={data.features} rowKey={(feature) => feature.code} columns={[
        { header: "Feature", cell: (feature) => <AdminCode>{feature.code}</AdminCode> },
        { header: "Description", cell: (feature) => feature.description },
        { header: "Privileges", cell: (feature) => feature.privileges.join(", ") || "—" },
      ]} />}</AdminQueryState>
    </AdminSection>
  </>;
}
