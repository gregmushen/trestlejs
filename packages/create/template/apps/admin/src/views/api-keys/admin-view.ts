import { KeyIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "api-keys",
  path: "/access/api-keys",
  navigation: { label: "API Keys", group: "Access", order: 60, icon: KeyIcon },
  permission: "platform.machine_access.read",
  component: () => import("./view"),
  commands: [
    { id: "api-keys.open", label: "Go to API Keys", hotkey: "g k", keywords: ["tokens", "credentials"] },
    { id: "api-keys.revoke", label: "Revoke the selected API key", hotkey: "r", kind: "action", scope: "selection", requires: "an unrevoked API key", destructive: true, permission: "platform.api_keys.revoke", keywords: ["leaked", "compromised", "token"] },
  ],
});
