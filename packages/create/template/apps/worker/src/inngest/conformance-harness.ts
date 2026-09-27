import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";

import { PostgresOutboxStore } from "@__TRESTLE_PROJECT_NAME__/db";
import { dispatchOutbox } from "@__TRESTLE_PROJECT_NAME__/events";
import { Hono } from "hono";
import { Inngest, NonRetriableError } from "inngest";
import { serve } from "inngest/hono";

import { conformanceRegistry, conformanceSequences } from "../job-conformance.js";
import type { ConformanceHarness } from "../job-conformance-suite.js";
import { cancelInngestSequence, inngestEventName, sendCommittedEventToInngest, sendSequenceToInngest } from "../job-runtime-inngest.js";
import { executeCommittedEventById } from "../job-runtime.js";
import type { SequenceEngine } from "../sequence-runtime.js";
import { createInngestSequenceFunction } from "./functions.js";

/**
 * The conformance suite against the real Inngest engine (the Dev Server,
 * downloaded by npx): the harness serves the conformance function from a Node
 * HTTP server it controls, so restarts stop and start the executor Inngest
 * calls, and a deploy swaps the served code while runs are in flight.
 */
const devPort = 18_288;
/** Set to run against an existing self-hosted Inngest server instead of the Dev Server. */
const selfHosted = process.env.TRESTLE_INNGEST_URL ? { url: process.env.TRESTLE_INNGEST_URL.replace(/\/$/u, ""), signingKey: process.env.TRESTLE_INNGEST_SIGNING_KEY!, eventKey: process.env.TRESTLE_INNGEST_EVENT_KEY!, serveOrigin: process.env.TRESTLE_INNGEST_SERVE_ORIGIN ?? `http://127.0.0.1:${13_939}` } : undefined;
const inngestUrl = selfHosted?.url ?? `http://127.0.0.1:${devPort}`;
const appPort = 13_939;
const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } } as never;
const finished = new Set(["Completed", "Failed", "Cancelled"]);

function listen(app: Hono): Promise<Server> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const init: RequestInit = { method: request.method ?? "GET", headers: request.headers as HeadersInit };
    if (body && request.method !== "GET") init.body = body;
    const result = await app.fetch(new Request(`http://127.0.0.1:${appPort}${request.url}`, init));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  });
  return new Promise((resolve) => server.listen(appPort, process.env.TRESTLE_INNGEST_LISTEN_HOST ?? "127.0.0.1", () => resolve(server)));
}

