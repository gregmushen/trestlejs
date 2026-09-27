import { createLogger, type Logger } from "@__TRESTLE_PROJECT_NAME__/context";
import {
  advanceSequenceRun, emailSuppressionReason, endSequenceRun, exitSequenceRuns, findSequenceRun, outsideReplayWindow, recordSequenceSend, sequenceSuppressedReason, setSequenceEngineRun, startSequenceRun,
  type CommittedEventStore, type Database, type ExitedSequenceRun, type SequenceRun,
} from "@__TRESTLE_PROJECT_NAME__/db";
import { applicationEventCatalog, safeErrorCategory, type defineEventCatalog, type EventEnvelope } from "@__TRESTLE_PROJECT_NAME__/events";
import { EmailRejected, EmailValidationError, type EmailService } from "@__TRESTLE_PROJECT_NAME__/integrations";

import type { EventConsumerRegistry, EventHandlerContext } from "./async-runtime.js";
import { nextAllowedSendTime, sequenceWaitEnd, validTimeZone } from "./sequence-timing.js";
import type { SequenceDefinition, SequenceStepContext, SequenceUser } from "./sequences.js";

type EventCatalog = ReturnType<typeof defineEventCatalog>;

/** What an engine carries for one run: identifiers only. The tenant comes from the committed trigger event. */
export type SequenceRunHandle = Readonly<{ runId: string; triggerEventId: string }>;

/** How a job runtime starts, and cancels, the durable run that executes a sequence's steps and waits. */
export type SequenceEngine<Environment> = Readonly<{
  name: string;
  /** Starts (or finds) the engine run for this sequence run; idempotent on the run ID. Returns the engine's own ID when it has one. */
  start(environment: Environment, run: SequenceRunHandle): Promise<{ engineRunId: string | null }>;
  /** Best effort: the next step's active check prevents a send whether or not this succeeds. */
  cancel(environment: Environment, run: SequenceRunHandle & { engineRunId: string | null }): Promise<void>;
}>;

/** Why the organization's authority over a run no longer holds. */
export type SequenceAuthority = "member" | "not_member" | "tenant_missing";

export type SequenceDependencies<Environment> = Readonly<{
  /** The committed event's tenant database (forced RLS) and how to close it. */
  tenantData(environment: Environment, organizationId: string): Database;
  closeTenantData(data: Database): Promise<void>;
  /** Reads committed outbox rows by ID. */
  outbox(environment: Environment): CommittedEventStore & { close(): Promise<void> };
  /** Whether the organization still exists and the user is still one of its members, read from current state. */
  authority(environment: Environment, organizationId: string, userId: string): Promise<SequenceAuthority>;
  hasEntitlement?(environment: Environment, organizationId: string, entitlement: string): Promise<boolean>;
  user?(environment: Environment, userId: string): Promise<SequenceUser | null>;
  email(environment: Environment): EmailService;
  /** The signed one-click unsubscribe link for a recipient; required when any sequence is marketing. */
  unsubscribeUrl?(environment: Environment, input: { organizationId: string; recipientHash: string }): Promise<string>;
  /** The engine starting new runs (no name), or the one a run was started on. */
  engine(environment: Environment, name?: string): SequenceEngine<Environment> | undefined;
  clock?: { now(): Date };
  logger?: (fields: Record<string, unknown>, environment: Environment) => Logger;
}>;

/**
 * A step ended the run for good: authority no longer holds, provenance is
 * gone or expired, or the provider rejected the email. Each engine turns it
 * into its own non-retryable error; the run is already marked `failed`.
 */
export class PermanentSequenceError extends Error {
  constructor(readonly reason: string) { super(`Sequence run failed permanently: ${reason}`); this.name = "PermanentSequenceError"; }
}

/** One step's result, JSON-safe so engines can memoize it. */
export type SequenceStepOutcome =
  | Readonly<{ state: "continue"; nextStep: number; wakeAt: string | null }>
  | Readonly<{ state: "finished"; status: "completed" | "exited" | "failed" }>;

