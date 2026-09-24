import { WebhooksLogoIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "webhooks",
  path: "/integrations/webhooks",
  navigation: { label: "Webhooks", group: "Integrations", order: 10, icon: WebhooksLogoIcon },
  permission: "platform.operations.read",
  component: () => import("./view"),
  commands: [
    { id: "webhooks.open", label: "Go to Webhooks", hotkey: "g w", keywords: ["endpoint", "delivery", "integration"] },
    { id: "webhooks.disable", label: "Emergency-disable the selected endpoint", hotkey: "d", kind: "action", scope: "selection", requires: "an enabled endpoint", destructive: true, permission: "platform.webhooks.manage", keywords: ["stop", "kill"] },
  ],
});
