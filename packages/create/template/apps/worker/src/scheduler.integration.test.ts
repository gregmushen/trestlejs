import { createServer, connect, type Server, type Socket } from "node:net";

import { PostgresBillingProjectionRepository } from "@__TRESTLE_PROJECT_NAME__/billing";
import { createDatabase, outboxMessage, PostgresOutboxStore, webhookAttempt, webhookDelivery, webhookMessage } from "@__TRESTLE_PROJECT_NAME__/db";
import type { EventEnvelope } from "@__TRESTLE_PROJECT_NAME__/events";
import { listCapturedEmails } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { app } from "./index.js";
import { scheduledJobs } from "./jobs.js";
import { TrestleScheduler } from "./scheduler-object.js";
import { projectWebhookForEvent } from "./webhook-runtime.js";
import type { WorkerEnvironment } from "./worker-environment.js";

/**
 * The scale-to-zero canary. PostgreSQL sits behind a TCP proxy that counts
 * every connection and byte the Worker sends, and the real TrestleScheduler
 * class runs on in-memory Durable Object storage whose alarm is a real timer,
 * the way the runtime fires it. Run on its own: it drains any pending outbox
 * rows in the database it is given.
 */
const databaseUrl = process.env.TRESTLE_SYSTEM_TEST_DATABASE_URL;
const articles = process.env.TRESTLE_SYSTEM_TEST_ARTICLES === "1";
const suite = databaseUrl && articles ? describe : describe.skip;
const idleSampleMs = Number(process.env.TRESTLE_IDLE_SAMPLE_MS ?? 5_000);

