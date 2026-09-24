import { SquaresFourIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "overview",
  path: "/",
  navigation: { label: "Overview", group: "Overview", order: 10, icon: SquaresFourIcon },
  permission: "platform.overview.read",
  component: () => import("./view"),
  commands: [
    { id: "overview.open", label: "Go to Overview", hotkey: "g d", keywords: ["home", "dashboard"] },
    { id: "overview.refresh", label: "Refresh overview", hotkey: "r", kind: "action", scope: "view" },
    { id: "overview.focus-unhealthy", label: "Focus the first exception", hotkey: "c", kind: "focus", scope: "view" },
  ],
});
