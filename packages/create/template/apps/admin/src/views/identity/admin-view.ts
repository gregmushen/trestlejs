import { IdentificationBadgeIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "identity",
  path: "/access/identity",
  navigation: { label: "Enterprise Identity", group: "Access", order: 70, icon: IdentificationBadgeIcon },
  permission: "platform.identity.read",
  capability: "sso",
  component: () => import("./view"),
  commands: [
    { id: "identity.open", label: "Go to Enterprise Identity", hotkey: "g y", keywords: ["sso", "scim", "directory", "workos", "saml", "oidc"] },
    { id: "identity.refresh", label: "Refresh identity status", hotkey: "r", kind: "action", scope: "view" },
  ],
});
