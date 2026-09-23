import { BellIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "notifications",
  path: "/communications/notifications",
  navigation: { label: "Notifications", group: "Communications", order: 10, icon: BellIcon },
  permission: "platform.notifications.read",
  capability: "notifications",
  component: () => import("./view"),
  commands: [
    { id: "notifications.open", label: "Go to Notifications", hotkey: "g n", keywords: ["inbox", "alerts", "delivery"] },
    { id: "notifications.new-stream", label: "New notification stream", hotkey: "n", kind: "action", scope: "view", permission: "platform.notification_streams.manage", keywords: ["create", "type", "template"] },
    { id: "notifications.retry", label: "Retry the selected delivery", hotkey: "r", kind: "action", scope: "selection", requires: "a failed, retryable delivery", permission: "platform.notifications.manage", keywords: ["resend"] },
    { id: "notifications.cancel", label: "Cancel the selected delivery", hotkey: "c", kind: "action", scope: "selection", requires: "a pending, optional delivery", destructive: true, permission: "platform.notifications.manage" },
  ],
});
