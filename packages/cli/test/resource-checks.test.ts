import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hasForcedRlsMigration, missingFiles, readMigrationSql } from "../src/resource-checks.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("resource convergence checks", () => {
  it("requires both table creation and forced RLS", () => {
    expect(hasForcedRlsMigration('CREATE TABLE "article" ();\nALTER TABLE "article" FORCE ROW LEVEL SECURITY;', "article")).toBe(true);
    expect(hasForcedRlsMigration('CREATE TABLE "article" ();', "article")).toBe(false);
    expect(hasForcedRlsMigration('ALTER TABLE "article" FORCE ROW LEVEL SECURITY;', "article")).toBe(false);
  });

  it("reads journaled SQL and reports missing declared files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-resource-checks-"));
    roots.push(root);
    await mkdir(path.join(root, "packages/db/migrations"), { recursive: true });
    await writeFile(path.join(root, "packages/db/migrations/0000_a.sql"), "SELECT 1;");
    await writeFile(path.join(root, "present.ts"), "");
    expect(await readMigrationSql(root, "packages/db")).toContain("SELECT 1;");
    expect(await readMigrationSql(root, "packages/missing")).toBe("");
    expect(await missingFiles(root, ["present.ts", "absent.ts"])).toEqual(["absent.ts"]);
  });
});
