import { ClipboardTextIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "audit",
  path: "/operations/audit",
  navigation: { label: "Audit", group: "Operations", order: 40, icon: ClipboardTextIcon },
  permission: "platform.audit.read",
  component: () => import("./view"),
  commands: [
    { id: "audit.open", label: "Go to Audit", hotkey: "g a", keywords: ["history", "log", "events"] },
    { id: "audit.copy-correlation", label: "Copy the selected event's correlation ID", hotkey: "c", kind: "action", scope: "selection", requires: "an audit event" },
    { id: "audit.open-support-session", label: "Open the event's support session", hotkey: "s", kind: "action", scope: "selection", requires: "an event recorded in a support session", permission: "platform.support.read", capability: "supportSessions" },
  ],
});
