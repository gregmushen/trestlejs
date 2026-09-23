import type { RegionalSetting, RegionalSource, RegionalValues } from "@__TRESTLE_PROJECT_NAME__/regional";
import { languageLabel } from "@__TRESTLE_PROJECT_NAME__/regional";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { formatDate, tenantApi, tenantKey, useTenantAccess } from "./api";
import { CurrencySelect, LanguageSelect, LocaleSelect, RegionalPreviewCard, Source, TimeZonePicker } from "./regional-controls";

type Resolved = Record<RegionalSetting, { value: string; source: RegionalSource }>;
type Configured = Record<RegionalSetting, string | null>;
type OrganizationRegional = {
  configured: Configured; effective: Resolved; application: RegionalValues; organizationSettings: boolean; canManage: boolean;
  i18n: { enabled: boolean; languages: string[] }; languages: string[];
  applicationIssues: Array<{ message: string; repair: string }>; schedulesFollowingOrganization: number;
};
type UserRegional = { configured: Omit<Configured, "currency">; effective: Resolved; organization: Resolved; languages: string[] };
type ScheduleImpact = { key: string; name: string; description: string; current: string; proposed: string };
type ScheduleReport = { timeZone: string; proposedTimeZone: string; organizationRelative: ScheduleImpact[]; zoned: ScheduleImpact[] };

const effectiveValue = (draft: Partial<Configured>, fallback: Resolved, setting: RegionalSetting) => draft[setting] ?? fallback[setting].value;

function Failure({ error }: { error: Error }) {
  return <section className="card p-8"><p role="alert" className="text-red-700">{error.message}</p></section>;
}

