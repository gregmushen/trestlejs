import type { PermissionRegistry } from "@__TRESTLE_PROJECT_NAME__/authz";
import { validateHotkey } from "@tanstack/react-hotkeys";
import type { FeatureCatalog } from "./billing-model";
import type { ComponentType } from "react";

import { applicationNavigationGroups } from "./navigation";

export const coreNavigationGroups = ["Overview", "Customers", "Commercial", "Access", "Integrations", "Communications", "Operations", "System"] as const;
export const navigationGroups: readonly string[] = [...coreNavigationGroups, ...applicationNavigationGroups];

export const capabilityIds = ["email", "payments", "admin", "queues", "workflows", "r2", "durableObjects", "plans", "serviceAccounts", "apiKeys", "webhooks", "notifications", "supportSessions", "passkeys", "twoFactor", "sso", "directory", "metering"] as const;
export type CapabilityId = (typeof capabilityIds)[number];
export type CapabilityState = "disabled" | "declared" | "configured" | "deployed" | "verified";
export type Environment = "local" | "preview" | "staging" | "production";

export type AdminComponentModule = { default: ComponentType<any> };
export type AdminComponentLoader = () => Promise<AdminComponentModule>;

/** Any theme-compatible icon component; the defaults come from `@phosphor-icons/react`. */
export type AdminIcon = ComponentType<{ className?: string; size?: number | string }>;

/**
 * Where a command's binding is active. "global" commands (navigation) work
 * everywhere; "view" commands work on their view; "selection" commands work
 * on their view once a target is selected; "dialog" is reserved for the shell.
 */
export type AdminCommandScope = "global" | "view" | "selection" | "dialog";
/** "navigate" opens the view; "focus" moves focus; "action" runs a mounted handler. */
export type AdminCommandKind = "navigate" | "focus" | "action";

/**
 * A command a view contributes to the palette and keyboard layer. Hotkeys are
 * a single chord ("Mod+Shift+R") or a space-separated sequence ("g o"). View
 * and selection commands are implemented by the mounted view through
 * `useAdminCommands`; destructive ones must open a confirmation.
 */
export type AdminCommand = Readonly<{
  /** Stable dotted identifier, unique across the registry, e.g. "api-keys.revoke". */
  id: string;
  label: string;
  hotkey?: string;
  /** Platform permission required to run the command; defaults to the view's permission. */
  permission?: string;
  /** Capability the command needs; defaults to the view's capability. */
  capability?: CapabilityId;
  keywords?: readonly string[];
  /** Defaults to "navigate". */
  kind?: AdminCommandKind;
  /** Defaults to "global" for navigation and "view" otherwise. */
  scope?: AdminCommandScope;
  /** The handler opens a confirmation dialog; it never mutates directly. */
  destructive?: true;
  /** For selection commands: what must be selected, shown in the palette, e.g. "an API key". */
  requires?: string;
}>;

export type AdminViewDescriptor = Readonly<{
  /** Stable kebab-case identifier, unique across the registry. */
  id: string;
  /** Route path, beginning with "/". */
  path: string;
  navigation: Readonly<{ label: string; group: string; order: number; icon: AdminIcon }>;
  /** Registered platform permission required to display the view. Display only: the API enforces its own. */
  permission: string;
  /** Optional feature code from the billing catalog. */
  entitlement?: string;
  /** Optional capability that must be configured for the view to be usable. */
  capability?: CapabilityId;
  component: AdminComponentLoader;
  overviewCard?: Readonly<{ title: string; order: number; component: AdminComponentLoader }>;
  /** At least one navigate command, plus the view's primary and destructive actions. */
  commands: readonly AdminCommand[];
}>;

export type RegisteredCommand = Readonly<{
  id: string;
  label: string;
  hotkey?: string;
  permission: string;
  capability?: CapabilityId;
  keywords: readonly string[];
  kind: AdminCommandKind;
  scope: AdminCommandScope;
  destructive: boolean;
  requires?: string;
  viewId: string;
  path: string;
  group: string;
  icon: AdminIcon;
}>;

