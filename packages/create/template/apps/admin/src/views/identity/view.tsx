import { api } from "../../api";
import { useAdminCommands } from "../../shell/commands";
import { useAdminQuery } from "../../shell/context";
import { AdminDataTable, AdminPageHeader, AdminQueryState, AdminSection, AdminStatus, formatDate } from "../../shell/ui";

/**
 * Enterprise identity across tenants, read-only. Tenants configure SSO,
 * SCIM, and group mappings themselves; secrets and IdP configuration never
 * reach this surface. Directory mappings can grant organization and
 * application roles only, never platform roles.
 */
export default function IdentityView() {
  const status = useAdminQuery(["identity"], () => api.identity());
  useAdminCommands({ "identity.refresh": { run: () => void status.refetch() } });
  const tenant = (row: { organizationName: string | null; organizationId: string | null }) => row.organizationName ?? row.organizationId ?? "—";
  return <>
    <AdminPageHeader title="Enterprise identity" description="SSO connections, directory provisioning, and recent directory events for every organization. Read-only: organizations manage their own identity settings." />
    <AdminQueryState query={status}>{(data) => <>
      <AdminSection title="Connections" description="Provider bindings, their last directory event, and the safe failure reason if one occurred.">
        <AdminDataTable caption="Identity connections" primary rows={data.connections} rowKey={(row) => `${row.provider}:${row.kind}:${row.externalId}:${row.domain ?? ""}`} columns={[
          { header: "Organization", cell: tenant },
          { header: "Kind", cell: (row) => row.kind === "sso" ? "SSO" : "Directory" },
          { header: "Provider", cell: (row) => row.provider === "workos" ? "WorkOS" : "Better Auth" },
          { header: "Connection", cell: (row) => <code>{row.externalId}</code> },
          { header: "Domain", cell: (row) => row.domain ?? "—" },
          { header: "State", cell: (row) => <AdminStatus value={row.state}>{row.state}</AdminStatus> },
          { header: "Mappings", cell: (row) => row.kind === "directory" ? row.mappings : "—" },
          { header: "Last event", cell: (row) => formatDate(row.lastEventAt) },
          { header: "Failure", cell: (row) => row.lastError ?? "—" },
        ]} />
      </AdminSection>
      <AdminSection title="SSO providers" description="Better Auth OIDC and SAML providers. Outside local, sign-in requires a verified domain.">
        <AdminDataTable caption="SSO providers" rows={data.ssoProviders} rowKey={(row) => row.providerId} columns={[
          { header: "Organization", cell: tenant },
          { header: "Provider", cell: (row) => <code>{row.providerId}</code> },
          { header: "Issuer", cell: (row) => row.issuer },
          { header: "Domain", cell: (row) => row.domain },
          { header: "Domain proof", cell: (row) => <AdminStatus variant={row.domainVerified ? "success" : "warning"}>{row.domainVerified ? "Verified" : "Unverified"}</AdminStatus> },
        ]} />
      </AdminSection>
      <AdminSection title="SCIM connections" description="Better Auth SCIM connections, active provisioned users, and credential status. Tokens are never shown.">
        <AdminDataTable caption="SCIM connections" rows={data.scim} rowKey={(row) => row.connectionId} columns={[
          { header: "Organization", cell: tenant },
          { header: "Connection", cell: (row) => <code>{row.connectionId}</code> },
          { header: "Status", cell: (row) => <AdminStatus value={row.status}>{row.status}</AdminStatus> },
          { header: "Active users", cell: (row) => row.activeUsers },
          { header: "Credential expires", cell: (row) => formatDate(row.credential?.expiresAt) },
          { header: "Last used", cell: (row) => formatDate(row.credential?.lastUsedAt) },
        ]} />
      </AdminSection>
      <AdminSection title="Recent directory events" description="WorkOS Directory Sync events applied by the customer Worker; each event ID is processed once.">
        <AdminDataTable caption="Directory events" rows={data.events} rowKey={(row) => row.id} columns={[
          { header: "Organization", cell: tenant },
          { header: "Type", cell: (row) => row.type },
          { header: "Outcome", cell: (row) => <AdminStatus value={row.outcome}>{row.outcome}</AdminStatus> },
          { header: "Received", cell: (row) => formatDate(row.receivedAt) },
        ]} />
      </AdminSection>
    </>}</AdminQueryState>
  </>;
}