/** Settings → Organization → Regional (docs/REGIONAL_SETTINGS_ADMIN_SPEC.md §3). */
export function OrganizationRegionalSettings() {
  const access = useTenantAccess();
  const organizationId = access.data?.organizationId;
  const client = useQueryClient();
  const key = tenantKey(organizationId, "regional");
  const settings = useQuery({ queryKey: key, enabled: Boolean(organizationId), queryFn: () => tenantApi<OrganizationRegional>("/api/tenant/regional") });
  const [draft, setDraft] = useState<Configured | null>(null);
  useEffect(() => { if (settings.data && !draft) setDraft(settings.data.configured); }, [settings.data, draft]);
  const zoneChanged = Boolean(settings.data && draft && (draft.timeZone ?? settings.data.application.timeZone) !== settings.data.effective.timeZone.value);
  const currencyChanged = Boolean(settings.data && draft && (draft.currency ?? settings.data.application.currency) !== settings.data.effective.currency.value);
  const proposedZone = draft?.timeZone ?? settings.data?.application.timeZone;
  const schedules = useQuery({
    queryKey: [...key, "schedules", proposedZone ?? ""], enabled: zoneChanged && Boolean(proposedZone),
    queryFn: () => tenantApi<ScheduleReport>(`/api/tenant/regional/schedules?timeZone=${encodeURIComponent(proposedZone!)}`),
  });
  const save = useMutation({
    mutationFn: (values: Configured) => tenantApi<OrganizationRegional>("/api/tenant/regional", { method: "PUT", body: values }),
    onSuccess: (next) => { client.setQueryData(key, next); setDraft(next.configured); },
  });
  if (access.error || settings.error) return <Failure error={(access.error ?? settings.error)!} />;
  if (!settings.data || !draft) return <section className="card p-8"><p>Loading…</p></section>;
  const data = settings.data;
  const readOnly = !data.canManage;
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.configured);
  const set = (setting: RegionalSetting) => (value: string | null) => setDraft({ ...draft, [setting]: value });
  const inherit = (setting: RegionalSetting) => `Application default (${setting === "language" ? languageLabel(data.application.language) : data.application[setting]})`;
  const previewValues = { locale: effectiveValue(draft, data.effective, "locale"), timeZone: proposedZone ?? data.effective.timeZone.value, currency: effectiveValue(draft, data.effective, "currency") };

  return <section className="space-y-6">
    <div className="card p-8">
      <p className="eyebrow">Organization</p>
      <h1 className="mt-2 text-3xl font-semibold">Regional</h1>
      <p className="mt-2 text-slate-600">Defaults for dates, numbers, money, and organization-relative schedules. Members may choose their own language and region.</p>
      {data.applicationIssues.map((issue) => <p key={issue.message} role="alert" className="mt-3 text-sm text-red-700">{issue.message} Run <code>{issue.repair}</code>.</p>)}
      {!data.organizationSettings && <p className="mt-4 text-sm text-slate-600">This application uses its own regional defaults for every organization.</p>}
      {readOnly && data.organizationSettings && <p className="mt-4 text-sm text-slate-600">You can view these settings. An organization administrator can change them.</p>}

      <form className="mt-6 grid gap-6 md:grid-cols-2" onSubmit={(event) => { event.preventDefault(); save.mutate(draft); }}>
        <div>
          <TimeZonePicker label="Time zone" value={draft.timeZone} onChange={set("timeZone")} disabled={readOnly} inheritLabel={inherit("timeZone")} />
          <p className="mt-1 text-xs text-slate-500">Used for organization-relative dates, schedules, reports, and default communication times.</p>
          <Source source={data.effective.timeZone.source} audience="organization" />
        </div>
        <div>
          <LocaleSelect label="Locale" value={draft.locale} onChange={set("locale")} disabled={readOnly} inheritLabel={inherit("locale")} />
          <p className="mt-1 text-xs text-slate-500">Controls date, number, percentage, and currency formatting.</p>
          <Source source={data.effective.locale.source} audience="organization" />
        </div>
        <div>
          {data.i18n.enabled
            ? <LanguageSelect label="Default language" languages={data.languages} value={draft.language} onChange={set("language")} disabled={readOnly} inheritLabel={inherit("language")} />
            : <><p className="text-sm font-medium">Language</p><p className="mt-1">{languageLabel(data.application.language)}</p></>}
          <p className="mt-1 text-xs text-slate-500">{data.i18n.enabled ? "Used when a member or recipient has not selected a language." : "This application is available in one language."}</p>
          <Source source={data.effective.language.source} audience="organization" />
        </div>
        <div>
          <CurrencySelect label="Default currency" value={draft.currency} onChange={set("currency")} disabled={readOnly} inheritLabel={inherit("currency")} />
          <p className="mt-1 text-xs text-slate-500">Used for newly created monetary values where the product permits a default. Existing values keep their own currency.</p>
          <Source source={data.effective.currency.source} audience="organization" />
        </div>

        <div className="md:col-span-2"><RegionalPreviewCard values={previewValues} /></div>

        {zoneChanged && <div role="note" className="md:col-span-2 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          <p>Future schedules that follow organization local time may occur at a different instant after this change. Historical timestamps are not changed.</p>
          {schedules.data && schedules.data.organizationRelative.length > 0 && <>
            <p className="mt-2 font-medium">{schedules.data.organizationRelative.length} recurring {schedules.data.organizationRelative.length === 1 ? "schedule uses" : "schedules use"} the organization time zone:</p>
            <ul className="mt-1 list-disc pl-5">{schedules.data.organizationRelative.map((item) => <li key={item.key}>{item.name} — {item.description}; next run {formatDate(item.current)} → {formatDate(item.proposed)}</li>)}</ul>
          </>}
          {schedules.data && schedules.data.zoned.length > 0 && <p className="mt-2 text-slate-600">{schedules.data.zoned.length} explicitly zoned {schedules.data.zoned.length === 1 ? "schedule is" : "schedules are"} unaffected.</p>}
        </div>}
        {currencyChanged && <div role="note" className="md:col-span-2 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">Existing monetary values keep their original currencies. Trestle does not automatically convert them.</div>}

        {!readOnly && <div className="md:col-span-2 flex items-center gap-3">
          <button className="button" type="submit" disabled={!dirty || save.isPending}>{save.isPending ? "Saving…" : "Save"}</button>
          {dirty && <button className="button-secondary" type="button" onClick={() => setDraft(data.configured)}>Discard changes</button>}
          {save.error && <p role="alert" className="text-sm text-red-700">{save.error.message}</p>}
          {save.isSuccess && !dirty && <p className="text-sm text-slate-600">Saved.</p>}
        </div>}
      </form>
    </div>
  </section>;
}

