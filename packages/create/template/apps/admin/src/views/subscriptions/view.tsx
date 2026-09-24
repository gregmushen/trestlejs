import { useRef, useState } from "react";

import { ResourceListPage } from "../../blocks/resource-list";
import { api, type Feature, type SubscriptionSummary } from "../../api";
import { useAdminCommands } from "../../shell/commands";
import { useConfirmAction, type ConfirmConfig } from "../../shell/ConfirmAction";
import { useAdmin, useAdminQuery, useInvalidate, useTenantScope } from "../../shell/context";
import { Button, Input, Select, Switch, Tabs } from "../../shell/kumo";
import { AdminCode, AdminDataTable, AdminEmpty, AdminFilter, AdminPageHeader, AdminQueryState, AdminSection, AdminStatus, formatDate } from "../../shell/ui";
import { useViewSearch } from "../../shell/url-state";

type OverrideDraft = { code: string; enabled: boolean; expiresAt: string };

function OverrideFields(props: { features: readonly Feature[]; draft: { current: OverrideDraft } }) {
  const [state, setState] = useState(props.draft.current);
  const set = (next: OverrideDraft) => { props.draft.current = next; setState(next); };
  return <div className="flex flex-col gap-3">
    <Select placeholder="Choose an entitlement" label="Entitlement" hideLabel={false} value={state.code} onValueChange={(value) => set({ ...state, code: String(value ?? "") })}>
      <Select.Option value="">Choose an entitlement</Select.Option>
      {props.features.map((feature) => <Select.Option key={feature.code} value={feature.code}>{feature.code} · {feature.description}</Select.Option>)}
    </Select>
    <Switch label="Grant the entitlement (off denies it, even if the plan includes it)" checked={state.enabled} onCheckedChange={(enabled: boolean) => set({ ...state, enabled })} />
    <Input label="Expires (optional)" type="datetime-local" value={state.expiresAt} onChange={(event) => set({ ...state, expiresAt: event.target.value })} />
  </div>;
}

function Detail({ subscription, onOverride }: { subscription: SubscriptionSummary; onOverride: () => void }) {
  const { can } = useAdmin();
  const invalidate = useInvalidate();
  const confirm = useConfirmAction();
  const [search, update] = useViewSearch<{ tab?: string }>();
  const detail = useAdminQuery(["subscription", subscription.organizationId], () => api.subscription(subscription.organizationId));
  const refresh = () => { void invalidate("subscription", subscription.organizationId); void invalidate("subscriptions"); };
  const manage = can("platform.entitlements.manage");
  const tab = search.tab ?? "summary";
  return <AdminQueryState query={detail}>{(data) => <AdminSection title={subscription.organizationName ?? subscription.organizationId}
    description={data.subscription ? `${data.subscription.planVersion ?? data.subscription.plan} · ${data.subscription.status} · provider ${data.subscription.provider}` : "No subscription"}
    actions={manage ? <Button variant="secondary" onClick={onOverride}>Add override</Button> : undefined}>
    <Tabs variant="underline" value={tab} onValueChange={(value) => update({ tab: String(value) === "summary" ? undefined : String(value) }, { replace: true })}
      tabs={[{ value: "summary", label: "Summary" }, { value: "overrides", label: `Overrides (${data.overrides.filter((override) => !override.removedAt).length})` }, { value: "plan", label: `Plan entitlements (${data.effective.length})` }]} />
    <div className="mt-3">
      {tab === "summary" && (data.subscription ? <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div><dt className="text-kumo-subtle">Status</dt><dd><AdminStatus value={data.subscription.status}>{data.subscription.status}</AdminStatus></dd></div>
        <div><dt className="text-kumo-subtle">Renews</dt><dd>{formatDate(data.subscription.currentPeriodEnd ?? null)}{data.subscription.cancelAtPeriodEnd ? " · cancels at period end" : ""}</dd></div>
        <div><dt className="text-kumo-subtle">Plan</dt><dd><AdminCode>{data.subscription.planVersion ?? data.subscription.plan}</AdminCode></dd></div>
        <div><dt className="text-kumo-subtle">Provider</dt><dd>{data.subscription.provider}</dd></div>
      </dl> : <AdminEmpty title="No subscription" description="This organization has no subscription projection yet." />)}
      {tab === "overrides" && (data.overrides.length === 0 ? <AdminEmpty title="No overrides" description="An override grants or denies one entitlement for this organization; it needs a reason and can expire." />
        : <AdminDataTable caption="Overrides" primary={false} rows={data.overrides} rowKey={(override) => override.id} columns={[
          { header: "Entitlement", cell: (override) => <AdminCode>{override.code}</AdminCode> },
          { header: "Effect", cell: (override) => <AdminStatus variant={override.enabled ? "success" : "warning"}>{override.enabled ? "granted" : "denied"}</AdminStatus> },
          { header: "Window", cell: (override) => `${formatDate(override.effectiveAt)} → ${override.expiresAt ? formatDate(override.expiresAt) : "open"}` },
          { header: "Reason", cell: (override) => <>{override.reason}<p className="text-xs text-kumo-subtle">by {override.author}</p></> },
          { header: "", cell: (override) => override.removedAt ? <AdminStatus variant="neutral">revoked</AdminStatus> : manage ? <Button size="sm" variant="secondary-destructive" onClick={() => confirm.open({ title: "Revoke override", confirmLabel: "Revoke override", destructive: true, scope: [`${override.code} returns to the plan's decision`, "the override is kept as history"], onConfirm: (reason) => api.removeOverride(subscription.organizationId, override.id, reason), onDone: refresh })}>Revoke</Button> : null },
        ]} />)}
      {tab === "plan" && (data.effective.length === 0 ? <AdminEmpty title="The plan includes no entitlements" /> : <ul className="flex flex-wrap gap-1">{data.effective.map((entitlement) => <li key={entitlement.code}><AdminStatus variant="success">{entitlement.code}</AdminStatus></li>)}</ul>)}
    </div>
    {confirm.dialog}
  </AdminSection>}</AdminQueryState>;
}