/** Keys the shell owns; views may not claim them or use them as a sequence prefix. */
export const reservedHotkeys: readonly string[] = ["Mod+K", "/", "?", "Escape", "["];
/** Keys the resource adapters own on every view: filter, row movement, selection, action menu, form submit. */
export const resourceHotkeys: readonly string[] = ["f", "j", "k", "Enter", "Space", "Shift+A", "Mod+Enter", "Mod+Shift+Enter"];

export type AdminOverviewCard = Readonly<{ viewId: string; title: string; order: number; permission: string; capability?: CapabilityId; component: AdminComponentLoader }>;
export type AdminRegistry = Readonly<{
  views: readonly AdminViewDescriptor[];
  commands: readonly RegisteredCommand[];
  groups: readonly Readonly<{ name: string; items: readonly AdminViewDescriptor[] }>[];
  overviewCards: readonly AdminOverviewCard[];
}>;

export type AdminRegistryOptions = Readonly<{
  permissions: Pick<PermissionRegistry, "get">;
  features: Pick<FeatureCatalog, "has">;
  groups?: readonly string[];
  capabilities?: readonly string[];
}>;

export class AdminRegistryError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid admin views:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "AdminRegistryError";
  }
}

export const defineAdminView = <const Descriptor extends AdminViewDescriptor>(descriptor: Descriptor): Descriptor => descriptor;

const idPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const commandIdPattern = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u;

