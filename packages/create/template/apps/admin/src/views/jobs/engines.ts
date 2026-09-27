/** Engine names and the "choosing an engine" comparison, as the jobs admin specification states them. */
export const engineLabels: Readonly<Record<string, string>> = { cloudflare: "Cloudflare", trigger: "trigger.dev", inngest: "Inngest" };
export const engineLabel = (runtime: string): string => engineLabels[runtime] ?? runtime;
export const hostingLabels: Readonly<Record<string, string>> = { cloudflare: "Cloudflare", cloud: "Vendor cloud", "self-hosted": "Self-hosted" };

export type EngineComparisonRow = Readonly<{ aspect: string; cloudflare: string; trigger: string; inngest: string }>;

export const engineComparison: readonly EngineComparisonRow[] = [
  { aspect: "Where job code runs", cloudflare: "Your Worker, Workflows", trigger: "trigger.dev machines (Node), or yours if self-hosted", inngest: "Your Worker; Inngest calls a signed endpoint" },
  { aspect: "Hosting", cloudflare: "Cloudflare", trigger: "trigger.dev cloud or self-hosted (Docker/K8s)", inngest: "Inngest cloud or self-hosted (Cloudflare Container + Neon)" },
  { aspect: "Best for", cloudflare: "No extra vendor, lowest cost, light and frequent work", trigger: "Long or heavy jobs, Node libraries, Python scripts, many sequences", inngest: "Step functions and sequences while keeping Worker bindings (R2, Queues, Durable Objects)" },
  { aspect: "Visibility", cloudflare: "Outbox and Workflow views in admin", trigger: "trigger.dev dashboard", inngest: "Inngest dashboard" },
  { aspect: "Trade-offs", cloudflare: "Worker CPU and time limits; basic tooling", trigger: "Separate trestle_jobs database login; secrets synced to the engine; Cloudflare bindings only through a signed internal route", inngest: "Another vendor; a signed endpoint on your Worker" },
];

/** Frequent schedules alone are not a reason to leave Cloudflare: due work runs on the scheduler's alarm, not a per-minute cron. */
export const frequentScheduleNote = "A job checked every minute uses no cron triggers on Cloudflare, and an idle project makes no database queries: due work runs on the scheduler's alarm. Each run still costs Worker time, which is where heavy per-minute work favors another engine.";
