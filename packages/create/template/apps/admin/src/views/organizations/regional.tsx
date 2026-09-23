import { canonicalTimeZone, currencyLabel, languageLabel, localeLabel, selectableLocales, supportedCurrencies } from "@__TRESTLE_PROJECT_NAME__/regional";
import { useState } from "react";

import { api, type OrganizationRegionalJson, type RegionalConfiguredJson, type RegionalResolvedJson, type RegionalSettingJson, type RegionalSourceJson } from "../../api";
import { useConfirmAction } from "../../shell/ConfirmAction";
import { useAdminQuery } from "../../shell/context";
import { Button } from "../../shell/kumo";
import { AdminQueryState, AdminStatus } from "../../shell/ui";

const settings: ReadonlyArray<[RegionalSettingJson, string]> = [["language", "Language"], ["locale", "Locale"], ["timeZone", "Time zone"], ["currency", "Currency"]];
const sourceText: Record<RegionalSourceJson, string> = { user: "User preference", organization: "Organization default", application: "Application default", operation: "Operation override" };

function display(setting: RegionalSettingJson, value: string | null): string {
  if (!value) return "Inherits";
  if (setting === "language") return languageLabel(value);
  if (setting === "locale") return localeLabel(value);
  if (setting === "currency") return currencyLabel(value);
  return value;
}

function ValueTable({ caption, values, sources }: { caption: string; values: Record<RegionalSettingJson, string | null>; sources?: RegionalResolvedJson }) {
  return <table className="w-full text-sm">
    <caption className="pb-1 text-left font-medium">{caption}</caption>
    <tbody>{settings.map(([key, label]) => <tr key={key} className="border-t border-kumo-hairline">
      <th scope="row" className="w-32 py-1.5 text-left font-normal text-kumo-subtle">{label}</th>
      <td className="py-1.5"><span className={key === "timeZone" || key === "currency" ? "font-mono text-xs" : ""}>{display(key, values[key])}</span></td>
      {sources && <td className="py-1.5 text-right text-kumo-subtle">{sourceText[sources[key].source]}</td>}
    </tr>)}</tbody>
  </table>;
}

const effectiveValues = (resolved: RegionalResolvedJson) => Object.fromEntries(settings.map(([key]) => [key, resolved[key].value])) as Record<RegionalSettingJson, string>;

/** Read-only diagnostic: evaluates the real resolution policy for one member. */
function Resolver({ organizationId, data }: { organizationId: string; data: OrganizationRegionalJson }) {
  const [userId, setUserId] = useState("");
  const resolution = useAdminQuery(["regional-resolve", organizationId, userId], () => api.resolveRegional(organizationId, userId), { enabled: Boolean(userId) });
  return <div className="mt-6">
    <h3 className="font-medium">Resolve regional context</h3>
    <label className="mt-2 block text-sm">
      <span className="text-kumo-subtle">Member</span>
      <select className="ml-2 rounded border border-kumo-line bg-kumo-base px-2 py-1" value={userId} onChange={(event) => setUserId(event.target.value)}>
        <option value="">Choose a member…</option>
        {data.members.map((member) => <option key={member.userId} value={member.userId}>{member.name} ({member.email})</option>)}
      </select>
    </label>
    {userId && <div className="mt-3"><AdminQueryState query={resolution}>{(result) => <ValueTable caption={`Effective for ${result.user.name}`} values={effectiveValues(result.effective)} sources={result.effective} />}</AdminQueryState></div>}
  </div>;
}

function RecoveryFields({ draft, onChange }: { draft: RegionalConfiguredJson; onChange: (next: RegionalConfiguredJson) => void }) {
  const set = (key: RegionalSettingJson) => (event: { target: { value: string } }) => onChange({ ...draft, [key]: event.target.value.trim() || null });
  const input = "mt-1 w-full rounded border border-kumo-line bg-kumo-base px-2 py-1";
  return <div className="grid gap-3 sm:grid-cols-2">
    <label className="text-sm">Time zone (IANA)<input className={input} value={draft.timeZone ?? ""} placeholder="Inherit" onChange={set("timeZone")} aria-invalid={Boolean(draft.timeZone && !canonicalTimeZone(draft.timeZone))} /></label>
    <label className="text-sm">Locale<select className={input} value={draft.locale ?? ""} onChange={set("locale")}><option value="">Inherit</option>{selectableLocales(draft.locale).map((tag) => <option key={tag} value={tag}>{localeLabel(tag)}</option>)}</select></label>
    <label className="text-sm">Currency<select className={input} value={draft.currency ?? ""} onChange={set("currency")}><option value="">Inherit</option>{supportedCurrencies().map((code) => <option key={code} value={code}>{currencyLabel(code)}</option>)}</select></label>
    <label className="text-sm">Language<input className={input} value={draft.language ?? ""} placeholder="Inherit" onChange={set("language")} /></label>
  </div>;
}

