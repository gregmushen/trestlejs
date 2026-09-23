import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";

import { formatDate, tenantApi, tenantKey, useTenantAccess } from "./api";

type Inbox = { unread: number; notifications: Array<{ id: string; type: string; title: string; body: string; link: string | null; count: number; createdAt: string; updatedAt: string; readAt: string | null }> };
type Channel = { channel: "in_app" | "email"; enabled: boolean; source: "mandatory" | "user" | "organization" | "default"; mandatory: boolean; organizationDefault: boolean | null };
type PreferenceType = { type: string; name: string; description: string; channels: Channel[] };
type DeliveryRow = { id: string; type: string; recipient: string; channel: string; status: string; preference: string; attempts: number; failureCategory: string | null; correlationId: string; createdAt: string };

const channelLabel = { in_app: "In-app", email: "Email" } as const;
const sourceLabel = { mandatory: "required", user: "your choice", organization: "organization default", default: "default" } as const;

function useInbox() {
  const access = useTenantAccess();
  const organizationId = access.data?.organizationId;
  return { organizationId, inbox: useQuery({ queryKey: tenantKey(organizationId, "notifications"), enabled: Boolean(organizationId), refetchInterval: 20_000, retry: false, queryFn: () => tenantApi<Inbox>("/api/tenant/notifications") }) };
}

/** Header bell with the unread count; hidden until the member has an active organization. */
export function NotificationBell() {
  const { inbox } = useInbox();
  if (!inbox.data) return null;
  return <Link to="/notifications" aria-label={`Notifications, ${inbox.data.unread} unread`} className="relative inline-flex items-center">
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>
    {inbox.data.unread > 0 && <span className="absolute -right-2 -top-2 rounded-full bg-red-600 px-1.5 text-xs font-semibold text-white">{inbox.data.unread > 99 ? "99+" : inbox.data.unread}</span>}
  </Link>;
}

