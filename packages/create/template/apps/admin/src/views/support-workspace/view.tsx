import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api, errorMessage } from "../../api";
import { useAdminCommands } from "../../shell/commands";
import { useAdmin } from "../../shell/context";
import { Button } from "../../shell/kumo";
import { AdminCode, AdminDataTable, AdminEmpty, AdminPageHeader, AdminQueryState, AdminSection, AdminStatus, formatDate, useAdminToast } from "../../shell/ui";
import { useViewSearch } from "../../shell/url-state";

/**
 * Acting inside the tenant during a support session. Every request runs as
 * you, with the session's frozen profile permissions, through the tenant's
 * RLS-bound services; sections the profile does not grant are not shown.
 */
export default function SupportWorkspaceView() {
  const { supportSession, environment } = useAdmin();
  const client = useQueryClient();
  const toast = useAdminToast();
  const [search] = useViewSearch<{ selected?: string; delivery?: string }>();
  const key = (...parts: string[]) => ["admin", environment, "support", supportSession?.id ?? "none", ...parts];
  const workspace = useQuery({ queryKey: key("workspace"), queryFn: api.supportTenant, enabled: Boolean(supportSession) });
  const permitted = new Set(workspace.data?.permitted ?? []);
  const members = useQuery({ queryKey: key("members"), queryFn: api.supportMembers, enabled: permitted.has("organization.members.read") });
  const webhooks = useQuery({ queryKey: key("webhooks"), queryFn: api.supportWebhooks, enabled: permitted.has("organization.webhooks.read") });
  const deliveries = useQuery({ queryKey: key("notification-deliveries"), queryFn: api.supportNotificationDeliveries, enabled: permitted.has("organization.notifications.read") });
  const audit = useQuery({ queryKey: key("audit"), queryFn: api.supportAudit, enabled: permitted.has("organization.audit.read") });
  const endpoint = webhooks.data?.endpoints.find((row) => row.id === search.selected);
  const endpointDeliveries = useQuery({ queryKey: key("webhook", endpoint?.id ?? ""), queryFn: () => api.supportWebhookDeliveries(endpoint!.id), enabled: Boolean(endpoint) && permitted.has("organization.webhooks.read") });
  const delivery = endpointDeliveries.data?.deliveries.find((row) => row.id === search.delivery);
  const manage = permitted.has("organization.webhooks.manage");
  // Commands stay disabled until the action and its refetch finish, so a repeated
  // shortcut never acts on stale state.
  const [busy, setBusy] = useState(false);
  const act = async (label: string, action: () => Promise<unknown>) => {
    setBusy(true);
    try { await action(); toast.success(label); await client.invalidateQueries({ queryKey: key() }); } catch (error) { toast.failure(label, error); } finally { setBusy(false); }
  };
  const toggle = (row: { id: string; name: string; state: string }) => () => void act(`${row.state === "active" ? "Paused" : "Resumed"} ${row.name}`, () => api.supportWebhookAction(row.id, row.state === "active" ? "pause" : "resume"));
  const test = (row: { id: string; name: string }) => () => void act(`Queued a test event for ${row.name}`, () => api.supportWebhookAction(row.id, "test"));
  const replayable = (row: { status: string; test: boolean }) => permitted.has("organization.webhooks.replay") && !row.test && (row.status === "failed" || row.status === "succeeded");
  useAdminCommands({
    "support-workspace.toggle-endpoint": { enabled: !busy && Boolean(endpoint && manage && endpoint.state !== "disabled"), ...(endpoint ? { target: endpoint.id } : {}), run: () => { if (endpoint) toggle(endpoint)(); } },
    "support-workspace.test-endpoint": { enabled: !busy && Boolean(endpoint && manage && endpoint.state === "active"), ...(endpoint ? { target: endpoint.id } : {}), run: () => { if (endpoint) test(endpoint)(); } },
    "support-workspace.replay": { enabled: !busy && Boolean(delivery && replayable(delivery)), ...(delivery ? { target: delivery.id } : {}), run: () => { if (delivery) void act("Replay queued", () => api.supportReplay(delivery.id)); } },
  });

  if (!supportSession) return <>
    <AdminPageHeader title="Support workspace" description="Act inside one tenant with an audited support profile." />
    <AdminEmpty title="No support session is active" description="Start one from an organization's page; its tenant tools appear here." />
  </>;
  if (workspace.isError) return <AdminPageHeader title="Support workspace" description={errorMessage(workspace.error)} />;
  return <>
    <AdminPageHeader title={`Support workspace: ${supportSession.organizationName}`} description={<>Profile {supportSession.profile}. You remain the acting principal; every change records session <AdminCode>{supportSession.id}</AdminCode> and your reason.</>} />
    <AdminSection title="Granted by this session" description="The profile's permission snapshot, fixed when the session started.">
      <div className="flex flex-wrap gap-1">{[...permitted].map((code) => <AdminStatus key={code} variant="success">{code}</AdminStatus>)}</div>
    </AdminSection>
    {permitted.has("organization.webhooks.read") && <AdminSection title="Webhook endpoints" description="Pause, resume, test, and replay use the tenant's webhook service. Signing secrets are never available in support.">
      <AdminQueryState query={webhooks} isEmpty={(data) => data.endpoints.length === 0} empty="This tenant has no webhook endpoints.">{(data) => <AdminDataTable caption="Tenant webhook endpoints" selectable rows={data.endpoints} rowKey={(row) => row.id} rowLabel={(row) => row.name}
        rowActions={(row) => manage ? [...(row.state !== "disabled" ? [{ label: row.state === "active" ? "Pause" : "Resume", hotkey: "p", run: toggle(row) }] : []), ...(row.state === "active" ? [{ label: "Send test", hotkey: "t", run: test(row) }] : [])] : []}
        columns={[
          { header: "Endpoint", cell: (row) => <><p className="font-medium">{row.name}</p><p className="text-xs text-kumo-subtle">{row.url}</p></> },
          { header: "State", cell: (row) => <AdminStatus value={row.state}>{row.state}</AdminStatus> },
          { header: "Health", cell: (row) => <AdminStatus value={row.health}>{row.health}</AdminStatus> },
          { header: "Last success", cell: (row) => formatDate(row.lastSuccessAt) },
        ]} />}</AdminQueryState>
      {endpoint && <div className="mt-4 flex flex-col gap-2">
        <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">Deliveries for {endpoint.name}</h3>{manage && endpoint.state === "active" && <Button size="sm" variant="secondary" onClick={test(endpoint)}>Send test</Button>}</div>
        <AdminQueryState query={endpointDeliveries} isEmpty={(data) => data.deliveries.length === 0} empty="No deliveries yet.">{(data) => <AdminDataTable caption="Endpoint deliveries" primary={false} selectable param="delivery" rows={data.deliveries} rowKey={(row) => row.id} rowLabel={(row) => row.event}
          rowActions={(row) => replayable(row) ? [{ label: "Replay", hotkey: "r", run: () => void act("Replay queued", () => api.supportReplay(row.id)) }] : []}
          columns={[
            { header: "Event", cell: (row) => <>{row.event}{row.test && <> <AdminStatus variant="info">test</AdminStatus></>}</> },
            { header: "Status", cell: (row) => <AdminStatus value={row.status}>{row.status}</AdminStatus> },
            { header: "Attempts", cell: (row) => `${row.attempts}${row.responseCode ? ` · HTTP ${row.responseCode}` : ""}${row.failureCategory ? ` · ${row.failureCategory}` : ""}` },
            { header: "Created", cell: (row) => formatDate(row.createdAt) },
          ]} />}</AdminQueryState>
      </div>}
    </AdminSection>}
    {permitted.has("organization.members.read") && <AdminSection title="Members"><AdminQueryState query={members} isEmpty={(data) => data.members.length === 0}>{(data) => <AdminDataTable caption="Tenant members" primary={false} rows={data.members} rowKey={(row) => row.memberId} columns={[
      { header: "Member", cell: (row) => row.name },
      { header: "Organization roles", cell: (row) => row.organizationRoles.join(", ") || "—" },
    ]} />}</AdminQueryState></AdminSection>}
    {permitted.has("organization.notifications.read") && <AdminSection title="Notification deliveries"><AdminQueryState query={deliveries} isEmpty={(data) => data.deliveries.length === 0} empty="No notification deliveries.">{(data) => <AdminDataTable caption="Tenant notification deliveries" primary={false} rows={data.deliveries} rowKey={(row) => row.id} columns={[
      { header: "Type", cell: (row) => <AdminCode>{row.type}</AdminCode> },
      { header: "Channel", cell: (row) => row.channel },
      { header: "Status", cell: (row) => <AdminStatus value={row.status}>{row.status}</AdminStatus> },
      { header: "Preference", cell: (row) => row.preference },
      { header: "When", cell: (row) => formatDate(row.createdAt) },
    ]} />}</AdminQueryState></AdminSection>}
    {permitted.has("organization.audit.read") && <AdminSection title="Tenant audit"><AdminQueryState query={audit} isEmpty={(data) => data.events.length === 0}>{(data) => <AdminDataTable caption="Tenant audit" primary={false} rows={data.events} rowKey={(row) => row.id} columns={[
      { header: "When", cell: (row) => formatDate(row.occurredAt) },
      { header: "Event", cell: (row) => <AdminCode>{row.name}</AdminCode> },
      { header: "Actor", cell: (row) => `${row.actorType} ${row.actorId}` },
      { header: "Reason", cell: (row) => row.reason ?? "—" },
    ]} />}</AdminQueryState></AdminSection>}
  </>;
}
