import { useEffect, useState } from "react";

import { api, errorMessage, type AuthPolicy, type AuthPolicyState, type AuthPolicyVersion } from "../../api";
import { useAdminCommands } from "../../shell/commands";
import { useConfirmAction } from "../../shell/ConfirmAction";
import { useAdmin, useAdminQuery, useInvalidate } from "../../shell/context";
import { Badge, Banner, Button, Input, Select, Switch } from "../../shell/kumo";
import { AdminDataTable, AdminPageHeader, AdminQueryState, AdminSection, AdminStat, AdminStatus, formatDate } from "../../shell/ui";
import { useViewSearch } from "../../shell/url-state";

type Setting = Readonly<{ path: string; label: string; help?: string } & ({ kind: "boolean" } | { kind: "number"; unit: string; min: number; max: number; zero?: string } | { kind: "select"; options: ReadonlyArray<readonly [string, string]> })>;

/** Runtime policy, grouped the way operators reason about authentication. */
const sections: ReadonlyArray<Readonly<{ title: string; description: string; settings: readonly Setting[] }>> = [
  { title: "Sign-in methods", description: "Passkeys, two-factor, and SSO are installed by trestle setup; this controls whether passwords are accepted.", settings: [
    { path: "signIn.password", label: "Password sign-in", kind: "boolean", help: "Refused unless a platform administrator has a passkey." },
  ] },
  { title: "Registration and verification", description: "Who may create an account, and whether the address must be proven first.", settings: [
    { path: "registration.mode", label: "Registration", kind: "select", options: [["open", "Open: anyone can sign up"], ["invite_only", "Invitation required"], ["closed", "Closed: no new sign-ups"]] },
    { path: "registration.requireEmailVerification", label: "Require email verification", kind: "boolean" },
  ] },
  { title: "Passwords and recovery", description: "Existing passwords keep working when the minimum rises.", settings: [
    { path: "password.minLength", label: "Minimum length", kind: "number", unit: "characters", min: 8, max: 128 },
    { path: "password.resetEnabled", label: "Password reset by email", kind: "boolean" },
    { path: "password.revokeSessionsOnReset", label: "Sign out other sessions after a reset", kind: "boolean" },
  ] },
  { title: "MFA and step-up", description: "Second-factor convenience and the freshness sensitive operator actions require.", settings: [
    { path: "mfa.trustedDeviceDays", label: "Trusted device lifetime", kind: "number", unit: "days", min: 1, max: 90 },
    { path: "stepUp.windowMinutes", label: "Step-up freshness", kind: "number", unit: "minutes", min: 5, max: 60 },
  ] },
  { title: "Sessions", description: "Lifetime, refresh, and how many sessions one account may hold.", settings: [
    { path: "sessions.lifetimeDays", label: "Lifetime without refresh", kind: "number", unit: "days", min: 1, max: 90 },
    { path: "sessions.refreshHours", label: "Refresh interval", kind: "number", unit: "hours", min: 1, max: 168 },
    { path: "sessions.maxConcurrent", label: "Concurrent sessions per account", kind: "number", unit: "sessions", min: 0, max: 100, zero: "unlimited" },
  ] },
  { title: "Organizations and invitations", description: "Self-serve organization creation and invitation limits.", settings: [
    { path: "organizations.allowCreation", label: "Members can create organizations", kind: "boolean" },
    { path: "organizations.limitPerUser", label: "Organizations per member", kind: "number", unit: "organizations", min: 0, max: 1000, zero: "unlimited" },
    { path: "organizations.invitationExpiryDays", label: "Invitation lifetime", kind: "number", unit: "days", min: 1, max: 30 },
    { path: "organizations.membershipLimit", label: "Members per organization", kind: "number", unit: "members", min: 1, max: 100_000 },
  ] },
];

