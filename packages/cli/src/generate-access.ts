import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ProjectManifest } from "@trestlejs/core";

import { CliFailure } from "./runtime.js";

export const permissionCodePattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;
export const adminNavigationGroups = ["Overview", "Customers", "Commercial", "Access", "Integrations", "Communications", "Operations", "System"] as const;
const principalTypes = ["user", "api_key"] as const;
export const permissionPlanes = ["organization", "application", "platform"] as const;
export type PermissionPlane = (typeof permissionPlanes)[number];
type Principal = (typeof principalTypes)[number];

const exists = (file: string) => access(file).then(() => true, () => false);

function permissionsFile(root: string, manifest: ProjectManifest): { absolute: string; relative: string } {
  const relative = path.join(manifest.packages.authz ?? "packages/authz", "src", "permissions.ts");
  return { absolute: path.join(root, relative), relative };
}

/** Codes registered in the `definePermissions({ ... })` object of permissions.ts. */
export function registeredPermissionCodes(source: string): string[] {
  const block = registryBlock(source);
  return [...source.slice(block.open, block.close).matchAll(/^\s*"([a-z][a-z0-9_.]*)"\s*:/gmu)].map((match) => match[1]!);
}

function registryBlock(source: string): { open: number; close: number } {
  const start = source.indexOf("definePermissions({");
  if (start === -1) throw new CliFailure("permissions.ts has no definePermissions({ ... }) registry");
  const open = start + "definePermissions({".length;
  const close = source.indexOf("\n});", open);
  if (close === -1) throw new CliFailure("permissions.ts registry is not closed with `});` on its own line");
  return { open, close };
}

function defaultDescription(code: string): string {
  const segments = code.split(".").filter((segment, index) => !(index === 0 && segment === "platform"));
  const action = segments.pop() ?? code;
  const subject = segments.join(" ").replaceAll("_", " ");
  return `${action[0]!.toUpperCase()}${action.slice(1).replaceAll("_", " ")}${subject ? ` ${subject}` : ""}`;
}

export type PermissionInput = { code: string; plane: PermissionPlane; description?: string; principals?: string[]; entitlement?: string };

/** Mirrors the registry rules in packages/authz/src/registry.ts so generation fails before review, not at build. */
export function permissionEntry(input: PermissionInput): { code: string; plane: PermissionPlane; line: string } {
  const { code, plane } = input;
  if (!permissionCodePattern.test(code)) throw new CliFailure(`permission ${code} must be a lowercase dotted code such as workflows.publish`);
  if (!permissionPlanes.includes(plane)) throw new CliFailure(`--plane must be one of ${permissionPlanes.join(", ")}`);
  const prefix = code.split(".")[0];
  const prefixPlane = prefix === "organization" || prefix === "platform" ? prefix : undefined;
  if (prefixPlane && prefixPlane !== plane) throw new CliFailure(`permission ${code} uses the ${prefixPlane}. prefix and must declare --plane ${prefixPlane}`);
  if (!prefixPlane && plane !== "application") throw new CliFailure(`${plane} permissions must use the ${plane}. prefix, e.g. ${plane}.${code}`);
  const principals = [...new Set(input.principals?.length ? input.principals : ["user"])];
  for (const principal of principals) if (!principalTypes.includes(principal as Principal)) throw new CliFailure(`principal ${principal} must be one of ${principalTypes.join(", ")}`);
  if (plane === "platform" && principals.some((principal) => principal !== "user")) throw new CliFailure(`platform permission ${code} is only grantable to human users with platform roles; remove api_key`);
  if (plane === "platform" && input.entitlement) throw new CliFailure(`platform permission ${code} cannot depend on a tenant entitlement`);
  if (input.entitlement !== undefined && !permissionCodePattern.test(input.entitlement)) throw new CliFailure(`entitlement ${input.entitlement} must be a lowercase dotted feature code`);
  const description = (input.description ?? defaultDescription(code)).trim();
  if (!description) throw new CliFailure("permission description must not be empty");
  const fields = [
    `plane: ${JSON.stringify(plane)}`,
    `description: ${JSON.stringify(description)}`,
    ...(principals.length === 1 && principals[0] === "user" ? [] : [`principals: [${principals.map((principal) => JSON.stringify(principal)).join(", ")}]`]),
    ...(input.entitlement ? [`entitlement: ${JSON.stringify(input.entitlement)}`] : []),
  ];
  return { code, plane, line: `  ${JSON.stringify(code)}: { ${fields.join(", ")} },` };
}

