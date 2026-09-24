import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { applyManifestCapabilities, TRESTLEJS_VERSION } from "@trestlejs/core";
import { describe, expect, it } from "vitest";

import { applySourceUpgrade, enableAdminCapability, finalizeSourceUpgrade, planSourceDiff } from "../src/upgrade-source.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

describe("read-only template source inventory", () => {
  it("separates untouched generated files, application edits, missing paths, and unsafe symlinks", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "trestle-source-diff-"));
    const root = path.join(parent, "sample-app");
    const template = path.join(parent, "template");
    try {
      await mkdir(path.join(root, ".trestle"), { recursive: true });
      await mkdir(template);
      await writeFile(path.join(root, ".trestle", "framework.json"), JSON.stringify({ templateVersion: "0.1.0-alpha.68" }));
      await writeFile(path.join(template, "same.txt"), "sample-app\n");
      await writeFile(path.join(template, "changed.txt"), "new sample-app\n");
      await writeFile(path.join(template, "custom.txt"), "target\n");
      await writeFile(path.join(template, "missing.txt"), "target\n");
      await writeFile(path.join(template, "added.txt"), "target\n");
      await writeFile(path.join(template, "unsafe.txt"), "target\n");
      await writeFile(path.join(root, "same.txt"), "sample-app\n");
      await writeFile(path.join(root, "changed.txt"), "old sample-app\n");
      await writeFile(path.join(root, "custom.txt"), "application edit\n");
      await symlink(path.join(parent, "outside"), path.join(root, "unsafe.txt"));
      await writeFile(path.join(root, ".trestle", "template-baseline.json"), JSON.stringify({ schemaVersion: 1, templateVersion: "0.1.0-alpha.68", files: {
        "same.txt": hash("sample-app\n"), "changed.txt": hash("old sample-app\n"), "custom.txt": hash("old custom\n"), "missing.txt": hash("old missing\n"), "unsafe.txt": hash("old unsafe\n"),
      } }));
      const report = await planSourceDiff(root, "sample-app", template);
      expect(report.baselineTrusted).toBe(true);
      expect(report.targetTemplateVersion).toBe(TRESTLEJS_VERSION);
      expect(Object.fromEntries(report.entries.map((entry) => [entry.path, entry.classification]))).toEqual({
        "added.txt": "new", "changed.txt": "unchanged", "custom.txt": "modified", "missing.txt": "missing", "same.txt": "same", "unsafe.txt": "unsafe",
      });
      expect(report.summary).toMatchObject({ same: 1, unchanged: 1, modified: 1, new: 1, missing: 1, unsafe: 1 });
      expect(await readFile(path.join(root, "custom.txt"), "utf8")).toBe("application edit\n");
      await rm(path.join(root, ".trestle", "template-baseline.json"));
      const unverified = await planSourceDiff(root, "sample-app", template);
      expect(unverified.baselineTrusted).toBe(false);
      expect(unverified.entries.find((entry) => entry.path === "changed.txt")?.classification).toBe("unverified");
      expect(unverified.entries.find((entry) => entry.path === "unsafe.txt")?.classification).toBe("unsafe");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe("optional capability source inventory", () => {
  it("includes the admin app only when enabled and treats the enabled manifest as the target", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "trestle-source-optional-"));
    const template = path.join(parent, "template");
    try {
      const manifest = (await readFile(path.join(import.meta.dirname, "..", "..", "create", "template", ".trestle", "project.yaml"), "utf8")).replaceAll("__TRESTLE_PROJECT_NAME__", "sample-app");
      await mkdir(path.join(template, ".trestle"), { recursive: true });
      await mkdir(path.join(template, "apps", "admin"), { recursive: true });
      await writeFile(path.join(template, ".trestle", "project.yaml"), manifest);
      await writeFile(path.join(template, "apps", "admin", "index.ts"), "export {};\n");
      for (const [name, adminEnabled] of [["plain", false], ["operated", true]] as const) {
        const root = path.join(parent, name, "sample-app");
        await mkdir(path.join(root, ".trestle"), { recursive: true });
        await writeFile(path.join(root, ".trestle", "project.yaml"), adminEnabled ? applyManifestCapabilities(manifest, new Set(["admin"])) : manifest);
        if (adminEnabled) { await mkdir(path.join(root, "apps", "admin"), { recursive: true }); await writeFile(path.join(root, "apps", "admin", "index.ts"), "export {};\n"); }
        const report = await planSourceDiff(root, "sample-app", template);
        const classifications = Object.fromEntries(report.entries.map((entry) => [entry.path, entry.classification]));
        expect(classifications[".trestle/project.yaml"]).toBe("same");
        expect(classifications["apps/admin/index.ts"]).toBe(adminEnabled ? "same" : undefined);
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe("adjacent-alpha source apply", () => {
  async function fixture() {
    const parent = await mkdtemp(path.join(os.tmpdir(), "trestle-source-apply-"));
    const root = path.join(parent, "sample-app");
    const template = path.join(parent, "template");
    const alpha = Number(TRESTLEJS_VERSION.split(".").at(-1));
    await mkdir(path.join(root, ".trestle"), { recursive: true });
    await mkdir(path.join(template, ".trestle"), { recursive: true });
    const oldMarker = JSON.stringify({ schemaVersion: 1, templateVersion: `0.1.0-alpha.${alpha - 1}` });
    const packageSource = JSON.stringify({ devDependencies: { trestlejs: TRESTLEJS_VERSION } });
    await writeFile(path.join(root, ".trestle", "framework.json"), oldMarker);
    await writeFile(path.join(template, ".trestle", "framework.json"), JSON.stringify({ schemaVersion: 1, templateVersion: TRESTLEJS_VERSION }));
    await writeFile(path.join(root, "package.json"), packageSource);
    await writeFile(path.join(template, "package.json"), packageSource);
    await writeFile(path.join(root, "pnpm-lock.yaml"), `importers:\n  .:\n    devDependencies:\n      trestlejs:\n        specifier: ${TRESTLEJS_VERSION}\n        version: ${TRESTLEJS_VERSION}\n`);
    await writeFile(path.join(template, "changed.txt"), "new sample-app\n");
    await writeFile(path.join(template, "added.txt"), "added\n");
    await writeFile(path.join(root, "changed.txt"), "old sample-app\n");
    await writeFile(path.join(root, "custom.txt"), "my application data\n");
    await writeFile(path.join(root, ".trestle", "template-baseline.json"), JSON.stringify({ schemaVersion: 1, templateVersion: `0.1.0-alpha.${alpha - 1}`, files: { ".trestle/framework.json": hash(oldMarker), "package.json": hash(packageSource), "changed.txt": hash("old sample-app\n") } }));
    return { parent, root, template };
  }

  it("updates pristine files but keeps custom files and old certification marker", async () => {
    const { parent, root, template } = await fixture();
    try {
      expect(await applySourceUpgrade(root, "sample-app", template)).toEqual(["added.txt", "changed.txt"]);
      expect(await readFile(path.join(root, "changed.txt"), "utf8")).toBe("new sample-app\n");
      expect(await readFile(path.join(root, "custom.txt"), "utf8")).toBe("my application data\n");
      expect(JSON.parse(await readFile(path.join(root, ".trestle", "framework.json"), "utf8")).templateVersion).not.toBe(TRESTLEJS_VERSION);
      expect(await applySourceUpgrade(root, "sample-app", template)).toEqual([]);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it("finalizes only after checks and target parity, refreshing the baseline without touching custom files", async () => {
    const { parent, root, template } = await fixture();
    try {
      await applySourceUpgrade(root, "sample-app", template);
      let checks = 0;
      await finalizeSourceUpgrade(root, "sample-app", async () => { checks += 1; }, template);
      expect(checks).toBe(1);
      expect(JSON.parse(await readFile(path.join(root, ".trestle", "framework.json"), "utf8")).templateVersion).toBe(TRESTLEJS_VERSION);
      const baseline = JSON.parse(await readFile(path.join(root, ".trestle", "template-baseline.json"), "utf8"));
      expect(baseline.templateVersion).toBe(TRESTLEJS_VERSION);
      expect(baseline.files[".trestle/framework.json"]).toBe(hash(await readFile(path.join(root, ".trestle", "framework.json"), "utf8")));
      expect(baseline.files["changed.txt"]).toBe(hash("new sample-app\n"));
      expect(await readFile(path.join(root, "custom.txt"), "utf8")).toBe("my application data\n");
      expect((await planSourceDiff(root, "sample-app", template)).baselineTrusted).toBe(true);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it("never advances the marker when checks fail or source changes during checks", async () => {
    const { parent, root, template } = await fixture();
    try {
      await applySourceUpgrade(root, "sample-app", template);
      await expect(finalizeSourceUpgrade(root, "sample-app", async () => { throw new Error("checks failed"); }, template)).rejects.toThrow("checks failed");
      expect(JSON.parse(await readFile(path.join(root, ".trestle", "framework.json"), "utf8")).templateVersion).not.toBe(TRESTLEJS_VERSION);
      await expect(finalizeSourceUpgrade(root, "sample-app", async () => { await writeFile(path.join(root, "changed.txt"), "edited during checks\n"); }, template)).rejects.toThrow("changed.txt");
      expect(JSON.parse(await readFile(path.join(root, ".trestle", "framework.json"), "utf8")).templateVersion).not.toBe(TRESTLEJS_VERSION);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it("refuses finalization before source parity or while retired generated source remains", async () => {
    const { parent, root, template } = await fixture();
    try {
      let checks = 0;
      await expect(finalizeSourceUpgrade(root, "sample-app", async () => { checks += 1; }, template)).rejects.toThrow("target parity");
      expect(checks).toBe(0);
      await applySourceUpgrade(root, "sample-app", template);
      const baselinePath = path.join(root, ".trestle", "template-baseline.json");
      const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
      baseline.files["retired.txt"] = hash("old generated\n");
      await writeFile(baselinePath, JSON.stringify(baseline));
      await writeFile(path.join(root, "retired.txt"), "old generated\n");
      await expect(finalizeSourceUpgrade(root, "sample-app", async () => { checks += 1; }, template)).rejects.toThrow("retired.txt");
      expect(checks).toBe(0);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it("accepts pnpm's package.json key reordering but rejects semantic application edits", async () => {
    const { parent, root, template } = await fixture();
    try {
      await writeFile(path.join(template, "package.json"), JSON.stringify({ name: "sample-app", devDependencies: { foo: "1", trestlejs: TRESTLEJS_VERSION } }));
      await writeFile(path.join(root, "package.json"), JSON.stringify({ devDependencies: { trestlejs: TRESTLEJS_VERSION, foo: "1" }, name: "sample-app" }));
      expect((await planSourceDiff(root, "sample-app", template)).entries.find(({ path: relative }) => relative === "package.json")?.classification).toBe("modified");
      expect(await applySourceUpgrade(root, "sample-app", template)).toEqual(["added.txt", "changed.txt"]);
      const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
      manifest.scripts = { unsafe: "changed by application" };
      await writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
      await expect(applySourceUpgrade(root, "sample-app", template)).rejects.toThrow("package.json");
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it("applies a changed generated package manifest after only the required CLI version bump", async () => {
    const { parent, root, template } = await fixture();
    try {
      const previousVersion = `0.1.0-alpha.${Number(TRESTLEJS_VERSION.split(".").at(-1)) - 1}`;
      const oldPackage = `${JSON.stringify({ name: "sample-app", scripts: { test: "node old.test.mjs" }, devDependencies: { trestlejs: previousVersion } }, null, 2)}\n`;
      const upgradedDependency = oldPackage.replace(previousVersion, TRESTLEJS_VERSION);
      const newPackage = `${JSON.stringify({ name: "sample-app", scripts: { test: "node new.test.mjs" }, devDependencies: { trestlejs: TRESTLEJS_VERSION } }, null, 2)}\n`;
      const baselinePath = path.join(root, ".trestle", "template-baseline.json");
      const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
      baseline.files["package.json"] = hash(oldPackage);
      await writeFile(baselinePath, JSON.stringify(baseline));
      await writeFile(path.join(root, "package.json"), upgradedDependency);
      await writeFile(path.join(template, "package.json"), newPackage);
      expect((await planSourceDiff(root, "sample-app", template)).entries.find(({ path: relative }) => relative === "package.json")?.classification).toBe("modified");
      expect(await applySourceUpgrade(root, "sample-app", template)).toEqual(["added.txt", "changed.txt", "package.json"]);
      expect(await readFile(path.join(root, "package.json"), "utf8")).toBe(newPackage);
      expect(await applySourceUpgrade(root, "sample-app", template)).toEqual([]);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it("uses a hash-verified package baseline when pnpm reformats the dependency bump", async () => {
    const { parent, root, template } = await fixture();
    try {
      const previousVersion = `0.1.0-alpha.${Number(TRESTLEJS_VERSION.split(".").at(-1)) - 1}`;
      const oldPackage = `${JSON.stringify({ name: "sample-app", scripts: { test: "node old.test.mjs" }, devDependencies: { trestlejs: previousVersion, foo: "1" } }, null, 2)}\n`;
      const target = `${JSON.stringify({ name: "sample-app", scripts: { test: "node new.test.mjs" }, devDependencies: { trestlejs: TRESTLEJS_VERSION, foo: "1" } }, null, 2)}\n`;
      const baselinePath = path.join(root, ".trestle", "template-baseline.json");
      const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
      baseline.files["package.json"] = hash(oldPackage);
      baseline.packageSource = oldPackage;
      await writeFile(baselinePath, JSON.stringify(baseline));
      await writeFile(path.join(root, "package.json"), JSON.stringify({ devDependencies: { foo: "1", trestlejs: TRESTLEJS_VERSION }, scripts: { test: "node old.test.mjs" }, name: "sample-app" }));
      await writeFile(path.join(template, "package.json"), target);
      expect(await applySourceUpgrade(root, "sample-app", template)).toContain("package.json");
      expect(await readFile(path.join(root, "package.json"), "utf8")).toBe(target);
      await finalizeSourceUpgrade(root, "sample-app", async () => {}, template);
      const finalized = JSON.parse(await readFile(baselinePath, "utf8"));
      expect(finalized.packageSource).toBe(target);
      expect(finalized.files["package.json"]).toBe(hash(target));
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it("still rejects an application package edit combined with a CLI version bump", async () => {
    const { parent, root, template } = await fixture();
    try {
      const previousVersion = `0.1.0-alpha.${Number(TRESTLEJS_VERSION.split(".").at(-1)) - 1}`;
      const oldPackage = JSON.stringify({ scripts: { test: "node old.test.mjs" }, devDependencies: { trestlejs: previousVersion } });
      const baselinePath = path.join(root, ".trestle", "template-baseline.json");
      const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
      baseline.files["package.json"] = hash(oldPackage);
      await writeFile(baselinePath, JSON.stringify(baseline));
      await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node application.test.mjs" }, devDependencies: { trestlejs: TRESTLEJS_VERSION } }));
      await writeFile(path.join(template, "package.json"), JSON.stringify({ scripts: { test: "node new.test.mjs" }, devDependencies: { trestlejs: TRESTLEJS_VERSION } }));
      await expect(applySourceUpgrade(root, "sample-app", template)).rejects.toThrow("package.json");
      await expect(readFile(path.join(root, "added.txt"))).rejects.toThrow();
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it("does not trust package source that disagrees with its recorded hash", async () => {
    const { parent, root, template } = await fixture();
    try {
      const baselinePath = path.join(root, ".trestle", "template-baseline.json");
      const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
      baseline.packageSource = '{"devDependencies":{"trestlejs":"tampered"}}';
      await writeFile(baselinePath, JSON.stringify(baseline));
      expect((await planSourceDiff(root, "sample-app", template)).baselineTrusted).toBe(false);
      await expect(applySourceUpgrade(root, "sample-app", template)).rejects.toThrow("matching baseline");
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it("fails before writing when an application edit or protected configuration would change", async () => {
    const { parent, root, template } = await fixture();
    try {
      await writeFile(path.join(root, "changed.txt"), "my edit\n");
      await expect(applySourceUpgrade(root, "sample-app", template)).rejects.toThrow("manual review");
      await expect(readFile(path.join(root, "added.txt"))).rejects.toThrow();
      await writeFile(path.join(root, "changed.txt"), "old sample-app\n");
      await mkdir(path.join(template, ".github", "workflows"), { recursive: true });
      await writeFile(path.join(template, ".github", "workflows", "deploy.yml"), "new deployment\n");
      await expect(applySourceUpgrade(root, "sample-app", template)).rejects.toThrow("deploy.yml");
      await expect(readFile(path.join(root, "added.txt"))).rejects.toThrow();
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it("refuses symlinked parent directories", async () => {
    const { parent, root, template } = await fixture();
    try {
      await mkdir(path.join(template, "nested"));
      await writeFile(path.join(template, "nested", "thing.txt"), "target\n");
      await symlink(parent, path.join(root, "nested"));
      expect((await planSourceDiff(root, "sample-app", template)).entries.find(({ path: relative }) => relative === "nested/thing.txt")?.classification).toBe("unsafe");
      await expect(applySourceUpgrade(root, "sample-app", template)).rejects.toThrow("manual review");
      await expect(readFile(path.join(root, "added.txt"))).rejects.toThrow();
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it("does not trust a symlinked framework marker or generation baseline", async () => {
    const { parent, root, template } = await fixture();
    try {
      const marker = path.join(root, ".trestle", "framework.json");
      const markerContent = await readFile(marker);
      await writeFile(path.join(parent, "marker.json"), markerContent);
      await rm(marker);
      await symlink(path.join(parent, "marker.json"), marker);
      expect((await planSourceDiff(root, "sample-app", template)).baselineTrusted).toBe(false);
      await expect(applySourceUpgrade(root, "sample-app", template)).rejects.toThrow("matching baseline");
      await rm(marker);
      await writeFile(marker, markerContent);
      const baseline = path.join(root, ".trestle", "template-baseline.json");
      const baselineContent = await readFile(baseline);
      await writeFile(path.join(parent, "baseline.json"), baselineContent);
      await rm(baseline);
      await symlink(path.join(parent, "baseline.json"), baseline);
      expect((await planSourceDiff(root, "sample-app", template)).baselineTrusted).toBe(false);
      await expect(applySourceUpgrade(root, "sample-app", template)).rejects.toThrow("matching baseline");
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it("rejects a missing baseline, non-adjacent version, or stale lockfile", async () => {
    const { parent, root, template } = await fixture();
    try {
      await rm(path.join(root, ".trestle", "template-baseline.json"));
      await expect(applySourceUpgrade(root, "sample-app", template)).rejects.toThrow("matching baseline");
      const alpha = Number(TRESTLEJS_VERSION.split(".").at(-1));
      await writeFile(path.join(root, ".trestle", "framework.json"), JSON.stringify({ templateVersion: `0.1.0-alpha.${alpha - 2}` }));
      await writeFile(path.join(root, ".trestle", "template-baseline.json"), JSON.stringify({ schemaVersion: 1, templateVersion: `0.1.0-alpha.${alpha - 2}`, files: { "changed.txt": hash("old sample-app\n") } }));
      await expect(applySourceUpgrade(root, "sample-app", template)).rejects.toThrow("immediately preceding alpha");
      await writeFile(path.join(root, ".trestle", "framework.json"), JSON.stringify({ templateVersion: `0.1.0-alpha.${alpha - 1}` }));
      await writeFile(path.join(root, ".trestle", "template-baseline.json"), JSON.stringify({ schemaVersion: 1, templateVersion: `0.1.0-alpha.${alpha - 1}`, files: { "changed.txt": hash("old sample-app\n") } }));
      await writeFile(path.join(root, "pnpm-lock.yaml"), "importers: {}\n");
      await expect(applySourceUpgrade(root, "sample-app", template)).rejects.toThrow("pnpm-lock.yaml");
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it("reports retired generated paths and refuses to leave obsolete source behind", async () => {
    const { parent, root, template } = await fixture();
    try {
      const baselinePath = path.join(root, ".trestle", "template-baseline.json");
      const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
      baseline.files["retired.txt"] = hash("old generated\n");
      await writeFile(baselinePath, JSON.stringify(baseline));
      await writeFile(path.join(root, "retired.txt"), "old generated\n");
      expect((await planSourceDiff(root, "sample-app", template)).entries.find(({ path: relative }) => relative === "retired.txt")?.classification).toBe("retired");
      await expect(applySourceUpgrade(root, "sample-app", template)).rejects.toThrow("retired.txt");
      await expect(readFile(path.join(root, "added.txt"))).rejects.toThrow();
      await writeFile(path.join(root, "retired.txt"), "my custom edit\n");
      expect((await planSourceDiff(root, "sample-app", template)).entries.find(({ path: relative }) => relative === "retired.txt")?.classification).toBe("retired-modified");
      await expect(applySourceUpgrade(root, "sample-app", template)).rejects.toThrow("retired.txt");
      await rm(path.join(root, "retired.txt"));
      expect((await planSourceDiff(root, "sample-app", template)).entries.find(({ path: relative }) => relative === "retired.txt")?.classification).toBe("retired-missing");
      expect(await applySourceUpgrade(root, "sample-app", template)).toEqual(["added.txt", "changed.txt"]);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it("rejects malformed baseline paths before inspecting them", async () => {
    const { parent, root, template } = await fixture();
    try {
      const baselinePath = path.join(root, ".trestle", "template-baseline.json");
      const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
      baseline.files["../outside.txt"] = hash("outside\n");
      await writeFile(baselinePath, JSON.stringify(baseline));
      expect((await planSourceDiff(root, "sample-app", template)).baselineTrusted).toBe(false);
      await expect(applySourceUpgrade(root, "sample-app", template)).rejects.toThrow("matching baseline");
      await expect(readFile(path.join(root, "added.txt"))).rejects.toThrow();
      delete baseline.files["../outside.txt"];
      baseline.files["changed.txt"] = "not-a-checksum";
      await writeFile(baselinePath, JSON.stringify(baseline));
      expect((await planSourceDiff(root, "sample-app", template)).baselineTrusted).toBe(false);
      await expect(applySourceUpgrade(root, "sample-app", template)).rejects.toThrow("matching baseline");
    } finally { await rm(parent, { recursive: true, force: true }); }
  });
});

describe("enabling the platform admin in an existing project", () => {
  async function project(templateVersion = TRESTLEJS_VERSION) {
    const parent = await mkdtemp(path.join(os.tmpdir(), "trestle-admin-enable-"));
    const root = path.join(parent, "sample-app");
    const template = path.join(parent, "template");
    const templateManifest = await readFile(path.join(import.meta.dirname, "..", "..", "create", "template", ".trestle", "project.yaml"), "utf8");
    const manifest = templateManifest.replaceAll("__TRESTLE_PROJECT_NAME__", "sample-app");
    await mkdir(path.join(template, ".trestle"), { recursive: true });
    await mkdir(path.join(template, "apps", "admin", "worker"), { recursive: true });
    await writeFile(path.join(template, ".trestle", "project.yaml"), templateManifest);
    await writeFile(path.join(template, "apps", "admin", "worker", "index.ts"), "export const project = \"__TRESTLE_PROJECT_NAME__\";\n");
    await writeFile(path.join(template, "README.md"), "readme\n");
    await mkdir(path.join(root, ".trestle"), { recursive: true });
    await writeFile(path.join(root, ".trestle", "project.yaml"), manifest);
    await writeFile(path.join(root, ".trestle", "framework.json"), JSON.stringify({ schemaVersion: 1, templateVersion }));
    await writeFile(path.join(root, ".trestle", "template-baseline.json"), JSON.stringify({ schemaVersion: 1, templateVersion, files: { ".trestle/project.yaml": hash(manifest), "README.md": hash("readme\n") } }));
    return { parent, root, template, manifest };
  }

  it("renders apps/admin, enables the manifest, and records template ownership", async () => {
    const { parent, root, template, manifest } = await project();
    try {
      expect(await enableAdminCapability(root, "sample-app", template)).toEqual(["apps/admin/worker/index.ts", ".trestle/project.yaml"]);
      expect(await readFile(path.join(root, "apps", "admin", "worker", "index.ts"), "utf8")).toBe("export const project = \"sample-app\";\n");
      const enabled = await readFile(path.join(root, ".trestle", "project.yaml"), "utf8");
      expect(enabled).toBe(applyManifestCapabilities(manifest, new Set(["admin"])));
      const baseline = JSON.parse(await readFile(path.join(root, ".trestle", "template-baseline.json"), "utf8")) as { files: Record<string, string> };
      expect(baseline.files["apps/admin/worker/index.ts"]).toBe(hash("export const project = \"sample-app\";\n"));
      expect(baseline.files[".trestle/project.yaml"]).toBe(hash(enabled));
      const report = await planSourceDiff(root, "sample-app", template);
      expect(report.entries.find((entry) => entry.path === "apps/admin/worker/index.ts")?.classification).toBe("same");
      expect(report.entries.find((entry) => entry.path === ".trestle/project.yaml")?.classification).toBe("same");
      expect(await enableAdminCapability(root, "sample-app", template)).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("refuses an older template version and never overwrites existing admin files", async () => {
    const older = await project("0.1.0-alpha.1");
    try {
      await expect(enableAdminCapability(older.root, "sample-app", older.template)).rejects.toThrow(/Run trestle upgrade first/u);
    } finally {
      await rm(older.parent, { recursive: true, force: true });
    }
    const existing = await project();
    try {
      await mkdir(path.join(existing.root, "apps", "admin", "worker"), { recursive: true });
      await writeFile(path.join(existing.root, "apps", "admin", "worker", "index.ts"), "application code\n");
      await expect(enableAdminCapability(existing.root, "sample-app", existing.template)).rejects.toThrow(/already exists/u);
      expect(await readFile(path.join(existing.root, "apps", "admin", "worker", "index.ts"), "utf8")).toBe("application code\n");
      expect(await readFile(path.join(existing.root, ".trestle", "project.yaml"), "utf8")).toBe(existing.manifest);
    } finally {
      await rm(existing.parent, { recursive: true, force: true });
    }
  });
});
