import { applicationEventCatalog, EVENT_PROVENANCE_RETENTION_DAYS, EVENT_REPLAY_WINDOW_DAYS, type defineEventCatalog, type EventEnvelope } from "@__TRESTLE_PROJECT_NAME__/events";
import type { Logger } from "@__TRESTLE_PROJECT_NAME__/context";
import type { Database } from "@__TRESTLE_PROJECT_NAME__/db";
import type { EmailTemplate } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { z } from "zod";

import { assertQuietHours, defaultQuietHours, parseSequenceWait, sequenceWaitDays, type QuietHours, type SequenceWait } from "./sequence-timing.js";

type EventCatalog = ReturnType<typeof defineEventCatalog>;

export type SequenceKind = "marketing" | "transactional";
/** Who a run emails. `timeZone` (IANA) measures calendar-day waits and quiet hours; UTC when unknown. */
export type SequenceRecipient = Readonly<{ userId: string; address: string; timeZone?: string | null }>;
export type SequenceUser = Readonly<{ id: string; email: string; name: string }>;

/** What `recipient` sees: the committed trigger event's tenant, its forced-RLS database, and a user lookup. */
export type SequenceRecipientContext = Readonly<{
  organizationId: string;
  data: Database;
  /** The user's account row (id, email, name), or null. */
  user(userId: string): Promise<SequenceUser | null>;
  log: Logger;
}>;

/** What `unless` and a template see when a send step is due. Authority and suppression were already checked. */
export type SequenceStepContext = Readonly<{
  organizationId: string;
  userId: string;
  sequenceId: string;
  runId: string;
  stepIndex: number;
  data: Database;
  log: Logger;
  clock: { now(): Date };
}>;

export type SequenceEmail = Readonly<{ subject: string; template: EmailTemplate }>;
/** Renders one email. Marketing sequences receive the signed one-click unsubscribe link to show in the body. */
export type SequenceTemplate = (context: SequenceStepContext & { unsubscribeUrl: string | null }) => SequenceEmail | Promise<SequenceEmail>;

export type SequenceStepInput =
  | Readonly<{ send: string; unless?: (context: SequenceStepContext) => boolean | Promise<boolean> }>
  | Readonly<{ wait: string }>;

export type SequenceConfig = Readonly<{
  /** Stable identity (runs, sends, and admin are keyed on it): lowercase letters, digits, and hyphens. */
  id: string;
  /** `marketing` honors every suppression (unsubscribes too) and carries unsubscribe headers; `transactional` ignores unsubscribes only. */
  kind: SequenceKind;
  authority: "tenant";
  /** The committed event (schema version 1) whose consumer starts a run. */
  trigger: string;
  /** The run's recipient for a trigger event, or null to start no run. */
  recipient: (event: EventEnvelope, context: SequenceRecipientContext) => SequenceRecipient | null | Promise<SequenceRecipient | null>;
  /** Committed events (schema version 1) that end the tenant's matching active runs: the event's user when its payload names `userId`, otherwise every run of this sequence in the organization. */
  exitOn: readonly string[];
  steps: readonly SequenceStepInput[];
  /** Every `send` names one of these. */
  templates: Readonly<Record<string, SequenceTemplate>>;
  /** Local times sends are held back from (default 21:00–08:00); `false` sends at any hour. */
  quietHours?: QuietHours | false;
  /** An entitlement the organization must still hold before every send. */
  requires?: Readonly<{ entitlement: string }>;
  /** Days after the trigger event the run may still send (default 14, at most 30: provenance is kept that long). */
  validForDays?: number;
}>;

export type CompiledSequenceStep =
  | Readonly<{ type: "send"; template: string; unless?: (context: SequenceStepContext) => boolean | Promise<boolean> }>
  | Readonly<{ type: "wait"; wait: SequenceWait; label: string }>;

export type SequenceDefinition = Readonly<{
  id: string;
  kind: SequenceKind;
  authority: "tenant";
  trigger: string;
  recipient: SequenceConfig["recipient"];
  exitOn: readonly string[];
  steps: readonly CompiledSequenceStep[];
  templates: SequenceConfig["templates"];
  quietHours: QuietHours | null;
  requires?: Readonly<{ entitlement: string }>;
  validForDays: number;
}>;

