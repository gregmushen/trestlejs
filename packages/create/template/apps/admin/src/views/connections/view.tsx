import { api, type ConnectionBackendJson, type IntegrationConnectionsState, type QuarantinedCallbackJson } from "../../api";
import { useAdminQuery } from "../../shell/context";
import { Banner, Select } from "../../shell/kumo";
import { AdminFacts } from "../../shell/resource";
import { AdminCode, AdminDataTable, AdminEmpty, AdminPageHeader, AdminQueryState, AdminSection, AdminStatus, formatDate, type StatusVariant } from "../../shell/ui";
import { useViewSearch } from "../../shell/url-state";

/** Lifecycle order, exceptions first: the states an operator should notice lead. */
export const connectionStateOrder = ["reauthorization_required", "degraded", "authorizing", "connected", "disconnected", "revoked"] as const;
const stateVariant: Record<string, StatusVariant> = { reauthorization_required: "destructive", degraded: "warning", authorizing: "info", connected: "success", disconnected: "neutral", revoked: "neutral" };
const forwardingLabel: Record<ConnectionBackendJson["webhookForwarding"], string> = { available: "available", unavailable: "unavailable", unknown: "depends on the Nango plan" };

/** The selected backend as the application Worker reports it: configuration state and safe detail only, never a secret. */
export function ConnectionBackendSummary(props: { backend: ConnectionBackendJson | null; counts: IntegrationConnectionsState["counts"] }) {
  const { backend } = props;
  return <>
    {backend?.name === "nango" && <Banner className="mb-4" variant="secondary" title="Experimental" description="The Nango connection backend is experimental and has not been verified against a live Nango environment." />}
    {!backend && <Banner className="mb-4" variant="alert" title="Backend status unavailable" description="The application Worker did not report its connection backend. Run pnpm exec trestle doctor for this environment." />}
    {backend?.name === "none" && <Banner className="mb-4" variant="secondary" title="Connections are disabled" description="TRESTLE_CONNECTION_BACKEND is none. Enable a backend with pnpm exec trestle integrations use nango --experimental." />}
    {backend && backend.name !== "none" && !backend.configured && <Banner className="mb-4" variant="alert" title={`${backend.name} is not configured`} description={backend.detail} />}
    {backend && <AdminFacts items={[
      ["Backend", <AdminCode key="b">{backend.name}</AdminCode>],
      ["Configured", <AdminStatus key="c" variant={backend.configured ? "success" : "warning"}>{backend.configured ? "configured" : "not configured"}</AdminStatus>],
      ["Detail", backend.detail],
      ["Callbacks", backend.inboundVerification ? "signed callbacks verified" : "callbacks refused (no signing key)"],
      ["Webhook forwarding", forwardingLabel[backend.webhookForwarding]],
    ]} />}
    <p className="mt-4 flex flex-wrap gap-2 text-sm">{connectionStateOrder.map((state) => <AdminStatus key={state} variant={props.counts[state] ? stateVariant[state]! : "neutral"}>{`${state.replaceAll("_", " ")}: ${props.counts[state] ?? 0}`}</AdminStatus>)}</p>
  </>;
}

const quarantineExplanations: Record<string, string> = {
  unbound: "No Trestle authorization attempt tag: the connection was not started from this application",
  unknown_attempt: "The attempt does not exist in this environment",
  unknown_connection: "No Connection is bound to this backend connection",
  binding_mismatch: "Environment, backend, or integration differs from the attempt",
  attempt_used: "The attempt already completed with a different connection",
  attempt_expired: "The attempt expired before the callback arrived",
  attempt_not_found: "The attempt does not exist in this environment",
  backend_connection_missing: "The backend does not hold the reported connection",
};
export const quarantineExplanation = (reason: string | null): string => (reason && quarantineExplanations[reason]) ?? reason ?? "unknown reason";

/** Verified callbacks that were acknowledged but never applied: misconfigured webhook URLs, stale attempts, or probing. */
export function QuarantinedCallbacks(props: { rows: readonly QuarantinedCallbackJson[] }) {
  return props.rows.length ? <AdminDataTable caption="Quarantined callbacks" primary={false} rows={props.rows} rowKey={(row) => row.id} columns={[
    { header: "Received", nowrap: true, cell: (row) => formatDate(row.receivedAt) },
    { header: "Integration", nowrap: true, cell: (row) => row.providerConfigKey ? <AdminCode>{row.providerConfigKey}</AdminCode> : "—" },
    { header: "Kind", nowrap: true, cell: (row) => row.kind },
    { header: "Reason", minWidth: "14rem", cell: (row) => quarantineExplanation(row.reason) },
  ]} /> : <AdminEmpty title="No quarantined callbacks" />;
}

export default function ConnectionsView() {
  const [search, update] = useViewSearch<{ state?: string }>();
  const connections = useAdminQuery(["connections"], api.connections, { refetchInterval: 30_000 });
  return <>
    <AdminPageHeader title="Connections" description="Tenant integration Connections across organizations and the connection backend that holds their credentials. Credentials, provider tokens, and backend connection IDs are never shown; tenants connect and disconnect from the customer app."
      actions={<Select placeholder="All states" aria-label="Filter by state" value={search.state ?? ""} onValueChange={(value) => update({ state: String(value ?? "") || undefined })}>
        <Select.Option value="">All states</Select.Option>
        {connectionStateOrder.map((state) => <Select.Option key={state} value={state}>{state}</Select.Option>)}
      </Select>} />
    <AdminQueryState query={connections}>{(data) => <>
      <AdminSection title="Connection backend"><ConnectionBackendSummary backend={data.backend} counts={data.counts} /></AdminSection>
      <AdminSection title={`Quarantined callbacks (${data.quarantined.length})`} description="Signed backend callbacks acknowledged but not applied. They never change a tenant's state.">
        <QuarantinedCallbacks rows={data.quarantined} />
      </AdminSection>
      <AdminSection title="Connections">
        {(() => {
          const rows = data.connections.filter((row) => !search.state || row.state === search.state);
          return rows.length ? <AdminDataTable caption="Integration connections" selectable rows={rows} rowKey={(row) => row.id} rowLabel={(row) => `${row.organizationName} ${row.providerConfigKey}`} columns={[
            { header: "Organization", minWidth: "10rem", cell: (row) => row.organizationName },
            { header: "Provider", minWidth: "8rem", cell: (row) => <><p className="font-medium">{row.provider ?? row.providerConfigKey}</p><p className="text-xs text-kumo-subtle">{row.backend} · {row.providerConfigKey} · generation {row.generation}</p></> },
            { header: "State", nowrap: true, cell: (row) => <>{<AdminStatus variant={stateVariant[row.state] ?? "neutral"}>{row.state}</AdminStatus>}{row.cleanupPending && <> <AdminStatus variant="warning">cleanup pending</AdminStatus></>}</> },
            { header: "Connected", nowrap: true, cell: (row) => formatDate(row.connectedAt) },
            { header: "Last updated", nowrap: true, priority: "low", cell: (row) => formatDate(row.updatedAt) },
          ]} /> : <AdminEmpty title="No connections match" />;
        })()}
      </AdminSection>
    </>}</AdminQueryState>
  </>;
}
