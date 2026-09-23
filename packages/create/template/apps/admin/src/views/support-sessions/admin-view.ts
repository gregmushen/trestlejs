import { LifebuoyIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "support-sessions",
  path: "/support/sessions",
  navigation: { label: "Support Sessions", group: "Customers", order: 40, icon: LifebuoyIcon },
  permission: "platform.support.read",
  capability: "supportSessions",
  component: () => import("./view"),
  commands: [
    { id: "support-sessions.open", label: "Go to Support Sessions", hotkey: "g x", keywords: ["tenant", "context", "support"] },
    { id: "support-sessions.start", label: "Start a support session", hotkey: "n", kind: "action", scope: "view", permission: "platform.support.enter_tenant", keywords: ["enter", "tenant"] },
    { id: "support-sessions.exit", label: "Exit your support session", hotkey: "x", kind: "action", scope: "view", keywords: ["leave"] },
    { id: "support-sessions.revoke", label: "Revoke the selected session", hotkey: "r", kind: "action", scope: "selection", requires: "an active session", destructive: true, permission: "platform.support.revoke", keywords: ["end", "terminate"] },
  ],
});
