import { ListChecksIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "entitlements",
  path: "/entitlements",
  navigation: { label: "Entitlements", group: "Commercial", order: 30, icon: ListChecksIcon },
  permission: "platform.subscriptions.read",
  capability: "plans",
  component: () => import("./view"),
  commands: [
    { id: "entitlements.open", label: "Go to Entitlements", hotkey: "g e", keywords: ["features", "quotas", "limits"] },
    { id: "entitlements.compare", label: "Compare changes for this organization", hotkey: "c", kind: "action", scope: "view", permission: "platform.subscriptions.read", keywords: ["simulate", "what if", "preview"] },
  ],
});
