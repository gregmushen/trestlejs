import { FingerprintIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "authentication",
  path: "/system/authentication",
  navigation: { label: "Authentication", group: "System", order: 20, icon: FingerprintIcon },
  permission: "platform.auth_policy.read",
  component: () => import("./view"),
  commands: [
    { id: "authentication.open", label: "Go to Authentication", hotkey: "g t", keywords: ["sign-in", "sessions", "mfa", "policy", "registration"] },
    { id: "authentication.draft", label: "Edit authentication policy as a draft", hotkey: "e", kind: "action", scope: "view", permission: "platform.auth_policy.manage", keywords: ["change", "policy"] },
  ],
});
