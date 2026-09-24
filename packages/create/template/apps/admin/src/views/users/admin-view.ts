import { UsersIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "users",
  path: "/users",
  navigation: { label: "Users", group: "Customers", order: 20, icon: UsersIcon },
  permission: "platform.users.read",
  component: () => import("./view"),
  commands: [
    { id: "users.open", label: "Go to Users", hotkey: "g u", keywords: ["people", "accounts"] },
  ],
});
