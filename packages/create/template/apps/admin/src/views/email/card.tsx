import { api } from "../../api";
import { useAdminQuery } from "../../shell/context";
import { AdminQueryState, AdminStatus } from "../../shell/ui";
import { webhookHealth } from "./deliverability";

export default function EmailDeliverabilityCard() {
  const state = useAdminQuery(["email-deliverability"], () => api.emailDeliverability());
  return <AdminQueryState query={state}>{(data) => {
    const health = webhookHealth(data.webhook);
    return <p className="text-sm"><AdminStatus variant={health.variant}>{health.label}</AdminStatus> {String(data.counts.last24h.bounced)} bounced, {String(data.counts.last24h.complained)} complaints in 24 hours.</p>;
  }}</AdminQueryState>;
}
