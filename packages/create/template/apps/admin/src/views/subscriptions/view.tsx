import { useRef, useState, type ReactNode } from "react";

import { ResourceListPage } from "../../blocks/resource-list";
import { api, type Feature, type ProviderChain, type SubscriptionSummary } from "../../api";
import { MappingStatus } from "../plans/stripe";
import { useAdminCommands } from "../../shell/commands";
import { useConfirmAction, type ConfirmConfig } from "../../shell/ConfirmAction";
import { useAdmin, useAdminQuery, useInvalidate, useTenantScope } from "../../shell/context";
import { FeatureSelect, FeatureValues, type PrivilegeValues } from "../../shell/feature-editor";
import { Button, Input, Select, Switch, Tabs } from "../../shell/kumo";
import { AdminCode, AdminDataTable, AdminEmpty, AdminFilter, AdminPageHeader, AdminQueryState, AdminSection, AdminStatus, formatDate, formatValue } from "../../shell/ui";
import { useViewSearch } from "../../shell/url-state";

type OverrideDraft = { code: string; enabled: boolean; values: PrivilegeValues; expiresAt: string };
type ChangeDraft = { toPlanVersion: string; effectiveAt: string };

function OverrideFields(props: { features: readonly Feature[]; draft: { current: OverrideDraft } }) {
  const [state, setState] = useState(props.draft.current);
  const set = (next: OverrideDraft) => { props.draft.current = next; setState(next); };
  const feature = props.features.find((candidate) => candidate.code === state.code);
  return <div className="flex flex-col gap-3">
    <FeatureSelect features={props.features} value={state.code} onChange={(code) => set({ ...state, code, values: {} })} />
    <Switch label="Grant the feature (off removes the plan entitlement)" checked={state.enabled} onCheckedChange={(enabled: boolean) => set({ ...state, enabled })} />
    {feature && state.enabled && <FeatureValues feature={feature} values={state.values} onChange={(values) => set({ ...state, values })} />}
    <Input label="Expires (optional)" type="datetime-local" value={state.expiresAt} onChange={(event) => set({ ...state, expiresAt: event.target.value })} />
  </div>;
}

function ChangeFields(props: { versions: readonly string[]; draft: { current: ChangeDraft } }) {
  const [state, setState] = useState(props.draft.current);
  const set = (next: ChangeDraft) => { props.draft.current = next; setState(next); };
  return <div className="grid gap-3 sm:grid-cols-2">
    <Select placeholder="Choose a version" label="Plan version" hideLabel={false} value={state.toPlanVersion} onValueChange={(value) => set({ ...state, toPlanVersion: String(value ?? "") })}>
      <Select.Option value="">Choose a version</Select.Option>
      {props.versions.map((version) => <Select.Option key={version} value={version}>{version}</Select.Option>)}
    </Select>
    <Input label="Effective" type="datetime-local" value={state.effectiveAt} onChange={(event) => set({ ...state, effectiveAt: event.target.value })} />
  </div>;
}

