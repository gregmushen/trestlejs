import { ReceiptIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "subscriptions",
  path: "/commercial/subscriptions",
  navigation: { label: "Subscriptions", group: "Commercial", order: 20, icon: ReceiptIcon },
  permission: "platform.subscriptions.read",
  capability: "payments",
  component: () => import("./view"),
  commands: [
    { id: "subscriptions.open", label: "Go to Subscriptions", hotkey: "g s", keywords: ["billing", "customers", "plan"] },
    { id: "subscriptions.override", label: "Grant or deny an entitlement", hotkey: "o", kind: "action", scope: "selection", requires: "a subscription", permission: "platform.entitlements.manage", keywords: ["contract", "negotiated", "override"] },
  ],
});
