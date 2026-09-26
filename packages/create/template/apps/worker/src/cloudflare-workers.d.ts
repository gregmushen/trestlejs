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
  /** The Durable Object storage surface the scheduler uses. */
  export type DurableObjectStorage = {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
    list<T>(options: { prefix: string }): Promise<Map<string, T>>;
    getAlarm(): Promise<number | null>;
    setAlarm(scheduledTime: number | Date): Promise<void>;
    deleteAlarm(): Promise<void>;
  };
  export type DurableObjectState = { readonly id: unknown; readonly storage: DurableObjectStorage };
  export abstract class DurableObject<Environment = unknown> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: Environment;
    constructor(ctx: DurableObjectState, env: Environment);
  }
}

declare module "cloudflare:workflows" {
  /** Thrown from a step to end the Workflow instance in an errored state without further retries. */
  export class NonRetryableError extends Error {
    constructor(message: string, name?: string);
  }
}