/** Inserts one single-line entry into the registry, after the last entry of the same plane when the file uses single-line entries. */
export function insertPermission(source: string, entry: { code: string; plane: PermissionPlane; line: string }): string {
  if (registeredPermissionCodes(source).includes(entry.code)) throw new CliFailure(`permission ${entry.code} is already registered`);
  const { open, close } = registryBlock(source);
  const before = source.slice(0, open);
  const lines = source.slice(open, close).split("\n");
  const entryLines = lines.map((line, index) => ({ line, index })).filter(({ line }) => /^\s*"[^"]+"\s*:/u.test(line));
  const singleLine = entryLines.every(({ line }) => /\}\s*,?\s*$/u.test(line));
  const samePlane = entryLines.filter(({ line }) => line.includes(`plane: "${entry.plane}"`));
  const anchor = singleLine ? samePlane.at(-1) : undefined;
  if (anchor) {
    if (!/,\s*$/u.test(lines[anchor.index]!)) lines[anchor.index] = `${lines[anchor.index]!.trimEnd()},`;
    lines.splice(anchor.index + 1, 0, entry.line);
  } else {
    let last = lines.length - 1;
    while (last > 0 && !lines[last]!.trim()) last -= 1;
    if (lines[last]!.trim() && !/[,{]\s*$/u.test(lines[last]!)) lines[last] = `${lines[last]!.trimEnd()},`;
    lines.splice(last + 1, 0, entry.line);
  }
  return `${before}${lines.join("\n")}${source.slice(close)}`;
}

export async function generatePermission(root: string, manifest: ProjectManifest, input: PermissionInput): Promise<{ file: string; code: string; plane: PermissionPlane }> {
  const entry = permissionEntry(input);
  const file = permissionsFile(root, manifest);
  const source = await readFile(file.absolute, "utf8").catch(() => { throw new CliFailure(`${file.relative} is missing; restore the authz package before generating permissions`); });
  if (input.entitlement) {
    const catalog = path.join(root, manifest.packages.billing ?? "packages/billing", "src", "catalog.ts");
    const features = await readFile(catalog, "utf8").catch(() => undefined);
    if (features !== undefined && !features.includes(`"${input.entitlement}":`)) throw new CliFailure(`entitlement ${input.entitlement} is not a defined feature in ${path.relative(root, catalog)}`);
  }
  await writeFile(file.absolute, insertPermission(source, entry), "utf8");
  return { file: file.relative, code: entry.code, plane: entry.plane };
}

type ViewNames = { className: string; kebab: string; label: string };

function viewNames(input: string): ViewNames {
  const words = input.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").split(/[^A-Za-z0-9]+/u).filter(Boolean);
  if (!words.length || !/^[A-Za-z]/u.test(words[0]!)) throw new CliFailure("admin view name must start with a letter, such as Contracts");
  return {
    className: words.map((word) => `${word[0]!.toUpperCase()}${word.slice(1)}`).join(""),
    kebab: words.map((word) => word.toLowerCase()).join("-"),
    label: words.map((word, index) => (index === 0 ? `${word[0]!.toUpperCase()}${word.slice(1)}` : word.toLowerCase())).join(" "),
  };
}

export type AdminViewInput = { name: string; group?: string; permission?: string; path?: string; order?: number; header?: string; body?: string; label?: string; icon?: string };

async function adminContext(root: string, manifest: ProjectManifest): Promise<string> {
  const adminPath = manifest.apps.admin;
  if (!adminPath || !(await exists(path.join(root, adminPath, "src", "registry.ts")))) {
    throw new CliFailure("the admin application is not installed; run pnpm exec trestle admin install first");
  }
  return adminPath;
}

