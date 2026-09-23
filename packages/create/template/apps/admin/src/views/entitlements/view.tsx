import { useState } from "react";

import { api, type EntitlementChange, type EntitlementExplorer, type FeatureExplanation } from "../../api";
import { useAdminCommands } from "../../shell/commands";
import { useAdminQuery, useTenantScope } from "../../shell/context";
import { FeatureSelect, FeatureValues, type PrivilegeValues } from "../../shell/feature-editor";
import { Button, Checkbox, Select, Switch } from "../../shell/kumo";
import { OrganizationPicker } from "../../shell/pickers";
import { AdminCreateDialog } from "../../shell/resource";
import { AdminCode, AdminDataTable, AdminEmpty, AdminPageHeader, AdminQueryState, AdminSection, AdminStat, AdminStatus, AdminUsageMeter, formatDate, formatValue, type StatusVariant } from "../../shell/ui";
import { useViewSearch } from "../../shell/url-state";

const statusVariant: Record<FeatureExplanation["status"], StatusVariant> = { included: "success", overridden: "warning", removed: "destructive", unavailable: "neutral" };
const changeVariant: Record<EntitlementChange["change"], StatusVariant> = { added: "success", removed: "destructive", changed: "warning", unchanged: "neutral" };
const values = (entries: Record<string, unknown> | undefined) => Object.entries(entries ?? {}).map(([name, value]) => `${name}: ${formatValue(value)}`).join(", ") || "—";

function FeatureTable(props: { rows: readonly FeatureExplanation[] }) {
  return <AdminDataTable caption="Features" rows={props.rows} rowKey={(row) => row.code} columns={[
    { header: "Feature", minWidth: "12rem", cell: (row) => <><p className="font-medium">{row.name}</p><AdminCode>{row.code}</AdminCode>{row.metered && <> <AdminStatus variant="info">metered</AdminStatus></>}</> },
    { header: "State", nowrap: true, cell: (row) => <AdminStatus variant={statusVariant[row.status]}>{row.status}</AdminStatus> },
    { header: "Effective values and provenance", minWidth: "16rem", cell: (row) => row.provenance.length
      ? <ul className="flex flex-col gap-0.5 text-sm">{row.provenance.map((entry) => <li key={entry.name}>{entry.name}: <strong>{formatValue(entry.value)}</strong> <span className="text-xs text-kumo-subtle">from {entry.source === "override" ? "override" : entry.ref ?? "plan"}</span></li>)}
        {row.unset.length > 0 && <li className="text-xs text-kumo-subtle">not set: {row.unset.join(", ")}</li>}</ul>
      : row.status === "unavailable" ? <span className="text-sm text-kumo-subtle">Not on this plan</span> : row.status === "removed" ? <span className="text-sm text-kumo-subtle">Removed by override</span> : "—" },
    { header: "Window", nowrap: true, priority: "low", cell: (row) => row.effectiveAt ? `${formatDate(row.effectiveAt)}${row.expiresAt ? ` → ${formatDate(row.expiresAt)}` : ""}` : "—" },
  ]} />;
}

type Proposal = { planVersion: string; removeOverrides: string[]; overrides: Array<{ code: string; enabled: boolean; values: PrivilegeValues }> };

