import { RobotIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "service-accounts",
  path: "/access/service-accounts",
  navigation: { label: "Service Accounts", group: "Access", order: 50, icon: RobotIcon },
  permission: "platform.machine_access.read",
  capability: "serviceAccounts",
  component: () => import("./view"),
  commands: [
    { id: "service-accounts.open", label: "Go to Service Accounts", hotkey: "g m", keywords: ["machines", "bots"] },
    { id: "service-accounts.new", label: "New service account", hotkey: "n", kind: "action", scope: "view", permission: "platform.machine_access.manage", keywords: ["create", "bot"] },
    { id: "service-accounts.suspend", label: "Suspend the selected service account", hotkey: "s", kind: "action", scope: "selection", requires: "an active service account", destructive: true, permission: "platform.machine_access.revoke", keywords: ["revoke", "disable", "bot"] },
  ],
});
