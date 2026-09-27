import { PlugsConnectedIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "connections",
  path: "/integrations/connections",
  navigation: { label: "Connections", group: "Integrations", order: 20, icon: PlugsConnectedIcon },
  permission: "platform.operations.read",
  component: () => import("./view"),
  commands: [
    { id: "connections.open", label: "Go to Connections", hotkey: "g c", keywords: ["integration", "nango", "oauth", "backend"] },
  ],
});
