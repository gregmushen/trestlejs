/** Vitest-only runtime shape; Wrangler bundles the real cloudflare:workers and cloudflare:workflows modules. */
export class WorkflowEntrypoint<Environment> {
  protected readonly env!: Environment;
}

/** Mirrors Cloudflare's error that ends a Workflow step without further retries. */
export class NonRetryableError extends Error {
  constructor(message: string, name = "NonRetryableError") { super(message); this.name = name; }
}

/** Vitest-only Durable Object base: the runtime supplies ctx (with storage and alarms) and env. */
export class DurableObject<Environment> {
  constructor(protected readonly ctx: unknown, protected readonly env: Environment) {}
}
