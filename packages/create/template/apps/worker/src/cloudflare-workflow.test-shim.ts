/** Vitest-only runtime shape; Wrangler bundles the real cloudflare:workers module. */
export class WorkflowEntrypoint<Environment> {
  protected readonly env!: Environment;
}
