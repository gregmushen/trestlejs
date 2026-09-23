import { api } from "../../api";
import { useAdminQuery, useTenantScope } from "../../shell/context";
import { OrganizationPicker } from "../../shell/pickers";
import { AdminCode, AdminDataTable, AdminFilter, AdminPageHeader, AdminQueryState, AdminStatus, formatBytes, formatDate } from "../../shell/ui";
import { useViewSearch } from "../../shell/url-state";

export default function ArtifactsView() {
  const [scope] = useTenantScope();
  const [search, update] = useViewSearch<{ organization?: string; q?: string }>();
  const organizationId = search.organization ?? scope;
  const artifacts = useAdminQuery(["artifacts", organizationId], () => api.artifacts(organizationId || undefined));
  const q = (search.q ?? "").toLowerCase();
  const rows = (artifacts.data?.artifacts ?? []).filter((row) => !q || `${row.id} ${row.contentType}`.toLowerCase().includes(q));
  return <>
    <AdminPageHeader title="Artifacts" description="Ownership, metadata, and retention state. Contents and signed URLs are not available here." />
    <div className="mb-4 grid gap-3 sm:grid-cols-2"><OrganizationPicker value={organizationId} onChange={(id) => update({ organization: id || undefined })} /><AdminFilter className="" label="Filter artifacts" placeholder="ID or content type" /></div>
    <AdminQueryState query={artifacts} isEmpty={() => rows.length === 0} empty="No artifacts.">{() => <AdminDataTable caption="Artifacts" selectable rows={rows} rowKey={(row) => row.id} columns={[
      { header: "Artifact", cell: (row) => <AdminCode>{row.id}</AdminCode> },
      { header: "Organization", cell: (row) => row.organizationId },
      { header: "Type", cell: (row) => row.contentType },
      { header: "Size", cell: (row) => formatBytes(row.size) },
      { header: "Created", cell: (row) => formatDate(row.createdAt) },
      { header: "Retention", cell: (row) => row.deletedAt ? <AdminStatus variant="neutral">{`deleted ${formatDate(row.deletedAt)}`}</AdminStatus> : row.retention },
    ]} />}</AdminQueryState>
  </>;
}