export async function generateAdminView(root: string, manifest: ProjectManifest, input: AdminViewInput): Promise<string[]> {
  const adminPath = await adminContext(root, manifest);
  const names = viewNames(input.name);
  const group = input.group ?? "Operations";
  const navigation = await readFile(path.join(root, adminPath, "src", "navigation.ts"), "utf8").catch(() => "");
  if (!(adminNavigationGroups as readonly string[]).includes(group) && !navigation.includes(`"${group}"`)) {
    throw new CliFailure(`navigation group ${group} is not defined; use ${adminNavigationGroups.join(", ")} or add it to ${path.join(adminPath, "src", "navigation.ts")}`);
  }
  const permission = input.permission ?? "platform.overview.read";
  if (!permission.startsWith("platform.")) throw new CliFailure(`admin views require a platform-plane permission; ${permission} is not in the platform plane`);
  const permissions = permissionsFile(root, manifest);
  const registry = await readFile(permissions.absolute, "utf8").catch(() => { throw new CliFailure(`${permissions.relative} is missing`); });
  if (!registeredPermissionCodes(registry).includes(permission)) throw new CliFailure(`permission ${permission} is not registered in ${permissions.relative}; run pnpm exec trestle generate permission ${permission}`);
  const routePath = input.path ?? `/${names.kebab}`;
  if (!/^\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/u.test(routePath)) throw new CliFailure(`admin view path ${routePath} must be a lowercase absolute path such as /contracts`);

  const directory = path.join(root, adminPath, "src", "views", names.kebab);
  const descriptor = path.join(directory, "admin-view.ts");
  const view = path.join(directory, "view.tsx");
  for (const file of [descriptor, view]) if (await exists(file)) throw new CliFailure(`refusing to overwrite ${path.relative(root, file)}`);
  await mkdir(directory, { recursive: true });
  const label = input.label ?? names.label;
  const icon = input.icon ?? "SquaresFourIcon";
  if (!/^[A-Z][A-Za-z0-9]*Icon$/u.test(icon)) throw new CliFailure(`icon ${icon} must be a @phosphor-icons/react component name such as FileTextIcon`);
  await writeFile(descriptor, `${input.header ?? ""}import { ${icon} } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: ${JSON.stringify(names.kebab)},
  path: ${JSON.stringify(routePath)},
  navigation: { label: ${JSON.stringify(label)}, group: ${JSON.stringify(group)}, order: ${input.order ?? 100}, icon: ${icon} },
  permission: ${JSON.stringify(permission)},
  component: () => import("./view"),
  // Every view declares a navigate command for the ⌘K palette. Add an unused
  // "g <key>" hotkey, and declare the view's primary and destructive actions as
  // { kind: "action", scope: "view" | "selection", hotkey, destructive? } and
  // implement them in view.tsx with useAdminCommands.
  commands: [
    { id: ${JSON.stringify(`${names.kebab}.open`)}, label: ${JSON.stringify(`Go to ${label}`)} },
  ],
});
`, "utf8");
  await writeFile(view, input.body ?? `import { AdminEmpty, AdminPageHeader } from "../../shell/ui";

/** Application-owned admin view. Use the Trestle adapters (shell/ui) and Kumo (shell/kumo) with semantic tokens only. */
export default function ${names.className}View() {
  return <>
    <AdminPageHeader title=${JSON.stringify(label)} description="Display permission does not grant backend authority; every API call enforces its own platform permission." />
    <AdminEmpty title="Nothing here yet" description="Replace this with an AdminDataTable backed by an /api/admin route." />
  </>;
}
`, "utf8");
  return [descriptor, view].map((file) => path.relative(root, file));
}

type ResourceDeclaration = { name: string; tenant?: boolean; routes?: Array<{ method: string; path: string }> };

