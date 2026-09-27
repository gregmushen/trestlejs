import type { EventEnvelope } from "@__TRESTLE_PROJECT_NAME__/events";
import { NonRetryableError } from "cloudflare:workflows";

import { conformanceRegistry, conformanceSequences, executeConformanceEvent } from "./job-conformance.js";
import type { ConformanceHarness } from "./job-conformance-suite.js";
import { sequenceWorkflowId } from "./sequence-engines.js";
import { driveSequenceRun, type SequenceEngine, type SequenceRunHandle } from "./sequence-runtime.js";

class Terminated extends Error {}

/**
 * The Cloudflare runtime, in process: Queue delivery creates one Workflow
 * instance per stable event ID (a repeated create finds the existing
 * instance), and each instance retries its step until it completes or throws
 * NonRetryableError, as `TrestleWorkflow` does. A sequence run is one
 * instance per run ID executing `runSequenceWorkflow`'s loop: `step.do`
 * retries a step, `step.sleepUntil` sleeps, and terminate stops the instance.
 */
export function cloudflareHarness(connectionString: string): ConformanceHarness {
  const instances = new Map<string, { envelope: EventEnvelope; state: "running" | "complete" | "errored" }>();
  const sequences = new Map<string, { terminated: boolean; state: "running" | "complete" | "errored" | "terminated"; done: Promise<void> }>();
  let version = "v1";
  const engine: SequenceEngine<unknown> = {
    name: "cloudflare",
    start: async (_environment, run) => {
      const id = sequenceWorkflowId(run.runId);
      if (!sequences.has(id)) {
        const instance = { terminated: false, state: "running" as "running" | "complete" | "errored" | "terminated", done: Promise.resolve() };
        sequences.set(id, instance);
        instance.done = runSequenceInstance(run, instance).then(() => { instance.state = "complete"; }, (error: unknown) => { instance.state = error instanceof Terminated ? "terminated" : "errored"; });
      }
      return { engineRunId: id };
    },
    cancel: async (_environment, run) => { const instance = sequences.get(run.engineRunId ?? sequenceWorkflowId(run.runId)); if (instance) instance.terminated = true; },
  };
  async function runSequenceInstance(run: SequenceRunHandle, instance: { terminated: boolean }): Promise<void> {
    await driveSequenceRun({
      registry: conformanceSequences(connectionString, engine), environment: {}, run,
      step: async (_name, execute) => {
        for (let attempt = 0; ; attempt++) {
          if (instance.terminated) throw new Terminated();
          try { return await execute(); }
          catch (error) {
            if (error instanceof NonRetryableError || attempt >= 5) throw error;
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        }
      },
      sleepUntil: async (_name, at) => {
        while (Date.now() < at.getTime()) {
          if (instance.terminated) throw new Terminated();
          await new Promise((resolve) => setTimeout(resolve, Math.min(100, at.getTime() - Date.now())));
        }
      },
      permanent: (message) => new NonRetryableError(message),
    });
  }
  return {
    runtime: "cloudflare",
    publisher: { send: async (envelope) => { if (!instances.has(envelope.id)) instances.set(envelope.id, { envelope, state: "running" }); } },
    async settle() {
      for (const [id, instance] of instances) {
        for (let attempt = 0; instance.state === "running" && attempt < 6; attempt++) {
          try {
            await executeConformanceEvent({ connectionString, envelope: instance.envelope, runId: id, runtime: "cloudflare", registry: conformanceRegistry(connectionString, version, engine), permanent: (message) => new NonRetryableError(message) });
            instance.state = "complete";
          } catch (error) {
            if (error instanceof NonRetryableError) instance.state = "errored";
          }
        }
      }
    },
    async settleSequences() {
      for (let settled = 0; settled < sequences.size;) {
        settled = sequences.size;
        await Promise.all([...sequences.values()].map((instance) => instance.done));
      }
    },
    failed: async () => [...instances].filter(([, instance]) => instance.state === "errored").map(([id]) => id),
    deploy: async (next) => { version = next; },
    restart: async () => {},
    close: async () => {},
  };
}
