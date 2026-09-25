import { ShieldStarIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "platform-roles",
  path: "/access/platform-roles",
  navigation: { label: "Platform Roles", group: "Access", order: 30, icon: ShieldStarIcon },
  permission: "platform.roles.read",
  component: () => import("./view"),
  commands: [
    { id: "platform-roles.open", label: "Go to Platform Roles", keywords: ["operators"] },
    { id: "platform-roles.assign", label: "Assign a platform role", hotkey: "n", kind: "action", scope: "view", permission: "platform.roles.manage", keywords: ["grant", "operator"] },
    { id: "platform-roles.revoke", label: "Revoke the selected assignment", hotkey: "r", kind: "action", scope: "selection", requires: "an active assignment", destructive: true, permission: "platform.roles.manage" },
  ],
});
