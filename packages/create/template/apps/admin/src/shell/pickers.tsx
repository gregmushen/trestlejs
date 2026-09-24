import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { api } from "../api";
import { useAdmin } from "./context";
import { Combobox } from "./kumo";

type Option = Readonly<{ value: string; label: string }>;

function Picker(props: { label: string; placeholder: string; options: readonly Option[]; value: string; onChange: (value: string) => void; loading: boolean }) {
  const selected = props.options.find((option) => option.value === props.value) ?? null;
  return <Combobox label={props.label} items={props.options as Option[]} value={selected as Option} isItemEqualToValue={(item: Option, value: Option) => item.value === value.value}
    onValueChange={(next) => props.onChange((next as Option | null)?.value ?? "")}>
    <Combobox.TriggerValue className="block w-full min-w-0 truncate pr-8 text-left leading-9" placeholder={props.loading ? "Loading…" : props.placeholder} />
    <Combobox.Content>
      <Combobox.Input placeholder="Search" />
      <Combobox.Empty>No matches.</Combobox.Empty>
      <Combobox.List>{(option: Option) => <Combobox.Item key={option.value} value={option}>{option.label}</Combobox.Item>}</Combobox.List>
    </Combobox.Content>
  </Combobox>;
}

/** Searchable organization selection instead of a raw ID field. */
export function OrganizationPicker(props: { label?: string; value: string; onChange: (organizationId: string) => void }) {
  const { environment } = useAdmin();
  const organizations = useQuery({ queryKey: ["admin", environment, "picker", "organizations"], queryFn: () => api.organizations(""), staleTime: 30_000 });
  const options = useMemo(() => (organizations.data?.organizations ?? []).map((organization) => ({ value: organization.id, label: `${organization.name} (${organization.slug})` })), [organizations.data]);
  return <Picker label={props.label ?? "Organization"} placeholder="Choose an organization" options={options} value={props.value} onChange={props.onChange} loading={organizations.isPending} />;
}

/** Searchable user selection for role assignment and access explanations. */
export function UserPicker(props: { label?: string; value: string; onChange: (userId: string) => void; organizationId?: string }) {
  const { environment } = useAdmin();
  const users = useQuery({ queryKey: ["admin", environment, "picker", "users"], queryFn: () => api.users(""), staleTime: 30_000 });
  const options = useMemo(() => (users.data?.users ?? [])
    .filter((user) => !props.organizationId || user.memberships.some((membership) => membership.organizationId === props.organizationId))
    .map((user) => ({ value: user.id, label: `${user.name} <${user.email}>` })), [props.organizationId, users.data]);
  return <Picker label={props.label ?? "User"} placeholder="Choose a user" options={options} value={props.value} onChange={props.onChange} loading={users.isPending} />;
}
