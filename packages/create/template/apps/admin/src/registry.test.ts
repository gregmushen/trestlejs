import { permissions } from "@__TRESTLE_PROJECT_NAME__/authz";
import { features } from "./billing-model";
import { describe, expect, it } from "vitest";

import { AdminRegistryError, availableCommands, breadcrumbsFor, buildAdminRegistry, defineAdminView, hotkeyConflicts, navigationGroups, repairCommand, searchCommands, visibleNavigation, type AdminCommand, type AdminViewDescriptor } from "./registry";

const component = async () => ({ default: () => null });
const icon = () => null;
type ViewOverrides = Omit<Partial<AdminViewDescriptor>, "navigation"> & { navigation?: Omit<AdminViewDescriptor["navigation"], "icon"> & { icon?: AdminViewDescriptor["navigation"]["icon"] } };
const view = (overrides: ViewOverrides = {}): AdminViewDescriptor => {
  const id = overrides.id ?? "contracts";
  return defineAdminView({
    id, path: "/contracts", permission: "platform.organizations.read", component, commands: [{ id: `${typeof id === "string" && /^[a-z]/u.test(id) ? id : "x"}.open`, label: `Go to ${id}` }],
    ...overrides, navigation: { label: "Contracts", group: "Customers", order: 40, icon, ...overrides.navigation },
  });
};
const options = { permissions, features, groups: navigationGroups };

describe("admin view registry", () => {
  it("orders views by group, order, and label and collects overview cards", () => {
    const registry = buildAdminRegistry([
      view({ id: "zeta", path: "/zeta", navigation: { label: "Zeta", group: "Operations", order: 10 } }),
      view({ id: "alpha", path: "/alpha", navigation: { label: "Alpha", group: "Customers", order: 50 }, overviewCard: { title: "Alpha card", order: 5, component } }),
      view(),
    ], options);
    expect(registry.views.map((entry) => entry.id)).toEqual(["contracts", "alpha", "zeta"]);
    expect(registry.groups.map((group) => group.name)).toEqual(["Customers", "Operations"]);
    expect(registry.overviewCards).toMatchObject([{ viewId: "alpha", title: "Alpha card" }]);
  });

  it("reports every invalid descriptor problem at once", () => {
    try {
      buildAdminRegistry([
        view(),
        view({ path: "/other" }),
        view({ id: "dup-path", path: "/contracts" }),
        view({ id: "tenant-permission", path: "/t", permission: "organization.members.read" }),
        view({ id: "unknown-permission", path: "/u", permission: "platform.nope.read" }),
        view({ id: "unknown-feature", path: "/f", entitlement: "made.up" }),
        view({ id: "unknown-capability", path: "/c", capability: "teleport" as never }),
        view({ id: "bad-group", path: "/g", navigation: { label: "Bad", group: "Nowhere", order: 1 } }),
        view({ id: "no-component", path: "/n", component: "view.tsx" as never }),
        view({ id: "Bad Id", path: "no-slash" }),
      ], options);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AdminRegistryError);
      const problems = (error as AdminRegistryError).problems.join("\n");
      for (const expected of ["duplicate id contracts", "duplicate path /contracts", "belongs to the organization plane", "platform.nope.read\" is not registered", "\"made.up\" is not a defined feature", "capability \"teleport\"", "navigation group \"Nowhere\"", "component must be a function", "must be kebab-case", "must start with \"/\""]) {
        expect(problems).toContain(expected);
      }
    }
  });

  it("filters navigation by platform permission and capability state without being a security boundary", () => {
    const registry = buildAdminRegistry([view(), view({ id: "keys", path: "/keys", permission: "platform.machine_access.read", capability: "apiKeys" }), view({ id: "mail", path: "/mail", permission: "platform.operations.read", capability: "email" })], options);
    const items = (permissionsHeld: string[], states: Record<string, { state: "disabled" | "declared" | "deployed"; message?: string }>) =>
      visibleNavigation(registry, { permissions: new Set(permissionsHeld), capabilityStates: states, environment: "staging" }).groups.flatMap((group) => group.items.map((item) => [item.view.id, item.availability.kind]));
    expect(items(["platform.organizations.read"], {})).toEqual([["contracts", "enabled"]]);
    expect(items(["platform.organizations.read", "platform.machine_access.read", "platform.operations.read"], { apiKeys: { state: "deployed" }, email: { state: "declared", message: "Email delivery is not configured for staging." } }))
      .toEqual([["contracts", "enabled"], ["keys", "enabled"], ["mail", "unconfigured"]]);
    const unconfigured = visibleNavigation(registry, { permissions: new Set(["platform.operations.read"]), capabilityStates: { email: { state: "declared" } }, environment: "staging" }).groups[0]!.items[0]!.availability;
    expect(unconfigured).toEqual({ kind: "unconfigured", message: "email is not configured for staging.", repair: "pnpm exec trestle setup --env staging" });
    expect(items(["platform.operations.read"], { email: { state: "disabled" } })).toEqual([]);
    expect(repairCommand("local")).toBe("pnpm exec trestle setup");
  });

  it("derives breadcrumbs from the registry", () => {
    const registry = buildAdminRegistry([view()], options);
    expect(breadcrumbsFor(registry, "/contracts/")).toEqual([{ label: "Admin", to: "/" }, { label: "Customers" }, { label: "Contracts" }]);
    expect(breadcrumbsFor(registry, "/missing").at(-1)).toEqual({ label: "Not found" });
  });
});

