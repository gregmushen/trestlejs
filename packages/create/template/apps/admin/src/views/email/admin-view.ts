import { EnvelopeSimpleIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "email",
  path: "/communications/email",
  navigation: { label: "Email Delivery", group: "Communications", order: 20, icon: EnvelopeSimpleIcon },
  permission: "platform.email.read",
  capability: "email",
  component: () => import("./view"),
  commands: [
    { id: "email.open", label: "Go to Email Delivery", hotkey: "g l", keywords: ["mail", "delivery", "bounce"] },
    { id: "email.refresh", label: "Refresh email deliveries", hotkey: "r", kind: "action", scope: "view" },
  ],
});