/** Account → Language & Region (docs/REGIONAL_SETTINGS_ADMIN_SPEC.md §4). */
export function LanguageAndRegion() {
  const access = useTenantAccess();
  const organizationId = access.data?.organizationId;
  const client = useQueryClient();
  const key = tenantKey(organizationId, "regional-preferences");
  const settings = useQuery({ queryKey: key, enabled: Boolean(organizationId), queryFn: () => tenantApi<UserRegional>("/api/tenant/regional-preferences") });
  const save = useMutation({
    mutationFn: (values: UserRegional["configured"]) => tenantApi<UserRegional>("/api/tenant/regional-preferences", { method: "PUT", body: values }),
    onSuccess: (next) => void client.setQueryData(key, next),
  });
  const [draft, setDraft] = useState<UserRegional["configured"] | null>(null);
  useEffect(() => { if (settings.data) setDraft(settings.data.configured); }, [settings.data]);
  if (access.error || settings.error) return <Failure error={(access.error ?? settings.error)!} />;
  if (!settings.data || !draft) return <section className="card p-8"><p>Loading…</p></section>;
  const data = settings.data;
  const set = (setting: "language" | "locale" | "timeZone") => (value: string | null) => setDraft({ ...draft, [setting]: value });
  const organizationDefaultLabel = (setting: RegionalSetting) => `Use organization default (${setting === "language" ? languageLabel(data.organization.language.value) : data.organization[setting].value})`;
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.configured);
  const effective = (setting: "language" | "locale" | "timeZone") => draft[setting] ?? data.organization[setting].value;

  return <section className="card p-8">
    <p className="eyebrow">Account</p>
    <h1 className="mt-2 text-3xl font-semibold">Language & Region</h1>
    <p className="mt-2 text-slate-600">How dates, times, and numbers appear to you. These follow your account across organizations.</p>
    <form className="mt-6 grid gap-6 md:grid-cols-2" onSubmit={(event) => { event.preventDefault(); save.mutate(draft); }}>
      <div>
        {data.languages.length > 1
          ? <LanguageSelect label="Language" languages={data.languages} value={draft.language} onChange={set("language")} inheritLabel={organizationDefaultLabel("language")} />
          : <><p className="text-sm font-medium">Language</p><p className="mt-1">{languageLabel(data.effective.language.value)}</p></>}
        <Source source={data.effective.language.source} audience="user" />
      </div>
      <div>
        <LocaleSelect label="Locale" value={draft.locale} onChange={set("locale")} inheritLabel={organizationDefaultLabel("locale")} />
        <Source source={data.effective.locale.source} audience="user" />
      </div>
      <div className="md:col-span-2">
        <TimeZonePicker label="Time zone" value={draft.timeZone} onChange={set("timeZone")} inheritLabel={organizationDefaultLabel("timeZone")} />
        <Source source={data.effective.timeZone.source} audience="user" />
      </div>
      <div className="md:col-span-2"><RegionalPreviewCard values={{ locale: effective("locale"), timeZone: effective("timeZone"), currency: data.effective.currency.value }} /></div>
      <div className="md:col-span-2 flex items-center gap-3">
        <button className="button" type="submit" disabled={!dirty || save.isPending}>{save.isPending ? "Saving…" : "Save"}</button>
        {save.error && <p role="alert" className="text-sm text-red-700">{save.error.message}</p>}
      </div>
    </form>
  </section>;
}

/** Hidden when the application does not let organizations override regional defaults (spec §14). */
export function RegionalLink() {
  const access = useTenantAccess();
  const organizationId = access.data?.organizationId;
  const settings = useQuery({ queryKey: tenantKey(organizationId, "regional"), enabled: Boolean(organizationId) && (access.data?.permissions.includes("organization.settings.regional.read") ?? false), retry: false, queryFn: () => tenantApi<OrganizationRegional>("/api/tenant/regional") });
  if (!settings.data?.organizationSettings) return null;
  return <Link to="/settings/regional" activeProps={{ className: "text-brand-500" }}>Regional</Link>;
}
