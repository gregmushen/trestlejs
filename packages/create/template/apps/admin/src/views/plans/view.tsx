import { useState } from "react";

import { api, errorMessage, type Feature, type PlanVersionJson } from "../../api";
import { useAdminCommands } from "../../shell/commands";
import { useConfirmAction, type ConfirmConfig } from "../../shell/ConfirmAction";
import { useAdmin, useAdminQuery, useInvalidate } from "../../shell/context";
import { FeatureValues, type PrivilegeValues } from "../../shell/feature-editor";
import { Button, Input, Switch } from "../../shell/kumo";
import { AdminCreateDialog, AdminDetailDrawer, keyFromName } from "../../shell/resource";
import { StripeMappings } from "./stripe";
import { AdminCode, AdminDataTable, AdminEmpty, AdminForm, AdminPageHeader, AdminQueryState, AdminSection, AdminStatus, formatDate, formatValue, useAdminToast, type StatusVariant } from "../../shell/ui";
import { useViewSearch } from "../../shell/url-state";

const stateVariant: Record<PlanVersionJson["state"], StatusVariant> = { draft: "info", active: "success", grandfathered: "warning", retired: "neutral" };
const refOf = (version: PlanVersionJson) => `${version.plan}@${version.version}`;

function DraftEditor({ version, features, onSaved }: { version: PlanVersionJson; features: readonly Feature[]; onSaved: () => void }) {
  const toast = useAdminToast();
  const [entitlements, setEntitlements] = useState<Record<string, PrivilegeValues>>(version.entitlements as Record<string, PrivilegeValues>);
  const [error, setError] = useState<string>();
  const save = async () => {
    try { setError(undefined); await api.updateDraft(version.plan, version.version, { entitlements }); toast.success(`Saved ${refOf(version)}`); onSaved(); }
    catch (failure) { setError(errorMessage(failure)); }
  };
  return <AdminForm label={`Edit ${refOf(version)}`} className="flex flex-col gap-3" onSubmit={() => void save()}>
    {features.map((feature) => {
      const enabled = feature.code in entitlements;
      return <fieldset key={feature.code} className="rounded-lg p-3 ring ring-kumo-hairline">
        <legend className="px-1"><Switch label={`${feature.name} (${feature.code})`} checked={enabled} onCheckedChange={(checked: boolean) => { const copy = { ...entitlements }; if (checked) copy[feature.code] = {}; else delete copy[feature.code]; setEntitlements(copy); }} /></legend>
        {enabled && <div className="mt-2"><FeatureValues feature={feature} values={entitlements[feature.code] ?? {}} onChange={(values) => setEntitlements({ ...entitlements, [feature.code]: values })} /></div>}
      </fieldset>;
    })}
    {error && <p role="alert" className="text-sm text-kumo-danger">{error}</p>}
    <div className="flex justify-end"><Button type="submit" variant="primary">Save draft</Button></div>
  </AdminForm>;
}

