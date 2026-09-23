import { UsersIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "users",
  path: "/users",
  navigation: { label: "Users", group: "Customers", order: 20, icon: UsersIcon },
  permission: "platform.users.read",
  component: () => import("./view"),
  commands: [
    { id: "users.open", label: "Go to Users", hotkey: "g u", keywords: ["people", "accounts"] },
    { id: "users.suspend", label: "Suspend or restore user", hotkey: "s", kind: "action", scope: "selection", requires: "a user", destructive: true, permission: "platform.users.suspend", keywords: ["ban", "block", "restore"] },
    { id: "users.revoke-sessions", label: "Revoke user sessions", hotkey: "r", kind: "action", scope: "selection", requires: "a user", destructive: true, permission: "platform.sessions.revoke", keywords: ["sign out", "logout"] },
  ],
});
