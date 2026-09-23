import { WebhooksLogoIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "webhooks",
  path: "/integrations/webhooks",
  navigation: { label: "Webhooks", group: "Integrations", order: 10, icon: WebhooksLogoIcon },
  permission: "platform.webhooks.read",
  capability: "webhooks",
  component: () => import("./view"),
  commands: [
    { id: "webhooks.open", label: "Go to Webhooks", hotkey: "g w", keywords: ["endpoint", "delivery", "integration"] },
    { id: "webhooks.new", label: "New webhook", hotkey: "n", kind: "action", scope: "view", permission: "platform.webhooks.manage", keywords: ["create", "endpoint"] },
    { id: "webhooks.disable", label: "Emergency-disable the selected endpoint", hotkey: "d", kind: "action", scope: "selection", requires: "an enabled endpoint", destructive: true, permission: "platform.webhooks.disable", keywords: ["stop", "kill"] },
  ],
});
