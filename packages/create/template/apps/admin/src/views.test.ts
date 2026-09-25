import { describe, expect, it } from "vitest";

import { adminViews } from "./api-registry";
import { adminRegistry } from "./views";

/**
 * The UI registry (view descriptors: navigation, icons, commands) and the
 * server registry (routes and the permissions the admin Worker enforces) must
 * describe the same views, so a sidebar entry never outlives or outruns the
 * authority behind it.
 */
describe("UI and server view registries", () => {
  it("describe the same views with the same paths and permissions", () => {
    const ui = new Map(adminRegistry.views.map((view) => [view.id, view]));
    const server = new Map(adminViews.map((view) => [view.id, view]));
    expect([...ui.keys()].sort()).toEqual([...server.keys()].sort());
    for (const [id, view] of ui) {
      expect({ id, path: view.path, permission: view.permission }).toEqual({ id, path: server.get(id)!.path, permission: server.get(id)!.permission });
    }
  });

  it("requires every command's permission to be one the server enforces on some admin route", () => {
    const enforced = new Set(adminViews.flatMap((view) => [view.permission, ...view.api.map((route) => route.permission ?? view.permission)]));
    for (const view of adminRegistry.views) {
      for (const command of view.commands) if (command.permission) expect(enforced, `${command.id} needs ${command.permission}`).toContain(command.permission);
    }
  });
});
