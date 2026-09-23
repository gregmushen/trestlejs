// Minimal build-time surface. `wrangler types` can replace this with full
// Cloudflare runtime declarations when an application adds more Workflow APIs.
declare module "cloudflare:workers" {
  export type WorkflowEvent<T> = { payload: Readonly<T>; timestamp: Date; instanceId: string; workflowName: string };
  export type WorkflowStep = {
    do<T>(name: string, config: { retries: { limit: number; delay: string; backoff: "constant" | "linear" | "exponential" }; timeout: string }, callback: () => Promise<T>): Promise<T>;
  };
  export abstract class WorkflowEntrypoint<Environment, Params = unknown> {
    protected readonly env: Environment;
    abstract run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<unknown>;
  }
}
