import { api } from "../../api";
import { useAdminQuery } from "../../shell/context";
import { AdminCode, AdminQueryState, AdminStatus } from "../../shell/ui";

export default function CapabilityHealthCard() {
  const capabilities = useAdminQuery(["capabilities"], api.capabilities);
  return <AdminQueryState query={capabilities}>{(data) => {
    const unhealthy = data.capabilities.filter((status) => status.state !== "disabled" && !status.healthy);
    return unhealthy.length === 0
      ? <p className="text-sm text-kumo-subtle"><AdminStatus variant="success">healthy</AdminStatus> Every declared capability is configured.</p>
      : <ul className="flex flex-col gap-1 text-sm">{unhealthy.map((status) => <li key={status.id}><AdminStatus variant="warning">{status.state}</AdminStatus> {status.label}{status.repair && <> <AdminCode>{status.repair}</AdminCode></>}</li>)}</ul>;
  }}</AdminQueryState>;
}
