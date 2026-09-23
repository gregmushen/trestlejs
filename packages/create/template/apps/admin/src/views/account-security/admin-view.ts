import { ShieldIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "account-security",
  path: "/system/security",
  navigation: { label: "Account Security", group: "System", order: 30, icon: ShieldIcon },
  // Every platform role holds platform.overview.read; managing your own factors needs no other authority.
  permission: "platform.overview.read",
  component: () => import("./view"),
  commands: [
    { id: "account-security.open", label: "Go to Account Security", hotkey: "g i", keywords: ["passkey", "two-factor", "mfa", "totp"] },
    { id: "account-security.add-passkey", label: "Add a passkey", hotkey: "p", kind: "action", scope: "view", keywords: ["webauthn", "security key"] },
  ],
});