/** The Resend idempotency key of a step's send: a retried step returns the first send instead of sending again. */
export const sequenceSendKey = (runId: string, stepIndex: number) => `seq:${runId}:${stepIndex}`;
/** Engine IDs derive from the run ID, so a repeated start finds the running instance. */
export const sequenceEngineRunKey = (runId: string) => `trestle-sequence:${runId}`;
/** Delivery events that always exit marketing runs for their recipient (bounces only when permanent). */
export const sequenceDeliveryExitEvents = ["email.unsubscribed", "email.bounced", "email.complained"] as const;

const quiet: Logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } } as unknown as Logger;
const systemClock = { now: () => new Date() };

export class SequenceRegistry<Environment> {
  private readonly sequences = new Map<string, SequenceDefinition>();
  readonly clock: { now(): Date };
  constructor(readonly dependencies: SequenceDependencies<Environment>, private readonly catalog: EventCatalog = applicationEventCatalog) {
    this.clock = dependencies.clock ?? systemClock;
  }

  register(definition: SequenceDefinition): void {
    if (this.sequences.has(definition.id)) throw new Error(`Sequence ${definition.id} is already registered`);
    if (definition.kind === "marketing" && !this.dependencies.unsubscribeUrl) throw new Error(`Marketing sequence ${definition.id} needs signed unsubscribe links, but the registry has no unsubscribeUrl`);
    if (definition.requires && !this.dependencies.hasEntitlement) throw new Error(`Sequence ${definition.id} requires an entitlement, but the registry has no entitlement check`);
    for (const name of [definition.trigger, ...definition.exitOn]) if (!this.catalog.has(name, 1)) throw new Error(`Sequence ${definition.id} uses ${name}, which is not in this registry's event catalog`);
    this.sequences.set(definition.id, definition);
  }

  get(id: string): SequenceDefinition | undefined { return this.sequences.get(id); }
  list(): SequenceDefinition[] { return [...this.sequences.values()]; }

  logger(fields: Record<string, unknown>, environment: Environment): Logger {
    return this.dependencies.logger?.(fields, environment) ?? createLogger(fields);
  }

  /**
   * Registers one tenant consumer per event the sequences use: a trigger
   * starts runs, an `exitOn` event exits them, and (with `deliveryExits`)
   * `email.unsubscribed`, permanent `email.bounced`, and `email.complained`
   * exit the recipient's marketing runs. Call it once, after registering
   * every sequence; an event it consumes must have no other consumer.
   */
  attach(consumers: EventConsumerRegistry<Environment, Database>, options: { deliveryExits?: boolean } = {}): void {
    if (this.sequences.size === 0) return;
    const events = new Set<string>(this.list().flatMap((sequence) => [sequence.trigger, ...sequence.exitOn]));
    if (options.deliveryExits ?? true) for (const name of sequenceDeliveryExitEvents) events.add(name);
    for (const name of events) {
      consumers.register({ name, schemaVersion: 1, parse: (payload) => this.catalog.parse(name, 1, payload) },
        async (payload, envelope, environment, context) => await this.consume(payload as Record<string, unknown>, envelope, environment, context, options.deliveryExits ?? true),
        { authority: "tenant" });
    }
  }