export default function PlansView() {
  const { can } = useAdmin();
  const invalidate = useInvalidate();
  const [search, update] = useViewSearch<{ tab?: string; selected?: string; editing?: string }>();
  const catalog = useAdminQuery(["features"], api.features);
  const plans = useAdminQuery(["plans"], api.plans);
  const confirm = useConfirmAction();
  const manage = can("platform.plans.manage");
  const families = [...new Set((plans.data?.versions ?? []).map((version) => version.plan))];
  const tab = search.tab ?? "comparison";
  const versions = (plans.data?.versions ?? []).filter((version) => version.plan === tab).sort((a, b) => b.version - a.version);
  const selected = versions.find((version) => refOf(version) === search.selected);
  const hasDraft = versions.some((version) => version.state === "draft");
  const refresh = () => void invalidate("plans");
  const [creating, setCreating] = useState<{ name: string; key: string; keyEdited: boolean } | null>(null);
  const createPlan = async () => {
    const input = { name: creating!.name.trim(), key: creating!.key };
    setCreating(null);
    confirm.open({
      title: `Create ${input.name}`, confirmLabel: "Create plan", scope: [`plan key ${input.key} (immutable)`, "version 1 starts as an empty draft", "activation is a separate, confirmed step"],
      onConfirm: (reason) => api.createPlan(input, reason),
      // Straight into the feature editor for the new draft.
      onDone: () => { refresh(); update({ tab: input.key, selected: `${input.key}@1`, editing: `${input.key}@1` }); },
      successMessage: `Created ${input.name}`,
    });
  };

  const draft = (): ConfirmConfig => ({ title: `Draft a new ${tab} version`, confirmLabel: "Create draft", scope: [`Copy the latest ${tab} version into a new draft`], onConfirm: (reason) => api.draftPlanVersion(tab, reason), onDone: refresh });
  const transition = (version: PlanVersionJson, to: "active" | "grandfathered" | "retired"): ConfirmConfig => ({
    title: `${to === "active" ? "Activate" : to === "grandfathered" ? "Grandfather" : "Retire"} ${refOf(version)}`, confirmLabel: `Move to ${to}`, destructive: to !== "active",
    scope: [`${refOf(version)}: ${version.state} → ${to}`, to === "active" ? "The version becomes immutable and available to new subscriptions; the current active version is grandfathered" : to === "retired" ? "Only allowed when no subscription references this version" : "Existing subscriptions keep this version; new subscriptions cannot use it"],
    onConfirm: (reason) => api.transitionPlanVersion(version.plan, version.version, to, reason), onDone: refresh,
  });
  const is = (state: PlanVersionJson["state"]) => manage && selected?.state === state;
  useAdminCommands({
    "plans.new": { enabled: manage, run: () => setCreating({ name: "", key: "", keyEdited: false }) },
    "plans.draft": { enabled: manage && tab !== "comparison" && !hasDraft, run: () => confirm.open(draft()) },
    "plans.edit": { enabled: is("draft"), ...(selected ? { target: refOf(selected) } : {}), run: () => { if (selected) update({ editing: refOf(selected) }); } },
    "plans.activate": { enabled: is("draft"), ...(selected ? { target: refOf(selected) } : {}), run: () => { if (selected) confirm.open(transition(selected, "active")); } },
    "plans.grandfather": { enabled: is("active"), ...(selected ? { target: refOf(selected) } : {}), confirm: () => { if (selected) confirm.open(transition(selected, "grandfathered")); } },
    "plans.retire": { enabled: is("grandfathered"), ...(selected ? { target: refOf(selected) } : {}), confirm: () => { if (selected) confirm.open(transition(selected, "retired")); } },
  });

  const actions = (version: PlanVersionJson) => !manage ? [] : [
    ...(version.state === "draft" ? [{ label: "Edit draft", hotkey: "e", run: () => update({ selected: refOf(version), editing: refOf(version) }) }, { label: "Activate", hotkey: "a", run: () => confirm.open(transition(version, "active")) }] : []),
    ...(version.state === "active" ? [{ label: "Grandfather", hotkey: "Shift+G", destructive: true, run: () => confirm.open(transition(version, "grandfathered")) }] : []),
    ...(version.state === "grandfathered" ? [{ label: "Retire", hotkey: "Shift+R", destructive: true, run: () => confirm.open(transition(version, "retired")) }] : []),
  ];

  return <>
    <AdminPageHeader title="Plans" description="Features describe meaning and value shape. Plan versions are immutable once activated: editing creates a new draft version, and subscriptions keep their recorded version until explicitly migrated."
      tabs={[{ value: "comparison", label: "Comparison" }, ...families.map((family) => ({ value: family, label: family }))]} tab={tab} onTabChange={(value) => update({ tab: value === "comparison" ? undefined : value, selected: undefined, editing: undefined })}
      actions={manage ? <span className="flex gap-2">
        {tab !== "comparison" && !hasDraft && <Button variant="secondary" onClick={() => confirm.open(draft())}>Draft next version</Button>}
        <Button variant="primary" onClick={() => setCreating({ name: "", key: "", keyEdited: false })}>New plan</Button>
      </span> : undefined} />
    {tab === "comparison" ? <>
      <AdminSection title="Active versions" description="Every feature against the currently active version of each plan.">
        <AdminQueryState query={plans}>{(data) => catalog.data ? <AdminDataTable caption="Plan comparison" rows={catalog.data.features} rowKey={(feature) => feature.code} columns={[
          { header: "Feature", cell: (feature) => <><p className="font-medium">{feature.name}</p><p className="text-xs text-kumo-subtle">{feature.code}</p></> },
          ...data.versions.filter((version) => version.state === "active").map((version) => ({ header: `${version.name} (v${version.version})`, cell: (feature: Feature) => feature.code in version.entitlements ? (Object.keys(version.entitlements[feature.code] ?? {}).length ? Object.entries(version.entitlements[feature.code]!).map(([name, value]) => `${name}: ${formatValue(value)}`).join(", ") : "included") : "—" })),
        ]} /> : null}</AdminQueryState>
      </AdminSection>
      <AdminSection title="Feature catalog" description="Defined in application source (packages/billing/src/catalog.ts).">
        <AdminQueryState query={catalog}>{(data) => <AdminDataTable caption="Features" primary={false} rows={data.features} rowKey={(feature) => feature.code} columns={[
          { header: "Feature", cell: (feature) => <><p className="font-medium">{feature.name}</p><p className="text-xs text-kumo-subtle">{feature.code}</p></> },
          { header: "Privileges", cell: (feature) => Object.entries(feature.privileges).map(([name, privilege]) => `${name}: ${privilege.type}`).join(", ") || "boolean" },
          { header: "Metered", cell: (feature) => feature.metered ? `${feature.metered.unit} / ${feature.metered.period}` : "—" },
        ]} />}</AdminQueryState>
      </AdminSection>
    </> : <>
      <AdminQueryState query={plans}>{() => <AdminDataTable caption={`${tab} versions`} selectable rows={versions} rowKey={refOf} rowLabel={refOf} rowActions={actions} columns={[
        { header: "Version", minWidth: "12rem", cell: (version) => <><p className="font-medium">{version.name}</p><p className="font-mono text-xs text-kumo-subtle">{refOf(version)}</p></> },
        { header: "State", nowrap: true, cell: (version) => <AdminStatus variant={stateVariant[version.state]}>{version.state}</AdminStatus> },
        { header: "Features", nowrap: true, cell: (version) => Object.keys(version.entitlements).length },
        { header: "Activated", nowrap: true, cell: (version) => formatDate(version.activatedAt ?? null) },
      ]} />}</AdminQueryState>
      <AdminDetailDrawer open={Boolean(selected)} onClose={() => update({ selected: undefined, editing: undefined })} width="lg" title={selected ? `${selected.name}` : ""} subtitle={selected ? <><AdminCode>{refOf(selected)}</AdminCode> · activated {formatDate(selected.activatedAt ?? null)}</> : undefined}
        actions={selected && actions(selected).length ? <>{actions(selected).map((action) => <Button key={action.label} variant={action.destructive ? "secondary-destructive" : "secondary"} onClick={action.run}>{action.label}</Button>)}</> : undefined}>
        {selected && (search.editing === refOf(selected) && selected.state === "draft" && catalog.data
          ? <DraftEditor version={selected} features={catalog.data.features} onSaved={() => { update({ editing: undefined }); refresh(); }} />
          : Object.keys(selected.entitlements).length
            ? <ul className="flex flex-col gap-1 text-sm">{Object.entries(selected.entitlements).map(([code, values]) => <li key={code}><AdminCode>{code}</AdminCode> {Object.entries(values ?? {}).map(([name, value]) => `${name}: ${formatValue(value)}`).join(", ")}</li>)}</ul>
            : <AdminEmpty title="No features yet" description={selected.state === "draft" ? "Edit the draft to include features." : "This version grants no features."} />)}
        {selected && search.editing !== refOf(selected) && <div className="mt-6"><StripeMappings key={refOf(selected)} version={selected} confirm={confirm} /></div>}
      </AdminDetailDrawer>
    </>}
    <AdminCreateDialog open={creating !== null} onClose={() => setCreating(null)} title="New plan" submitLabel="Create plan" description="The key is derived from the name and cannot change after creation. Version 1 is created as a draft and opens in the feature editor."
      disabled={!creating?.name.trim() || !creating?.key} onSubmit={createPlan}>
      {creating && <>
        <Input label="Name" autoFocus required placeholder="Business" value={creating.name} onChange={(event) => setCreating({ ...creating, name: event.target.value, ...(creating.keyEdited ? {} : { key: keyFromName(event.target.value, "-") }) })} />
        <Input label="Key" required value={creating.key} onChange={(event) => setCreating({ ...creating, key: event.target.value.toLowerCase(), keyEdited: true })} />
      </>}
    </AdminCreateDialog>
    {confirm.dialog}
  </>;
}