describe("commands and hotkeys", () => {
  const withCommands = (id: string, path: string, commands: readonly AdminCommand[], permission = "platform.organizations.read") => view({ id, path, permission, commands });

  it("composes commands from view metadata with kind, scope, and permission defaults", () => {
    const registry = buildAdminRegistry([withCommands("contracts", "/contracts", [
      { id: "contracts.open", label: "Open contracts", hotkey: "g c" },
      { id: "contracts.revoke", label: "Revoke a contract", hotkey: "r", kind: "action", scope: "selection", requires: "a contract", destructive: true, permission: "platform.api_keys.revoke", keywords: ["cancel"] },
    ])], options);
    expect(registry.commands).toEqual([
      { id: "contracts.open", label: "Open contracts", hotkey: "g c", permission: "platform.organizations.read", keywords: [], kind: "navigate", scope: "global", destructive: false, viewId: "contracts", path: "/contracts", group: "Customers", icon },
      { id: "contracts.revoke", label: "Revoke a contract", hotkey: "r", permission: "platform.api_keys.revoke", keywords: ["cancel"], kind: "action", scope: "selection", destructive: true, requires: "a contract", viewId: "contracts", path: "/contracts", group: "Customers", icon },
    ]);
  });

  it("requires an icon and a navigate command on every view", () => {
    const problems = (() => { try { buildAdminRegistry([view({ navigation: { label: "No icon", group: "Customers", order: 1, icon: undefined as never } }), view({ id: "silent", path: "/silent", commands: [] })], options); return ""; } catch (error) { return (error as AdminRegistryError).problems.join("\n"); } })();
    expect(problems).toContain("navigation.icon must be an icon component");
    expect(problems).toContain("declare at least one navigate command");
  });

  it("validates scopes, destructive actions, and selection requirements", () => {
    const problems = (() => { try {
      buildAdminRegistry([withCommands("bad", "/bad", [
        { id: "bad.open", label: "Open", scope: "view" },
        { id: "bad.delete", label: "Delete", destructive: true },
        { id: "bad.pick", label: "Pick", kind: "action", scope: "selection" },
        { id: "bad.global", label: "Global action", kind: "action", scope: "global" },
      ])], options); return "";
    } catch (error) { return (error as AdminRegistryError).problems.join("\n"); } })();
    for (const expected of ["navigates, so its scope must be global", "is destructive, so it must be an action", "must say what it requires", "its scope must be view or selection"]) expect(problems).toContain(expected);
  });

  it("allows the same key on different views but not twice on one view or against global bindings", () => {
    const action = (id: string, hotkey: string): AdminCommand => ({ id, label: id, hotkey, kind: "action", scope: "view" });
    expect(hotkeyConflicts([
      withCommands("one", "/one", [{ id: "one.open", label: "One", hotkey: "g o" }, action("one.refresh", "r")]),
      withCommands("two", "/two", [{ id: "two.open", label: "Two", hotkey: "g t" }, action("two.retry", "r")]),
    ])).toEqual([]);
    const problems = hotkeyConflicts([
      withCommands("one", "/one", [{ id: "one.open", label: "One", hotkey: "g o" }, action("one.a", "r"), action("one.b", "r"), action("one.g", "g"), action("one.filter", "f"), action("one.row", "j")]),
    ]).join("\n");
    expect(problems).toContain("conflicts with one.b on the same view");
    expect(problems).toContain("the first key of global navigation sequences");
    expect(problems).toContain("reserved for filters, rows, and forms");
  });

  it("rejects invalid ids, permissions, hotkeys, duplicates, prefix clashes, and reserved keys", () => {
    try {
      buildAdminRegistry([
        withCommands("one", "/one", [{ id: "one.open", label: "One", hotkey: "g o" }, { id: "Bad", label: "" }, { id: "one.tenant", label: "Tenant", permission: "organization.read" }]),
        withCommands("two", "/two", [{ id: "one.open", label: "Dup", hotkey: "g o" }, { id: "two.prefix", label: "Prefix", hotkey: "g" }, { id: "two.palette", label: "Palette", hotkey: "Mod+K" }, { id: "two.bad-key", label: "Bad key", hotkey: "Mod+NotAKey+Q" }]),
      ], options);
      expect.unreachable();
    } catch (error) {
      const problems = (error as AdminRegistryError).problems.join("\n");
      for (const expected of ["must be a dotted lowercase id", "requires a label", "belongs to the organization plane", "duplicate command id one.open", "conflicts with one.open", "is a prefix of", "reserved by the admin shell", "is invalid"]) expect(problems).toContain(expected);
    }
  });

  it("offers only commands the operator may run and searches labels and keywords", () => {
    const registry = buildAdminRegistry([
      withCommands("keys", "/keys", [{ id: "keys.open", label: "Go to API keys", hotkey: "g k" }, { id: "keys.revoke", label: "Revoke an API key", permission: "platform.api_keys.revoke", kind: "action", scope: "selection", requires: "a key", destructive: true, keywords: ["leaked"] }], "platform.machine_access.read"),
      withCommands("users", "/users", [{ id: "users.open", label: "Go to users" }, { id: "users.revoke-sessions", label: "Revoke user sessions", permission: "platform.roles.manage", kind: "action", scope: "selection", requires: "a user", destructive: true }], "platform.audit.read"),
    ], options);
    const context = (held: string[]) => ({ permissions: new Set(held), capabilityStates: {} });
    expect(availableCommands(registry, context(["platform.machine_access.read"])).map((command) => command.id)).toEqual(["keys.open"]);
    expect(availableCommands(registry, context(["platform.audit.read"])).map((command) => command.id)).toEqual(["users.open"]);
    const all = availableCommands(registry, context(["platform.machine_access.read", "platform.api_keys.revoke", "platform.audit.read", "platform.roles.manage"]));
    expect(searchCommands(all, "revoke").map((command) => command.id)).toEqual(["keys.revoke", "users.revoke-sessions"]);
    expect(searchCommands(all, "leaked").map((command) => command.id)).toEqual(["keys.revoke"]);
  });
});
