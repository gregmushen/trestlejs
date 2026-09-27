import type { EmailDeliverability } from "../../main-backend";
import { Banner, Grid } from "../../shell/kumo";
import { AdminCode, AdminCopy, AdminDataTable, AdminSection, AdminStat, AdminStatus, formatDate } from "../../shell/ui";

const labels = { delivered: "Delivered", delivery_delayed: "Delayed", bounced: "Bounced", complained: "Complained" } as const;
const variants = { delivered: "success", delivery_delayed: "warning", bounced: "warning", complained: "destructive" } as const;

/** Whether verified Resend webhooks are arriving, as the Worker and the event table know it. */
export function webhookHealth(webhook: EmailDeliverability["webhook"]): { variant: "success" | "warning" | "neutral"; label: string } {
  if (webhook.secretConfigured === false) return { variant: "warning", label: "not configured" };
  if (webhook.secretConfigured === null) return { variant: "neutral", label: "unknown" };
  return webhook.lastReceivedAt ? { variant: "success", label: "receiving" } : { variant: "warning", label: "no events yet" };
}

/** Webhook readiness, 24-hour and 7-day outcome counts, and the latest verified events (no recipients). */
export function EmailDeliverabilityPanel(props: { data: EmailDeliverability }) {
  const { webhook, counts, events } = props.data;
  const health = webhookHealth(webhook);
  return <>
    {webhook.secretConfigured === false && <Banner className="mb-4" variant="alert" title="The Resend webhook is not configured"
      description={<>Delivery outcomes, suppressions, and email events need it. Run <AdminCode>{webhook.command}</AdminCode> <AdminCopy value={webhook.command} label="command" />, then push secrets and deploy.</>} />}
    <AdminSection title="Resend webhook" description="The signing secret's presence as the Worker reports it, and the last verified event received. The admin never calls Resend.">
      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <div><dt className="text-kumo-subtle">Status</dt><dd><AdminStatus variant={health.variant}>{health.label}</AdminStatus></dd></div>
        <div><dt className="text-kumo-subtle">Last event</dt><dd className="font-medium">{webhook.lastReceivedAt ? formatDate(webhook.lastReceivedAt) : "—"}</dd></div>
        <div><dt className="text-kumo-subtle">Configure or rotate</dt><dd><AdminCopy value={webhook.command} label="webhook command" /></dd></div>
      </dl>
    </AdminSection>
    {(["last24h", "last7d"] as const).map((window) => <section key={window} aria-label={window === "last24h" ? "Last 24 hours" : "Last 7 days"} className="mb-6">
      <h3 className="mb-2 text-sm font-semibold">{window === "last24h" ? "Last 24 hours" : "Last 7 days"}</h3>
      <Grid variant="4up" gap="base">{(Object.keys(labels) as Array<keyof typeof labels>).map((status) =>
        <AdminStat key={status} label={labels[status]} value={counts[window][status]} variant={counts[window][status] && status !== "delivered" ? variants[status] : "neutral"} />)}</Grid>
    </section>)}
    <AdminSection title="Recent provider events" description="Verified webhook events, newest first. Recipients are never recorded here.">
      <AdminDataTable caption="Recent provider events" rows={events.slice(0, 25)} rowKey={(row) => row.id} primary={false} columns={[
        { header: "When", nowrap: true, cell: (row) => formatDate(row.occurredAt) },
        { header: "Organization", minWidth: "10rem", cell: (row) => row.organizationId ? <AdminCode>{row.organizationId}</AdminCode> : <span className="text-kumo-subtle">untagged</span> },
        { header: "Type", nowrap: true, cell: (row) => <AdminStatus value={row.status}>{row.status}</AdminStatus> },
        { header: "Bounce", nowrap: true, priority: "low", cell: (row) => row.bounceType ? `${row.bounceType}${row.bounceSubType ? ` / ${row.bounceSubType}` : ""}` : "—" },
        { header: "Provider message", priority: "low", cell: (row) => <AdminCode>{row.emailDeliveryId}</AdminCode> },
      ]} />
    </AdminSection>
  </>;
}
