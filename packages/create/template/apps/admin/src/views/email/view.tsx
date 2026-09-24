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
  return <AdminDetailDrawer open={props.open} onClose={props.onClose} title="Email delivery" subtitle={delivery ? <AdminCode>{delivery.id}</AdminCode> : undefined}>
    <AdminQueryState query={detail}>{(data) => <div className="flex flex-col gap-6">
      <AdminFacts items={[
        ["Status", <AdminStatus key="s" value={data.events.at(-1)?.status ?? data.delivery.status}>{data.events.at(-1)?.status ?? data.delivery.status}</AdminStatus>],
        ["Provider message", <AdminCopy key="m" value={data.delivery.id} label="provider message ID" />],
        ["Provider", data.delivery.provider],
        ["First event", formatDate(data.delivery.createdAt)],
      ]} />
      <section aria-label="Provider events"><h3 className="mb-2 text-sm font-semibold">Provider events</h3>{data.events.length ? <ol className="flex flex-col gap-1 text-sm">{data.events.map((event, index) => <li key={index}>{formatDate(event.occurredAt)} <AdminStatus value={event.status}>{event.status}</AdminStatus></li>)}</ol> : <AdminEmpty title="No provider events yet" description="The provider has not reported beyond the recorded send." />}</section>
    </div>}</AdminQueryState>
  </AdminDetailDrawer>;
}

export default function EmailView() {
  const [search, update] = useViewSearch<{ status?: string; q?: string; selected?: string }>();
  const deliveries = useAdminQuery(["email", search.status ?? ""], () => api.email(search.status));
  const q = (search.q ?? "").toLowerCase();
  const rows = (deliveries.data?.deliveries ?? []).filter((row) => !q || row.id.toLowerCase().includes(q));
  const selected = useSelectedDetail(rows, (row) => row.id);
  useAdminCommands({ "email.refresh": { run: () => void deliveries.refetch() } });
  return <>
    <AdminPageHeader title="Email delivery" description="Delivery status reported by the email provider, grouped by provider message. Recipients, templates, bodies, links, and tokens are never recorded here." />
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <div className="w-full sm:w-48"><Select label="Status" hideLabel={false} value={search.status ?? "all"} onValueChange={(value) => update({ status: String(value ?? "all") === "all" ? undefined : String(value) })}>
        <Select.Option value="all">All statuses</Select.Option>{statuses.map((status) => <Select.Option key={status} value={status}>{status}</Select.Option>)}
      </Select></div>
      <AdminFilter className="w-full sm:w-72" label="Filter deliveries" placeholder="Provider message ID" />
    </div>
    <AdminQueryState query={deliveries} isEmpty={() => rows.length === 0} empty="No delivery events.">{() => <AdminDataTable caption="Email deliveries" selectable rows={rows} rowKey={(row) => row.id} columns={[
      { header: "Provider message", minWidth: "14rem", cell: (row) => <AdminCode>{row.id}</AdminCode> },
      { header: "Status", nowrap: true, cell: (row) => <AdminStatus value={row.status}>{row.status}</AdminStatus> },
      { header: "Events", nowrap: true, priority: "low", cell: (row) => row.events },
      { header: "When", nowrap: true, cell: (row) => formatDate(row.occurredAt) },
    ]} />}</AdminQueryState>
    {selected.id && <DeliveryDrawer key={selected.id} id={selected.id} open={selected.open} onClose={selected.close} />}
  </>;
}