/** Splits "g o" into ["g", "o"]; a chord such as "Mod+Shift+K" stays one step. */
export const hotkeySteps = (hotkey: string): string[] => hotkey.trim().split(/\s+/u).filter(Boolean);
const normalizeStep = (step: string): string => step.split("+").map((part) => part.trim().toLowerCase()).sort().join("+");
const pathPattern = /^\/(?:[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*)?$/u;

export function validateAdminViews(descriptors: readonly AdminViewDescriptor[], options: AdminRegistryOptions): string[] {
  const groups = options.groups ?? navigationGroups;
  const capabilities = options.capabilities ?? capabilityIds;
  const problems: string[] = [];
  const ids = new Map<string, number>();
  const paths = new Map<string, string>();
  descriptors.forEach((descriptor, index) => {
    const name = typeof descriptor?.id === "string" && descriptor.id ? descriptor.id : `#${index + 1}`;
    const problem = (message: string) => problems.push(`${name}: ${message}`);
    if (!descriptor || typeof descriptor !== "object") { problems.push(`${name}: descriptor must be an object`); return; }
    if (typeof descriptor.id !== "string" || !idPattern.test(descriptor.id)) problem(`id ${JSON.stringify(descriptor.id)} must be kebab-case`);
    else if (ids.has(descriptor.id)) problem(`duplicate id ${descriptor.id}`);
    else ids.set(descriptor.id, index);
    if (typeof descriptor.path !== "string" || !pathPattern.test(descriptor.path)) problem(`path ${JSON.stringify(descriptor.path)} must start with "/" and use lowercase segments`);
    else if (paths.has(descriptor.path)) problem(`duplicate path ${descriptor.path} (also used by ${paths.get(descriptor.path)})`);
    else paths.set(descriptor.path, name);
    const navigation = descriptor.navigation;
    if (!navigation || typeof navigation !== "object") problem("navigation is required");
    else {
      if (typeof navigation.label !== "string" || !navigation.label.trim()) problem("navigation.label is required");
      if (!groups.includes(navigation.group)) problem(`navigation group ${JSON.stringify(navigation.group)} is not one of ${groups.join(", ")}`);
      if (typeof navigation.order !== "number" || !Number.isFinite(navigation.order)) problem("navigation.order must be a finite number");
    }
    const permission = typeof descriptor.permission === "string" ? options.permissions.get(descriptor.permission) : undefined;
    if (!permission) problem(`permission ${JSON.stringify(descriptor.permission)} is not registered`);
    else if (permission.plane !== "platform") problem(`permission ${descriptor.permission} belongs to the ${permission.plane} plane; admin views require a platform-plane permission`);
    if (descriptor.entitlement !== undefined && !options.features.has(descriptor.entitlement)) problem(`entitlement ${JSON.stringify(descriptor.entitlement)} is not a defined feature`);
    if (descriptor.capability !== undefined && !capabilities.includes(descriptor.capability)) problem(`capability ${JSON.stringify(descriptor.capability)} is not one of ${capabilities.join(", ")}`);
    if (typeof descriptor.component !== "function") problem("component must be a function returning import(\"./view\")");
    const icon = navigation?.icon as unknown;
    if (!icon || (typeof icon !== "function" && !(typeof icon === "object" && "$$typeof" in (icon as object)))) problem("navigation.icon must be an icon component, e.g. from @phosphor-icons/react");
    if (!Array.isArray(descriptor.commands)) problem("commands are required; declare at least one navigate command");
    else if (!descriptor.commands.some((command) => (command.kind ?? "navigate") === "navigate")) problem("declare at least one navigate command so the view is reachable from the command palette");
    for (const command of descriptor.commands ?? []) {
      const where = `command ${JSON.stringify(command.id)}`;
      const kind = command.kind ?? "navigate";
      const scope = command.scope ?? (kind === "navigate" ? "global" : "view");
      if (typeof command.id !== "string" || !commandIdPattern.test(command.id)) problem(`${where} must be a dotted lowercase id such as "api-keys.revoke"`);
      if (typeof command.label !== "string" || !command.label.trim()) problem(`${where} requires a label`);
      if (!["navigate", "focus", "action"].includes(kind)) problem(`${where} kind must be navigate, focus, or action`);
      if (kind === "navigate" && scope !== "global") problem(`${where} navigates, so its scope must be global`);
      if (kind !== "navigate" && scope !== "view" && scope !== "selection") problem(`${where} is a view command; its scope must be view or selection`);
      if (command.destructive && kind !== "action") problem(`${where} is destructive, so it must be an action that opens a confirmation`);
      if (scope === "selection" && !command.requires?.trim()) problem(`${where} is selection-scoped and must say what it requires, e.g. requires: "an API key"`);
      if (command.capability !== undefined && !capabilities.includes(command.capability)) problem(`${where} capability ${JSON.stringify(command.capability)} is not one of ${capabilities.join(", ")}`);
      if (command.permission !== undefined) {
        const commandPermission = options.permissions.get(command.permission);
        if (!commandPermission) problem(`${where} permission ${JSON.stringify(command.permission)} is not registered`);
        else if (commandPermission.plane !== "platform") problem(`${where} permission ${command.permission} belongs to the ${commandPermission.plane} plane; commands require a platform-plane permission`);
      }
      if (command.hotkey !== undefined) {
        const steps = hotkeySteps(command.hotkey);
        if (!steps.length) problem(`${where} hotkey must not be empty`);
        for (const step of steps) {
          const result = validateHotkey(step);
          if (!result.valid) problem(`${where} hotkey step ${JSON.stringify(step)} is invalid: ${result.errors.join("; ")}`);
        }
      }
    }
    if (descriptor.overviewCard !== undefined) {
      const card = descriptor.overviewCard;
      if (typeof card.title !== "string" || !card.title.trim()) problem("overviewCard.title is required");
      if (typeof card.order !== "number" || !Number.isFinite(card.order)) problem("overviewCard.order must be a finite number");
      if (typeof card.component !== "function") problem("overviewCard.component must be a function returning import(\"./card\")");
    }
  });
  problems.push(...hotkeyConflicts(descriptors));
  return problems;
}

type Binding = Readonly<{ id: string; view: string; scope: AdminCommandScope; steps: readonly string[] }>;

/**
 * Scope-aware collision rules. Global bindings must be unique everywhere and
 * never prefix one another. View and selection bindings may repeat across
 * views (only one view is mounted), but within a view they must be unique and
 * must not collide with global bindings, shell keys, resource keys, or the
 * first key of any global sequence.
 */
export function hotkeyConflicts(descriptors: readonly AdminViewDescriptor[]): string[] {
  const problems: string[] = [];
  const bindings: Binding[] = [];
  const seenIds = new Map<string, string>();
  for (const descriptor of descriptors) {
    if (!descriptor || !Array.isArray(descriptor.commands)) continue;
    const view = typeof descriptor.id === "string" ? descriptor.id : "unnamed view";
    for (const command of descriptor.commands) {
      if (typeof command.id === "string") {
        if (seenIds.has(command.id)) problems.push(`${view}: duplicate command id ${command.id} (also declared by ${seenIds.get(command.id)})`);
        else seenIds.set(command.id, view);
      }
      if (typeof command.hotkey !== "string" || !command.hotkey.trim()) continue;
      const kind = command.kind ?? "navigate";
      bindings.push({ id: command.id, view, scope: command.scope ?? (kind === "navigate" ? "global" : "view"), steps: hotkeySteps(command.hotkey).map(normalizeStep) });
    }
  }
  const shell = new Set(reservedHotkeys.map(normalizeStep));
  const resource = new Set(resourceHotkeys.map(normalizeStep));
  const key = (binding: Binding) => binding.steps.join(" ");
  const global = bindings.filter((binding) => binding.scope === "global");
  const prefixes = (a: Binding, b: Binding) => key(a) !== key(b) && key(b).startsWith(`${key(a)} `);
  for (const binding of bindings) {
    if (shell.has(binding.steps[0]!)) problems.push(`${binding.view}: command ${binding.id} hotkey "${key(binding)}" uses a key reserved by the admin shell`);
  }
  global.forEach((binding, index) => {
    for (const other of global.slice(index + 1)) {
      if (key(binding) === key(other)) problems.push(`${binding.view}: command ${binding.id} hotkey "${key(binding)}" conflicts with ${other.id}`);
    }
    for (const other of global) if (prefixes(binding, other)) problems.push(`command ${binding.id} hotkey "${key(binding)}" is a prefix of ${other.id} hotkey "${key(other)}"`);
  });
  const sequenceStarts = new Set(global.filter((binding) => binding.steps.length > 1).map((binding) => binding.steps[0]!));
  const local = bindings.filter((binding) => binding.scope !== "global");
  local.forEach((binding, index) => {
    const where = `${binding.view}: command ${binding.id} hotkey "${key(binding)}"`;
    if (resource.has(binding.steps[0]!)) problems.push(`${where} uses a key reserved for filters, rows, and forms (${resourceHotkeys.join(", ")})`);
    if (sequenceStarts.has(binding.steps[0]!)) problems.push(`${where} starts with "${binding.steps[0]}", the first key of global navigation sequences`);
    for (const other of global) if (key(other) === key(binding) || prefixes(binding, other) || prefixes(other, binding)) problems.push(`${where} conflicts with global command ${other.id}`);
    for (const other of local.slice(index + 1)) {
      if (other.view !== binding.view) continue;
      if (key(other) === key(binding)) problems.push(`${where} conflicts with ${other.id} on the same view`);
      else if (prefixes(binding, other) || prefixes(other, binding)) problems.push(`${where} and ${other.id} prefix one another on the same view`);
    }
  });
  return problems;
}

export function buildAdminRegistry(descriptors: readonly AdminViewDescriptor[], options: AdminRegistryOptions): AdminRegistry {
  const problems = validateAdminViews(descriptors, options);
  if (problems.length) throw new AdminRegistryError(problems);
  const groups = options.groups ?? navigationGroups;
  const views = [...descriptors].sort((a, b) =>
    groups.indexOf(a.navigation.group) - groups.indexOf(b.navigation.group)
    || a.navigation.order - b.navigation.order
    || a.navigation.label.localeCompare(b.navigation.label));
  const overviewCards = views.flatMap((view) => view.overviewCard ? [{
    viewId: view.id, title: view.overviewCard.title, order: view.overviewCard.order, permission: view.permission,
    ...(view.capability ? { capability: view.capability } : {}), component: view.overviewCard.component,
  }] : []).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  const commands: RegisteredCommand[] = views.flatMap((view) => view.commands.map((command) => {
    const kind = command.kind ?? "navigate";
    const capability = command.capability ?? view.capability;
    return {
      id: command.id, label: command.label, ...(command.hotkey ? { hotkey: command.hotkey } : {}),
      permission: command.permission ?? view.permission, keywords: command.keywords ?? [], kind, scope: command.scope ?? (kind === "navigate" ? "global" : "view"),
      destructive: command.destructive === true, ...(command.requires ? { requires: command.requires } : {}),
      viewId: view.id, path: view.path, group: view.navigation.group, icon: view.navigation.icon, ...(capability ? { capability } : {}),
    };
  }));
  return {
    views,
    commands,
    groups: groups.map((name) => ({ name, items: views.filter((view) => view.navigation.group === name) })).filter((group) => group.items.length > 0),
    overviewCards,
  };
}

export type CapabilityStatusLike = Readonly<{ state: CapabilityState; label?: string; message?: string; repair?: string }>;
export type NavigationContext = Readonly<{
  permissions: ReadonlySet<string>;
  capabilityStates: Readonly<Record<string, CapabilityStatusLike | undefined>>;
  environment?: Environment;
}>;
export type ViewAvailability =
  | Readonly<{ kind: "enabled" }>
  | Readonly<{ kind: "hidden"; reason: "permission" | "capability" }>
  | Readonly<{ kind: "unconfigured"; message: string; repair: string }>;

export const repairCommand = (environment: Environment | undefined): string =>
  !environment || environment === "local" ? "pnpm exec trestle doctor" : `pnpm exec trestle doctor --env ${environment}`;

/** Usability only. Every API operation enforces its own authorization server-side. */
export function viewAvailability(view: Pick<AdminViewDescriptor, "permission" | "capability">, context: NavigationContext): ViewAvailability {
  if (!context.permissions.has(view.permission)) return { kind: "hidden", reason: "permission" };
  if (!view.capability) return { kind: "enabled" };
  const status = context.capabilityStates[view.capability];
  if (!status || status.state === "disabled") return { kind: "hidden", reason: "capability" };
  if (status.state === "declared") {
    const where = context.environment ? ` for ${context.environment}` : "";
    return { kind: "unconfigured", message: status.message ?? `${status.label ?? view.capability} is not configured${where}.`, repair: status.repair ?? repairCommand(context.environment) };
  }
  return { kind: "enabled" };
}

export type NavigationItem = Readonly<{ view: AdminViewDescriptor; availability: Exclude<ViewAvailability, { kind: "hidden" }> }>;

export function visibleNavigation(registry: AdminRegistry, context: NavigationContext): { groups: { name: string; items: NavigationItem[] }[]; overviewCards: AdminOverviewCard[] } {
  const groups = registry.groups.map((group) => ({
    name: group.name,
    items: group.items.flatMap((view) => {
      const availability = viewAvailability(view, context);
      return availability.kind === "hidden" ? [] : [{ view, availability }];
    }),
  })).filter((group) => group.items.length > 0);
  const overviewCards = registry.overviewCards.filter((card) => viewAvailability(card, context).kind === "enabled");
  return { groups, overviewCards };
}

export type Breadcrumb = Readonly<{ label: string; to?: string }>;

export function breadcrumbsFor(registry: AdminRegistry, pathname: string, detail?: string): Breadcrumb[] {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/u, "") : pathname;
  const view = registry.views.find((candidate) => candidate.path === normalized);
  if (!view) return [{ label: "Admin", to: "/" }, { label: "Not found" }];
  const crumbs: Breadcrumb[] = [{ label: "Admin", to: "/" }];
  if (view.navigation.group !== view.navigation.label) crumbs.push({ label: view.navigation.group });
  crumbs.push(detail ? { label: view.navigation.label, to: view.path } : { label: view.navigation.label });
  if (detail) crumbs.push({ label: detail });
  return crumbs;
}

/** Commands the current operator can run: permitted, and on a configured capability. */
export function availableCommands(registry: AdminRegistry, context: NavigationContext): RegisteredCommand[] {
  return registry.commands.filter((command) => viewAvailability({ permission: command.permission, ...(command.capability ? { capability: command.capability } : {}) }, context).kind === "enabled");
}

/** Ranks commands by label, group, and keywords; every query word must match. */
export function searchCommands<T extends Pick<RegisteredCommand, "label" | "group" | "keywords" | "id">>(commands: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (!words.length) return [...commands];
  return commands
    .map((command) => {
      const label = command.label.toLowerCase();
      const haystack = [label, command.group.toLowerCase(), command.id, ...command.keywords.map((keyword) => keyword.toLowerCase())].join(" ");
      if (!words.every((word) => haystack.includes(word))) return undefined;
      return { command, score: (label.startsWith(words[0]!) ? 0 : 1) + (label.includes(words.join(" ")) ? 0 : 1) };
    })
    .filter((entry): entry is { command: T; score: number } => Boolean(entry))
    .sort((a, b) => a.score - b.score || a.command.label.localeCompare(b.command.label))
    .map((entry) => entry.command);
}