export class SequenceDefinitionError extends Error {
  constructor(message: string) { super(message); this.name = "SequenceDefinitionError"; }
}

const functionSchema = <T>() => z.custom<T>((value) => typeof value === "function", { message: "must be a function" });
const eventName = z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u, "must be an event name such as user.signed_up");
const quietHoursSchema = z.object({ start: z.string(), end: z.string() }).strict();
const sequenceConfigSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u, "must be lowercase letters, digits, and hyphens"),
  kind: z.enum(["marketing", "transactional"]),
  authority: z.literal("tenant"),
  trigger: eventName,
  recipient: functionSchema<SequenceConfig["recipient"]>(),
  exitOn: z.array(eventName),
  steps: z.array(z.union([
    z.object({ send: z.string().min(1), unless: functionSchema<(context: SequenceStepContext) => boolean | Promise<boolean>>().optional() }).strict(),
    z.object({ wait: z.string() }).strict(),
  ])).min(1),
  templates: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u), functionSchema<SequenceTemplate>()),
  quietHours: z.union([quietHoursSchema, z.literal(false)]).optional(),
  requires: z.object({ entitlement: z.string().min(1) }).strict().optional(),
  validForDays: z.number().int().min(1).max(EVENT_PROVENANCE_RETENTION_DAYS).optional(),
}).strict();

/**
 * Defines an email sequence. Everything that can be checked without running
 * is checked here: step and template names, wait durations, quiet hours, that
 * the trigger and every `exitOn` event exist in the event catalog, and that
 * the sequence's waits fit inside its validity window.
 */
export function defineSequence(config: SequenceConfig, options: { catalog?: EventCatalog } = {}): SequenceDefinition {
  const parsed = sequenceConfigSchema.safeParse(config);
  if (!parsed.success) throw new SequenceDefinitionError(`Sequence ${String((config as { id?: unknown }).id)}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "config"} ${issue.message}`).join("; ")}`);
  const catalog = options.catalog ?? applicationEventCatalog;
  const fail = (message: string): never => { throw new SequenceDefinitionError(`Sequence ${config.id}: ${message}`); };
  for (const name of [config.trigger, ...config.exitOn]) if (!catalog.has(name, 1)) fail(`event ${name} is not in the event catalog`);
  if (new Set(config.exitOn).size !== config.exitOn.length) fail("exitOn lists an event twice");
  if (config.exitOn.includes(config.trigger)) fail("the trigger cannot also be an exit event");
  const steps = config.steps.map((step, index): CompiledSequenceStep => {
    if ("wait" in step) {
      try { return { type: "wait", wait: parseSequenceWait(step.wait), label: step.wait }; }
      catch (error) { return fail(`step ${index}: ${(error as Error).message}`); }
    }
    if (!Object.hasOwn(config.templates, step.send)) fail(`step ${index} sends ${step.send}, which is not in templates`);
    return { type: "send", template: step.send, ...(step.unless ? { unless: step.unless } : {}) };
  });
  if (!steps.some((step) => step.type === "send")) fail("a sequence needs at least one send");
  const unused = Object.keys(config.templates).filter((name) => !steps.some((step) => step.type === "send" && step.template === name));
  if (unused.length) fail(`templates ${unused.join(", ")} are never sent`);
  const quietHours = config.quietHours === false ? null : config.quietHours ?? defaultQuietHours;
  if (quietHours) {
    try { assertQuietHours(quietHours); } catch (error) { fail((error as Error).message); }
  }
  const validForDays = config.validForDays ?? EVENT_REPLAY_WINDOW_DAYS;
  // Each wait may be pushed out of quiet hours by up to a day.
  const longest = steps.reduce((total, step) => total + (step.type === "wait" ? sequenceWaitDays(step.wait) + (quietHours ? 1 : 0) : 0), 0);
  if (longest > validForDays) fail(`its waits can take ${Math.ceil(longest)} days, longer than validForDays (${validForDays})`);
  return Object.freeze({
    id: config.id, kind: config.kind, authority: config.authority, trigger: config.trigger, recipient: config.recipient,
    exitOn: Object.freeze([...config.exitOn]), steps: Object.freeze(steps), templates: config.templates, quietHours,
    ...(config.requires ? { requires: config.requires } : {}), validForDays,
  });
}
