import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { auditMigrations, formatMigrationAudit } from "../src/upgrade-migrations.js";

const first = "0000_first";
const second = "0001_second";
const custom = "0001_custom";

async function writeJournal(root: string, entries: Array<{ tag: string; sql: string; when?: number }>) {
  const directory = path.join(root, "packages", "db", "migrations");
  await mkdir(path.join(directory, "meta"), { recursive: true });
  await writeFile(path.join(directory, "meta", "_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries: entries.map((entry, idx) => ({ idx, version: "7", when: entry.when ?? 1000 + idx, tag: entry.tag, breakpoints: true })) }));
  for (const entry of entries) await writeFile(path.join(directory, `${entry.tag}.sql`), entry.sql);
  return directory;
}

describe("read-only migration journal audit", () => {
  async function fixture() {
    const parent = await mkdtemp(path.join(os.tmpdir(), "trestle-migration-audit-"));
    const application = path.join(parent, "application");
    const target = path.join(parent, "target");
    await writeJournal(application, [{ tag: first, sql: "SELECT 1;\n" }, { tag: second, sql: "SELECT 2;\n" }]);
    await writeJournal(target, [{ tag: first, sql: "SELECT 1;\n" }, { tag: second, sql: "SELECT 2;\n" }]);
    return { parent, application, target };
  }

  it("reports exact journal and SQL parity without writing", async () => {
    const { parent, application, target } = await fixture();
    try {
      const source = await readFile(path.join(application, "packages/db/migrations/meta/_journal.json"), "utf8");
      const report = await auditMigrations(application, target);
      expect(report).toMatchObject({ classification: "matching", commonPrefix: 2, applicationCount: 2, targetCount: 2, requiresReview: false, firstDifference: null });
      expect(formatMigrationAudit(report)).toContain("does not prove deployed migration state");
      expect(await readFile(path.join(application, "packages/db/migrations/meta/_journal.json"), "utf8")).toBe(source);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it("distinguishes a target append from application-owned migration history", async () => {
    const { parent, application, target } = await fixture();
    try {
      await writeJournal(application, [{ tag: first, sql: "SELECT 1;\n" }]);
      await rm(path.join(application, "packages/db/migrations", `${second}.sql`));
      expect(await auditMigrations(application, target)).toMatchObject({ classification: "target-ahead", commonPrefix: 1, targetTail: [second], firstDifference: { reason: "append" }, requiresReview: true });
      await writeJournal(application, [{ tag: first, sql: "SELECT 1;\n" }, { tag: second, sql: "SELECT 2;\n" }, { tag: "0002_article", sql: "SELECT 3;\n" }]);
      expect(await auditMigrations(application, target)).toMatchObject({ classification: "application-ahead", commonPrefix: 2, applicationTail: ["0002_article"], requiresReview: true });
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it("surfaces same-index divergent histories like the canary without treating them as append-only", async () => {
    const { parent, application, target } = await fixture();
    try {
      await rm(path.join(application, "packages/db/migrations", `${second}.sql`));
      await writeJournal(application, [{ tag: first, sql: "SELECT 1;\n" }, { tag: custom, sql: "SELECT 20;\n" }]);
      const report = await auditMigrations(application, target);
      expect(report).toMatchObject({ classification: "diverged", commonPrefix: 1, firstDifference: { index: 1, application: custom, target: second, reason: "tag" }, applicationTail: [custom], targetTail: [second] });
      expect(formatMigrationAudit(report)).toContain("never rewrites journal history or proves schema equivalence");
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it("detects SQL changes and timestamp changes even when migration tags match", async () => {
    const { parent, application, target } = await fixture();
    try {
      await writeFile(path.join(application, "packages/db/migrations", `${second}.sql`), "SELECT 200;\n");
      expect(await auditMigrations(application, target)).toMatchObject({ classification: "diverged", commonPrefix: 1, firstDifference: { reason: "sql" } });
      await writeFile(path.join(application, "packages/db/migrations", `${second}.sql`), "SELECT 2;\n");
      await writeJournal(application, [{ tag: first, sql: "SELECT 1;\n" }, { tag: second, sql: "SELECT 2;\n", when: 3000 }]);
      expect(await auditMigrations(application, target)).toMatchObject({ classification: "diverged", commonPrefix: 1, firstDifference: { reason: "timestamp" } });
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it("fails closed on duplicate, missing, and unjournaled migration files", async () => {
    const { parent, application, target } = await fixture();
    try {
      const directory = path.join(application, "packages/db/migrations");
      const journalPath = path.join(directory, "meta/_journal.json");
      const original = JSON.parse(await readFile(journalPath, "utf8"));
      await writeFile(journalPath, JSON.stringify({ ...original, entries: [original.entries[0], { ...original.entries[1], tag: first }] }));
      expect(await auditMigrations(application, target)).toMatchObject({ classification: "invalid", requiresReview: true });
      await writeFile(journalPath, JSON.stringify(original));
      await rm(path.join(directory, `${second}.sql`));
      expect(await auditMigrations(application, target)).toMatchObject({ classification: "invalid", requiresReview: true });
      await writeFile(path.join(directory, `${second}.sql`), "SELECT 2;\n");
      await writeFile(path.join(directory, "0002_unjournaled.sql"), "SELECT 3;\n");
      expect((await auditMigrations(application, target)).issues[0]).toContain("unjournaled SQL files");
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it("never follows a symlinked journal, migration, or parent directory", async () => {
    const { parent, application, target } = await fixture();
    try {
      const directory = path.join(application, "packages/db/migrations");
      const journal = path.join(directory, "meta/_journal.json");
      const outside = path.join(parent, "outside.json");
      await writeFile(outside, await readFile(journal));
      await rm(journal);
      await symlink(outside, journal);
      expect((await auditMigrations(application, target)).issues[0]).toContain("unsafe migration path");
      await rm(journal);
      await writeFile(journal, await readFile(outside));
      const sql = path.join(directory, `${second}.sql`);
      await rm(sql);
      await symlink(outside, sql);
      expect((await auditMigrations(application, target)).issues[0]).toContain("unsafe migration path");
      await rm(sql);
      await writeFile(sql, "SELECT 2;\n");
      const meta = path.join(directory, "meta");
      await rm(meta, { recursive: true });
      await symlink(path.join(target, "packages/db/migrations/meta"), meta);
      expect((await auditMigrations(application, target)).issues[0]).toContain("unsafe migration path");
    } finally { await rm(parent, { recursive: true, force: true }); }
  });
});
