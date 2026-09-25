import { useState } from "react";

import { api } from "../../api";
import { useAdminCommands } from "../../shell/commands";
import { useAdmin, useAdminQuery, useTenantScope } from "../../shell/context";
import { OrganizationPicker } from "../../shell/pickers";
import { RoleManager } from "../../shell/role-manager";
import { AdminDataTable, AdminEmpty, AdminQueryState, AdminSection, formatDate } from "../../shell/ui";
import { useViewSearch } from "../../shell/url-state";

export default function ApplicationRolesView() {
  const { can } = useAdmin();
  const [createRequests, setCreateRequests] = useState(0);
  const [scope] = useTenantScope();
  const [search, update] = useViewSearch<{ organization?: string }>();
  const organizationId = search.organization ?? scope;
  const assignments = useAdminQuery(["application-role-assignments", organizationId], () => api.applicationRoleAssignments(organizationId), { enabled: Boolean(organizationId) });
  return <RoleManager plane="application" title="Application roles" createRequests={createRequests}
    description="Product-domain roles, defined in reviewed source (packages/authz) and available to every organization. Assignments apply per organization to users and service accounts.">
    <AdminSection title="Assignments in one organization">
      <div className="mb-4 max-w-md"><OrganizationPicker value={organizationId} onChange={(id) => update({ organization: id || undefined })} /></div>
      {!organizationId ? <AdminEmpty title="Choose an organization" /> : <AdminQueryState query={assignments} isEmpty={(data) => data.assignments.length === 0} empty="No application-role assignments in this organization.">{(data) => <AdminDataTable caption="Application role assignments" primary={false} rows={data.assignments} rowKey={(row) => `${row.userId}:${row.role}`} columns={[
        { header: "User", minWidth: "12rem", cell: (row) => <>{row.name ?? row.userId}<p className="text-kumo-subtle">{row.email}</p></> },
        { header: "Role", nowrap: true, cell: (row) => row.role },
        { header: "Granted", nowrap: true, cell: (row) => `${formatDate(row.grantedAt)} by ${row.grantedBy}` },
      ]} />}</AdminQueryState>}
    </AdminSection>
  </RoleManager>;
}
