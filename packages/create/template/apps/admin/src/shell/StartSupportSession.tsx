import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { api } from "../api";
import type { ConfirmConfig } from "./ConfirmAction";
import { useAdmin } from "./context";
import { Badge, Input, Loader, Select } from "./kumo";
import { AdminError } from "./ui";

/**
 * The start-session form: profile, duration, and ticket, with the exact
 * organization and application permissions the profile grants and denies in
 * this tenant previewed before the operator confirms with a reason.
 */
function SupportSessionFields(props: { organizationId: string; choice: { current: SessionChoice } }) {
  const { environment } = useAdmin();
  const [state, setState] = useState<SessionChoice>(props.choice.current);
  const onChange = (next: SessionChoice) => { props.choice.current = next; setState(next); };
  const profiles = useQuery({ queryKey: ["admin", environment, "support", "profiles"], queryFn: api.supportProfiles });
  const preview = useQuery({ queryKey: ["admin", environment, "support", "preview", props.organizationId, state.profile], queryFn: () => api.previewSupport(props.organizationId, state.profile) });
  const members = useQuery({ queryKey: ["admin", environment, "organizations", props.organizationId], queryFn: () => api.organization(props.organizationId) });
  return <div className="flex flex-col gap-3">
    <Select label="View as member" hideLabel={false} value={state.targetUserId} onValueChange={(value) => onChange({ ...state, targetUserId: String(value) })}>
      <Select.Option value="none">Organization overview only</Select.Option>
      {(members.data?.members ?? []).map((member) => <Select.Option key={member.userId} value={member.userId}>{member.name} ({member.email})</Select.Option>)}
    </Select>
    {members.isError && <AdminError error={members.error} />}
    <div className="grid gap-3 sm:grid-cols-3">
      <Select label="Profile" hideLabel={false} value={state.profile} onValueChange={(value) => onChange({ ...state, profile: String(value) })}>
        {(profiles.data?.profiles ?? [{ key: "read_only", name: "Read-only support" }]).map((option) => <Select.Option key={option.key} value={option.key}>{option.name}</Select.Option>)}
      </Select>
      <Select label="Duration" hideLabel={false} value={String(state.duration)} onValueChange={(value) => onChange({ ...state, duration: Number(value) })}>
        {(profiles.data?.durations ?? [15, 30, 60, 120, 240]).map((minutes) => <Select.Option key={minutes} value={String(minutes)}>{minutes} minutes</Select.Option>)}
      </Select>
      <Input label="Ticket" placeholder="SUP-1234" maxLength={120} value={state.ticket} onChange={(event) => onChange({ ...state, ticket: event.target.value })} />
    </div>
    {preview.isPending ? <span className="flex items-center gap-2 text-sm text-kumo-subtle"><Loader size={14} />Previewing access</span>
      : preview.isError ? <AdminError error={preview.error} />
        : <div role="region" aria-label="Access preview" className="max-h-56 overflow-y-auto rounded-lg ring ring-kumo-hairline">
          <table className="min-w-full text-left text-xs"><tbody>
            {preview.data.permissions.map((entry) => <tr key={entry.code} className="border-b border-kumo-hairline last:border-0">
              <td className="px-2 py-1"><Badge variant={entry.allowed ? "success" : "neutral"}>{entry.allowed ? "granted" : "denied"}</Badge></td>
              <td className="px-2 py-1 font-mono">{entry.code}</td>
              <td className="px-2 py-1 text-kumo-subtle">{entry.reason}</td>
            </tr>)}
          </tbody></table>
        </div>}
  </div>;
}

export type SessionChoice = Readonly<{ profile: string; duration: number; ticket: string; targetUserId: string }>;

/** Builds the confirmation for starting a support session; the caller opens it from a button or its hotkey. */
export function useStartSupportSession() {
  const { startSupportSession } = useAdmin();
  // Read when the operator confirms, so the latest profile, duration, and ticket are used.
  const choice = useRef<SessionChoice>({ profile: "read_only", duration: 30, ticket: "", targetUserId: "none" });
  const config = (organization: { id: string; name: string }): ConfirmConfig => {
    // A member chosen in another organization must never carry into this confirmation.
    choice.current = { ...choice.current, targetUserId: "none" };
    return {
    title: `Support session in ${organization.name}`,
    description: "Your platform permission lets you start the session. Choose a member only if you need the read-only customer-app view; no customer login or write authority is granted.",
    scope: [`View ${organization.name} as yourself`, "Support reads record you as the actor and end when this session expires"],
    confirmLabel: "Start support session",
    successMessage: `Support session started in ${organization.name}`,
    fields: <SupportSessionFields organizationId={organization.id} choice={choice} />,
    onConfirm: (reason) => {
      const { profile, duration, ticket, targetUserId } = choice.current;
      return startSupportSession({ organizationId: organization.id, profile, durationMinutes: duration, ...(targetUserId !== "none" ? { targetUserId } : {}), ...(ticket.trim() ? { ticket: ticket.trim() } : {}) }, reason);
    },
    };
  };
  return { config };
}
