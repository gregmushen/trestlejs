/** Mirrors EVENT_PROVENANCE_RETENTION_DAYS in the generated `packages/events`; the store enforces it again. */
export const OUTBOX_PROVENANCE_RETENTION_DAYS = 30;
const day = 86_400_000;

export type OutboxRetentionSummary = { count: number; oldestRetainedAt: string | null };

/** Refuse, before touching secrets or the database, a cutoff that would prune provenance supported replays can still need. */
export function assertOutboxRetentionCutoff(before: string, now: Date = new Date()): void {
  const latest = new Date(now.getTime() - OUTBOX_PROVENANCE_RETENTION_DAYS * day);
  if (new Date(before).getTime() > latest.getTime()) {
    throw new Error(`--before is inside the ${OUTBOX_PROVENANCE_RETENTION_DAYS}-day provenance window; use a cutoff at or before ${latest.toISOString()}`);
  }
}

export function formatOutboxRetentionSummary(
  options: { environment: string; before: string; limit: number; apply: boolean; now?: Date },
  summary: OutboxRetentionSummary,
): string {
  const now = options.now ?? new Date();
  const action = `${options.apply ? "Pruned" : "Eligible"} ${summary.count} succeeded outbox record(s) in ${options.environment} before ${options.before}${options.apply ? ` (limit ${options.limit})` : " (dry run)"}`;
  const oldest = summary.oldestRetainedAt
    ? `${summary.oldestRetainedAt} (${((now.getTime() - new Date(summary.oldestRetainedAt).getTime()) / day).toFixed(1)} days old)`
    : "none";
  return `${action}\nOldest retained succeeded record: ${oldest}\n`;
}
