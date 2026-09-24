import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { checkAdminViews, defaultViewsDirectory, describeRegistry } from "./check-admin-views";

const scratchRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.wrangler");
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function views(definitions: Record<string, { descriptor: string; view?: string }>): Promise<string> {
  await mkdir(scratchRoot, { recursive: true });
  const directory = await mkdtemp(path.join(scratchRoot, "views-"));
  directories.push(directory);
  const registry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/registry");
  for (const [name, files] of Object.entries(definitions)) {
    await mkdir(path.join(directory, name));
    await writeFile(path.join(directory, name, "admin-view.ts"), `import { FileTextIcon } from "@phosphor-icons/react";\nimport { defineAdminView } from ${JSON.stringify(registry)};\nexport default defineAdminView(${files.descriptor});\n`);
    if (files.view !== undefined) await writeFile(path.join(directory, name, "view.tsx"), files.view);
  }
  return directory;
}

describe("build-time admin view discovery", () => {
  it("validates every default view", async () => {
    const result = await checkAdminViews(defaultViewsDirectory);
    expect(result.problems).toEqual([]);
    expect(describeRegistry(result.registry!).groups.map((group) => group.name)).toEqual(["Overview", "Customers", "Commercial", "Access", "Integrations", "Communications", "Operations", "System"]);
    expect(result.registry!.views.find((view) => view.id === "permissions")?.navigation.group).toBe("Access");
  });

  it("discovers a dropped-in application view and places it in the sidebar registry", async () => {
    const directory = await views({
      contracts: { descriptor: `{ id: "contracts", path: "/contracts", navigation: { label: "Contracts", group: "Customers", order: 40, icon: FileTextIcon }, permission: "platform.organizations.read", component: () => import("./view"), commands: [{ id: "contracts.open", label: "Go to Contracts" }] }`, view: "export default function Contracts() { return null; }\n" },
    });
    const result = await checkAdminViews(directory);
    expect(result.problems).toEqual([]);
    expect(describeRegistry(result.registry!)).toEqual({ views: [{ id: "contracts", path: "/contracts", label: "Contracts", group: "Customers", order: 40, permission: "platform.organizations.read" }], groups: [{ name: "Customers", views: ["contracts"] }], commands: [{ id: "contracts.open", label: "Go to Contracts", view: "contracts", permission: "platform.organizations.read", kind: "navigate", scope: "global" }] });
  });

  it("fails the build for duplicate, invalid, or componentless views", async () => {
    const directory = await views({
      one: { descriptor: `{ id: "same", path: "/same", navigation: { label: "One", group: "Customers", order: 1, icon: FileTextIcon }, permission: "platform.organizations.read", component: () => import("./view"), commands: [{ id: "same.open", label: "One" }] }`, view: "export default function One() { return null; }\n" },
      two: { descriptor: `{ id: "same", path: "/same", navigation: { label: "Two", group: "Customers", order: 2, icon: FileTextIcon }, permission: "resource.read", component: () => import("./view"), commands: [{ id: "same.go", label: "Two" }] }`, view: "export const notDefault = 1;\n" },
    });
    const result = await checkAdminViews(directory);
    expect(result.registry).toBeUndefined();
    expect(result.problems.join("\n")).toMatch(/duplicate id same[\s\S]*duplicate path \/same[\s\S]*application plane/u);
    expect(result.problems.join("\n")).toContain("does not resolve to a module with a default-exported React component");
  });

  it("requires mounted handlers, confirmation for destructive commands, and Kumo tokens", async () => {
    const directory = await views({
      ledger: {
        descriptor: `{ id: "ledger", path: "/ledger", navigation: { label: "Ledger", group: "Operations", order: 5, icon: FileTextIcon }, permission: "platform.audit.read", component: () => import("./view"), commands: [
          { id: "ledger.open", label: "Go to Ledger" },
          { id: "ledger.refresh", label: "Refresh", hotkey: "r", kind: "action", scope: "view" },
          { id: "ledger.purge", label: "Purge", hotkey: "p", kind: "action", scope: "selection", requires: "an entry", destructive: true },
        ] }`,
        view: `export default function Ledger() { useAdminCommands({ "ledger.purge": { run: () => undefined } }); return <div className="bg-slate-100 dark:bg-black" />; }\ndeclare function useAdminCommands(handlers: unknown): void;\n`,
      },
    });
    const problems = (await checkAdminViews(directory)).problems.join("\n");
    expect(problems).toContain("command ledger.refresh has no handler");
    expect(problems).toContain("destructive command ledger.purge must be registered with confirm:");
    expect(problems).toContain("raw color class bg-slate-100");
    expect(problems).toContain("dark: variants");
  });
});

