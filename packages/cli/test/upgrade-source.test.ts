import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TRESTLEJS_VERSION } from "@trestlejs/core";
import { describe, expect, it } from "vitest";

import { planSourceDiff } from "../src/upgrade-source.js";

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
