import { api } from "../../api";
import { useAdminCommands } from "../../shell/commands";
import { useAdminQuery } from "../../shell/context";
import { Grid } from "../../shell/kumo";
import { AdminDataTable, AdminPageHeader, AdminQueryState, AdminSection, AdminStatus } from "../../shell/ui";
import { CapabilityCard } from "../overview/view";

const rank: Record<string, number> = { failed: 0, degraded: 1, ok: 2 };

export default function HealthView() {
  const health = useAdminQuery(["health"], api.health);
  const capabilities = useAdminQuery(["capabilities"], api.capabilities);
  useAdminCommands({ "health.refresh": { run: () => { void health.refetch(); void capabilities.refetch(); } } });
  return <>
    <AdminPageHeader title="Health" description="Read-only runtime checks, failures first. Repair commands are shown to copy; nothing here repairs state from the browser." />
    <AdminSection title="Runtime checks">
      <AdminQueryState query={health} isEmpty={(data) => data.checks.length === 0}>{(data) => <AdminDataTable caption="Runtime checks" selectable rows={[...data.checks].sort((a, b) => (rank[a.status] ?? 1) - (rank[b.status] ?? 1))} rowKey={(check) => check.name} columns={[
        { header: "Check", cell: (check) => check.name },
        { header: "Status", cell: (check) => <AdminStatus variant={check.status === "ok" ? "success" : check.status === "degraded" ? "warning" : "destructive"}>{check.status}</AdminStatus> },
        { header: "Detail", cell: (check) => check.detail ?? "—" },
      ]} />}</AdminQueryState>
    </AdminSection>
    <AdminSection title="Capability projection">
      <AdminQueryState query={capabilities}>{(data) => <Grid variant="3up" gap="base">{[...data.capabilities].sort((a, b) => Number(a.healthy) - Number(b.healthy)).map((status) => <CapabilityCard key={status.id} status={status} />)}</Grid>}</AdminQueryState>
    </AdminSection>
  </>;
}
