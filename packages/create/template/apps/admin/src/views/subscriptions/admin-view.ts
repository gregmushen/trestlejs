import { ReceiptIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "subscriptions",
  path: "/subscriptions",
  navigation: { label: "Subscriptions", group: "Commercial", order: 20, icon: ReceiptIcon },
  permission: "platform.subscriptions.read",
  capability: "plans",
  component: () => import("./view"),
  commands: [
    { id: "subscriptions.open", label: "Go to Subscriptions", hotkey: "g s", keywords: ["billing", "customers"] },
    { id: "subscriptions.override", label: "Add a subscription override", hotkey: "o", kind: "action", scope: "selection", requires: "a subscription", permission: "platform.subscriptions.manage", keywords: ["contract", "negotiated"] },
    { id: "subscriptions.schedule", label: "Schedule a plan change", hotkey: "c", kind: "action", scope: "selection", requires: "a subscription", permission: "platform.subscriptions.manage", keywords: ["migrate", "upgrade", "downgrade"] },
    { id: "subscriptions.reconcile", label: "Reconcile with the provider", hotkey: "r", kind: "action", scope: "selection", requires: "a subscription", permission: "platform.reconciliation.run", keywords: ["stripe", "sync"] },
  ],
});
