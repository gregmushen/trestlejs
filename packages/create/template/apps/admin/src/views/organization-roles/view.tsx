import { useState } from "react";

import { useAdminCommands } from "../../shell/commands";
import { useAdmin } from "../../shell/context";
import { RoleManager } from "../../shell/role-manager";

export default function OrganizationRolesView() {
  const { can } = useAdmin();
  const [createRequests, setCreateRequests] = useState(0);
  return <RoleManager plane="organization" title="Organization roles" createRequests={createRequests}
    description="Account-administration roles available to every organization. Owner is not an application or platform administrator. Roles are defined in reviewed source (packages/authz)." />;
}