const read = (policy: AuthPolicy, path: string): unknown => path.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], policy);
const write = (policy: AuthPolicy, path: string, value: unknown): AuthPolicy => {
  const [section, key] = path.split(".") as [keyof AuthPolicy, string];
  return { ...policy, [section]: { ...policy[section], [key]: value } };
};
const display = (setting: Setting, value: unknown) => setting.kind === "boolean" ? (value ? "On" : "Off")
  : setting.kind === "select" ? setting.options.find(([option]) => option === value)?.[1] ?? String(value)
    : value === 0 && setting.zero ? setting.zero : `${String(value)} ${setting.unit}`;

function SettingControl(props: { setting: Setting; value: unknown; onChange: (value: unknown) => void }) {
  const { setting } = props;
  if (setting.kind === "boolean") return <Switch label={setting.label} checked={Boolean(props.value)} onCheckedChange={(on: boolean) => props.onChange(on)} />;
  if (setting.kind === "select") return <Select label={setting.label} hideLabel={false} value={String(props.value)} onValueChange={(next) => props.onChange(String(next))}>{setting.options.map(([value, label]) => <Select.Option key={value} value={value}>{label}</Select.Option>)}</Select>;
  return <Input label={`${setting.label} (${setting.unit}${setting.zero ? `, 0 = ${setting.zero}` : ""})`} type="number" min={setting.min} max={setting.max} value={String(props.value)} onChange={(event) => props.onChange(Number(event.target.value))} />;
}

function PolicySections(props: { data: AuthPolicyState; editing: AuthPolicy | null; onChange: (policy: AuthPolicy) => void }) {
  const effective = props.data.effective.policy;
  return <div className="flex flex-col">{sections.map((section) => <AdminSection key={section.title} title={section.title} description={section.description}>
    <dl className="flex flex-col divide-y divide-kumo-hairline">{section.settings.map((setting) => {
      const current = read(effective, setting.path);
      const proposed = props.editing ? read(props.editing, setting.path) : current;
      return <div key={setting.path} className="grid gap-2 py-2 sm:grid-cols-[1fr_1fr] sm:items-center">
        <dt><p className="text-sm font-medium">{setting.label}</p>{setting.help && <p className="text-xs text-kumo-subtle">{setting.help}</p>}</dt>
        <dd className="flex flex-wrap items-center gap-2 text-sm">
          {props.editing ? <div className="w-full max-w-sm"><SettingControl setting={setting} value={proposed} onChange={(value) => props.onChange(write(props.editing!, setting.path, value))} /></div>
            : <><span>{display(setting, current)}</span><Badge variant="secondary">{props.data.effective.sources[setting.path] ?? "default"}</Badge></>}
          {props.editing && proposed !== current && <span className="text-xs text-kumo-subtle">was {display(setting, current)}</span>}
        </dd>
      </div>;
    })}</dl>
  </AdminSection>)}</div>;
}

