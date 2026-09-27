import { api } from "../../api";
import type { EmailSuppression } from "../../main-backend";
import { useAdminCommands } from "../../shell/commands";
import { useConfirmAction, type ConfirmConfig } from "../../shell/ConfirmAction";
import { useAdmin, useAdminQuery, useInvalidate, useTenantScope } from "../../shell/context";
import { Banner } from "../../shell/kumo";
import { OrganizationPicker } from "../../shell/pickers";
import { useSelectedDetail } from "../../shell/resource";
import { AdminCode, AdminDataTable, AdminFilter, AdminPageHeader, AdminQueryState, AdminStatus, formatDate } from "../../shell/ui";
import { useViewSearch } from "../../shell/url-state";

const reasonVariant = { bounced: "warning", complained: "destructive", unsubscribed: "neutral" } as const;

/**
 * Addresses each organization must not email: permanent bounces and spam
 * complaints from verified Resend webhooks, and unsubscribes. Addresses are
 * masked; searching by a full address finds it exactly, and only then can an
 * operator with platform.email.manage remove it (reason, step-up, audited).
 */
export default function EmailSuppressionsView() {
  const { can } = useAdmin();
  const manage = can("platform.email.manage");
  const invalidate = useInvalidate();
  const [scope] = useTenantScope();
  const [search, update] = useViewSearch<{ organization?: string; address?: string; selected?: string }>();
  const organizationId = search.organization ?? scope;
  const address = search.address?.includes("@") ? search.address : undefined;
  const suppressions = useAdminQuery(["email-suppressions", organizationId ?? "", address ?? ""], () => api.emailSuppressions({ ...(organizationId ? { organizationId } : {}), ...(address ? { address } : {}) }));
  const rows = suppressions.data?.suppressions ?? [];
  const selected = useSelectedDetail(rows, (row) => `${row.organizationId}:${row.address}`);
  const confirm = useConfirmAction();
  // Removal needs the full address, which the list never shows: only a row found by it qualifies.
  const removable = () => manage && Boolean(address);
  const remove = (row: EmailSuppression): ConfirmConfig => ({
    title: "Remove suppression", confirmLabel: "Remove suppression", destructive: true,
    scope: [`Allow ${row.organizationName ?? row.organizationId} to email ${row.address} again`, `Suppressed because the address ${row.reason === "complained" ? "reported email as spam" : row.reason === "bounced" ? "bounced permanently" : "unsubscribed"} (${formatDate(row.createdAt)})`],
    description: row.reason === "complained" ? <Banner variant="alert" title="This recipient marked email as spam" description="Emailing them again may violate their consent and harm sender reputation. Remove only with the recipient's documented request." />
      : row.reason === "unsubscribed" ? <Banner variant="alert" title="This recipient unsubscribed" description="Remove only with the recipient's documented consent." /> : undefined,
    onConfirm: (reason) => api.removeEmailSuppression({ organizationId: row.organizationId, address: address! }, reason),
    onDone: () => void invalidate("email-suppressions"), successMessage: "Suppression removed",
  });
  useAdminCommands({
    "email-suppressions.remove": { enabled: Boolean(selected.row && removable()), ...(selected.row ? { target: `${selected.row.organizationId}:${selected.row.address}` } : {}), confirm: () => { if (selected.row) confirm.open(remove(selected.row)); } },
    "email-suppressions.refresh": { run: () => void suppressions.refetch() },
  });
  return <>
    <AdminPageHeader title="Email suppressions" description="Addresses an organization's email is no longer sent to: permanent bounces, spam complaints, and unsubscribes. Addresses are masked; search by a full address to find and remove one." />
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <div className="w-full max-w-xs"><OrganizationPicker value={organizationId} onChange={(id) => update({ organization: id || undefined })} /></div>
      <AdminFilter className="w-full max-w-xs" label="Full email address" placeholder="person@example.com" param="address" />
    </div>
    <AdminQueryState query={suppressions} isEmpty={() => rows.length === 0} empty={address ? "That address is not suppressed." : "No suppressed addresses."}>{() => <AdminDataTable caption="Email suppressions" selectable rows={rows} rowKey={(row) => `${row.organizationId}:${row.address}`} rowLabel={(row) => row.address}
      rowActions={(row) => removable() ? [{ label: "Remove suppression", hotkey: "Shift+X", destructive: true, run: () => confirm.open(remove(row)) }] : []}
      columns={[
        { header: "Address", minWidth: "12rem", cell: (row) => <AdminCode>{row.address}</AdminCode> },
        { header: "Organization", minWidth: "10rem", cell: (row) => row.organizationName ?? <AdminCode>{row.organizationId}</AdminCode> },
        { header: "Reason", nowrap: true, cell: (row) => <AdminStatus variant={reasonVariant[row.reason]}>{row.reason}</AdminStatus> },
        { header: "Source event", priority: "low", cell: (row) => row.sourceEventId ? <AdminCode>{row.sourceEventId}</AdminCode> : "—" },
        { header: "Since", nowrap: true, cell: (row) => formatDate(row.createdAt) },
      ]} />}</AdminQueryState>
    {confirm.dialog}
  </>;
}
