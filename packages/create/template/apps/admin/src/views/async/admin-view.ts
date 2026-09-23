import { ArrowsClockwiseIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "async",
  path: "/operations/async",
  navigation: { label: "Async Operations", group: "Operations", order: 20, icon: ArrowsClockwiseIcon },
  permission: "platform.jobs.read",
  overviewCard: { title: "Dead letters", order: 20, component: () => import("./card") },
  component: () => import("./view"),
  commands: [
    { id: "async.open", label: "Go to Async Operations", hotkey: "g j", keywords: ["jobs", "queue", "outbox", "dlq"] },
    { id: "async.redrive", label: "Redrive the selected dead letter", hotkey: "r", kind: "action", scope: "selection", requires: "a dead letter", permission: "platform.jobs.redrive", keywords: ["retry", "dlq", "failed"] },
    { id: "async.refresh", label: "Refresh outbox state", hotkey: "Shift+R", kind: "action", scope: "view" },
  ],
});
