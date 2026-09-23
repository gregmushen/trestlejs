import { HeartbeatIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "health",
  path: "/system/health",
  navigation: { label: "Health", group: "System", order: 10, icon: HeartbeatIcon },
  permission: "platform.overview.read",
  overviewCard: { title: "Capability health", order: 10, component: () => import("./card") },
  component: () => import("./view"),
  commands: [
    { id: "health.open", label: "Go to Health", hotkey: "g h", keywords: ["status", "capabilities"] },
    { id: "health.refresh", label: "Refresh health checks", hotkey: "r", kind: "action", scope: "view" },
  ],
});
