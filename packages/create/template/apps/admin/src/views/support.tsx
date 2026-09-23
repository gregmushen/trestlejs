import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { adminApi, adminPost, type AdminSession, type SubscriptionRow, type SupportOrganization, type SupportSessionRecord } from "../api";

function StartSession({ organizations }: { organizations: SubscriptionRow[] }) {
  const client = useQueryClient();
  const [organizationId, setOrganizationId] = useState(organizations[0]?.organizationId ?? "");
  const [durationMinutes, setDuration] = useState(30);
  const [reason, setReason] = useState("");
  const start = useMutation({
    mutationFn: () => adminPost("/api/admin/support/sessions", { organizationId, durationMinutes, reason }),
    onSuccess: async () => { setReason(""); await client.invalidateQueries({ queryKey: ["admin-support"] }); },
  });
  const submit = (event: FormEvent) => { event.preventDefault(); start.mutate(); };
  return <form className="mt-6 flex flex-wrap items-end gap-3 text-sm" onSubmit={submit}>
    <label>Organization<select value={organizationId} onChange={(event) => setOrganizationId(event.target.value)} className="mt-1 block rounded border border-border px-2 py-1">
      {organizations.map((row) => <option key={row.organizationId} value={row.organizationId}>{row.organizationName}</option>)}
    </select></label>
    <label>Minutes<input type="number" min={5} max={240} value={durationMinutes} onChange={(event) => setDuration(Number(event.target.value))} className="mt-1 block w-24 rounded border border-border px-2 py-1" /></label>
    <label className="flex-1">Reason (the customer sees that support accessed their organization)<input required maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} className="mt-1 block w-full rounded border border-border px-2 py-1" /></label>
    <button type="submit" disabled={start.isPending || !organizationId} className="rounded bg-primary px-3 py-1.5 text-white">Start support session</button>
    {start.error && <p role="alert" className="w-full text-destructive">{start.error.message}</p>}
  </form>;
}

function ActiveSession({ session }: { session: SupportSessionRecord }) {
  const client = useQueryClient();
  const view = useQuery({ queryKey: ["admin-support-view", session.id], retry: false, queryFn: () => adminApi<SupportOrganization>(`/api/admin/support/sessions/${session.id}/organization`) });
  const end = useMutation({ mutationFn: () => adminPost(`/api/admin/support/sessions/${session.id}/end`, { reason: "" }), onSuccess: async () => { await client.invalidateQueries({ queryKey: ["admin-support"] }); } });
  return <div className="mt-6 rounded-xl border border-border bg-surface p-4">
    <div className="flex items-center justify-between">
      <p className="text-sm">Support session in <strong>{view.data?.organization?.name ?? session.organizationId}</strong> until {new Date(session.expiresAt).toLocaleTimeString()}. Every view is recorded in the organization's audit log.</p>
      <button type="button" onClick={() => end.mutate()} className="rounded border border-border px-3 py-1 text-sm">End session</button>
    </div>
    {view.error && <p role="alert" className="mt-2 text-sm text-destructive">{view.error.message}</p>}
    {view.data && <>
      <p className="mt-4 text-sm">Plan: {view.data.subscription ? `${view.data.subscription.plan}@${view.data.subscription.planVersion} (${view.data.subscription.status})` : "none"}</p>
      <p className="mt-1 text-sm">Regional overrides: {view.data.regional ? Object.entries(view.data.regional).filter(([, value]) => value).map(([key, value]) => `${key} ${value}`).join(", ") || "none" : "none (application defaults)"}</p>
      <h3 className="mt-4 font-semibold">Members</h3>
      <table className="mt-2 w-full text-left text-sm"><tbody>{view.data.members.map((person) => <tr key={person.userId} className="border-t border-border"><td className="py-1">{person.name}</td><td>{person.email}</td><td>{person.role}</td></tr>)}</tbody></table>
      <h3 className="mt-4 font-semibold">Recent audit events</h3>
      <table className="mt-2 w-full text-left text-sm"><tbody>{view.data.recentAudit.map((event) => <tr key={`${event.correlationId}-${event.name}-${event.occurredAt}`} className="border-t border-border"><td className="py-1"><code className="text-xs">{event.name}</code></td><td>{event.actorType}</td><td>{new Date(event.occurredAt).toLocaleString()}</td></tr>)}</tbody></table>
    </>}
  </div>;
}

export function SupportView() {
  const session = useQuery({ queryKey: ["admin-session"], queryFn: () => adminApi<AdminSession>("/api/admin/session") });
  const sessions = useQuery({ queryKey: ["admin-support"], queryFn: () => adminApi<{ sessions: SupportSessionRecord[]; organizations: SubscriptionRow[] }>("/api/admin/support/sessions") });
  if (sessions.error) return <p role="alert" className="text-destructive">{sessions.error.message}</p>;
  if (!sessions.data) return <p>Loading…</p>;
  const now = Date.now();
  const active = sessions.data.sessions.find((item) => item.operatorId === session.data?.operator.id && !item.endedAt && new Date(item.expiresAt).getTime() > now);
  return <section>
    <h1 className="text-2xl font-semibold">Support sessions</h1>
    <p className="mt-1 text-sm text-muted">A support session gives you time-boxed, read-only access to one organization's members, plan, and audit history. It never signs you in as a customer. Starting, viewing, and ending are all audited on the organization.</p>
    {active ? <ActiveSession session={active} /> : <StartSession organizations={sessions.data.organizations} />}
    <h2 className="mt-8 text-lg font-semibold">Your recent sessions</h2>
    <table className="mt-2 w-full text-left text-sm">
      <thead><tr className="text-muted"><th className="py-2">Organization</th><th>Reason</th><th>Started</th><th>Ended</th></tr></thead>
      <tbody>{sessions.data.sessions.map((item) => <tr key={item.id} className="border-t border-border">
        <td className="py-2">{item.organizationId}</td><td>{item.reason}</td><td>{new Date(item.startedAt).toLocaleString()}</td>
        <td>{item.endedAt ? new Date(item.endedAt).toLocaleString() : new Date(item.expiresAt).getTime() <= now ? "Expired" : "Open"}</td>
      </tr>)}</tbody>
    </table>
  </section>;
}
