import { api } from "../../api";
import { useAdminCommands } from "../../shell/commands";
import { useAdminQuery } from "../../shell/context";
import { AdminDetailDrawer, AdminFacts, useSelectedDetail } from "../../shell/resource";
import { Select } from "../../shell/kumo";
import { AdminCode, AdminCopy, AdminDataTable, AdminEmpty, AdminFilter, AdminPageHeader, AdminQueryState, AdminStatus, formatDate } from "../../shell/ui";
import { useViewSearch } from "../../shell/url-state";

const statuses = ["captured", "accepted", "delivered", "bounced", "complained", "failed"];

/** Operational history for one send: status timeline, attempts, and correlation. Content is never stored here. */
function DeliveryDrawer(props: { id: string; open: boolean; onClose: () => void }) {
  const detail = useAdminQuery(["email-delivery", props.id], () => api.emailDelivery(props.id), { enabled: props.open });
  const delivery = detail.data?.delivery;
  return <AdminDetailDrawer open={props.open} onClose={props.onClose} title={delivery?.template ?? "Email delivery"} subtitle={delivery ? delivery.recipient : undefined}>
    <AdminQueryState query={detail}>{(data) => <div className="flex flex-col gap-6">
      <AdminFacts items={[
        ["Status", <AdminStatus key="s" value={data.events.at(-1)?.status ?? data.delivery.status}>{data.events.at(-1)?.status ?? data.delivery.status}</AdminStatus>],
        ["Template", <AdminCode key="t">{data.delivery.template}</AdminCode>],
        ["Recipient", `${data.delivery.recipient}${data.delivery.recipientCount > 1 ? ` (+${data.delivery.recipientCount - 1})` : ""}`],
        ["Provider", data.delivery.provider === "local" ? "local capture" : data.delivery.provider],
        ["Organization", data.delivery.organizationName ?? data.delivery.organizationId ?? "—"],
        ["Failure", data.delivery.failureCategory ?? "—"],
        ["Attempts", data.notification ? `${data.notification.attempts} (notification ${data.notification.type}, ${data.notification.status})` : "1"],
        ["Correlation", data.delivery.correlationId ? <AdminCopy key="c" value={data.delivery.correlationId} label="correlation ID" /> : "—"],
        ["Sent", formatDate(data.delivery.createdAt)],
      ]} />
      <section aria-label="Provider events"><h3 className="mb-2 text-sm font-semibold">Provider events</h3>{data.events.length ? <ol className="flex flex-col gap-1 text-sm">{data.events.map((event, index) => <li key={index}>{formatDate(event.occurredAt)} <AdminStatus value={event.status}>{event.status}</AdminStatus></li>)}</ol> : <AdminEmpty title="No provider events yet" description="The provider has not reported beyond the recorded send." />}</section>
    </div>}</AdminQueryState>
  </AdminDetailDrawer>;
}

export default function EmailView() {
  const [search, update] = useViewSearch<{ status?: string; q?: string; selected?: string }>();
  const deliveries = useAdminQuery(["email", search.status ?? ""], () => api.email(search.status));
  const q = (search.q ?? "").toLowerCase();
  const rows = (deliveries.data?.deliveries ?? []).filter((row) => !q || `${row.template} ${row.recipient} ${row.correlationId}`.toLowerCase().includes(q));
  const selected = useSelectedDetail(rows, (row) => row.id);
  useAdminCommands({ "email.refresh": { run: () => void deliveries.refetch() } });
  return <>
    <AdminPageHeader title="Email delivery" description="Provider-neutral delivery status. Recipients are masked; message bodies, links, and tokens are never shown." />
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <div className="w-full sm:w-48"><Select label="Status" hideLabel={false} value={search.status ?? "all"} onValueChange={(value) => update({ status: String(value ?? "all") === "all" ? undefined : String(value) })}>
        <Select.Option value="all">All statuses</Select.Option>{statuses.map((status) => <Select.Option key={status} value={status}>{status}</Select.Option>)}
      </Select></div>
      <AdminFilter className="w-full sm:w-72" label="Filter deliveries" placeholder="Template, recipient, or correlation ID" />
    </div>
    <AdminQueryState query={deliveries} isEmpty={() => rows.length === 0} empty="No delivery events.">{() => <AdminDataTable caption="Email deliveries" selectable rows={rows} rowKey={(row) => row.id} columns={[
      { header: "Template", minWidth: "10rem", cell: (row) => row.template },
      { header: "Provider", nowrap: true, priority: "low", cell: (row) => row.provider === "local" ? "local capture" : row.provider },
      { header: "Recipient", nowrap: true, cell: (row) => row.recipient },
      { header: "Status", nowrap: true, cell: (row) => <AdminStatus value={row.status}>{row.status}</AdminStatus> },
      { header: "Failure", nowrap: true, cell: (row) => row.failureCategory ?? "—" },
      { header: "Events", nowrap: true, priority: "low", cell: (row) => row.events },
      { header: "Correlation", nowrap: true, priority: "low", cell: (row) => <span className="font-mono text-xs" title={row.correlationId}>{row.correlationId.slice(0, 12)}…</span> },
      { header: "When", nowrap: true, cell: (row) => formatDate(row.occurredAt) },
    ]} />}</AdminQueryState>
    {selected.id && <DeliveryDrawer key={selected.id} id={selected.id} open={selected.open} onClose={selected.close} />}
  </>;
}