function CompareDialog(props: { open: boolean; onClose: () => void; organizationId: string; data: EntitlementExplorer }) {
  const features = useAdminQuery(["features"], api.features);
  const plans = useAdminQuery(["plans"], api.plans);
  const [proposal, setProposal] = useState<Proposal>({ planVersion: "", removeOverrides: [], overrides: [] });
  const [result, setResult] = useState<{ from: string | null; to: string | null; changes: EntitlementChange[] } | null>(null);
  const versions = (plans.data?.versions ?? []).filter((version) => version.state !== "retired" && version.state !== "draft").map((version) => `${version.plan}@${version.version}`);
  const compare = async () => {
    setResult(await api.compareEntitlements(props.organizationId, { ...(proposal.planVersion ? { planVersion: proposal.planVersion } : {}), removeOverrides: proposal.removeOverrides, overrides: proposal.overrides.filter((override) => override.code) }));
  };
  const changed = result?.changes.filter((change) => change.change !== "unchanged") ?? [];
  return <AdminCreateDialog open={props.open} onClose={props.onClose} size="lg" title="Compare changes" submitLabel="Compare" onSubmit={compare}
    description="Evaluates a proposed plan version and override set against this organization's current entitlements. Nothing is saved.">
    <Select placeholder="Keep the current version" label="Plan version" hideLabel={false} value={proposal.planVersion} onValueChange={(value) => setProposal({ ...proposal, planVersion: String(value ?? "") })}>
      <Select.Option value="">Keep the current version</Select.Option>
      {versions.map((version) => <Select.Option key={version} value={version}>{version}</Select.Option>)}
    </Select>
    {props.data.overrides.length > 0 && <fieldset className="flex flex-col gap-1 text-sm"><legend className="mb-1 font-medium">Remove existing overrides</legend>
      {props.data.overrides.map((override) => <label key={override.id} className="flex items-center gap-2"><Checkbox checked={proposal.removeOverrides.includes(override.id)} aria-label={`Remove ${override.code} override`}
        onCheckedChange={(on) => setProposal({ ...proposal, removeOverrides: on ? [...proposal.removeOverrides, override.id] : proposal.removeOverrides.filter((id) => id !== override.id) })} />{override.code} ({override.enabled ? values(override.values) : "disabled"})</label>)}
    </fieldset>}
    {proposal.overrides.map((override, index) => {
      const feature = features.data?.features.find((candidate) => candidate.code === override.code);
      const change = (next: Proposal["overrides"][number]) => setProposal({ ...proposal, overrides: proposal.overrides.map((entry, position) => position === index ? next : entry) });
      return <fieldset key={index} className="flex flex-col gap-2 rounded-lg p-3 ring ring-kumo-hairline">
        <legend className="px-1 text-sm font-medium">Proposed override {index + 1}</legend>
        <div className="grid gap-3 sm:grid-cols-2"><FeatureSelect features={features.data?.features ?? []} value={override.code} onChange={(code) => change({ ...override, code, values: {} })} />
          <Switch label="Grant" checked={override.enabled} onCheckedChange={(enabled: boolean) => change({ ...override, enabled })} /></div>
        {feature && override.enabled && <FeatureValues feature={feature} values={override.values} onChange={(next) => change({ ...override, values: next })} />}
        <div><Button size="sm" variant="ghost" onClick={() => setProposal({ ...proposal, overrides: proposal.overrides.filter((_, position) => position !== index) })}>Remove</Button></div>
      </fieldset>;
    })}
    <div><Button variant="secondary" onClick={() => setProposal({ ...proposal, overrides: [...proposal.overrides, { code: "", enabled: true, values: {} }] })}>Add proposed override</Button></div>
    {result && <section aria-label="Comparison" className="flex flex-col gap-2">
      <p className="text-sm">{result.from ?? "no plan"} → {result.to ?? "no plan"}: {changed.length ? `${changed.length} feature${changed.length === 1 ? "" : "s"} change` : "no entitlement changes"}</p>
      {changed.length > 0 && <AdminDataTable caption="Entitlement changes" primary={false} rows={changed} rowKey={(row) => row.code} columns={[
        { header: "Feature", cell: (row) => row.name },
        { header: "Change", nowrap: true, cell: (row) => <AdminStatus variant={changeVariant[row.change]}>{row.change}</AdminStatus> },
        { header: "Detail", cell: (row) => row.change === "changed" ? row.differences.map((difference) => `${difference.name}: ${formatValue(difference.before ?? null)} → ${formatValue(difference.after ?? null)}`).join("; ") : row.change === "added" ? values(row.after?.values) : values(row.before?.values) },
      ]} />}
    </section>}
  </AdminCreateDialog>;
}

