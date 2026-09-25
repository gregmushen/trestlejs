import { StackIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "plans",
  path: "/commercial/plans",
  navigation: { label: "Plans", group: "Commercial", order: 10, icon: StackIcon },
  permission: "platform.subscriptions.read",
  capability: "payments",
  component: () => import("./view"),
  commands: [
    { id: "plans.open", label: "Go to Plans", hotkey: "g p", keywords: ["pricing", "features", "catalog"] },
  ],
});
