/** Vitest-only runtime shape; Wrangler bundles the real cloudflare:workers and cloudflare:workflows modules. */
export class WorkflowEntrypoint<Environment> {
  protected readonly env!: Environment;
}

/** Mirrors Cloudflare's error that ends a Workflow step without further retries. */
export class NonRetryableError extends Error {
  constructor(message: string, name = "NonRetryableError") { super(message); this.name = name; }
}
