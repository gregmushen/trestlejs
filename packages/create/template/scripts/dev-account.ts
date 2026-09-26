import { DevAccountError, ensureDevAccount } from "../packages/auth/src/dev-account.js";

/** Runs `trestle dev-account`. Input arrives as JSON in TRESTLE_DEV_ACCOUNT; the password only on standard input. */
const input = JSON.parse(process.env.TRESTLE_DEV_ACCOUNT ?? "{}") as Parameters<typeof ensureDevAccount>[1] & { passwordStdin?: boolean };
let password: string | undefined;
if (input.passwordStdin) {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  password = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/u, "");
  if (!password) throw new DevAccountError("standard input contained no password");
}
const connectionString = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!connectionString) throw new DevAccountError("DATABASE_URL is required");
try {
  const result = await ensureDevAccount(connectionString, { ...input, ...(password ? { password } : {}) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