  private async consume(payload: Record<string, unknown>, envelope: EventEnvelope, environment: Environment, context: EventHandlerContext<Database>, deliveryExits: boolean): Promise<void> {
    const organizationId = context.organizationId!;
    for (const sequence of this.list().filter((item) => item.trigger === envelope.name)) await this.start(sequence, envelope, environment, context);
    const exiting = this.list().filter((item) => item.exitOn.includes(envelope.name));
    const exited: ExitedSequenceRun[] = [];
    if (exiting.length) {
      const userId = typeof payload.userId === "string" ? payload.userId : undefined;
      const recipientHash = typeof payload.recipientHash === "string" ? payload.recipientHash : undefined;
      // An event naming neither a user nor a recipient is organization-wide: it exits every active run of these sequences.
      exited.push(...await exitSequenceRuns(context.data!, { organizationId, reason: envelope.name, sequenceIds: exiting.map((item) => item.id), now: this.clock.now(),
        ...(userId ? { userId } : recipientHash ? { recipientHash } : {}) }));
    }
    const permanentBounce = envelope.name !== "email.bounced" || payload.bounceType === "Permanent";
    if (deliveryExits && (sequenceDeliveryExitEvents as readonly string[]).includes(envelope.name) && permanentBounce && typeof payload.recipientHash === "string") {
      exited.push(...await exitSequenceRuns(context.data!, { organizationId, reason: envelope.name, recipientHash: payload.recipientHash, kind: "marketing", now: this.clock.now() }));
    }
    for (const run of exited) {
      context.log.info("sequence.run.exited", { runId: run.id, sequenceId: run.sequenceId, reason: envelope.name });
      await this.cancel(environment, run, context.log);
    }
  }

  private async start(sequence: SequenceDefinition, envelope: EventEnvelope, environment: Environment, context: EventHandlerContext<Database>): Promise<void> {
    const organizationId = context.organizationId!;
    const user = this.dependencies.user;
    const recipient = await sequence.recipient(envelope, { organizationId, data: context.data!, log: context.log, user: async (userId) => user ? await user(environment, userId) : null });
    if (!recipient) {
      context.log.info("sequence.run.skipped", { sequenceId: sequence.id, reason: "no_recipient" });
      return;
    }
    const engine = this.dependencies.engine(environment);
    if (!engine) throw new Error(`No sequence engine is available for sequence ${sequence.id}`);
    const { run, created } = await startSequenceRun(context.data!, { organizationId, sequenceId: sequence.id, kind: sequence.kind, userId: recipient.userId, address: recipient.address,
      timeZone: validTimeZone(recipient.timeZone) ? recipient.timeZone : null, triggerEventId: envelope.id, engine: engine.name, now: this.clock.now() });
    // A repeated trigger for a user already in this sequence starts nothing.
    if (run.triggerEventId !== envelope.id || run.status !== "active") {
      context.log.info("sequence.run.skipped", { sequenceId: sequence.id, runId: run.id, reason: run.triggerEventId === envelope.id ? "already_ended" : "already_active" });
      return;
    }
    const started = await (this.dependencies.engine(environment, run.engine) ?? engine).start(environment, { runId: run.id, triggerEventId: envelope.id });
    if (started.engineRunId && started.engineRunId !== run.engineRunId) await setSequenceEngineRun(context.data!, organizationId, run.id, started.engineRunId);
    context.log.info(created ? "sequence.run.started" : "sequence.run.resumed", { sequenceId: sequence.id, runId: run.id, engine: run.engine });
  }

  private async cancel(environment: Environment, run: ExitedSequenceRun, log: Logger): Promise<void> {
    const engine = this.dependencies.engine(environment, run.engine);
    try { await engine?.cancel(environment, { runId: run.id, triggerEventId: run.triggerEventId, engineRunId: run.engineRunId }); }
    catch (error) { log.warn("sequence.run.cancel_failed", { runId: run.id, engine: run.engine, errorCategory: safeErrorCategory(error) }); }
  }
}

/**
 * Executes step `stepIndex` of one run, on any engine. Every execution reloads
 * the run and the committed trigger event; nothing is memoized in the engine
 * except this JSON result, and the database fences each change on the run's
 * current step, so a retried or replayed step is a no-op that returns the
 * stored outcome.
 *
 * Before every send: the trigger event is still committed for this tenant and
 * inside the sequence's validity window, the organization exists, the user is
 * still a member, a declared entitlement is still held (any failure ends the
 * run as `failed` and throws `PermanentSequenceError`); the run is still
 * active (an exit recorded during a wait means no send); the recipient is not
 * suppressed (marketing: any suppression; transactional: permanent bounces and
 * complaints, never unsubscribes; a suppressed recipient exits the run as
 * `suppressed`); and `unless` is false. The send uses the Resend idempotency
 * key `seq:<runId>:<stepIndex>` and is recorded in the same transaction that
 * advances the run.
 */
