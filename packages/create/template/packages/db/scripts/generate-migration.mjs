import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const journalPath = path.join(directory, "migrations", "meta", "_journal.json");
const before = JSON.parse(await readFile(journalPath, "utf8"));
const result = spawnSync("pnpm", ["exec", "drizzle-kit", "generate", "--config", "drizzle.config.ts"], { cwd: directory, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const after = JSON.parse(await readFile(journalPath, "utf8"));
if (JSON.stringify(after.entries.slice(0, before.entries.length)) !== JSON.stringify(before.entries)) {
  throw new Error("Drizzle modified existing migration journal entries");
}
if (after.entries.length > before.entries.length) {
  let previous = before.entries.at(-1)?.when ?? 0;
  if (!Number.isSafeInteger(previous)) throw new Error("Invalid migration journal timestamp");
  for (const entry of after.entries.slice(before.entries.length)) {
    entry.when = Math.max(Date.now(), previous + 1);
    previous = entry.when;
  }
  await writeFile(journalPath, `${JSON.stringify(after, null, 2)}\n`, "utf8");
}
