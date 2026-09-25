import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadProjectManifest } from "../src/core.js";
import { generateAdminModule } from "../src/generate-admin-module.js";

const template = path.resolve("packages/create/template");

describe("application-owned admin modules", () => {
  it("requires an enabled admin and a registered platform permission", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-admin-module-"));
    try {
      const manifest = await loadProjectManifest(template);
      await expect(generateAdminModule(root, manifest, "crop-editorial", "platform.operations.read")).rejects.toThrow("enable the platform admin");
      const enabled = { ...manifest, apps: { ...manifest.apps, admin: "apps/admin" }, capabilities: { ...manifest.capabilities, admin: true } };
      await mkdir(path.join(root, "packages", "authz", "src"), { recursive: true });
      await writeFile(path.join(root, "packages", "authz", "src", "permissions.ts"), '"platform.operations.read": { plane: "platform" },\n');
      await mkdir(path.join(root, "apps", "admin", "src"), { recursive: true });
      await writeFile(path.join(root, "apps", "admin", "src", "application-views.ts"), 'export const applicationAdminViews = [\n  // trestle:admin-module-list\n];\n');
      await expect(generateAdminModule(root, enabled, "../escape", "platform.operations.read")).rejects.toThrow("kebab-case");
      await expect(generateAdminModule(root, enabled, "crop-editorial", "organization.members.read")).rejects.toThrow("platform permission");
      await expect(generateAdminModule(root, enabled, "crop-editorial", "platform.unknown.read")).rejects.toThrow("must be registered");
      const files = await generateAdminModule(root, enabled, "crop-editorial", "platform.operations.read");
      expect(files).toEqual([
        "apps/admin/src/views/crop-editorial/admin-view.ts",
        "apps/admin/src/views/crop-editorial/view.tsx",
        "apps/admin/src/application-views.ts",
      ]);
      expect(await readFile(path.join(root, files[0]!), "utf8")).toContain('permission: "platform.operations.read"');
      expect(await readFile(path.join(root, files[2]!), "utf8")).toContain('api: []');
      await expect(generateAdminModule(root, enabled, "crop-editorial", "platform.operations.read")).rejects.toThrow("already exists");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
