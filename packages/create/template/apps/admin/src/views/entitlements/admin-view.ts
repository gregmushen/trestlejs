import { ListChecksIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "entitlements",
  path: "/commercial/entitlements",
  navigation: { label: "Entitlements", group: "Commercial", order: 30, icon: ListChecksIcon },
  permission: "platform.subscriptions.read",
  capability: "payments",
  component: () => import("./view"),
  commands: [
    { id: "entitlements.open", label: "Go to Entitlements", hotkey: "g e", keywords: ["features", "access", "plan", "override"] },
  ],
});