export function NotificationInbox() {
  const { organizationId, inbox } = useInbox();
  const client = useQueryClient();
  const navigate = useNavigate();
  const markRead = useMutation({ mutationFn: (ids: string[] | "all") => tenantApi("/api/tenant/notifications/read", { method: "POST", body: { ids } }), onSuccess: () => void client.invalidateQueries({ queryKey: tenantKey(organizationId, "notifications") }) });
  if (inbox.error) return <section className="card p-8"><p className="text-red-700">{inbox.error.message}</p></section>;
  return <section className="card p-8">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><p className="eyebrow">Inbox</p><h1 className="mt-2 text-3xl font-semibold">Notifications</h1></div>
      <div className="flex gap-3"><Link to="/settings/notifications" className="button-secondary">Preferences</Link>{(inbox.data?.unread ?? 0) > 0 && <button className="button" onClick={() => markRead.mutate("all")}>Mark all read</button>}</div>
    </div>
    {inbox.data?.notifications.length === 0 && <p className="mt-6 text-slate-600">You're all caught up.</p>}
    <ul className="mt-6 divide-y divide-slate-100">{inbox.data?.notifications.map((entry) => <li key={entry.id} className={`flex items-start justify-between gap-4 py-4 ${entry.readAt ? "" : "font-medium"}`}>
      <button className="text-left" onClick={async () => { if (!entry.readAt) await markRead.mutateAsync([entry.id]); if (entry.link) await navigate({ to: entry.link }); }}>
        <p>{!entry.readAt && <span aria-label="unread" className="mr-2 inline-block size-2 rounded-full bg-brand-500" />}{entry.title}</p>
        <p className="mt-1 text-sm font-normal text-slate-600">{entry.body}</p>
        <p className="mt-1 text-xs font-normal text-slate-500">{formatDate(entry.updatedAt)}{entry.count > 1 ? ` · ${entry.count} grouped` : ""}</p>
      </button>
      {!entry.readAt && <button className="shrink-0 text-sm text-brand-500" onClick={() => markRead.mutate([entry.id])}>Mark read</button>}
    </li>)}</ul>
  </section>;
}

export function NotificationPreferences() {
  const access = useTenantAccess();
  const organizationId = access.data?.organizationId;
  const client = useQueryClient();
  const key = tenantKey(organizationId, "notification-preferences");
  const preferences = useQuery({ queryKey: key, enabled: Boolean(organizationId), queryFn: () => tenantApi<{ types: PreferenceType[]; canManageDefaults: boolean }>("/api/tenant/notification-preferences") });
  const canReadHistory = access.data?.permissions.includes("organization.notifications.read") ?? false;
  const history = useQuery({ queryKey: tenantKey(organizationId, "notification-deliveries"), enabled: Boolean(organizationId) && canReadHistory, queryFn: () => tenantApi<{ deliveries: DeliveryRow[] }>("/api/tenant/notification-deliveries") });
  const save = useMutation({
    mutationFn: (input: { scope: "user" | "organization"; type: string; channel: string; enabled: boolean | null }) => tenantApi(input.scope === "user" ? "/api/tenant/notification-preferences" : "/api/tenant/notification-defaults", { method: "PUT", body: { type: input.type, channel: input.channel, enabled: input.enabled } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: key }),
  });
  if (access.error || preferences.error) return <section className="card p-8"><p className="text-red-700">{(access.error ?? preferences.error)!.message}</p></section>;
  return <section className="space-y-6">
    <div className="card p-8">
      <p className="eyebrow">Notifications</p>
      <h1 className="mt-2 text-3xl font-semibold">Notification preferences</h1>
      <p className="mt-2 text-slate-600">Choose where you hear about each kind of event in this organization. Required notifications always reach your inbox.</p>
      {save.error && <p role="alert" className="mt-3 text-sm text-red-700">{save.error.message}</p>}
      <table className="mt-6 w-full text-left text-sm">
        <thead><tr className="text-slate-500"><th className="py-2">Notification</th><th>In-app</th><th>Email</th></tr></thead>
        <tbody>{preferences.data?.types.map((type) => <tr key={type.type} className="border-t border-slate-100 align-top">
          <td className="py-3 pr-4"><p className="font-medium">{type.name}</p><p className="text-slate-500">{type.description}</p></td>
          {(["in_app", "email"] as const).map((channel) => { const value = type.channels.find((entry) => entry.channel === channel); return <td key={channel} className="py-3">{!value ? <span className="text-slate-400">—</span> : <div>
            <label className="flex items-center gap-2"><input type="checkbox" aria-label={`${type.name} ${channelLabel[channel]}`} checked={value.enabled} disabled={value.mandatory} onChange={(event) => save.mutate({ scope: "user", type: type.type, channel, enabled: event.target.checked })} />{value.enabled ? "On" : "Off"}</label>
            <p className="text-xs text-slate-500">{sourceLabel[value.source]}{value.source === "user" && <> · <button className="underline" onClick={() => save.mutate({ scope: "user", type: type.type, channel, enabled: null })}>reset</button></>}</p>
          </div>}</td>; })}
        </tr>)}</tbody>
      </table>
    </div>
    {preferences.data?.canManageDefaults && <div className="card p-8">
      <h2 className="text-lg font-semibold">Organization defaults</h2>
      <p className="mt-1 text-sm text-slate-600">Apply to members who have not chosen for themselves.</p>
      <table className="mt-4 w-full text-left text-sm"><tbody>{preferences.data.types.flatMap((type) => type.channels.filter((channel) => !channel.mandatory).map((channel) => <tr key={`${type.type}-${channel.channel}`} className="border-t border-slate-100">
        <td className="py-2">{type.name}</td><td>{channelLabel[channel.channel]}</td>
        <td><select aria-label={`Default for ${type.name} ${channelLabel[channel.channel]}`} className="rounded-lg border px-2 py-1" value={channel.organizationDefault === null ? "" : channel.organizationDefault ? "on" : "off"} onChange={(event) => save.mutate({ scope: "organization", type: type.type, channel: channel.channel, enabled: event.target.value === "" ? null : event.target.value === "on" })}>
          <option value="">Application default</option><option value="on">On</option><option value="off">Off</option>
        </select></td>
      </tr>))}</tbody></table>
    </div>}
    {canReadHistory && <div className="card p-8">
      <h2 className="text-lg font-semibold">Delivery history</h2>
      <p className="mt-1 text-sm text-slate-600">Every notification delivery in this organization. Message content is not shown.</p>
      <table className="mt-4 w-full text-left text-sm">
        <thead><tr className="text-slate-500"><th className="py-2">Type</th><th>Recipient</th><th>Channel</th><th>Status</th><th>Why</th><th>When</th></tr></thead>
        <tbody>{history.data?.deliveries.map((row) => <tr key={row.id} className="border-t border-slate-100"><td className="py-2"><code className="text-xs">{row.type}</code></td><td>{row.recipient}</td><td>{channelLabel[row.channel as "in_app" | "email"] ?? row.channel}</td><td>{row.status}{row.failureCategory ? ` (${row.failureCategory})` : ""}</td><td>{row.preference}</td><td>{formatDate(row.createdAt)}</td></tr>)}</tbody>
      </table>
    </div>}
  </section>;
}
