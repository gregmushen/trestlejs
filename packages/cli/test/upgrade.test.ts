import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TRESTLEJS_VERSION } from "@trestlejs/core";
import { applyUpgrade, planUpgrade } from "../src/upgrade.js";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true }))));

describe("versioned project upgrades", () => {
  it("plans without mutation and applies convergently while preserving custom guidance", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-upgrade-")); roots.push(root);
    await mkdir(path.join(root, ".trestle"));
    await mkdir(path.join(root, ".agents", "skills", "trestle-setup"), { recursive: true });
    await writeFile(path.join(root, "package.json"), '{"devDependencies":{"trestlejs":"0.1.0-alpha.8"}}\n');
    await writeFile(path.join(root, ".agents", "skills", "trestle-setup", "SKILL.md"), "---\nname: trestle-setup\n---\n\n# Custom guidance\n");
    expect((await planUpgrade(root)).operations.every(({ classification }) => classification === "update")).toBe(true);
    expect(await readFile(path.join(root, "package.json"), "utf8")).toContain("alpha.8");
    await applyUpgrade(root);
    await applyUpgrade(root);
    expect(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).devDependencies.trestlejs).toBe(TRESTLEJS_VERSION);
    const skill = await readFile(path.join(root, ".agents", "skills", "trestle-setup", "SKILL.md"), "utf8");
    expect(skill).toContain("# Custom guidance");
    expect(skill.match(/trestle-managed-guidance/g)).toHaveLength(1);
    expect((await planUpgrade(root)).operations.every(({ classification }) => classification === "already-correct")).toBe(true);
  });
});