export default function EntitlementsView() {
  const [scope] = useTenantScope();
  const [search, update] = useViewSearch<{ organization?: string; show?: string }>();
  const organizationId = search.organization ?? scope;
  const explorer = useAdminQuery(["entitlements", organizationId], () => api.entitlements(organizationId), { enabled: Boolean(organizationId) });
  const [comparing, setComparing] = useState(false);
  useAdminCommands({ "entitlements.compare": { enabled: Boolean(organizationId && explorer.data), run: () => setComparing(true) } });
  const filter = search.show ?? "all";
  return <>
    <AdminPageHeader title="Entitlements" description="What an organization can use, value by value, and where each value comes from. Entitlements never grant permissions in any authority plane."
      actions={organizationId && explorer.data ? <Button variant="primary" onClick={() => setComparing(true)}>Compare changes</Button> : undefined} />
    <div className="mb-4 max-w-md"><OrganizationPicker value={organizationId} onChange={(id) => update({ organization: id || undefined })} /></div>
    {!organizationId ? <AdminEmpty title="Choose an organization" description="Its plan, every catalog feature with provenance, usage, and overrides appear here." />
      : <AdminQueryState query={explorer}>{(data) => {
        const rows = data.features.filter((row) => filter === "all" || (filter === "available" ? row.status !== "unavailable" : row.status === filter));
        return <div className="flex flex-col">
          <div className="mb-6 grid gap-3 sm:grid-cols-4">
            <AdminStat label="Plan" value={data.subscription ? data.subscription.planName ?? data.subscription.plan : "None"} hint={data.subscription?.planVersion ?? "no subscription"} />
            <AdminStat label="Subscription" value={data.subscription?.status ?? "—"} variant={data.subscription && ["active", "trialing"].includes(data.subscription.status) ? "success" : data.subscription?.status === "past_due" ? "warning" : "neutral"} hint={data.subscription?.cancelAtPeriodEnd ? "cancels at period end" : data.subscription?.currentPeriodEnd ? `renews ${formatDate(data.subscription.currentPeriodEnd)}` : undefined} />
            <AdminStat label="Features" value={`${data.features.filter((row) => row.status === "included" || row.status === "overridden").length} of ${data.features.length}`} hint="available of catalog" />
            <AdminStat label="Overrides" value={data.overrides.filter((override) => !override.scheduled).length} hint={`${data.overrides.filter((override) => override.scheduled).length} scheduled`} />
          </div>
          <AdminSection title="Features" description="Every feature in the catalog, including ones this organization cannot use."
            actions={<Select aria-label="Show features" value={filter} onValueChange={(value) => update({ show: String(value) === "all" ? undefined : String(value) }, { replace: true })}>
              <Select.Option value="all">All features</Select.Option><Select.Option value="available">Available</Select.Option><Select.Option value="overridden">Overridden</Select.Option><Select.Option value="removed">Removed</Select.Option><Select.Option value="unavailable">Unavailable</Select.Option>
            </Select>}>
            {rows.length ? <FeatureTable rows={rows} /> : <AdminEmpty title="No features match" />}
          </AdminSection>
          <AdminSection title="Usage and limits" description="The local figures authorization reads. Periods reset at the date shown.">
            {data.quotas.length ? <div className="flex flex-col gap-3">{data.quotas.map((quota) => <div key={quota.code}>
              <AdminUsageMeter label={`${quota.code} (${quota.enforcement}${quota.exceeded ? ", exceeded" : ""})`} used={quota.used} limit={quota.limit} included={quota.included} />
              <p className="mt-1 text-xs text-kumo-subtle">Resets {formatDate(quota.period.end)}</p>
            </div>)}</div> : <AdminEmpty title="No metered features" />}
            {data.metering.some((row) => row.provider) && <div className="mt-4"><AdminDataTable caption="Metering provenance" primary={false} rows={data.metering} rowKey={(row) => `${row.featureCode}:${row.periodStart}`} columns={[
              { header: "Feature", cell: (row) => <AdminCode>{row.featureCode}</AdminCode> },
              { header: "Local", nowrap: true, cell: (row) => row.local },
              { header: "Reported", nowrap: true, cell: (row) => row.reported },
              { header: "Provider", nowrap: true, cell: (row) => row.provider ? `${row.provider}: ${row.drift ? row.local + row.drift.difference : "—"}` : "—" },
              { header: "Drift", nowrap: true, cell: (row) => row.drift ? <AdminStatus variant={row.drift.outcome === "in_sync" ? "success" : "warning"}>{row.drift.outcome === "in_sync" ? "In sync" : `${row.drift.difference > 0 ? "+" : ""}${row.drift.difference}`}</AdminStatus> : "not reconciled" },
            ]} /></div>}
          </AdminSection>
          <AdminSection title="Overrides and scheduled changes" description="Manage overrides and plan changes from Subscriptions.">
            {data.overrides.length === 0 && data.scheduledChanges.length === 0 ? <AdminEmpty title="None" /> : <ul className="flex flex-col gap-1 text-sm">
              {data.overrides.map((override) => <li key={override.id}><AdminStatus variant={override.scheduled ? "info" : "warning"}>{override.scheduled ? "scheduled" : "active"}</AdminStatus> <AdminCode>{override.code}</AdminCode> {override.enabled ? values(override.values) : "disabled"} · {formatDate(override.effectiveAt)} → {override.expiresAt ? formatDate(override.expiresAt) : "open"} · {override.reason}</li>)}
              {data.scheduledChanges.map((change) => <li key={change.id}><AdminStatus variant="info">plan change</AdminStatus> to {change.toPlanVersion} on {formatDate(change.effectiveAt)}</li>)}
            </ul>}
          </AdminSection>
          <CompareDialog open={comparing} onClose={() => setComparing(false)} organizationId={organizationId} data={data} />
        </div>;
      }}</AdminQueryState>}
  </>;
}
