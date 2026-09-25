import { AppWindowIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "application-roles",
  path: "/access/application-roles",
  navigation: { label: "Application Roles", group: "Access", order: 20, icon: AppWindowIcon },
  permission: "platform.roles.read",
  component: () => import("./view"),
  commands: [
    { id: "application-roles.open", label: "Go to Application Roles", keywords: ["product roles"] },
  ],
});
