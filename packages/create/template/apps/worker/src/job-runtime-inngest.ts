import type { EventEnvelope } from "@__TRESTLE_PROJECT_NAME__/events";

import type { JobRuntimeAdapter } from "./job-runtime.js";
import type { WorkerEnvironment } from "./worker-environment.js";

/** The Inngest event that carries one committed event's ID to the `trestle-event` function. */
export const inngestEventName = "trestle/event.committed";

export type InngestEnvironment = Readonly<{
  INNGEST_EVENT_KEY?: string;
  INNGEST_SIGNING_KEY?: string;
  /** Self-hosted Inngest (or the local Dev Server); hosted Inngest when unset. */
  INNGEST_BASE_URL?: string;
  INNGEST_DEV?: string;
}>;

function eventApi(environment: InngestEnvironment): string {
  return (environment.INNGEST_BASE_URL ?? "https://inn.gs").replace(/\/$/u, "");
}

/**
 * Sends one committed event's ID to Inngest. Payloads never leave the
 * application: the function loads the committed envelope from the outbox.
 * The Inngest event ID is the event and dispatch generation, so Inngest
 * deduplicates a resend and a settlement re-dispatch starts a fresh run.
 */
export async function sendCommittedEventToInngest(input: { environment: InngestEnvironment; eventId: string; generation?: number; fetch?: typeof fetch }): Promise<string[]> {
  const key = input.environment.INNGEST_EVENT_KEY ?? (input.environment.INNGEST_DEV === "1" ? "local" : undefined);
  if (!key) throw new Error("INNGEST_EVENT_KEY is not set");
  const response = await (input.fetch ?? fetch)(`${eventApi(input.environment)}/e/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([{ name: inngestEventName, id: `trestle-event:${input.eventId}:${input.generation ?? 0}`, data: { eventId: input.eventId } }]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Inngest did not accept the event (HTTP ${response.status})`);
  }
  // Inngest's own IDs for the stored event, for looking up its runs.
  return ((await response.json().catch(() => ({}))) as { ids?: string[] }).ids ?? [];
}

export const inngestRuntime: JobRuntimeAdapter = {
  name: "inngest",
  publisher: (environment) => {
    const inngest = environment as WorkerEnvironment & InngestEnvironment;
    if (!inngest.INNGEST_EVENT_KEY && inngest.INNGEST_DEV !== "1") return undefined;
    return { send: async (envelope: EventEnvelope, delivery?: { generation: number }) => { await sendCommittedEventToInngest({ environment: inngest, eventId: envelope.id, generation: delivery?.generation ?? 0 }); } };
  },
  describe: (environment) => {
    const inngest = environment as WorkerEnvironment & InngestEnvironment;
    if (inngest.INNGEST_DEV === "1") return { configured: true, detail: `the Inngest Dev Server at ${eventApi(inngest)}` };
    return inngest.INNGEST_EVENT_KEY
      ? { configured: true, detail: `Inngest at ${eventApi(inngest)}${inngest.INNGEST_SIGNING_KEY ? "" : " (INNGEST_SIGNING_KEY missing: the serve endpoint will refuse calls)"}` }
      : { configured: false, detail: "INNGEST_EVENT_KEY is not set; committed events wait in the outbox" };
  },
};