function scope(before: RegionalConfiguredJson, after: RegionalConfiguredJson): string[] {
  const changed = settings.filter(([key]) => (before[key] ?? null) !== (after[key] ?? null)).map(([key, label]) => `${label}: ${before[key] ?? "inherit"} → ${after[key] ?? "inherit"}`);
  return changed.length ? changed : ["No changes"];
}

/** Organizations → <organization> → Regional (docs/REGIONAL_SETTINGS_ADMIN_SPEC.md §9-§13). */
export function OrganizationRegional({ organizationId, organizationName }: { organizationId: string; organizationName: string }) {
  const regional = useAdminQuery(["organization-regional", organizationId], () => api.organizationRegional(organizationId));
  const confirm = useConfirmAction();
  const [draft, setDraft] = useState<RegionalConfiguredJson | null>(null);
  return <AdminQueryState query={regional}>{(data) => {
    const recover = () => {
      let pending = draft ?? data.configured;
      confirm.open({
        title: `Recover regional settings for ${organizationName}`,
        scope: scope(data.configured, pending),
        description: "Changes future defaults only. Historical timestamps and monetary values are never reinterpreted. Requires step-up and a reason; the change is audited in the organization.",
        fields: <RecoveryFields draft={pending} onChange={(next) => { pending = next; setDraft(next); }} />,
        confirmLabel: "Recover settings",
        onConfirm: async (reason) => { await api.recoverRegional(organizationId, pending, reason); setDraft(null); await regional.refetch(); },
      });
    };
    return <div>
      {data.applicationIssues.map((issue) => <p key={issue.message} role="alert" className="mb-3 text-sm text-kumo-danger">{issue.message} Run <code>{issue.repair}</code>.</p>)}
      {!data.organizationSettings && <p className="mb-3 text-sm text-kumo-subtle">Organization regional settings are disabled; application defaults apply to every organization.</p>}
      <div className="grid gap-6 lg:grid-cols-3">
        <ValueTable caption="Application defaults" values={data.application} />
        <ValueTable caption="Organization defaults" values={data.configured} />
        <ValueTable caption="Effective organization context" values={effectiveValues(data.effective)} sources={data.effective} />
      </div>
      <div className="mt-6">
        <h3 className="font-medium">Internationalization</h3>
        <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-kumo-subtle">Status</dt><dd>{data.i18n.enabled ? <AdminStatus variant="info">declared</AdminStatus> : "Not enabled"}</dd>
          <dt className="text-kumo-subtle">Application language</dt><dd>{languageLabel(data.application.language)}</dd>
          <dt className="text-kumo-subtle">Fallback language</dt><dd>{languageLabel(data.application.language)}</dd>
          {data.i18n.enabled && <><dt className="text-kumo-subtle">Available languages</dt><dd>{data.i18n.languages.map((code) => languageLabel(code)).join(", ")}</dd></>}
        </dl>
        <p className="mt-1 text-xs text-kumo-subtle">Translation catalogs are application-owned source; the admin does not edit them.</p>
      </div>
      <Resolver organizationId={organizationId} data={data} />
      {data.canRecover && data.organizationSettings && <div className="mt-6 border-t border-kumo-hairline pt-4">
        <p className="text-sm text-kumo-subtle">Viewing is read-only. Recovery changes this organization's defaults with your platform authority.</p>
        <Button variant="secondary" className="mt-2" onClick={recover}>Recover settings…</Button>
      </div>}
    </div>;
  }}</AdminQueryState>;
}
