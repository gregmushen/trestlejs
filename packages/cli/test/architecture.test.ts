import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkArchitecture } from "../src/architecture.js";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true }))));

describe("static architecture checks", () => {
  it("detects provider leakage and missing forced RLS", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-architecture-")); roots.push(root);
    await mkdir(path.join(root, "apps", "app", "src"), { recursive: true });
    await mkdir(path.join(root, ".trestle", "resources"), { recursive: true });
    await mkdir(path.join(root, ".agents", "skills", "trestle-setup"), { recursive: true });
    await writeFile(path.join(root, "apps", "app", "src", "billing.ts"), 'import Stripe from "stripe";\n');
    await writeFile(path.join(root, ".trestle", "resources", "article.json"), JSON.stringify({ name: "Article", tenant: true, persistence: { table: "article" }, files: ["missing.ts"] }));
    await writeFile(path.join(root, ".agents", "skills", "trestle-setup", "SKILL.md"), "# stale\n\n<!-- trestle-managed-guidance:0 -->\n");
    const report = await checkArchitecture(root);
    expect(report.valid).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "architecture.provider-boundary", status: "fail" }),
      expect.objectContaining({ id: "architecture.resource.Article.rls", status: "fail" }),
      expect.objectContaining({ id: "architecture.guidance.managed", status: "fail" }),
    ]));
  });
});
