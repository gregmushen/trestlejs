import { createDatabase, createTenantDatabase, member, organization, PostgresEventInbox, PostgresOutboxStore, tenantRecord, type Database } from "@__TRESTLE_PROJECT_NAME__/db";
import { applicationEventCatalog, defineEvent, defineEventCatalog, type EventEnvelope } from "@__TRESTLE_PROJECT_NAME__/events";
import { ResendEmailAdapter, sequenceMessageTemplate } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { EventConsumerRegistry } from "./async-runtime.js";
import { consumeCommittedEvent, type JobRuntimeName } from "./job-runtime.js";
import { SequenceRegistry, signUnsubscribeToken, type SequenceEngine } from "./sequence-runtime.js";
import { defineSequence } from "./sequences.js";

/**
 * The runtime conformance suite: the guarantees every job runtime must keep,
 * observed only through PostgreSQL so it applies equally to runtimes that
 * execute in this process (Cloudflare's, simulated) and to real engines
 * running elsewhere (trigger.dev, Inngest). A runtime is supported only when
 * this suite passes against it.
 */
export const conformanceEvent = { name: "trestle.conformance.probe", schemaVersion: 1 } as const;
export const conformanceEntitledEvent = { name: "trestle.conformance.entitled", schemaVersion: 1 } as const;
const payloadSchema = z.object({ tag: z.string().min(1), failTimes: z.number().int().min(0).default(0) });
export type ConformancePayload = z.infer<typeof payloadSchema>;
export const conformanceEntitlement = "conformance.probe";
/** Provider events the Worker commits after verifying a Stripe or Resend webhook. */
export const conformanceProviderEvents = [{ name: "billing.invoice.paid", schemaVersion: 1 }, { name: "email.bounced", schemaVersion: 1 }] as const;

export async function countRecords(database: Database, organizationId: string, name: string): Promise<number> {
  return (await database.select({ id: tenantRecord.id }).from(tenantRecord).where(and(eq(tenantRecord.organizationId, organizationId), eq(tenantRecord.name, name)))).length;
}

/**
 * The consumers every runtime executes. Each attempt and each completion is a
 * tenant row written through the handler's tenant-scoped database, so the
 * assertions also prove tenant authority. `failTimes` makes the first
 * attempts fail transiently. The entitlement is read from current database
 * state on every execution.
 */
export function conformanceRegistry(connectionString: string, version = "v1", sequenceEngine?: SequenceEngine<unknown>): EventConsumerRegistry<unknown, Database> {
  const registry = new EventConsumerRegistry<unknown, Database>(undefined, {
    tenantData: (_environment, organizationId) => createTenantDatabase(connectionString, "postgres-js", organizationId),
    closeTenantData: async (data) => { await data.$client.end(); },
    hasEntitlement: async (_environment, organizationId, entitlement) => {
      const database = createDatabase(connectionString, "postgres-js");
      try { return await countRecords(database, organizationId, `entitlement:${entitlement}`) > 0; }
      finally { await database.$client.end(); }
    },
  });
  const handler = async (payload: ConformancePayload, _envelope: EventEnvelope, _environment: unknown, context: { organizationId?: string; data?: Database }) => {
    const data = context.data!;
    await data.insert(tenantRecord).values({ organizationId: context.organizationId!, name: `attempt:${payload.tag}` });
    if (await countRecords(data, context.organizationId!, `attempt:${payload.tag}`) <= payload.failTimes) throw new Error("transient conformance failure");
    await data.insert(tenantRecord).values({ organizationId: context.organizationId!, name: `done:${payload.tag}:${version}` });
  };
  registry.register({ ...conformanceEvent, parse: (payload) => payloadSchema.parse(payload) }, handler, { authority: "tenant" });
  registry.register({ ...conformanceEntitledEvent, parse: (payload) => payloadSchema.parse(payload) }, handler, { authority: "tenant", requires: { entitlement: conformanceEntitlement } });
  // A verified provider event reaches its handler under the organization it was committed for.
  for (const definition of conformanceProviderEvents) {
    registry.register({ ...definition, parse: (payload) => applicationEventCatalog.parse(definition.name, definition.schemaVersion, payload) },
      async (_payload: unknown, envelope: EventEnvelope, _environment: unknown, context: { organizationId?: string; data?: Database }) => {
        await context.data!.insert(tenantRecord).values({ organizationId: context.organizationId!, name: `provider:${envelope.name}:${envelope.causationId}:${version}` });
      }, { authority: "tenant" });
  }
  // The sequence cases: the start event creates a run on the harness's engine and the exit event ends it.
  if (sequenceEngine) conformanceSequences(connectionString, sequenceEngine).attach(registry, { deliveryExits: false });
  return registry;
}

