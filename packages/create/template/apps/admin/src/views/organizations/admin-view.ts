import { BuildingsIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "organizations",
  path: "/organizations",
  navigation: { label: "Organizations", group: "Customers", order: 10, icon: BuildingsIcon },
  permission: "platform.organizations.read",
  component: () => import("./view"),
  commands: [
    { id: "organizations.open", label: "Go to Organizations", hotkey: "g o", keywords: ["customers", "tenants"] },
    { id: "organizations.start-support-session", label: "Start support session", hotkey: "e", kind: "action", scope: "selection", requires: "an organization", permission: "platform.support.enter_tenant", capability: "supportSessions", keywords: ["support", "tenant", "context", "ticket"] },
    { id: "organizations.exit-support-session", label: "Exit support context", hotkey: "x", kind: "action", scope: "view", keywords: ["leave", "support"] },
  ],
});
