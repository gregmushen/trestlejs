import { PostgresOutboxStore } from "../src/outbox.js";

const [operation, argument, limitArgument] = process.argv.slice(2);
// `trestle queue prune` passes the migration role here: it owns the SECURITY DEFINER
// retention functions (migration 0033), which nothing else may execute.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
if (!operation || !["list", "redrive", "retention-count", "retention-prune"].includes(operation)) throw new Error("expected list, redrive, retention-count, or retention-prune");
const store = new PostgresOutboxStore(connectionString);
try {
  if (operation === "list") {
    const entries = await store.listDead();
    process.stdout.write(`${JSON.stringify(entries.map(({ id: entryId, message, status, attempts, availableAt, lastError }) => ({ id: entryId, event: `${message.name}@${message.schemaVersion}`, resource: message.resource, status, attempts, availableAt: availableAt.toISOString(), lastError: lastError ?? null })))}\n`);
  } else if (operation === "redrive") {
    if (!argument) throw new Error("redrive requires an outbox entry ID");
    const entry = await store.redrive(argument);
    process.stdout.write(`${JSON.stringify({ id: entry.id, event: `${entry.message.name}@${entry.message.schemaVersion}`, status: entry.status })}\n`);
  } else {
    if (!argument || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(argument)) throw new Error("retention cutoff must be an ISO UTC timestamp");
    const cutoff = new Date(argument);
    if (!Number.isFinite(cutoff.getTime())) throw new Error("retention cutoff is invalid");
    const limit = limitArgument === undefined ? 1_000 : Number(limitArgument);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error("retention limit must be between 1 and 10000");
    const count = operation === "retention-count" ? await store.countPrunableSucceeded(cutoff) : await store.pruneSucceeded(cutoff, limit);
    const oldest = await store.oldestRetainedSucceeded();
    process.stdout.write(`${JSON.stringify({ before: cutoff.toISOString(), count, ...(operation === "retention-prune" ? { limit } : {}), oldestRetainedAt: oldest?.toISOString() ?? null })}\n`);
  }
} finally { await store.close(); }
