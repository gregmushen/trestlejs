import { LightningIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "jobs",
  path: "/operations/jobs",
  navigation: { label: "Jobs", group: "Operations", order: 25, icon: LightningIcon },
  permission: "platform.operations.read",
  overviewCard: { title: "Jobs engine", order: 25, component: () => import("./card") },
  component: () => import("./view"),
  commands: [
    { id: "jobs.open", label: "Go to Jobs", hotkey: "g n", keywords: ["engine", "runtime", "trigger", "inngest", "workflows"] },
    { id: "jobs.pause", label: "Pause or resume job dispatch", hotkey: "p", kind: "action", scope: "view", permission: "platform.jobs.manage", keywords: ["stop", "hold", "resume"] },
    { id: "jobs.settle", label: "Settle unconsumed job events now", hotkey: "Shift+S", kind: "action", scope: "view", destructive: true, permission: "platform.jobs.manage", keywords: ["redispatch", "drain", "migrate"] },
    { id: "jobs.revert", label: "Revert jobs to the deployed configuration", hotkey: "Shift+V", kind: "action", scope: "view", destructive: true, permission: "platform.jobs.manage", keywords: ["override", "rollback", "undo"] },
    { id: "jobs.refresh", label: "Refresh jobs state", hotkey: "Shift+R", kind: "action", scope: "view" },
  ],
});
