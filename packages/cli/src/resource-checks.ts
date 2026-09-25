import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** All journaled SQL for a database package, or "" when the package has no migrations. */
export async function readMigrationSql(root: string, dbPath: string): Promise<string> {
  const directory = path.join(root, dbPath, "migrations");
  const files = (await readdir(directory).catch(() => [])).filter((file) => file.endsWith(".sql")).sort();
  return (await Promise.all(files.map((file) => readFile(path.join(directory, file), "utf8")))).join("\n");
}

export function hasForcedRlsMigration(sql: string, table: string): boolean {
  return sql.includes(`CREATE TABLE "${table}"`) && new RegExp(`ALTER TABLE ["']?${table}["']? FORCE ROW LEVEL SECURITY`, "u").test(sql);
}

export async function missingFiles(root: string, files: readonly string[]): Promise<string[]> {
  return (await Promise.all(files.map((file) => access(path.join(root, file)).then(() => undefined, () => file)))).filter((file): file is string => file !== undefined);
}
