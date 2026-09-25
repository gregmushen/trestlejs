import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ProjectManifest } from "./core.js";

const moduleName = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const permissionName = /^platform\.[a-z][a-z0-9_.]*$/u;
const marker = "  // trestle:admin-module-list";

const present = async (file: string): Promise<boolean> => access(file).then(() => true, () => false);

/** A guarded, application-owned view shell. Domain routes and authority are
 * deliberately not inferred from a module name. */
export async function generateAdminModule(root: string, manifest: ProjectManifest, name: string, permission: string): Promise<readonly string[]> {
  if (!moduleName.test(name)) throw new Error("admin module name must be kebab-case");
  if (!permissionName.test(permission)) throw new Error("--permission must name a platform permission");
  if (!manifest.capabilities.admin || !manifest.apps.admin) throw new Error("enable the platform admin with a reviewed SetupPlan before generating an admin module");
  const registryPath = path.join(root, manifest.packages.authz ?? "packages/authz", "src", "permissions.ts");
  const permissionSource = await readFile(registryPath, "utf8");
  if (!permissionSource.includes(`"${permission}": { plane: "platform"`)) {
    throw new Error(`${permission} must be registered in packages/authz/src/permissions.ts as a platform permission`);
  }
  const admin = path.join(root, manifest.apps.admin);
  const applicationViewsPath = path.join(admin, "src", "application-views.ts");
  const source = await readFile(applicationViewsPath, "utf8");
  if (source.split(marker).length !== 2) throw new Error("admin application view registry has no unique generation anchor; review it manually");
  const directory = path.join(admin, "src", "views", name);
  if (await present(directory) || source.includes(`id: "${name}"`)) throw new Error(`admin module ${name} already exists`);
  const title = name.split("-").map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`).join(" ");
  const descriptor = `import { SquaresFourIcon } from "@phosphor-icons/react";\n\nimport { defineAdminView } from "../../registry";\n\nexport default defineAdminView({\n  id: "${name}",\n  path: "/modules/${name}",\n  navigation: { label: "${title}", group: "Operations", order: 900, icon: SquaresFourIcon },\n  permission: "${permission}",\n  component: () => import("./view"),\n  commands: [{ id: "${name}.open", label: "Go to ${title}" }],\n});\n`;
  const view = `import { AdminPageHeader, AdminSection } from "../../shell/ui";\n\n/** Application-owned module. Add domain-specific reads and actions here.\n * Server routes require platform authorization; mutations also require\n * step-up, a reason, and a durable audit record. */\nexport default function ${name.split("-").map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`).join("")}View() {\n  return <><AdminPageHeader title="${title}" description="Application-owned platform workflow." /><AdminSection title="${title}"><p>Implement the product-specific workflow here.</p></AdminSection></>;\n}\n`;
  const entry = `  { id: "${name}", path: "/modules/${name}", label: "${title}", group: "Operations", permission: "${permission}", api: [] },\n`;
  const next = source.replace(marker, `${entry}${marker}`);
  await mkdir(directory, { recursive: true });
  const files = [path.join(directory, "admin-view.ts"), path.join(directory, "view.tsx")];
  await writeFile(files[0]!, descriptor, { flag: "wx" });
  await writeFile(files[1]!, view, { flag: "wx" });
  await writeFile(applicationViewsPath, next, "utf8");
  return [...files, applicationViewsPath].map((file) => path.relative(root, file));
}