export async function runSequenceStep<Environment>(input: { registry: SequenceRegistry<Environment>; environment: Environment; run: SequenceRunHandle; stepIndex: number }): Promise<SequenceStepOutcome> {
  const { registry, environment } = input;
  const dependencies = registry.dependencies;
  const now = registry.clock.now();
  const outbox = dependencies.outbox(environment);
  let committed;
  try { committed = await outbox.findCommitted(input.run.triggerEventId); }
  finally { await outbox.close(); }
  // Without its committed row the run has no trusted tenant, so nothing can be read or marked.
  if (!committed?.organizationId) throw new PermanentSequenceError("provenance_missing");
  const organizationId = committed.organizationId;
  const data = dependencies.tenantData(environment, organizationId);
  try {
    const run = await findSequenceRun(data, organizationId, input.run.runId);
    if (!run || run.triggerEventId !== committed.id) throw new PermanentSequenceError("provenance_mismatch");
    const log = registry.logger({ runId: run.id, sequenceId: run.sequenceId, organizationId, correlationId: committed.message.correlationId }, environment);
    const fail = async (reason: string): Promise<never> => {
      await endSequenceRun(data, { organizationId, runId: run.id, status: "failed", reason, now });
      log.warn("sequence.run.failed", { reason, stepIndex: input.stepIndex });
      throw new PermanentSequenceError(reason);
    };
    const sequence = registry.get(run.sequenceId);
    if (run.status !== "active") return { state: "finished", status: run.status as "completed" | "exited" | "failed" };
    if (!sequence) return await fail("sequence_unknown");
    if (committed.message.name !== sequence.trigger) return await fail("provenance_mismatch");
    if (outsideReplayWindow(committed.message.occurredAt, now, sequence.validForDays)) return await fail("provenance_expired");
    // A replayed step (an engine retrying after the change committed) returns what the run already recorded.
    if (input.stepIndex < run.currentStep) return replayed(run, sequence);
    if (input.stepIndex > run.currentStep) return await fail("step_out_of_order");
    const step = sequence.steps[input.stepIndex];
    const last = input.stepIndex + 1 >= sequence.steps.length;
    if (!step) {
      await advanceSequenceRun(data, { organizationId, runId: run.id, fromStep: run.currentStep, toStep: run.currentStep, nextAt: null, complete: true, now });
      return { state: "finished", status: "completed" };
    }
    if (step.type === "wait") {
      const ends = sequenceWaitEnd(now, step.wait, run.timeZone);
      const wakeAt = sequence.steps[input.stepIndex + 1]?.type === "send" ? nextAllowedSendTime(ends, run.timeZone, sequence.quietHours) : ends;
      if (!await advanceSequenceRun(data, { organizationId, runId: run.id, fromStep: input.stepIndex, toStep: input.stepIndex + 1, nextAt: wakeAt, complete: last, now })) return await reloaded(data, organizationId, run.id, sequence);
      return last ? { state: "finished", status: "completed" } : { state: "continue", nextStep: input.stepIndex + 1, wakeAt: wakeAt.toISOString() };
    }
    // An engine that woke early, or a send due inside quiet hours, sleeps again until it is allowed.
    const due = run.nextAt && run.nextAt > now ? run.nextAt : nextAllowedSendTime(now, run.timeZone, sequence.quietHours);
    if (due > now) {
      if (due.getTime() !== run.nextAt?.getTime()) await advanceSequenceRun(data, { organizationId, runId: run.id, fromStep: input.stepIndex, toStep: input.stepIndex, nextAt: due, now });
      return { state: "continue", nextStep: input.stepIndex, wakeAt: due.toISOString() };
    }
    const authority = await dependencies.authority(environment, organizationId, run.userId);
    if (authority !== "member") return await fail(authority);
    if (sequence.requires && !await dependencies.hasEntitlement!(environment, organizationId, sequence.requires.entitlement)) return await fail("not_entitled");
    const suppression = await emailSuppressionReason(data, organizationId, run.recipientAddress);
    if (suppression && (sequence.kind === "marketing" || suppression !== "unsubscribed")) {
      await endSequenceRun(data, { organizationId, runId: run.id, status: "exited", reason: sequenceSuppressedReason, now });
      log.info("sequence.run.suppressed", { stepIndex: input.stepIndex, suppressionReason: suppression });
      return { state: "finished", status: "exited" };
    }
    const context: SequenceStepContext = { organizationId, userId: run.userId, sequenceId: sequence.id, runId: run.id, stepIndex: input.stepIndex, data, log, clock: registry.clock };
    if (step.unless && await step.unless(context)) {
      if (!await advanceSequenceRun(data, { organizationId, runId: run.id, fromStep: input.stepIndex, toStep: input.stepIndex + 1, nextAt: null, complete: last, now })) return await reloaded(data, organizationId, run.id, sequence);
      log.info("sequence.step.skipped", { stepIndex: input.stepIndex, template: step.template });
      return last ? { state: "finished", status: "completed" } : { state: "continue", nextStep: input.stepIndex + 1, wakeAt: null };
    }
    const unsubscribeUrl = sequence.kind === "marketing" ? await dependencies.unsubscribeUrl!(environment, { organizationId, recipientHash: run.recipientHash }) : null;
    const email = await sequence.templates[step.template]!({ ...context, unsubscribeUrl });
    const idempotencyKey = sequenceSendKey(run.id, input.stepIndex);
    let receipt;
    try {
      receipt = await dependencies.email(environment).send({
        to: run.recipientAddress, subject: email.subject, template: email.template,
        ...(unsubscribeUrl ? { headers: { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } } : {}),
      }, { idempotencyKey, organizationId, correlationId: committed.message.correlationId, causationId: committed.id });
    } catch (error) {
      // A rejected message (an invalid address, a mismatched idempotent request) will never succeed; anything else retries.
      if (error instanceof EmailValidationError || error instanceof EmailRejected) return await fail("email_rejected");
      throw error;
    }
    await recordSequenceSend(data, { organizationId, runId: run.id, stepIndex: input.stepIndex, idempotencyKey, emailDeliveryId: receipt.id, toStep: input.stepIndex + 1, complete: last, now });
    log.info("sequence.step.sent", { stepIndex: input.stepIndex, template: step.template, emailDeliveryId: receipt.id });
    return last ? { state: "finished", status: "completed" } : { state: "continue", nextStep: input.stepIndex + 1, wakeAt: null };
  } finally {
    await dependencies.closeTenantData(data);
  }
}