/** Organization -> Customer, subscription -> Subscription, lines -> items and prices, each an explicit link. */
function ProviderChainView(props: { chain: ProviderChain | null; plan: string }) {
  const chain = props.chain;
  if (!chain) return <AdminEmpty title="No subscription" />;
  if (chain.provider === "local") return <AdminEmpty title="Local billing" description="This subscription is managed by the local billing adapter and has no provider chain." />;
  const link = (label: string, value: ReactNode, state?: ReactNode) => <div className="grid grid-cols-[10rem_1fr] items-start gap-2 text-sm"><dt className="text-kumo-subtle">{label}</dt><dd className="flex flex-wrap items-center gap-2">{value}{state}</dd></div>;
  return <div className="flex flex-col gap-4">
    <dl className="flex flex-col gap-2">
      {link("Environment", chain.environment)}
      {link("Plan family → Product", chain.product ? <AdminCode>{chain.product.externalId}</AdminCode> : <span className="text-kumo-danger">not mapped</span>, chain.product ? <MappingStatus mapping={chain.product} /> : undefined)}
      {link("Version → Price", chain.prices.length ? chain.prices.map((price) => <span key={price.id} className="flex items-center gap-1"><AdminCode>{price.externalId}</AdminCode>{price.offer ? ` ${price.offer}` : ""}<MappingStatus mapping={price} /></span>) : <span className="text-kumo-danger">not mapped</span>)}
      {link("Organization → Customer", chain.customerId ? <AdminCode>{chain.customerId}</AdminCode> : "—")}
      {link("Subscription", chain.subscriptionId ? <AdminCode>{chain.subscriptionId}</AdminCode> : "—")}
      {link("Reconciliation", chain.reconciliation ? `${chain.reconciliation.outcome} · ${formatDate(chain.reconciliation.ranAt ?? null)}` : "never run", chain.reconciliation ? <AdminStatus variant={chain.reconciliation.outcome === "in_sync" ? "success" : "warning"}>{chain.reconciliation.outcome}</AdminStatus> : undefined)}
    </dl>
    {chain.lines.length ? <AdminDataTable caption="Subscription lines" primary={false} rows={chain.lines} rowKey={(line) => line.id} columns={[
      { header: "Line", cell: (line) => <>{line.planVersion.startsWith("unmapped:") ? <span className="text-kumo-danger">unmapped price</span> : line.planVersion}{line.offer ? ` · ${line.offer}` : ""}</> },
      { header: "Item", nowrap: true, cell: (line) => line.providerItemId ? <AdminCode>{line.providerItemId}</AdminCode> : "—" },
      { header: "Price", nowrap: true, cell: (line) => line.providerPriceId ? <AdminCode>{line.providerPriceId}</AdminCode> : "—" },
      { header: "Mapping", nowrap: true, cell: (line) => line.mapping ? <MappingStatus mapping={line.mapping} /> : <AdminStatus variant="destructive">none</AdminStatus> },
      { header: "Qty", nowrap: true, cell: (line) => line.quantity },
    ]} /> : <AdminEmpty title="No subscription lines yet" description="Lines are recorded from verified provider subscription events." />}
  </div>;
}