export default function AuthenticationView() {
  const { can } = useAdmin();
  const invalidate = useInvalidate();
  const confirm = useConfirmAction();
  const manage = can("platform.auth_policy.manage");
  const [search, update] = useViewSearch<{ tab?: string }>();
  const tab = search.tab ?? "policy";
  const state = useAdminQuery(["auth-policy"], api.authPolicy);
  const draft = state.data?.draft ?? null;
  const [editing, setEditing] = useState<AuthPolicy | null>(null);
  const [checked, setChecked] = useState<{ shape: string[]; safeguards: string[]; impact: string[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => { setEditing(draft ? draft.policy : null); setChecked(null); setSaveError(null); }, [draft?.version, JSON.stringify(draft?.policy)]);
  const refresh = () => { void invalidate("auth-policy"); };
  const dirty = Boolean(editing && draft && JSON.stringify(editing) !== JSON.stringify(draft.policy));
  const problems = checked ? [...checked.shape, ...checked.safeguards] : draft ? [...draft.shape, ...draft.safeguards] : [];
  const impact = checked?.impact ?? draft?.impact ?? [];
  const startDraft = () => confirm.open({ title: "Create a policy draft", confirmLabel: "Create draft", scope: [`copies ${state.data?.effective.version ? `active version ${state.data.effective.version}` : "the defaults"} into a draft`, "nothing changes until the draft is activated"], onConfirm: (reason) => api.createAuthPolicyDraft(reason), onDone: refresh });
  const save = async () => {
    setSaving(true); setSaveError(null);
    try { setChecked(await api.saveAuthPolicyDraft(editing!)); refresh(); } catch (error) { setSaveError(errorMessage(error)); } finally { setSaving(false); }
  };
  const activate = () => confirm.open({
    title: `Activate policy version ${draft!.version}`, confirmLabel: "Activate policy", scope: impact.length ? impact : ["no effective change"],
    description: "Safeguards are checked again at activation. Every isolate applies the policy within 10 seconds.",
    onConfirm: (reason) => api.activateAuthPolicyDraft(reason), onDone: refresh, successMessage: "Authentication policy activated",
  });
  const rollback = (version: AuthPolicyVersion) => confirm.open({
    title: `Roll back to version ${version.version}`, confirmLabel: "Roll back", scope: [...(version.impact.length ? version.impact : ["no effective change"]), `a new version copies version ${version.version}; history is kept`],
    onConfirm: (reason) => api.rollbackAuthPolicy(version.version, reason), onDone: refresh, successMessage: "Authentication policy rolled back",
  });
  useAdminCommands({ "authentication.draft": { enabled: Boolean(manage && state.data && !draft), run: startDraft } });
  return <>
    <AdminPageHeader title="Authentication" description="Effective sign-in posture and where each setting comes from. Runtime policy is versioned here; providers, secrets, origins, and cookies are setup-owned. Your own factors live in Account Security."
      tabs={[{ value: "policy", label: "Policy" }, { value: "setup", label: "Setup and providers" }, { value: "history", label: "History" }]} tab={tab} onTabChange={(value) => update({ tab: value === "policy" ? undefined : value }, { replace: true })}
      actions={manage && state.data ? draft ? undefined : <Button variant="primary" onClick={startDraft}>Edit as draft</Button> : undefined} />
    <AdminQueryState query={state}>{(data) => <div className="flex flex-col">
      <div className="mb-6 grid gap-3 sm:grid-cols-4">
        <AdminStat label="Active policy" value={data.effective.version ? `Version ${data.effective.version}` : "Defaults"} hint={data.effective.version ? "runtime policy" : "no runtime version active"} />
        <AdminStat label="Sign-in methods" value={[data.effective.policy.signIn.password ? "Password" : null, ...data.setup.filter((row) => ["Passkeys", "Enterprise SSO"].includes(row.label) && row.value !== "disabled" && row.value !== "not reported").map((row) => row.label === "Passkeys" ? "Passkeys" : "SSO")].filter(Boolean).join(", ") || "None"} />
        <AdminStat label="Auth email" value={data.email.healthy ? "Healthy" : "Unhealthy"} variant={data.email.healthy ? "success" : "destructive"} hint={data.email.mode} />
        <AdminStat label="Recovery guardians" value={`${data.guardians.total} admin${data.guardians.total === 1 ? "" : "s"}`} variant={data.guardians.withPasskey ? "success" : "warning"} hint={`${data.guardians.withPasskey} with passkey · ${data.guardians.withTwoFactor} with two-factor`} />
      </div>
      {data.effective.problems.length > 0 && <Banner className="mb-6" variant="alert" title="The active policy fails a safeguard" description={<ul className="list-disc pl-5">{data.effective.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>} />}

      {tab === "policy" && <>
        {draft && editing && <AdminSection title={`Draft version ${draft.version}`} description={`Based on ${draft.basedOn ? `version ${draft.basedOn}` : "the defaults"}. Save to re-check safeguards and impact; activation needs a reason and step-up.`}
          actions={manage ? <span className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={!dirty} onClick={() => { setEditing(draft.policy); setChecked(null); }}>Revert</Button>
            <Button variant="secondary" loading={saving} disabled={!dirty} onClick={() => void save()}>Save draft</Button>
            <Button variant="primary" disabled={dirty || problems.length > 0} onClick={activate}>Activate</Button>
            <Button variant="secondary-destructive" onClick={() => confirm.open({ title: `Discard draft ${draft.version}`, confirmLabel: "Discard draft", destructive: true, scope: ["the draft is kept in history as discarded", "the active policy is unchanged"], onConfirm: (reason) => api.discardAuthPolicyDraft(reason), onDone: refresh })}>Discard</Button>
          </span> : undefined}>
          {dirty && <p className="mb-2 text-sm text-kumo-subtle">Unsaved changes.</p>}
          {saveError && <p role="alert" className="mb-2 text-sm text-kumo-danger">{saveError}</p>}
          {problems.length > 0 && <Banner className="mb-3" variant="alert" title="This draft cannot be activated" description={<ul className="list-disc pl-5">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>} />}
          <div className="mt-3"><p className="text-sm font-medium">Impact of activating</p>{impact.length ? <ul className="mt-1 list-disc pl-5 text-sm">{impact.map((line) => <li key={line}>{line}</li>)}</ul> : <p className="text-sm text-kumo-subtle">No effective change yet.</p>}</div>
        </AdminSection>}
        <PolicySections data={data} editing={draft && manage ? editing : null} onChange={(policy) => { setEditing(policy); }} />
      </>}

      {tab === "setup" && <>
        <AdminSection title="Setup-owned configuration" description="Read-only here. Change these with trestle setup or deployment configuration; secrets are only ever reported as present.">
          <AdminDataTable caption="Setup-owned authentication settings" primary={false} rows={data.setup} rowKey={(row) => row.label} columns={[
            { header: "Setting", minWidth: "12rem", cell: (row) => row.label },
            { header: "Value", minWidth: "12rem", cell: (row) => row.value },
            { header: "Source", nowrap: true, cell: (row) => <Badge variant="secondary">{row.source}</Badge> },
            { header: "Health", nowrap: true, cell: (row) => row.healthy === null ? "—" : <AdminStatus variant={row.healthy ? "success" : "destructive"}>{row.healthy ? "healthy" : "unhealthy"}</AdminStatus> },
          ]} />
        </AdminSection>
        <AdminSection title="Authentication email" description="Verification, reset, invitation, and sign-in-code messages depend on this route.">
          <p className="text-sm"><AdminStatus variant={data.email.healthy ? "success" : "destructive"}>{data.email.healthy ? "healthy" : "unhealthy"}</AdminStatus> {data.email.mode}{data.email.message ? ` · ${data.email.message}` : ""}</p>
          <p className="mt-1 text-xs text-kumo-subtle">Flows: {data.email.flows.join(", ")}.</p>
        </AdminSection>
      </>}

      {tab === "history" && <AdminSection title="Versions" description="Rolling back activates a new version copied from an earlier one, after the same safeguards.">
        {data.versions.length ? <AdminDataTable caption="Authentication policy versions" primary={false} rows={data.versions} rowKey={(row) => String(row.version)} columns={[
          { header: "Version", nowrap: true, cell: (row) => `v${row.version}${row.basedOn ? ` (from v${row.basedOn})` : ""}` },
          { header: "State", nowrap: true, cell: (row) => <AdminStatus value={row.state}>{row.state}</AdminStatus> },
          { header: "Activated", nowrap: true, cell: (row) => row.activatedAt ? `${formatDate(row.activatedAt)} by ${row.activatedBy ?? "—"}` : "—" },
          { header: "Reason", minWidth: "10rem", cell: (row) => row.reason ?? "—" },
          { header: "", nowrap: true, cell: (row) => manage && row.state === "superseded" ? <Button size="sm" variant="secondary" onClick={() => rollback(row)}>Roll back to this</Button> : null },
        ]} /> : <p className="text-sm text-kumo-subtle">No versions yet: Better Auth and Trestle defaults apply.</p>}
      </AdminSection>}
    </div>}</AdminQueryState>
    {confirm.dialog}
  </>;
}
