import type { EventEnvelope } from "@__TRESTLE_PROJECT_NAME__/events";
import { NonRetryableError } from "cloudflare:workflows";

import { conformanceRegistry, executeConformanceEvent, runtimeConformanceSuite, type ConformanceHarness } from "./job-conformance.js";

/**
 * The Cloudflare runtime, in process: Queue delivery creates one Workflow
 * instance per stable event ID (a repeated create finds the existing
 * instance), and each instance retries its step until it completes or throws
 * NonRetryableError, as `TrestleWorkflow` does.
 */
function cloudflareHarness(connectionString: string): ConformanceHarness {
  const instances = new Map<string, { envelope: EventEnvelope; state: "running" | "complete" | "errored" }>();
  let version = "v1";
  return {
    runtime: "cloudflare",
    publisher: { send: async (envelope) => { if (!instances.has(envelope.id)) instances.set(envelope.id, { envelope, state: "running" }); } },
    async settle() {
      for (const [id, instance] of instances) {
        for (let attempt = 0; instance.state === "running" && attempt < 6; attempt++) {
          try {
            await executeConformanceEvent({ connectionString, envelope: instance.envelope, runId: id, runtime: "cloudflare", registry: conformanceRegistry(connectionString, version), permanent: (message) => new NonRetryableError(message) });
            instance.state = "complete";
          } catch (error) {
            if (error instanceof NonRetryableError) instance.state = "errored";
          }
        }
      }
    },
    failed: async () => [...instances].filter(([, instance]) => instance.state === "errored").map(([id]) => id),
    deploy: async (next) => { version = next; },
    restart: async () => {},
    close: async () => {},
  };
}

runtimeConformanceSuite({ runtime: "cloudflare", connectionString: process.env.TRESTLE_RLS_TEST_DATABASE_URL, harness: async (connectionString) => cloudflareHarness(connectionString) });