export async function inngestHarness(connectionString: string): Promise<ConformanceHarness> {
  let version = "v1";
  const inngest = selfHosted
    ? new Inngest({ id: "trestle-conformance", baseUrl: selfHosted.url, signingKey: selfHosted.signingKey, eventKey: selfHosted.eventKey })
    : new Inngest({ id: "trestle-conformance", isDev: true, baseUrl: inngestUrl });
  const environment = selfHosted ? { INNGEST_EVENT_KEY: selfHosted.eventKey, INNGEST_BASE_URL: selfHosted.url } : { INNGEST_DEV: "1", INNGEST_BASE_URL: inngestUrl };
  // Sequence runs start and cancel through the Worker's own sends; the harness keeps Inngest's event IDs to watch their runs.
  const sequenceEvents: string[] = [];
  const engine: SequenceEngine<unknown> = {
    name: "inngest",
    start: async (_environment, run) => {
      const ids = await sendSequenceToInngest({ environment, ...run });
      sequenceEvents.push(...ids);
      return { engineRunId: ids[0] ?? null };
    },
    cancel: async (_environment, run) => { await cancelInngestSequence({ environment, runId: run.runId }); },
  };
  const probe = inngest.createFunction(
    { id: "trestle-conformance-event", retries: 5, triggers: [{ event: inngestEventName }] },
    async ({ event, step, runId }) => {
      await step.run("consume-event-v1", async () => {
        await executeCommittedEventById({ eventId: String(event.data.eventId), connectionString, registry: conformanceRegistry(connectionString, version, engine), environment: {}, runId, runtime: "inngest", log: quiet, permanent: (message) => new NonRetriableError(message), assumeApplicationRole: false });
      });
    },
  );
  const sequence = createInngestSequenceFunction(inngest, "trestle-conformance-sequence", conformanceSequences(connectionString, engine), {});
  const app = new Hono();
  app.on(["GET", "POST", "PUT"], "/api/jobs/inngest", serve({ client: inngest, functions: [probe, sequence], ...(selfHosted ? { serveOrigin: selfHosted.serveOrigin } : {}) }));
  let server = await listen(app);
  let dev: ChildProcess | undefined;
  if (selfHosted) {
    // A self-hosted server learns about the app when the app registers itself.
    const synced = await fetch(`http://127.0.0.1:${appPort}/api/jobs/inngest`, { method: "PUT" });
    if (!synced.ok) throw new Error(`registering with the self-hosted Inngest server failed (HTTP ${synced.status})`);
  } else {
    dev = spawn("npx", ["--yes", "inngest-cli@1.45.1", "dev", "--port", String(devPort), "-u", `http://127.0.0.1:${appPort}/api/jobs/inngest`, "--no-discovery", "--no-poll"], { stdio: "ignore", detached: true });
    for (let waited = 0; ; waited += 1_000) {
      const registered = await fetch(`http://127.0.0.1:${devPort}/dev`).then((response) => response.ok ? response.json() as Promise<{ functions?: unknown[] }> : undefined).catch(() => undefined);
      if ((registered?.functions?.length ?? 0) >= 2) break;
      if (waited > 180_000) throw new Error("the Inngest Dev Server did not register the conformance function");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  const events = new Map<string, string[]>();
  // A run between retries is reported "Failed" with no ended_at; only ended_at marks a finished run.
  const runsFor = async (id: string) => ((await (await fetch(`${inngestUrl}/v1/events/${id}/runs`, selfHosted ? { headers: { authorization: `Bearer ${selfHosted.signingKey}` } } : {})).json()) as { data: Array<{ status: string; run_started_at: string; ended_at: string | null }> }).data;
  const latest = async (eventId: string) => (await Promise.all((events.get(eventId) ?? []).map(runsFor))).flat().sort((left, right) => right.run_started_at.localeCompare(left.run_started_at))[0];
  const publisher: ConformanceHarness["publisher"] = {
    send: async (envelope, delivery) => {
      // The Worker's own send, to the Dev Server.
      const ids = await sendCommittedEventToInngest({ environment, eventId: envelope.id, generation: delivery?.generation ?? 0 });
      events.set(envelope.id, [...(events.get(envelope.id) ?? []), ...ids]);
    },
  };
  const settledRuns = async () => {
    for (let waited = 0; waited < 240_000; waited += 2_000) {
      const runs = await Promise.all([...events.keys()].map(latest));
      if (runs.every((run) => run && run.ended_at && finished.has(run.status))) return;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error("Inngest runs did not settle");
  };
  return {
    runtime: "inngest",
    publisher,
    async settle() {
      await settledRuns();
      const store = new PostgresOutboxStore(connectionString);
      try {
        for (let round = 0; round < 3 && (await store.settleUnconsumed({ olderThanMs: 0 })).length > 0; round++) {
          await dispatchOutbox(store, publisher);
          await settledRuns();
        }
      } finally { await store.close(); }
    },
    async settleSequences() {
      for (let waited = 0; waited < 240_000; waited += 1_000) {
        const runs = (await Promise.all(sequenceEvents.map(runsFor))).map((found) => found.sort((left, right) => right.run_started_at.localeCompare(left.run_started_at))[0]);
        if (runs.every((run) => run && run.ended_at && finished.has(run.status))) return;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      throw new Error("Inngest sequence runs did not settle");
    },
    async failed() {
      const failed: string[] = [];
      for (const eventId of events.keys()) { const run = await latest(eventId); if (run?.ended_at && run.status === "Failed") failed.push(eventId); }
      return failed;
    },
    async deploy(next) { version = next; },
    async restart() {
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      server = await listen(app);
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      if (dev) { try { process.kill(-dev.pid!, "SIGTERM"); } catch { /* already stopped */ } }
    },
  };
}
