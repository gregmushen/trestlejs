import { ProhibitIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "email-suppressions",
  path: "/communications/suppressions",
  navigation: { label: "Suppressions", group: "Communications", order: 25, icon: ProhibitIcon },
  permission: "platform.operations.read",
  capability: "email",
  component: () => import("./view"),
  commands: [
    { id: "email-suppressions.open", label: "Go to Email Suppressions", hotkey: "g b", keywords: ["bounce", "complaint", "unsubscribe", "suppression"] },
    { id: "email-suppressions.remove", label: "Remove the selected suppression", hotkey: "Shift+X", kind: "action", scope: "selection", requires: "a suppression found by its full address", destructive: true, permission: "platform.email.manage", keywords: ["unsuppress", "allow", "delete"] },
    { id: "email-suppressions.refresh", label: "Refresh suppressions", hotkey: "r", kind: "action", scope: "view" },
  ],
});
