import { RobotIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "service-accounts",
  path: "/access/service-accounts",
  navigation: { label: "Service Accounts", group: "Access", order: 50, icon: RobotIcon },
  permission: "platform.machine_access.read",
  component: () => import("./view"),
  commands: [
    { id: "service-accounts.open", label: "Go to Service Accounts", hotkey: "g m", keywords: ["machines", "bots"] },
  ],
});
