import { PlusIcon } from "@phosphor-icons/react";
import { useState } from "react";

import { ResourceListPage } from "../../blocks/resource-list";
import { api, type NotificationDetail } from "../../api";
import { useAdminCommands } from "../../shell/commands";
import { useConfirmAction, type ConfirmConfig } from "../../shell/ConfirmAction";
import { useAdmin, useAdminQuery, useInvalidate, useTenantScope } from "../../shell/context";
import { Button, Checkbox, Select } from "../../shell/kumo";
import { OrganizationPicker } from "../../shell/pickers";
import { AdminCode, AdminCopy, AdminDataTable, AdminEmpty, AdminPageHeader, AdminQueryState, AdminSection, AdminStatus, formatDate } from "../../shell/ui";
import { useViewSearch } from "../../shell/url-state";
import { NewStreamDialog, StreamDrawer, StreamsTable } from "./streams";

type Delivery = NotificationDetail["deliveries"][number];
const statuses = ["pending", "sent", "failed", "skipped", "cancelled"];

export default function NotificationsView() {
  const { can } = useAdmin();
  const invalidate = useInvalidate();
  const [scope] = useTenantScope();
  const [search, update] = useViewSearch<{ tab?: string; organization?: string; status?: string; type?: string; selected?: string; delivery?: string; stream?: string; archived?: string }>();
  const tab = search.tab === "deliveries" ? "deliveries" : "streams";
  const streams = useAdminQuery(["notification-streams"], api.notificationStreams, { enabled: tab === "streams" });
  const openStream = search.stream && streams.data?.streams.some((stream) => stream.type === search.stream) ? search.stream : undefined;
  const [creating, setCreating] = useState(false);
  const organizationId = search.organization ?? scope;
  const list = useAdminQuery(["notifications", organizationId, search.status ?? "", search.type ?? ""], () => api.notifications({ organizationId, ...(search.status ? { status: search.status } : {}), ...(search.type ? { type: search.type } : {}) }), { refetchInterval: 15_000, enabled: tab === "deliveries" });
  const detail = useAdminQuery(["notification", search.selected ?? ""], () => api.notification(search.selected!), { enabled: Boolean(search.selected) });
  const delivery = detail.data?.deliveries.find((row) => row.id === search.delivery);
  const actions = detail.data?.definition?.operatorActions ?? {};
  const manage = can("platform.notifications.manage");
  const retryable = (row: Delivery) => manage && Boolean(actions.retry) && row.status === "failed";
  const cancellable = (row: Delivery) => manage && Boolean(actions.cancel) && row.status === "pending" && !row.mandatory;
  const confirm = useConfirmAction();
  const refresh = () => { void invalidate("notifications"); void invalidate("notification"); };
  const refreshStreams = () => { void invalidate("notification-streams"); void invalidate("notification-stream"); };
  const recipient = detail.data?.notification.recipient.email ?? "the recipient";
  const retry = (row: Delivery): ConfirmConfig => ({ title: "Retry delivery", confirmLabel: "Retry", scope: [`Retry the ${row.channel} delivery to ${recipient}`], onConfirm: (reason) => api.notificationDeliveryAction(row.id, "retry", reason), onDone: refresh });
  const cancel = (row: Delivery): ConfirmConfig => ({ title: "Cancel delivery", confirmLabel: "Cancel delivery", destructive: true, scope: [`Cancel the pending ${row.channel} delivery to ${recipient}`], onConfirm: (reason) => api.notificationDeliveryAction(row.id, "cancel", reason), onDone: refresh });
  useAdminCommands({
    "notifications.new-stream": { enabled: can("platform.notification_streams.manage"), run: () => { update({ tab: undefined }); setCreating(true); } },
    "notifications.retry": { enabled: Boolean(delivery && retryable(delivery)), ...(delivery ? { target: delivery.id } : {}), run: () => { if (delivery) confirm.open(retry(delivery)); } },
    "notifications.cancel": { enabled: Boolean(delivery && cancellable(delivery)), ...(delivery ? { target: delivery.id } : {}), confirm: () => { if (delivery) confirm.open(cancel(delivery)); } },
  });
  return <>
    <AdminPageHeader title="Notifications" description={tab === "streams" ? "Streams are the contracts application code sends by type: inputs, routes, templates, and policy, published as immutable versions." : "Delivery state across tenants: type, logical recipient, channel states, and correlation. Titles, bodies, and links are never shown."}
      tabs={[{ value: "streams", label: "Streams" }, { value: "deliveries", label: "Deliveries" }]} tab={tab} onTabChange={(value) => update({ tab: value === "streams" ? undefined : value, selected: undefined, delivery: undefined, stream: undefined }, { replace: true })}
      actions={tab === "streams" && can("platform.notification_streams.manage") ? <Button variant="primary" icon={<PlusIcon />} onClick={() => setCreating(true)}>New stream</Button> : undefined} />
    {tab === "streams" ? <>
      <label className="mb-4 flex items-center gap-2 text-sm"><Checkbox checked={search.archived === "1"} onCheckedChange={(on) => update({ archived: on ? "1" : undefined })} aria-label="Show archived streams" />Show archived</label>
      <StreamsTable showArchived={search.archived === "1"} onSelect={(type) => update({ stream: type })} />
      {openStream && <StreamDrawer key={openStream} type={openStream} open onClose={() => update({ stream: undefined })} confirm={confirm} onChanged={refreshStreams} />}
      <NewStreamDialog open={creating} onClose={() => setCreating(false)} confirm={confirm} onCreated={(type) => { refreshStreams(); update({ stream: type }); }} />
    </> : <>
    <div className="mb-4 grid gap-3 sm:grid-cols-3">
      <OrganizationPicker value={organizationId} onChange={(id) => update({ organization: id || undefined })} />
      <Select placeholder="All types" label="Type" hideLabel={false} value={search.type ?? ""} onValueChange={(value) => update({ type: String(value ?? "") || undefined })}><Select.Option value="">All types</Select.Option>{list.data?.types.map((entry) => <Select.Option key={entry.type} value={entry.type}>{entry.name}</Select.Option>)}</Select>
      <Select placeholder="Any status" label="Delivery status" hideLabel={false} value={search.status ?? ""} onValueChange={(value) => update({ status: String(value ?? "") || undefined })}><Select.Option value="">Any status</Select.Option>{statuses.map((status) => <Select.Option key={status} value={status}>{status}</Select.Option>)}</Select>
    </div>
    <ResourceListPage detail={search.selected ? <AdminQueryState query={detail}>{({ notification, deliveries, preferences, definition }) => <AdminSection title={definition?.name ?? notification.type} description={`${notification.recipient.name} (${notification.recipient.email}) · ${notification.organizationName}`}>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div><dt className="text-kumo-subtle">Grouping</dt><dd>{notification.groupKey ? <>key <AdminCode>{notification.groupKey}</AdminCode>, {notification.groupCount} grouped{definition?.group ? ` within ${definition.group.windowMinutes} min` : ""}</> : "not grouped"}</dd></div>
        <div><dt className="text-kumo-subtle">Deduplication</dt><dd>{notification.dedupeKey ? <>key <AdminCode>{notification.dedupeKey}</AdminCode>{definition?.dedupe ? ` for ${definition.dedupe.windowMinutes} min` : ""}</> : "none"}</dd></div>
        <div><dt className="text-kumo-subtle">Created / scheduled</dt><dd>{formatDate(notification.createdAt)} / {formatDate(notification.scheduledAt)}</dd></div>
        <div><dt className="text-kumo-subtle">Read</dt><dd>{formatDate(notification.readAt)}</dd></div>
        <div><dt className="text-kumo-subtle">Correlation</dt><dd><AdminCopy value={notification.correlationId} label="correlation ID" /></dd></div>
      </dl>
      <h3 className="mt-4 text-sm font-semibold">Channels and preference resolution</h3>
      <AdminDataTable caption="Notification deliveries" primary={false} selectable param="delivery" rows={deliveries} rowKey={(row) => row.id} rowLabel={(row) => `${row.channel} delivery`}
        rowActions={(row) => [...(retryable(row) ? [{ label: "Retry", hotkey: "r", run: () => confirm.open(retry(row)) }] : []), ...(cancellable(row) ? [{ label: "Cancel", hotkey: "c", destructive: true, run: () => confirm.open(cancel(row)) }] : [])]}
        columns={[
          { header: "Channel", cell: (row) => <>{row.channel}{row.mandatory && <> <AdminStatus variant="info">mandatory</AdminStatus></>}</> },
          { header: "Status", cell: (row) => <AdminStatus value={row.status}>{row.status}</AdminStatus> },
          { header: "Why", cell: (row) => row.preferenceSource },
          { header: "Attempts", cell: (row) => `${row.attempts}${row.failureCategory ? ` · ${row.failureCategory}` : ""}${row.nextAttemptAt ? ` · next ${formatDate(row.nextAttemptAt)}` : ""}` },
          { header: "Provider", cell: (row) => row.emailDeliveryId ? `${row.providerStatus ?? "recorded"}` : "—" },
        ]} />
      <p className="mt-2 text-xs text-kumo-subtle">Stored choices: {preferences.length ? preferences.map((preference) => `${preference.scope} ${preference.channel} ${preference.enabled ? "on" : "off"}`).join("; ") : "none (definition defaults apply)"}.</p>
    </AdminSection>}</AdminQueryState> : <AdminEmpty title="Select a notification" description="Grouping, deduplication, preference resolution, and attempts appear here." />}>
      <AdminQueryState query={list} isEmpty={(data) => data.notifications.length === 0} empty="No notifications match.">{(data) => <AdminDataTable caption="Notifications" selectable rows={data.notifications} rowKey={(row) => row.id} rowLabel={(row) => row.type} columns={[
        { header: "Type", cell: (row) => <><AdminCode>{row.type}</AdminCode>{row.groupCount > 1 && <> <AdminStatus variant="neutral">{`×${row.groupCount}`}</AdminStatus></>}</> },
        { header: "Recipient", cell: (row) => <><p>{row.recipient.name}</p><p className="text-xs text-kumo-subtle">{row.recipient.email} · {row.organizationName}</p></> },
        { header: "Channels", cell: (row) => <span className="flex flex-wrap gap-1">{row.channels.map((channel) => <AdminStatus key={channel.id} value={channel.status}>{`${channel.channel}: ${channel.status}`}</AdminStatus>)}</span> },
        { header: "Failure", cell: (row) => row.failureCategory ?? "—" },
        { header: "Created", cell: (row) => formatDate(row.createdAt) },
      ]} />}</AdminQueryState>
    </ResourceListPage>
    </>}
    {confirm.dialog}
  </>;
}