function replayed(run: SequenceRun, sequence: SequenceDefinition): SequenceStepOutcome {
  if (run.status !== "active" || run.currentStep >= sequence.steps.length) return { state: "finished", status: run.status === "active" ? "completed" : run.status as "completed" | "exited" | "failed" };
  return { state: "continue", nextStep: run.currentStep, wakeAt: run.nextAt?.toISOString() ?? null };
}

async function reloaded(data: Database, organizationId: string, runId: string, sequence: SequenceDefinition): Promise<SequenceStepOutcome> {
  const run = await findSequenceRun(data, organizationId, runId);
  if (!run) throw new PermanentSequenceError("provenance_mismatch");
  return replayed(run, sequence);
}

/**
 * The loop every engine runs for one sequence run, with the engine's own
 * durable primitives: `step` memoizes a step's result (Workflow `step.do`,
 * Inngest `step.run`; trigger.dev runs it directly, since the database already
 * fences replays) and `sleepUntil` is the engine's durable wait. A
 * `PermanentSequenceError` becomes `permanent(reason)`, the engine's
 * non-retryable error.
 */
export async function driveSequenceRun<Environment>(input: {
  registry: SequenceRegistry<Environment>;
  environment: Environment;
  run: SequenceRunHandle;
  step(name: string, execute: () => Promise<SequenceStepOutcome>): Promise<SequenceStepOutcome>;
  sleepUntil(name: string, at: Date): Promise<void>;
  permanent(message: string): Error;
  log?: Logger;
}): Promise<SequenceStepOutcome> {
  const log = input.log ?? quiet;
  let index = 0;
  // Every step either advances or sleeps until an allowed time, so a run ends well within this bound.
  const turns = (input.registry.list().reduce((most, sequence) => Math.max(most, sequence.steps.length), 0) + 1) * 3;
  for (let turn = 0; turn < turns; turn++) {
    const outcome = await input.step(`sequence-step-${turn}`, async () => {
      try { return await runSequenceStep({ registry: input.registry, environment: input.environment, run: input.run, stepIndex: index }); }
      catch (error) {
        if (error instanceof PermanentSequenceError) {
          log.warn("sequence.run.rejected", { runId: input.run.runId, reason: error.reason });
          throw input.permanent(`Sequence run failed: ${error.reason}`);
        }
        log.warn("sequence.step.retrying", { runId: input.run.runId, stepIndex: index, errorCategory: safeErrorCategory(error) });
        throw error;
      }
    });
    if (outcome.state === "finished") return outcome;
    if (outcome.wakeAt) await input.sleepUntil(`sequence-wait-${turn}`, new Date(outcome.wakeAt));
    index = outcome.nextStep;
  }
  throw input.permanent("Sequence run exceeded its step budget");
}

