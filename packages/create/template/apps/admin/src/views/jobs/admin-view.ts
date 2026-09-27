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
  ],
});
