import { FlowArrowIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "email-sequences",
  path: "/communications/sequences",
  navigation: { label: "Sequences", group: "Communications", order: 30, icon: FlowArrowIcon },
  permission: "platform.operations.read",
  capability: "email",
  overviewCard: { title: "Email sequences", order: 35, component: () => import("./card") },
  component: () => import("./view"),
  commands: [
    { id: "email-sequences.open", label: "Go to Email Sequences", hotkey: "g q", keywords: ["drip", "nurture", "campaign", "sequence"] },
    { id: "email-sequences.exit", label: "Exit the selected sequence run", hotkey: "Shift+E", kind: "action", scope: "selection", requires: "an active run", destructive: true, permission: "platform.sequences.manage", keywords: ["stop", "cancel", "end"] },
    { id: "email-sequences.refresh", label: "Refresh sequences", hotkey: "r", kind: "action", scope: "view" },
  ],
});
