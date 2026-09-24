import { LifebuoyIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "support-sessions",
  path: "/support/sessions",
  navigation: { label: "Support Sessions", group: "Customers", order: 40, icon: LifebuoyIcon },
  permission: "platform.support_sessions.use",
  component: () => import("./view"),
  commands: [
    { id: "support-sessions.open", label: "Go to Support Sessions", hotkey: "g x", keywords: ["tenant", "context", "support"] },
    { id: "support-sessions.start", label: "Start a support session", hotkey: "n", kind: "action", scope: "view", permission: "platform.support_sessions.use", keywords: ["enter", "tenant"] },
    { id: "support-sessions.exit", label: "Exit your support session", hotkey: "x", kind: "action", scope: "view", keywords: ["leave"] },
  ],
});