export const conformanceSequenceStart = { name: "conformance.sequence.started", schemaVersion: 1 } as const;
export const conformanceSequenceExit = { name: "conformance.sequence.exited", schemaVersion: 1 } as const;
const sequenceStartSchema = z.object({ tag: z.string().min(1), sequence: z.enum(["short", "long"]), userId: z.string().min(1), address: z.string().min(3) });
const sequenceExitSchema = z.object({ tag: z.string().min(1), userId: z.string().min(1) });
export type ConformanceSequencePayload = z.infer<typeof sequenceStartSchema>;
/** Sequence runs' waits: `short` completes on its own; `long` outlasts an engine's slowest dispatch and settle, leaving time to act during the wait. */
export const conformanceSequenceWaits = { short: "2s", long: "45s" } as const;
const conformanceSequenceCatalog = defineEventCatalog([
  defineEvent({ name: conformanceSequenceStart.name, schemaVersion: 1, description: "Starts a conformance sequence run", sensitivity: "internal",
    resource: { type: "conformance", id: (payload: ConformancePayloadStart) => payload.tag }, payload: sequenceStartSchema }),
  defineEvent({ name: conformanceSequenceExit.name, schemaVersion: 1, description: "Exits a conformance sequence run", sensitivity: "internal",
    resource: { type: "conformance", id: (payload: z.infer<typeof sequenceExitSchema>) => payload.tag }, payload: sequenceExitSchema }),
]);
type ConformancePayloadStart = z.infer<typeof sequenceStartSchema>;
/** Signs the conformance sequences' unsubscribe links; never a real secret. */
const conformanceUnsubscribeSecret = "trestle-conformance-unsubscribe-signing-secret";

/**
 * Two marketing sequences (send, wait, send) sending through the real Resend
 * adapter to the recorded fake at TRESTLE_CONFORMANCE_RESEND_URL, so the
 * idempotency key crosses the HTTP boundary exactly as it would to Resend.
 * Authority is read from current organization and membership rows.
 */
export function conformanceSequences(connectionString: string, engine: SequenceEngine<unknown>): SequenceRegistry<unknown> {
  const resendUrl = process.env.TRESTLE_CONFORMANCE_RESEND_URL;
  const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } } as never;
  const registry = new SequenceRegistry<unknown>({
    tenantData: (_environment, organizationId) => createTenantDatabase(connectionString, "postgres-js", organizationId),
    closeTenantData: async (data) => { await data.$client.end(); },
    outbox: () => new PostgresOutboxStore(connectionString),
    authority: async (_environment, organizationId, userId) => {
      const database = createDatabase(connectionString, "postgres-js");
      try {
        if (!(await database.select({ id: organization.id }).from(organization).where(eq(organization.id, organizationId)).limit(1)).length) return "tenant_missing";
        return (await database.select({ id: member.id }).from(member).where(and(eq(member.organizationId, organizationId), eq(member.userId, userId))).limit(1)).length ? "member" : "not_member";
      } finally { await database.$client.end(); }
    },
    email: () => {
      if (!resendUrl) throw new Error("TRESTLE_CONFORMANCE_RESEND_URL is not set");
      return new ResendEmailAdapter({ apiKey: "re_conformance", from: "Conformance <conformance@example.test>", baseUrl: resendUrl });
    },
    unsubscribeUrl: async (_environment, input) => `https://conformance.example.test/api/email/unsubscribe?token=${await signUnsubscribeToken(conformanceUnsubscribeSecret, { ...input, expiresAt: new Date(Date.now() + 86_400_000) })}`,
    engine: () => engine,
    logger: () => quiet,
  }, conformanceSequenceCatalog);
  for (const variant of ["short", "long"] as const) {
    registry.register(defineSequence({
      id: `conformance-${variant}`, kind: "marketing", authority: "tenant", trigger: conformanceSequenceStart.name, exitOn: [conformanceSequenceExit.name],
      recipient: (event) => {
        const payload = sequenceStartSchema.parse(event.payload);
        return payload.sequence === variant ? { userId: payload.userId, address: payload.address } : null;
      },
      steps: [{ send: "first" }, { wait: conformanceSequenceWaits[variant] }, { send: "second" }],
      templates: {
        first: ({ unsubscribeUrl }) => ({ subject: "first", template: sequenceMessageTemplate("conformance-first", { heading: "First", paragraphs: [], unsubscribeUrl }) }),
        second: ({ unsubscribeUrl }) => ({ subject: "second", template: sequenceMessageTemplate("conformance-second", { heading: "Second", paragraphs: [], unsubscribeUrl }) }),
      },
      quietHours: false,
    }, { catalog: conformanceSequenceCatalog }));
  }
  return registry;
}

/** One execution of a delivered event: what each runtime's step or task body runs. */
export async function executeConformanceEvent(input: { connectionString: string; envelope: EventEnvelope; runId: string; runtime: JobRuntimeName; permanent: (message: string) => Error; registry?: EventConsumerRegistry<unknown, Database> }): Promise<void> {
  const inbox = new PostgresEventInbox(input.connectionString);
  const outbox = new PostgresOutboxStore(input.connectionString);
  const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } } as never;
  try {
    await consumeCommittedEvent({ registry: input.registry ?? conformanceRegistry(input.connectionString), inbox, outbox, envelope: input.envelope, environment: {}, runId: input.runId, runtime: input.runtime, log: quiet, permanent: input.permanent });
  } finally {
    await Promise.all([inbox.close(), outbox.close()]);
  }
}