export async function generateAdminResource(root: string, manifest: ProjectManifest, name: string): Promise<{ files: string[]; permission: string; route: string }> {
  if (!/^[A-Z][A-Za-z0-9]*$/u.test(name)) throw new CliFailure("resource name must be PascalCase");
  const words = name.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").split(" ").map((word) => word.toLowerCase());
  const kebab = words.join("-");
  const declarationPath = path.join(root, ".trestle", "resources", `${kebab}.json`);
  const declaration = await readFile(declarationPath, "utf8").then((text) => JSON.parse(text) as ResourceDeclaration, () => undefined);
  if (!declaration) throw new CliFailure(`resource ${name} is not declared (.trestle/resources/${kebab}.json); run pnpm exec trestle generate resource ${name} first`);
  await adminContext(root, manifest);
  const pluralKebab = kebab.endsWith("s") ? `${kebab}es` : `${kebab}s`;
  const pluralSnake = pluralKebab.replaceAll("-", "_");
  const permission = `platform.${pluralSnake}.read`;
  const route = `/api/admin/resources/${pluralKebab}`;
  const label = `${name.replace(/([a-z0-9])([A-Z])/gu, "$1 $2")}s`;
  const directory = path.join(root, manifest.apps.admin!, "src", "views", pluralKebab);
  for (const file of ["admin-view.ts", "view.tsx"]) if (await exists(path.join(directory, file))) throw new CliFailure(`refusing to overwrite ${path.relative(root, path.join(directory, file))}`);

  const permissions = permissionsFile(root, manifest);
  const registry = await readFile(permissions.absolute, "utf8").catch(() => { throw new CliFailure(`${permissions.relative} is missing`); });
  const registered = registeredPermissionCodes(registry).includes(permission);
  if (!registered) await writeFile(permissions.absolute, insertPermission(registry, permissionEntry({ code: permission, plane: "platform", description: `Read ${label.toLowerCase()} across tenants for support` })), "utf8");

  const header = `// Admin view for the ${name} resource.
//
// The platform admin never reuses customer credentials or tenant headers. This
// view calls GET ${route}, which is NOT generated: add that route to the admin
// Worker, require the platform permission ${permission} (registered in
// ${permissions.relative}), return sanitized fields only, and audit the read.
// Assign ${permission} to a platform role in role-definitions.ts.

`;
  const body = `import { api } from "../../api";
import { useAdminQuery } from "../../shell/context";
import { AdminDataTable, AdminFilter, AdminPageHeader, AdminQueryState, formatDate } from "../../shell/ui";
import { useViewSearch } from "../../shell/url-state";

type ${name}Row = { id: string; organizationId: string; name: string; createdAt: string };

export default function ${name}AdminView() {
  const [search] = useViewSearch<{ q?: string }>();
  const query = useAdminQuery(["resources", ${JSON.stringify(pluralKebab)}], () => api.request<{ records: ${name}Row[] }>("GET", ${JSON.stringify(`resources/${pluralKebab}`)}));
  const q = (search.q ?? "").toLowerCase();
  return <>
    <AdminPageHeader title=${JSON.stringify(label)} description="Sanitized, audited reads across tenants." />
    <AdminFilter label=${JSON.stringify(`Filter ${label.toLowerCase()}`)} placeholder="Name or organization" />
    <AdminQueryState query={query} isEmpty={(data) => data.records.length === 0} empty=${JSON.stringify(`No ${label.toLowerCase()} yet.`)}>{(data) => <AdminDataTable caption=${JSON.stringify(label)} selectable
      rows={data.records.filter((record) => !q || \`\${record.name} \${record.organizationId}\`.toLowerCase().includes(q))} rowKey={(record) => record.id} rowLabel={(record) => record.name} columns={[
        { header: "Name", cell: (record) => record.name },
        { header: "Organization", cell: (record) => record.organizationId },
        { header: "Created", cell: (record) => formatDate(record.createdAt) },
      ]} />}</AdminQueryState>
  </>;
}
`;
  const files = await generateAdminView(root, manifest, { name: pluralKebab, label, group: "Customers", permission, path: `/resources/${pluralKebab}`, order: 200, header, body: `${header}${body}`, icon: "DatabaseIcon" });
  return { files: registered ? files : [...files, permissions.relative], permission, route };
}
