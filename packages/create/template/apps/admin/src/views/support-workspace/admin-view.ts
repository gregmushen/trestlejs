import { HeadsetIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "support-workspace",
  path: "/support/workspace",
  navigation: { label: "Support Workspace", group: "Customers", order: 50, icon: HeadsetIcon },
  permission: "platform.support_sessions.use",
  component: () => import("./view"),
  commands: [
    { id: "support-workspace.open", label: "Go to the Support Workspace", hotkey: "g y", keywords: ["tenant", "support", "customer"] },
  ],
});
