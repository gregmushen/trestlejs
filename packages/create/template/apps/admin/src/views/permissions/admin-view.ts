import { ShieldCheckIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "permissions",
  path: "/access/permissions",
  navigation: { label: "Permissions", group: "Access", order: 40, icon: ShieldCheckIcon },
  permission: "platform.roles.read",
  component: () => import("./view"),
  commands: [
    { id: "permissions.open", label: "Go to Permissions and access explorer", hotkey: "g r", keywords: ["registry", "roles", "explain", "why", "denied"] },
    { id: "permissions.new", label: "New permission", hotkey: "n", kind: "action", scope: "view", permission: "platform.access_catalog.manage" },
    { id: "permissions.focus-explorer", label: "Focus the Effective Access Explorer", hotkey: "x", kind: "focus", scope: "view", permission: "platform.access.explain", keywords: ["why", "denied", "debug"] },
  ],
});
