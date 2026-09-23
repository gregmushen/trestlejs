import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { permissions } from "@__TRESTLE_PROJECT_NAME__/authz";
import { features } from "@__TRESTLE_PROJECT_NAME__/billing/model";

import { AdminRegistryError, buildAdminRegistry, navigationGroups, type AdminComponentLoader, type AdminRegistry, type AdminViewDescriptor } from "../src/registry";

export const defaultViewsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/views");
export const descriptorFile = "admin-view.ts";

export type DiscoveredView = Readonly<{ directory: string; file: string }>;
export type AdminViewCheck = Readonly<{ discovered: DiscoveredView[]; registry?: AdminRegistry; problems: string[] }>;

/** Finds `<viewsDirectory>/<id>/admin-view.ts` descriptors, the same convention the SPA discovers with import.meta.glob. */
export async function discoverAdminViews(viewsDirectory: string = defaultViewsDirectory): Promise<DiscoveredView[]> {
  const entries = await readdir(viewsDirectory, { withFileTypes: true });
  const found: DiscoveredView[] = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(viewsDirectory, entry.name, descriptorFile);
    if (await stat(file).then((info) => info.isFile(), () => false)) found.push({ directory: entry.name, file });
  }
  return found;
}

const isComponent = (value: unknown): boolean =>
  typeof value === "function" || (typeof value === "object" && value !== null && "$$typeof" in value);

async function resolvesToComponent(label: string, loader: AdminComponentLoader, problems: string[]): Promise<void> {
  try {
    const loaded: unknown = await loader();
    if (!loaded || typeof loaded !== "object" || !("default" in loaded) || !isComponent(loaded.default)) problems.push(`${label} does not resolve to a module with a default-exported React component`);
  } catch (error) {
    problems.push(`${label} failed to load: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function checkAdminViews(viewsDirectory: string = defaultViewsDirectory, groups: readonly string[] = navigationGroups): Promise<AdminViewCheck> {
  const discovered = await discoverAdminViews(viewsDirectory);
  const problems: string[] = [];
  const descriptors: AdminViewDescriptor[] = [];
  for (const view of discovered) {
    const where = `views/${view.directory}/${descriptorFile}`;
    try {
      const loaded = await import(pathToFileURL(view.file).href) as { default?: unknown };
      if (!loaded.default || typeof loaded.default !== "object") { problems.push(`${where} must default-export defineAdminView({ ... })`); continue; }
      descriptors.push(loaded.default as AdminViewDescriptor);
    } catch (error) {
      problems.push(`${where} failed to load: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let registry: AdminRegistry | undefined;
  try {
    registry = buildAdminRegistry(descriptors, { permissions, features, groups });
  } catch (error) {
    if (!(error instanceof AdminRegistryError)) throw error;
    problems.push(...error.problems);
  }
  for (const descriptor of descriptors) {
    const name = typeof descriptor.id === "string" ? descriptor.id : "unnamed view";
    if (typeof descriptor.component === "function") await resolvesToComponent(`${name}: component`, descriptor.component, problems);
    if (typeof descriptor.overviewCard?.component === "function") await resolvesToComponent(`${name}: overviewCard.component`, descriptor.overviewCard.component, problems);
  }
  problems.push(...await checkHandlerContracts(viewsDirectory, discovered, descriptors));
  problems.push(...await checkDesignRules(viewsDirectory));
  return registry && !problems.length ? { discovered, registry, problems } : { discovered, problems };
}

async function sourceFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sourceFiles(file));
    else if (/\.(?:tsx?|css)$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)) found.push(file);
  }
  return found;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * Every action or focus command must be implemented by its mounted view
 * (`useAdminCommands`), and destructive commands must be registered with
 * `confirm:` so a shortcut can only open the confirmation dialog.
 */
export async function checkHandlerContracts(viewsDirectory: string, discovered: readonly DiscoveredView[], descriptors: readonly AdminViewDescriptor[]): Promise<string[]> {
  const problems: string[] = [];
  for (const [index, view] of discovered.entries()) {
    const descriptor = descriptors[index];
    if (!descriptor || !Array.isArray(descriptor.commands)) continue;
    const files = await sourceFiles(path.join(viewsDirectory, view.directory));
    const source = (await Promise.all(files.filter((file) => !file.endsWith(descriptorFile)).map((file) => readFile(file, "utf8")))).join("\n");
    for (const command of descriptor.commands) {
      if ((command.kind ?? "navigate") === "navigate" || typeof command.id !== "string") continue;
      const registered = new RegExp(`["']${escapeRegExp(command.id)}["']\\s*:\\s*\\{`, "u");
      if (!registered.test(source)) { problems.push(`${view.directory}: command ${command.id} has no handler; register it with useAdminCommands in the view`); continue; }
      if (command.destructive && !new RegExp(`["']${escapeRegExp(command.id)}["']\\s*:\\s*\\{[^\\n]*\\bconfirm\\s*:`, "u").test(source)) problems.push(`${view.directory}: destructive command ${command.id} must be registered with confirm: (it may only open a confirmation dialog)`);
    }
  }
  return problems;
}

