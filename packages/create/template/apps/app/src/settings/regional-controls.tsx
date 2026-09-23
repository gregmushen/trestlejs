import {
  currencyLabel, languageLabel, localeLabel, regionalPreview, searchTimeZones, selectableLocales, supportedCurrencies, timeZoneOptions,
  type RegionalSource, type RegionalValues, type TimeZoneOption,
} from "@__TRESTLE_PROJECT_NAME__/regional";
import { useId, useMemo, useState } from "react";

/** Plain-language provenance; the resolution algorithm stays out of the form. */
export function sourceLabel(source: RegionalSource, audience: "organization" | "user"): string {
  if (source === "user") return "Your preference";
  if (source === "organization") return audience === "organization" ? "Organization setting" : "Organization default";
  if (source === "operation") return "Set for this operation";
  return "Application default";
}

export function Source({ source, audience }: { source: RegionalSource; audience: "organization" | "user" }) {
  return <span className="text-xs text-slate-500">{sourceLabel(source, audience)}</span>;
}

function zoneSummary(option: TimeZoneOption | undefined, id: string): string {
  return option ? `${option.name || option.city} · ${option.offset}` : id;
}

/**
 * Searchable time-zone combobox. Matches cities, zone names, abbreviations,
 * and identifiers ("Seattle", "Pacific", "PST"), and always stores the IANA identifier.
 */
export function TimeZonePicker({ value, onChange, label, disabled, inheritLabel }: { value: string | null; onChange: (value: string | null) => void; label: string; disabled?: boolean; inheritLabel?: string }) {
  const id = useId();
  const options = useMemo(() => timeZoneOptions(new Date()), []);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const matches = useMemo(() => searchTimeZones(query, options, 12), [query, options]);
  const current = options.find((option) => option.id === value);
  const choose = (next: string | null) => { onChange(next); setOpen(false); setQuery(""); };
  return <div className="relative">
    <label htmlFor={id} className="text-sm font-medium">{label}</label>
    <input id={id} role="combobox" aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list" disabled={disabled}
      aria-activedescendant={open && matches[active] ? `${id}-${active}` : undefined}
      className="mt-1 w-full rounded-lg border px-3 py-2" placeholder={value ?? inheritLabel ?? "Search city, region, or zone"}
      value={open ? query : value ?? ""} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 120)}
      onChange={(event) => { setQuery(event.target.value); setActive(0); setOpen(true); }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => Math.min(index + 1, matches.length - 1)); }
        else if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)); }
        else if (event.key === "Enter" && matches[active]) { event.preventDefault(); choose(matches[active]!.id); }
        else if (event.key === "Escape") setOpen(false);
      }} />
    <p className="mt-1 text-xs text-slate-500">{value ? zoneSummary(current, value) : inheritLabel}{value && " · offset is informational"}</p>
    {open && <ul id={`${id}-list`} role="listbox" className="absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded-lg border bg-white shadow-lg">
      {inheritLabel && <li role="option" aria-selected={value === null} className="cursor-pointer px-3 py-2 text-sm hover:bg-slate-50" onMouseDown={() => choose(null)}>{inheritLabel}</li>}
      {matches.map((option, index) => <li key={option.id} id={`${id}-${index}`} role="option" aria-selected={option.id === value}
        className={`cursor-pointer px-3 py-2 text-sm ${index === active ? "bg-slate-100" : "hover:bg-slate-50"}`} onMouseDown={() => choose(option.id)}>
        <span className="font-medium">{option.city}</span> <span className="text-slate-500">{option.name}{option.abbreviations.length ? ` (${option.abbreviations.join("/")})` : ""} · {option.offset}</span>
        <span className="block text-xs text-slate-400">{option.id}</span>
      </li>)}
      {matches.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">No matching time zones</li>}
    </ul>}
  </div>;
}

type SelectProps = { label: string; value: string | null; onChange: (value: string | null) => void; disabled?: boolean; inheritLabel?: string };

function Select({ label, value, onChange, disabled, inheritLabel, options }: SelectProps & { options: ReadonlyArray<readonly [string, string]> }) {
  const id = useId();
  return <div>
    <label htmlFor={id} className="text-sm font-medium">{label}</label>
    <select id={id} className="mt-1 w-full rounded-lg border px-3 py-2" disabled={disabled} value={value ?? ""} onChange={(event) => onChange(event.target.value || null)}>
      {inheritLabel && <option value="">{inheritLabel}</option>}
      {options.map(([code, text]) => <option key={code} value={code}>{text}</option>)}
    </select>
  </div>;
}

export function LocaleSelect(props: SelectProps) {
  return <Select {...props} options={selectableLocales(props.value).map((tag) => [tag, localeLabel(tag)] as const)} />;
}

export function LanguageSelect(props: SelectProps & { languages: readonly string[] }) {
  return <Select {...props} options={props.languages.map((code) => [code, languageLabel(code)] as const)} />;
}

export function CurrencySelect(props: SelectProps) {
  return <Select {...props} options={supportedCurrencies().map((code) => [code, currencyLabel(code)] as const)} />;
}

/** Sample values under the draft settings, updated before save. */
export function RegionalPreviewCard({ values }: { values: Pick<RegionalValues, "locale" | "timeZone" | "currency"> }) {
  const preview = regionalPreview(values, new Date());
  const rows: Array<[string, string]> = [["Date & time", preview.dateTime], ["Date", preview.date], ["Number", preview.number], ["Currency", preview.currency], ["Percentage", preview.percent]];
  return <div className="rounded-lg border border-slate-200 p-4" aria-live="polite">
    <p className="text-sm font-medium">Preview</p>
    <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
      {rows.map(([name, value]) => <div key={name} className="contents"><dt className="text-slate-500">{name}</dt><dd>{value}</dd></div>)}
    </dl>
  </div>;
}
