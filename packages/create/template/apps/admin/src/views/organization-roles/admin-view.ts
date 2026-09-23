import { UsersThreeIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "organization-roles",
  path: "/access/organization-roles",
  navigation: { label: "Organization Roles", group: "Access", order: 10, icon: UsersThreeIcon },
  permission: "platform.roles.read",
  component: () => import("./view"),
  commands: [
    { id: "organization-roles.open", label: "Go to Organization Roles", keywords: ["owner", "members"] },
    { id: "organization-roles.new", label: "New organization role", hotkey: "n", kind: "action", scope: "view", permission: "platform.access_catalog.manage" },
  ],
});
