import type { Feature } from "../api";
import { Input, Select, Switch } from "./kumo";

export type PrivilegeValues = Record<string, boolean | number | string | null>;

/** One typed privilege control generated from the feature catalog; raw JSON is never the default editor. */
export function PrivilegeField(props: { feature: Feature; name: string; value: PrivilegeValues[string] | undefined; onChange: (value: PrivilegeValues[string] | undefined) => void }) {
  const privilege = props.feature.privileges[props.name]!;
  const label = `${props.name}${privilege.nullable ? " (blank = unlimited)" : ""}`;
  if (privilege.type === "boolean") return <Switch label={props.name} checked={props.value === true} onCheckedChange={(checked: boolean) => props.onChange(checked)} />;
  if (privilege.type === "select") return <Select placeholder="—" label={label} hideLabel={false} value={typeof props.value === "string" ? props.value : ""} onValueChange={(value) => props.onChange(value ? String(value) : undefined)}>
    <Select.Option value="">—</Select.Option>
    {(privilege.options ?? []).map((option) => <Select.Option key={option} value={option}>{option}</Select.Option>)}
  </Select>;
  const numeric = privilege.type === "integer" || privilege.type === "decimal";
  return <Input label={label} inputMode={numeric ? "decimal" : "text"} placeholder={privilege.type === "duration" ? "P30D" : ""} value={props.value === null || props.value === undefined ? "" : String(props.value)}
    onChange={(event) => { const raw = event.target.value; props.onChange(raw === "" ? (privilege.nullable ? null : undefined) : numeric ? Number(raw) : raw); }} />;
}

/** Every privilege of one feature. */
export function FeatureValues(props: { feature: Feature; values: PrivilegeValues; onChange: (values: PrivilegeValues) => void }) {
  const names = Object.keys(props.feature.privileges);
  if (names.length === 0) return <p className="text-sm text-kumo-subtle">This feature has no values; enabling it is enough.</p>;
  return <div className="grid gap-3 sm:grid-cols-2">{names.map((name) => <PrivilegeField key={name} feature={props.feature} name={name} value={props.values[name]}
    onChange={(value) => { const next = { ...props.values }; if (value === undefined) delete next[name]; else next[name] = value; props.onChange(next); }} />)}</div>;
}

export function FeatureSelect(props: { features: readonly Feature[]; value: string; onChange: (code: string) => void; label?: string }) {
  return <Select placeholder="Choose a feature" label={props.label ?? "Feature"} hideLabel={false} value={props.value} onValueChange={(value) => props.onChange(String(value ?? ""))}>
    <Select.Option value="">Choose a feature</Select.Option>
    {props.features.map((feature) => <Select.Option key={feature.code} value={feature.code}>{feature.name}</Select.Option>)}
  </Select>;
}