async function countingProxy(target: string): Promise<{ url: string; connections: number; bytes: number; reset(): void; close(): Promise<void> }> {
  const upstream = new URL(target);
  const sockets = new Set<Socket>();
  const state = { connections: 0, bytes: 0 };
  const server: Server = createServer((client) => {
    state.connections++;
    const database = connect(Number(upstream.port || 5432), upstream.hostname);
    sockets.add(client); sockets.add(database);
    client.on("data", (chunk) => { state.bytes += chunk.length; });
    client.pipe(database); database.pipe(client);
    const end = () => { client.destroy(); database.destroy(); sockets.delete(client); sockets.delete(database); };
    client.on("error", end); database.on("error", end); client.on("close", end); database.on("close", end);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Proxy did not bind");
  const url = new URL(target);
  url.hostname = "127.0.0.1";
  url.port = String(address.port);
  return {
    url: url.toString(),
    get connections() { return state.connections; },
    get bytes() { return state.bytes; },
    reset: () => { state.connections = 0; state.bytes = 0; },
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

/** Durable Object storage plus a single alarm that fires on a real timer, one invocation at a time. */
function memoryDurableObject() {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  const fired: number[] = [];
  let object: TrestleScheduler | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = undefined;
    if (alarm !== null) timer = setTimeout(() => { void fire(); }, Math.max(0, alarm - Date.now()));
  };
  const fire = async (): Promise<void> => {
    if (running) { await running; return await fire(); }
    if (alarm === null || alarm > Date.now()) return arm();
    alarm = null;
    fired.push(Date.now());
    running = object!.alarm().catch(() => { /* the runtime retries a failed alarm */ }).finally(() => { running = undefined; });
    await running;
  };
  const storage = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => { values.set(key, value); },
    delete: async (key: string) => values.delete(key),
    list: async <T>(options: { prefix: string }) => new Map([...values].filter(([key]) => key.startsWith(options.prefix))) as Map<string, T>,
    getAlarm: async () => alarm,
    setAlarm: async (time: number | Date) => { alarm = typeof time === "number" ? time : time.getTime(); arm(); },
    deleteAlarm: async () => { alarm = null; arm(); },
  };
  return {
    fired,
    bind(environment: WorkerEnvironment) { object = new TrestleScheduler({ id: "trestle-scheduler", storage }, environment); },
    binding: { idFromName: (name: string) => name, get: () => ({
      schedule: async (items: Array<{ key: string; dueAt: string }>) => { await object!.schedule(items); },
      pending: async () => await object!.pending(),
    }) },
    idle: () => alarm === null && timer === undefined && running === undefined,
    async settle(timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (!(alarm === null && running === undefined)) {
        if (Date.now() > deadline) throw new Error("The scheduler did not become idle");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    stop() { clearTimeout(timer); alarm = null; },
  };
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting for scheduled work");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

suite("scale to zero with the due-time scheduler", () => {
  const unique = crypto.randomUUID();
  const origin = "http://localhost:42069";
  const published: Array<{ body: EventEnvelope; at: number }> = [];
  const pending: Promise<unknown>[] = [];
  const executionContext = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); }, passThroughOnException: () => {}, props: {} };
  const scheduler = memoryDurableObject();
  let proxy: Awaited<ReturnType<typeof countingProxy>>;
  let environment: WorkerEnvironment;
  let admin: ReturnType<typeof createDatabase>;
  let headers: Record<string, string>;
  let organizationId: string;

  const request = async (path: string, init?: RequestInit) => {
    const response = await app.request(`http://localhost:8787${path}`, init, environment, executionContext);
    await Promise.all(pending.splice(0));
    return response;
  };

  beforeAll(async () => {
    proxy = await countingProxy(databaseUrl!);
    admin = createDatabase(databaseUrl!, "postgres-js");
    environment = {
      DATABASE_URL: proxy.url,
      DATABASE_DRIVER: "postgres-js",
      BETTER_AUTH_SECRET: "scheduler-test-secret-with-at-least-thirty-two-characters",
      BETTER_AUTH_URL: "http://localhost:8787",
      WEB_ORIGIN: origin,
      APP_ENV: "local",
      EMAIL_DELIVERY_MODE: "local",
      STRIPE_MODE: "local",
      WEBHOOK_DELIVERY_MODE: "local",
      WEBHOOK_SECRET_KEY: "scheduler-test-webhook-key-with-at-least-32-bytes",
      TRESTLE_EVENTS: { send: async (body: unknown) => { published.push({ body: body as EventEnvelope, at: Date.now() }); } },
      TRESTLE_SCHEDULER: scheduler.binding,
    } as WorkerEnvironment;
    scheduler.bind(environment);
    const email = `scheduler-${unique}@example.test`;
    const json = { "content-type": "application/json", origin };
    expect((await request("/api/auth/sign-up/email", { method: "POST", headers: json, body: JSON.stringify({ name: "Scheduler Canary", email, password: "scheduler-canary-password-123" }) })).status).toBe(200);
    const link = listCapturedEmails().find((message) => message.to.includes(email))?.text.match(/https?:\/\/\S+/u)?.[0];
    expect([200, 302]).toContain((await app.request(link!, { method: "GET" }, environment)).status);
    const signIn = await request("/api/auth/sign-in/email", { method: "POST", headers: json, body: JSON.stringify({ email, password: "scheduler-canary-password-123" }) });
    const cookie = signIn.headers.get("set-cookie")!.split(";")[0]!;
    const created = await request("/api/auth/organization/create", { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ name: "Scheduler Canary", slug: `scheduler-${unique}` }) });
    organizationId = (await created.json() as { id: string }).id;
    await new PostgresBillingProjectionRepository(databaseUrl!, "postgres-js").put({ organizationId, provider: "local", plan: "starter", planVersion: 1, status: "active", cancelAtPeriodEnd: false, entitlements: ["article.basic"] });
    headers = { ...json, cookie, "x-trestle-tenant": organizationId };
    const endpoint = await request("/api/developer/webhooks/endpoints", { method: "POST", headers, body: JSON.stringify({ name: "Scheduler canary receiver", destinationUrl: "https://example.com/hooks", subscriptions: [{ type: "resource.article.created", version: 1 }] }) });
    expect(endpoint.status).toBe(201);
    const endpointId = (await endpoint.json() as { endpoint: { id: string } }).endpoint.id;
    expect((await request(`/api/developer/webhooks/endpoints/${endpointId}/state`, { method: "PATCH", headers, body: JSON.stringify({ state: "active" }) })).status).toBe(200);
    // Anything the setup made due (including rows other suites left pending) drains first.
    await scheduler.settle(15_000);
  }, 60_000);

  afterAll(async () => {
    scheduler.stop();
    await proxy?.close();
    await admin?.$client.end();
  });

  it("dispatches a created event on commit, without waiting for a cron", async () => {
    const before = published.length;
    const created = await request("/api/articles", { method: "POST", headers, body: JSON.stringify({ name: "Scheduler Article", summary: "Due now", published: false }) });
    expect(created.status).toBe(201);
    const committedAt = Date.now();
    const { article } = await created.json() as { article: { id: string } };
    const [row] = await admin.select().from(outboxMessage).where(and(eq(outboxMessage.resourceId, article.id), eq(outboxMessage.eventName, "resource.article.created")));
    const dispatched = await waitFor(async () => published.slice(before).find((item) => item.body.id === row!.id), 3_000);
    expect(dispatched.at - committedAt).toBeLessThan(2_000);
    const [after] = await admin.select({ status: outboxMessage.status }).from(outboxMessage).where(eq(outboxMessage.id, row!.id));
    expect(after?.status).toBe("succeeded");
    await scheduler.settle();
    expect(scheduler.idle()).toBe(true);
  }, 20_000);

  it("fires a scheduled webhook retry at its due time", async () => {
    const created = await request("/api/articles", { method: "POST", headers, body: JSON.stringify({ name: "Retry Article", summary: "Retry", published: false }) });
    const { article } = await created.json() as { article: { id: string } };
    const event = await waitFor(async () => published.find((item) => item.body.resource.id === article.id)?.body, 3_000);
    await scheduler.settle();
    // The first local attempt fails with a retryable status; its retry is recorded with the scheduler.
    const store = new PostgresOutboxStore(databaseUrl!, { assumeApplicationRole: true });
    try {
      await projectWebhookForEvent({ envelope: event, environment, outbox: store, localScenario: { kind: "fail-times", count: 1, status: 503 }, scheduler: environment.TRESTLE_SCHEDULER! });
    } finally { await store.close(); }
    const [message] = await admin.select().from(webhookMessage).where(eq(webhookMessage.sourceEventId, event.id));
    const [delivery] = await admin.select().from(webhookDelivery).where(eq(webhookDelivery.messageId, message!.id));
    expect(delivery).toMatchObject({ state: "retry", attemptCount: 1 });
    const dueAt = delivery!.nextAttemptAt!.getTime();
    expect((await (await request("/api/dev/scheduler")).json() as { work: Array<{ key: string; dueAt: string }> }).work)
      .toContainEqual({ key: `framework:webhooks:${organizationId}`, dueAt: new Date(dueAt).toISOString() });
    const retried = await waitFor(async () => {
      const [attempt] = await admin.select().from(webhookAttempt).where(and(eq(webhookAttempt.deliveryId, delivery!.id), eq(webhookAttempt.attemptNumber, 2)));
      return attempt;
    }, 5_000);
    expect(retried.outcome).toBe("succeeded");
    expect(retried.attemptedAt.getTime()).toBeGreaterThanOrEqual(dueAt);
    expect(retried.attemptedAt.getTime() - dueAt).toBeLessThan(1_500);
    await scheduler.settle();
    expect(scheduler.idle()).toBe(true);
  }, 20_000);

  it("runs a registered application job when due, once, then sleeps", async () => {
    let dueAt: Date | null = new Date(Date.now() + 400);
    const runs: string[] = [];
    scheduledJobs.register("canary.reminders", {
      next: () => dueAt,
      run: async (job) => { runs.push(job.dueAt.toISOString()); dueAt = null; },
    });
    expect(await scheduledJobs.notify(environment, "canary.reminders", dueAt!)).toBe(true);
    const slot = dueAt!.toISOString();
    await waitFor(async () => runs.length > 0 ? true : undefined, 3_000);
    await scheduler.settle();
    expect(runs).toEqual([slot]);
    // A repeated or overlapping trigger for the same slot is a no-op under the PostgreSQL lease.
    const [first, second] = await Promise.all([scheduledJobs.run("canary.reminders", new Date(slot), environment), scheduledJobs.run("canary.reminders", new Date(slot), environment)]);
    expect([first.outcome, second.outcome].sort()).toEqual(["completed", "completed"]);
    expect(runs).toEqual([slot]);
    expect(scheduler.idle()).toBe(true);
  }, 20_000);

  it("makes zero database queries over a sampled idle window", async () => {
    await scheduler.settle();
    const firedBefore = scheduler.fired.length;
    proxy.reset();
    const sampleEnd = Date.now() + idleSampleMs;
    // Health and the scheduler's own state answer without the database.
    expect((await request("/api/health")).status).toBe(200);
    expect(await (await request("/api/dev/scheduler")).json()).toEqual({ configured: true, alarmAt: null, work: [] });
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, sampleEnd - Date.now())));
    expect({ connections: proxy.connections, bytes: proxy.bytes, alarms: scheduler.fired.length - firedBefore, idle: scheduler.idle() })
      .toEqual({ connections: 0, bytes: 0, alarms: 0, idle: true });
  }, idleSampleMs + 10_000);
});