export default function SubscriptionsView() {
  const { can } = useAdmin();
  const invalidate = useInvalidate();
  const [scope] = useTenantScope();
  const [search] = useViewSearch<{ q?: string; selected?: string }>();
  const q = search.q ?? scope;
  const subscriptions = useAdminQuery(["subscriptions", q], () => api.subscriptions(q));
  const features = useAdminQuery(["features"], api.features);
  const selected = subscriptions.data?.subscriptions.find((row) => row.organizationId === search.selected);
  const confirm = useConfirmAction();
  const draft = useRef<OverrideDraft>({ code: "", enabled: true, expiresAt: "" });
  const manage = can("platform.entitlements.manage");
  const override = (subscription: SubscriptionSummary): ConfirmConfig => {
    draft.current = { code: "", enabled: true, expiresAt: "" };
    return {
      title: `Override for ${subscription.organizationName ?? subscription.organizationId}`, confirmLabel: "Apply override",
      scope: ["Applies to this organization only; the plan is unchanged", "A new override supersedes the active one for the same entitlement", "Customers see that the entitlement comes from their contract, never the reason"],
      fields: <OverrideFields features={features.data?.features ?? []} draft={draft} />,
      onConfirm: (reason) => {
        const { code, enabled, expiresAt } = draft.current;
        if (!code) return Promise.reject(new Error("Choose an entitlement"));
        return api.addOverride(subscription.organizationId, { code, enabled, ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}) }, reason);
      },
      onDone: () => { void invalidate("subscription", subscription.organizationId); void invalidate("subscriptions"); },
    };
  };
  useAdminCommands({
    "subscriptions.override": { enabled: Boolean(selected) && manage, ...(selected ? { target: selected.organizationId } : {}), run: () => { if (selected) confirm.open(override(selected)); } },
  });
  return <>
    <AdminPageHeader title="Subscriptions" description="The provider-neutral subscription projection. Checkout redirects are never proof of payment; verified provider events update this state, and audited overrides adjust one organization's entitlements." />
    <AdminFilter label="Search subscriptions" placeholder="Organization or plan" />
    <ResourceListPage detail={selected ? <Detail subscription={selected} onOverride={() => confirm.open(override(selected))} /> : <AdminEmpty title="Select a subscription" description="Its plan, entitlements, and overrides appear here." />}>
      <AdminQueryState query={subscriptions} isEmpty={(data) => data.subscriptions.length === 0} empty="No subscriptions.">{(data) => <AdminDataTable caption="Subscriptions" selectable rows={data.subscriptions} rowKey={(row) => row.organizationId} rowLabel={(row) => row.organizationName ?? row.organizationId}
        rowActions={(row) => manage ? [{ label: "Add override", hotkey: "o", run: () => confirm.open(override(row)) }] : []}
        columns={[
          { header: "Organization", cell: (row) => row.organizationName ?? row.organizationId },
          { header: "Plan", cell: (row) => row.planVersion ?? row.plan },
          { header: "Status", cell: (row) => <AdminStatus variant={row.status === "active" || row.status === "trialing" ? "success" : row.status === "past_due" ? "warning" : "neutral"}>{row.status}</AdminStatus> },
          { header: "Renews", cell: (row) => formatDate(row.currentPeriodEnd ?? null) },
        ]} />}</AdminQueryState>
    </ResourceListPage>
    {confirm.dialog}
  </>;
}
