import { ArchiveIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "artifacts",
  path: "/operations/artifacts",
  navigation: { label: "Artifacts", group: "Operations", order: 30, icon: ArchiveIcon },
  permission: "platform.artifacts.read",
  component: () => import("./view"),
  commands: [
    { id: "artifacts.open", label: "Go to Artifacts", hotkey: "g f", keywords: ["files", "r2", "storage"] },
  ],
});
