// Applies the migration journal with drizzle-kit, after refusing the one case
// Drizzle handles silently: it applies only migrations newer than the latest
// recorded one, so a migration older than an applied one (for example a
// framework migration adopted in an upgrade after the application generated
// its own) would be skipped forever. `--apply-skipped` applies exactly those,
// in journal order and inside a transaction each, then continues normally.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const applySkipped = process.argv.includes("--apply-skipped");

const journal = JSON.parse(await readFile(path.join(root, "migrations", "meta", "_journal.json"), "utf8"));
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  const [{ exists }] = await sql`select to_regclass('drizzle.__drizzle_migrations') is not null as exists`;
  if (exists) {
    // A migration is identified by its journal timestamp (Drizzle's created_at), which reviewed
    // corrections and renumbering keep, rather than by its SQL hash.
    const applied = await sql`select created_at from drizzle.__drizzle_migrations`;
    const recorded = new Set(applied.map((row) => Number(row.created_at)));
    const latest = Math.max(0, ...recorded);
    const skipped = journal.entries.filter((entry) => !recorded.has(entry.when) && entry.when <= latest);
    if (skipped.length && !applySkipped) {
      process.stderr.write(`These migrations are older than the latest applied one, so Drizzle would skip them:\n${skipped.map((entry) => `  ${entry.tag}`).join("\n")}\nThis happens after an upgrade adopts framework migrations beside your own. Review them, then run: pnpm db:migrate -- --apply-skipped\n`);
      process.exitCode = 1;
    } else {
      for (const entry of skipped) {
        const query = await readFile(path.join(root, "migrations", `${entry.tag}.sql`), "utf8");
        const hash = createHash("sha256").update(query).digest("hex");
        await sql.begin(async (transaction) => {
          for (const statement of query.split("--> statement-breakpoint")) if (statement.trim()) await transaction.unsafe(statement);
          await transaction`insert into drizzle.__drizzle_migrations (hash, created_at) values (${hash}, ${entry.when})`;
        });
        process.stdout.write(`Applied skipped migration ${entry.tag}\n`);
      }
    }
  }
} finally {
  await sql.end();
}
if (!process.exitCode) {
  const child = spawn("drizzle-kit", ["migrate", "--config", "drizzle.config.ts"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  child.once("exit", (code) => { process.exitCode = code ?? 1; });
}