const encoder = new TextEncoder();
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const fromBase64url = (value: string) => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (character) => character.charCodeAt(0));

async function unsubscribeKey(secret: string): Promise<CryptoKey> {
  if (encoder.encode(secret).length < 32) throw new Error("The unsubscribe signing secret must be at least 32 bytes");
  // A purpose-bound key derived from the Worker secret, so an unsubscribe signature is valid nowhere else.
  const root = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = new Uint8Array(await crypto.subtle.sign("HMAC", root, encoder.encode("trestle.email.unsubscribe.v1")));
  return await crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Unsubscribe links stay valid this long, well past the 30 days recipients are owed. */
export const unsubscribeLinkDays = 90;

/** A signed, expiring token naming an organization and a recipient hash (never the address). */
export async function signUnsubscribeToken(secret: string, input: { organizationId: string; recipientHash: string; expiresAt: Date }): Promise<string> {
  if (!/^[A-Za-z0-9_-]+$/u.test(input.organizationId) || !/^[0-9a-f]{64}$/u.test(input.recipientHash)) throw new Error("Invalid unsubscribe token subject");
  const body = base64url(encoder.encode(`v1.${input.organizationId}.${input.recipientHash}.${Math.floor(input.expiresAt.getTime() / 1_000)}`));
  return `${body}.${base64url(new Uint8Array(await crypto.subtle.sign("HMAC", await unsubscribeKey(secret), encoder.encode(body))))}`;
}

/** The token's organization and recipient hash, or null when it is malformed, forged, or expired. */
export async function verifyUnsubscribeToken(secret: string, token: string, now = new Date()): Promise<{ organizationId: string; recipientHash: string } | null> {
  const match = /^([A-Za-z0-9_-]{1,512})\.([A-Za-z0-9_-]{43})$/u.exec(token);
  if (!match) return null;
  try {
    if (!await crypto.subtle.verify("HMAC", await unsubscribeKey(secret), fromBase64url(match[2]!), encoder.encode(match[1]!))) return null;
    const fields = /^v1\.([A-Za-z0-9_-]+)\.([0-9a-f]{64})\.([0-9]{1,12})$/u.exec(new TextDecoder().decode(fromBase64url(match[1]!)));
    if (!fields || Number(fields[3]) * 1_000 < now.getTime()) return null;
    return { organizationId: fields[1]!, recipientHash: fields[2]! };
  } catch { return null; }
}
