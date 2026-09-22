import { CloudflareQueuePublisher, dispatchOutbox, EventRegistry, processQueueBatch, type CloudflareQueueBinding, type EventDefinition, type EventEnvelope, type OutboxStore, type QueueBatchMessage } from "@__TRESTLE_PROJECT_NAME__/events";

export type QueueBatch = { messages: QueueBatchMessage[] };
export type EventHandler<T = unknown, Environment = unknown> = (payload: T, envelope: EventEnvelope, environment: Environment) => Promise<void>;

export class EventConsumerRegistry<Environment = unknown> {
  private readonly definitions = new EventRegistry();
  private readonly handlers = new Map<string, EventHandler<unknown, Environment>>();

  register<T>(definition: EventDefinition<T>, handler: EventHandler<T, Environment>): void {
    const key = `${definition.name}@${definition.schemaVersion}`;
    if (this.handlers.has(key)) throw new Error(`Event consumer ${key} is already registered`);
    this.definitions.register(definition);
    this.handlers.set(key, handler as EventHandler<unknown, Environment>);
  }

  async handle(envelope: EventEnvelope, environment: Environment): Promise<void> {
    const key = `${envelope.name}@${envelope.schemaVersion}`;
    const handler = this.handlers.get(key);
    if (!handler) throw new Error(`No event consumer registered for ${key}`);
    await handler(this.definitions.parse(envelope), envelope, environment);
  }
}

export function createQueueConsumer<Environment>(registry: EventConsumerRegistry<Environment>) {
  return async (batch: QueueBatch, environment: Environment): Promise<{ acknowledged: number; retried: number }> =>
    await processQueueBatch(batch.messages, async (envelope) => await registry.handle(envelope, environment));
}

export async function dispatchQueuedOutbox(store: OutboxStore, binding: CloudflareQueueBinding): Promise<{ sent: number; failed: number }> {
  return await dispatchOutbox(store, new CloudflareQueuePublisher(binding));
}