const rawPalette = /\b(?:bg|text|border|ring|outline|fill|stroke|divide|from|via|to|shadow|placeholder|decoration|accent|caret)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(?:-\d{2,3})?(?:\/\d+)?\b/u;
const legacyClasses = /className=(?:"|\{`)[^"`]*\b(?:panel|button|button-secondary|button-danger|input|label)\b(?![-\w])/u;
const forbidden: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bCloudflareLogo\b|\bPoweredByCloudflare\b/u, "Cloudflare branding components are not used in the Trestle admin"],
  [/\bdark:[a-z]/u, "use Kumo semantic tokens instead of dark: variants"],
  [/<Badge\b[^>]*variant="destructive"/u, "Badge variant \"destructive\" is deprecated in Kumo; use AdminStatus or variant=\"error\""],
  [/\buseModal\b/u, "use Kumo Dialog through useConfirmAction instead of the legacy modal"],
];

/**
 * Design-system gates: Kumo semantic tokens only, no competing component
 * classes, no deprecated Kumo APIs, and the required stylesheet order.
 */
export async function checkDesignRules(viewsDirectory: string): Promise<string[]> {
  const root = path.dirname(viewsDirectory);
  const problems: string[] = [];
  const isDefault = path.resolve(viewsDirectory) === path.resolve(defaultViewsDirectory);
  const files = isDefault ? await sourceFiles(root) : await sourceFiles(viewsDirectory);
  for (const file of files) {
    const relative = path.relative(root, file);
    const text = await readFile(file, "utf8");
    text.split("\n").forEach((line, index) => {
      const where = `${relative}:${index + 1}`;
      const palette = rawPalette.exec(line);
      if (palette) problems.push(`${where}: raw color class ${palette[0]}; use a Kumo semantic token (bg-kumo-*, text-kumo-*)`);
      if (legacyClasses.test(line)) problems.push(`${where}: legacy component class; use Kumo components or the Trestle adapters`);
      for (const [pattern, message] of forbidden) if (pattern.test(line)) problems.push(`${where}: ${message}`);
    });
  }
  if (isDefault) {
    const css = await readFile(path.join(root, "styles.css"), "utf8").catch(() => "");
    const positions = [/@source\s+"[^"]*@cloudflare\/kumo\/dist/u, /@import\s+"@cloudflare\/kumo\/styles"/u, /@import\s+"tailwindcss"/u].map((pattern) => css.search(pattern));
    if (positions.some((position) => position < 0) || !(positions[0]! < positions[1]! && positions[1]! < positions[2]!)) problems.push("styles.css: Kumo requires @source for @cloudflare/kumo/dist, then @import \"@cloudflare/kumo/styles\", then @import \"tailwindcss\"");
  }
  return problems;
}

/** Machine-readable route and navigation discovery used by `trestle admin views`. */
export function describeRegistry(registry: AdminRegistry) {
  return {
    views: registry.views.map((view) => ({
      id: view.id, path: view.path, label: view.navigation.label, group: view.navigation.group, order: view.navigation.order, permission: view.permission,
      ...(view.entitlement ? { entitlement: view.entitlement } : {}),
      ...(view.capability ? { capability: view.capability } : {}),
      ...(view.overviewCard ? { overviewCard: view.overviewCard.title } : {}),
    })),
    groups: registry.groups.map((group) => ({ name: group.name, views: group.items.map((view) => view.id) })),
    commands: registry.commands.map((command) => ({ id: command.id, label: command.label, view: command.viewId, permission: command.permission, kind: command.kind, scope: command.scope, ...(command.destructive ? { destructive: true } : {}), ...(command.hotkey ? { hotkey: command.hotkey } : {}) })),
  };
}

async function main(argv: readonly string[]): Promise<number> {
  const json = argv.includes("--json");
  const viewsFlag = argv.indexOf("--views");
  const directory = viewsFlag >= 0 && argv[viewsFlag + 1] ? path.resolve(argv[viewsFlag + 1]!) : defaultViewsDirectory;
  const result = await checkAdminViews(directory);
  if (!result.registry) {
    console.error(`Admin view check failed (${result.problems.length} problem${result.problems.length === 1 ? "" : "s"}):`);
    for (const problem of result.problems) console.error(`  - ${problem}`);
    return 1;
  }
  if (json) {
    console.log(JSON.stringify(describeRegistry(result.registry), null, 2));
    return 0;
  }
  console.log(`Admin views: ${result.registry.views.length} valid across ${result.registry.groups.length} navigation groups`);
  for (const group of result.registry.groups) {
    console.log(`  ${group.name}`);
    for (const view of group.items) console.log(`    ${view.navigation.label.padEnd(24)}${view.path.padEnd(32)}${view.permission}${view.capability ? `  [${view.capability}]` : ""}`);
  }
  if (result.registry.overviewCards.length) console.log(`  Overview cards: ${result.registry.overviewCards.map((card) => card.title).join(", ")}`);
  const hotkeys = result.registry.commands.filter((command) => command.hotkey);
  console.log(`  Commands: ${result.registry.commands.length} (${hotkeys.length} with hotkeys: ${hotkeys.map((command) => `${command.hotkey} ${command.id}`).join(", ")})`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
