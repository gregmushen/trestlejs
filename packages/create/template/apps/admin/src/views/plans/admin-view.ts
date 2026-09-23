import { StackIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "plans",
  path: "/plans",
  navigation: { label: "Plans", group: "Commercial", order: 10, icon: StackIcon },
  permission: "platform.plans.read",
  capability: "plans",
  component: () => import("./view"),
  commands: [
    { id: "plans.open", label: "Go to Plans", hotkey: "g p", keywords: ["pricing", "features"] },
    { id: "plans.new", label: "New plan", hotkey: "n", kind: "action", scope: "view", permission: "platform.plans.manage", keywords: ["create", "pricing"] },
    { id: "plans.draft", label: "Draft the next plan version", hotkey: "d", kind: "action", scope: "view", permission: "platform.plans.manage", keywords: ["new version", "pricing"] },
    { id: "plans.edit", label: "Edit the selected draft", hotkey: "e", kind: "action", scope: "selection", requires: "a draft version", permission: "platform.plans.manage" },
    { id: "plans.activate", label: "Activate the selected draft", hotkey: "a", kind: "action", scope: "selection", requires: "a draft version", permission: "platform.plans.manage" },
    { id: "plans.grandfather", label: "Grandfather the selected version", hotkey: "Shift+G", kind: "action", scope: "selection", requires: "an active version", destructive: true, permission: "platform.plans.manage" },
    { id: "plans.retire", label: "Retire the selected version", hotkey: "Shift+R", kind: "action", scope: "selection", requires: "a grandfathered version", destructive: true, permission: "platform.plans.manage" },
  ],
});
