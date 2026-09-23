import { HeadsetIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "support-workspace",
  path: "/support/workspace",
  navigation: { label: "Support Workspace", group: "Customers", order: 45, icon: HeadsetIcon },
  permission: "platform.support.enter_tenant",
  capability: "supportSessions",
  component: () => import("./view"),
  commands: [
    { id: "support-workspace.open", label: "Go to Support Workspace", hotkey: "g c", keywords: ["tenant", "context", "act"] },
    { id: "support-workspace.toggle-endpoint", label: "Pause or resume the selected endpoint", hotkey: "p", kind: "action", scope: "selection", requires: "a tenant webhook endpoint" },
    { id: "support-workspace.test-endpoint", label: "Queue a test event for the selected endpoint", hotkey: "t", kind: "action", scope: "selection", requires: "an active tenant webhook endpoint" },
    { id: "support-workspace.replay", label: "Replay the selected delivery", hotkey: "r", kind: "action", scope: "selection", requires: "a completed delivery" },
  ],
});