function Detail({ subscription, workflows }: { subscription: SubscriptionSummary; workflows: { override: () => void; schedule: () => void; reconcile: () => void } }) {
  const { can } = useAdmin();
  const invalidate = useInvalidate();
  const confirm = useConfirmAction();
  const [search, update] = useViewSearch<{ tab?: string }>();
  const detail = useAdminQuery(["subscription", subscription.organizationId], () => api.subscription(subscription.organizationId));
  const refresh = () => void invalidate("subscription", subscription.organizationId);
  const manage = can("platform.subscriptions.manage");
  const tab = search.tab ?? "summary";
  return <AdminQueryState query={detail}>{(data) => <AdminSection title={subscription.organizationName ?? subscription.organizationId}
    description={`${data.planVersion ? `${data.planVersion.name} ${data.planVersion.plan}@${data.planVersion.version}` : subscription.plan} · ${subscription.status} · provider ${subscription.provider}`}
    actions={<>
      {manage && <Button variant="secondary" onClick={workflows.override}>Add override</Button>}
      {manage && <Button variant="secondary" onClick={workflows.schedule}>Schedule change</Button>}
      {can("platform.reconciliation.run") && <Button variant="secondary" onClick={workflows.reconcile}>Reconcile</Button>}
    </>}>
    <Tabs variant="underline" value={tab} onValueChange={(value) => update({ tab: String(value) === "summary" ? undefined : String(value) }, { replace: true })}
      tabs={[{ value: "summary", label: "Summary" }, { value: "overrides", label: `Overrides (${data.overrides.filter((override) => !override.removedAt).length})` }, { value: "changes", label: "Scheduled changes" }, { value: "provider", label: "Provider chain" }, { value: "reconciliation", label: "Reconciliation" }]} />
    <div className="mt-3">
      {tab === "summary" && <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div><dt className="text-kumo-subtle">Status</dt><dd><AdminStatus value={subscription.status}>{subscription.status}</AdminStatus></dd></div>
        <div><dt className="text-kumo-subtle">Renews</dt><dd>{formatDate(subscription.currentPeriodEnd ?? null)}{subscription.cancelAtPeriodEnd ? " · cancels at period end" : ""}</dd></div>
        <div><dt className="text-kumo-subtle">Provider reference</dt><dd className="font-mono text-xs">{subscription.providerSubscriptionId ?? "—"}</dd></div>
        <div><dt className="text-kumo-subtle">Effective entitlements</dt><dd>{data.effective.length}</dd></div>
      </dl>}
      {tab === "overrides" && (data.overrides.length === 0 ? <AdminEmpty title="No overrides" description="Negotiated values apply to this subscription only; each needs a reason and an effective time." />
        : <AdminDataTable caption="Overrides" primary={false} rows={data.overrides} rowKey={(override) => override.id} columns={[
          { header: "Feature", cell: (override) => override.code },
          { header: "Effect", cell: (override) => override.enabled ? Object.entries(override.values).map(([name, value]) => `${name}: ${formatValue(value)}`).join(", ") || "enabled" : "disabled" },
          { header: "Window", cell: (override) => `${formatDate(override.effectiveAt)} → ${override.expiresAt ? formatDate(override.expiresAt) : "open"}` },
          { header: "Reason", cell: (override) => <>{override.reason}<p className="text-xs text-kumo-subtle">by {override.author}</p></> },
          { header: "", cell: (override) => override.removedAt ? <AdminStatus variant="neutral">removed</AdminStatus> : manage ? <Button size="sm" variant="secondary-destructive" onClick={() => confirm.open({ title: "Remove override", confirmLabel: "Remove override", destructive: true, scope: [`${override.code} returns to the plan value`], onConfirm: (reason) => api.removeOverride(subscription.organizationId, override.id, reason), onDone: refresh })}>Remove</Button> : null },
        ]} />)}
      {tab === "provider" && <ProviderChainView chain={data.chain ?? null} plan={subscription.plan} />}
      {tab === "changes" && (data.scheduledChanges.length === 0 ? <AdminEmpty title="No scheduled changes" /> : <ul className="flex flex-col gap-1 text-sm">{data.scheduledChanges.map((change) => <li key={change.id}><AdminStatus value={change.status ?? "scheduled"}>{change.status ?? "scheduled"}</AdminStatus> {change.toPlanVersion} on {formatDate(change.effectiveAt)}{change.reason ? ` — ${change.reason}` : ""}</li>)}</ul>)}
      {tab === "reconciliation" && (data.reconciliations.length === 0 ? <AdminEmpty title="Never reconciled" /> : <ul className="flex flex-col gap-2 text-sm">{data.reconciliations.map((record, index) => <li key={record.id ?? index}>
        <AdminStatus variant={record.outcome === "in_sync" ? "success" : "warning"}>{record.outcome}</AdminStatus> {formatDate(record.ranAt ?? null)} {record.actor ? `by ${record.actor}` : ""}
        {record.differences.length > 0 && <ul className="ml-4 list-disc">{record.differences.map((difference) => <li key={difference.field}>{difference.field}: local {difference.local ?? "—"} · provider {difference.provider ?? "—"}</li>)}</ul>}
      </li>)}</ul>)}
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
  const plans = useAdminQuery(["plans"], api.plans);
  const selected = subscriptions.data?.subscriptions.find((row) => row.organizationId === search.selected);
  const confirm = useConfirmAction();
  const overrideDraft = useRef<OverrideDraft>({ code: "", enabled: true, values: {}, expiresAt: "" });
  const changeDraft = useRef<ChangeDraft>({ toPlanVersion: "", effectiveAt: "" });
  const refresh = (organizationId: string) => () => { void invalidate("subscription", organizationId); void invalidate("subscriptions"); };

  const override = (subscription: SubscriptionSummary): ConfirmConfig => {
    overrideDraft.current = { code: "", enabled: true, values: {}, expiresAt: "" };
    return {
      title: `Override for ${subscription.organizationName ?? subscription.organizationId}`, confirmLabel: "Apply override", scope: ["Applies to this subscription only; the base plan is unchanged"],
      fields: <OverrideFields features={features.data?.features ?? []} draft={overrideDraft} />,
      onConfirm: (reason) => {
        const { code, enabled, values, expiresAt } = overrideDraft.current;
        if (!code) return Promise.reject(new Error("Choose a feature"));
        return api.addOverride(subscription.organizationId, { code, enabled, values: enabled ? values : {}, effectiveAt: new Date().toISOString(), ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}) }, reason);
      },
      onDone: refresh(subscription.organizationId),
    };
  };
  const schedule = (subscription: SubscriptionSummary): ConfirmConfig => {
    changeDraft.current = { toPlanVersion: "", effectiveAt: "" };
    const versions = (plans.data?.versions ?? []).filter((version) => version.state === "active" || version.state === "grandfathered").map((version) => `${version.plan}@${version.version}`);
    return {
      title: "Schedule plan change", confirmLabel: "Schedule change", scope: [`Move ${subscription.organizationName ?? subscription.organizationId} to another plan version at a set time`],
      fields: <ChangeFields versions={versions} draft={changeDraft} />,
      onConfirm: (reason) => {
        const { toPlanVersion, effectiveAt } = changeDraft.current;
        if (!toPlanVersion || !effectiveAt) return Promise.reject(new Error("Choose a plan version and an effective time"));
        return api.scheduleChange(subscription.organizationId, { toPlanVersion, effectiveAt: new Date(effectiveAt).toISOString() }, reason);
      },
      onDone: refresh(subscription.organizationId),
    };
  };
  const reconcile = (subscription: SubscriptionSummary): ConfirmConfig => ({ title: "Reconcile with provider", confirmLabel: "Run reconciliation", scope: ["Compare the provider with the local projection", "Differences are recorded; nothing is authorized from the provider response"], onConfirm: (reason) => api.reconcile(subscription.organizationId, reason), onDone: refresh(subscription.organizationId) });
  const target = selected ? { target: selected.organizationId } : {};
  useAdminCommands({
    "subscriptions.override": { enabled: Boolean(selected) && can("platform.subscriptions.manage"), ...target, run: () => { if (selected) confirm.open(override(selected)); } },
    "subscriptions.schedule": { enabled: Boolean(selected) && can("platform.subscriptions.manage"), ...target, run: () => { if (selected) confirm.open(schedule(selected)); } },
    "subscriptions.reconcile": { enabled: Boolean(selected) && can("platform.reconciliation.run"), ...target, run: () => { if (selected) confirm.open(reconcile(selected)); } },
  });
  return <>
    <AdminPageHeader title="Subscriptions" description="Provider-neutral subscription projection. Checkout redirects are never proof of payment; verified provider events and audited reconciliation update this state." />
    <AdminFilter label="Search subscriptions" placeholder="Organization, plan, or provider reference" />
    <ResourceListPage detail={selected ? <Detail subscription={selected} workflows={{ override: () => confirm.open(override(selected)), schedule: () => confirm.open(schedule(selected)), reconcile: () => confirm.open(reconcile(selected)) }} />
      : <AdminEmpty title="Select a subscription" description="Overrides, scheduled changes, and reconciliation history appear here." />}>
      <AdminQueryState query={subscriptions} isEmpty={(data) => data.subscriptions.length === 0} empty="No subscriptions.">{(data) => <AdminDataTable caption="Subscriptions" selectable rows={data.subscriptions} rowKey={(row) => row.organizationId} rowLabel={(row) => row.organizationName ?? row.organizationId}
        rowActions={(row) => [
          ...(can("platform.subscriptions.manage") ? [{ label: "Add override", hotkey: "o", run: () => confirm.open(override(row)) }, { label: "Schedule change", hotkey: "c", run: () => confirm.open(schedule(row)) }] : []),
          ...(can("platform.reconciliation.run") ? [{ label: "Reconcile", hotkey: "r", run: () => confirm.open(reconcile(row)) }] : []),
        ]}
        columns={[
          { header: "Organization", cell: (row) => row.organizationName ?? row.organizationId },
          { header: "Plan", cell: (row) => row.planVersion ?? row.plan },
          { header: "Status", cell: (row) => <AdminStatus variant={row.status === "active" || row.status === "trialing" ? "success" : row.status === "past_due" ? "warning" : "neutral"}>{row.status}</AdminStatus> },
          { header: "Provider", cell: (row) => row.provider },
        ]} />}</AdminQueryState>
    </ResourceListPage>
    {confirm.dialog}
  </>;
}
