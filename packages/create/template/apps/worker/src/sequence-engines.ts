import { createLogger, loggerSecretsFromEnvironment } from "@__TRESTLE_PROJECT_NAME__/context";
import { createDatabase, createTenantDatabase, member, organization, PostgresOutboxStore, user } from "@__TRESTLE_PROJECT_NAME__/db";
import { createEmailService } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { and, eq } from "drizzle-orm";

import type { SequenceWorkflowParams } from "./async-runtime.js";
import { cancelInngestSequence, sendSequenceToInngest, type InngestEnvironment } from "./job-runtime-inngest.js";
import { cancelTriggerRun, triggerSequenceRun, type TriggerEnvironment } from "./job-runtime-trigger.js";
import { signUnsubscribeToken, unsubscribeLinkDays, type SequenceAuthority, type SequenceDependencies, type SequenceEngine } from "./sequence-runtime.js";
import { hasCurrentEntitlement } from "./webhook-runtime.js";
import type { WorkerEnvironment } from "./worker-environment.js";

/** The Workflow instance ID of a sequence run; a repeated create finds the running instance. */
export const sequenceWorkflowId = (runId: string) => `seq-${runId}`;

export function isSequenceWorkflowParams(value: unknown): value is SequenceWorkflowParams {
  const params = value as Partial<SequenceWorkflowParams> | null;
  return typeof params === "object" && params !== null && params.kind === "sequence" && typeof params.runId === "string" && typeof params.triggerEventId === "string";
}

/**
 * Cloudflare: one Workflow instance per sequence run, on the TRESTLE_WORKFLOW
 * binding (`TrestleWorkflow` runs it with `step.do` and `step.sleepUntil`).
 * An exit terminates the instance. Sequences on Cloudflare need Workflows.
 */
export const cloudflareSequenceEngine: SequenceEngine<WorkerEnvironment> = {
  name: "cloudflare",
  start: async (environment, run) => {
    const binding = environment.TRESTLE_WORKFLOWS_ENABLED === "true" ? environment.TRESTLE_WORKFLOW : undefined;
    if (!binding) throw new Error("Email sequences on Cloudflare need Workflows: set TRESTLE_WORKFLOWS_ENABLED and bind TRESTLE_WORKFLOW");
    const id = sequenceWorkflowId(run.runId);
    try { await binding.create({ id, params: { kind: "sequence", runId: run.runId, triggerEventId: run.triggerEventId } }); }
    catch (error) {
      // A redelivered trigger after the create succeeded finds the instance.
      try { if (!await binding.get(id)) throw error; } catch { throw error; }
    }
    return { engineRunId: id };
  },
  cancel: async (environment, run) => {
    const instance = await environment.TRESTLE_WORKFLOW?.get(run.engineRunId ?? sequenceWorkflowId(run.runId)) as { terminate?: () => Promise<void> } | undefined;
    await instance?.terminate?.();
  },
};

/** trigger.dev: one `trestle-sequence` task run; `wait.until` holds it between steps and an exit cancels it. */
export const triggerSequenceEngine: SequenceEngine<WorkerEnvironment> = {
  name: "trigger",
  start: async (environment, run) => {
    const trigger = environment as WorkerEnvironment & TriggerEnvironment;
    if (!trigger.TRIGGER_SECRET_KEY) throw new Error("TRIGGER_SECRET_KEY is not set");
    return { engineRunId: (await triggerSequenceRun({ apiUrl: trigger.TRIGGER_API_URL ?? "https://api.trigger.dev", secretKey: trigger.TRIGGER_SECRET_KEY, ...run })).runId };
  },
  cancel: async (environment, run) => {
    const trigger = environment as WorkerEnvironment & TriggerEnvironment;
    if (!run.engineRunId || !trigger.TRIGGER_SECRET_KEY) return;
    await cancelTriggerRun({ apiUrl: trigger.TRIGGER_API_URL ?? "https://api.trigger.dev", secretKey: trigger.TRIGGER_SECRET_KEY, runId: run.engineRunId });
  },
};

/** Inngest: the `trestle-sequence` function, with `step.sleepUntil` between steps and `cancelOn` the exit event. */
export const inngestSequenceEngine: SequenceEngine<WorkerEnvironment> = {
  name: "inngest",
  start: async (environment, run) => ({ engineRunId: (await sendSequenceToInngest({ environment: environment as WorkerEnvironment & InngestEnvironment, ...run }))[0] ?? null }),
  cancel: async (environment, run) => { await cancelInngestSequence({ environment: environment as WorkerEnvironment & InngestEnvironment, runId: run.runId }); },
};

const engines: Readonly<Record<string, SequenceEngine<WorkerEnvironment>>> = { cloudflare: cloudflareSequenceEngine, trigger: triggerSequenceEngine, inngest: inngestSequenceEngine };

/** The runtime-owned database reads authority needs: the organization and the membership, as request authorization reads them. */
async function sequenceAuthority(environment: WorkerEnvironment, organizationId: string, userId: string): Promise<SequenceAuthority> {
  const database = createDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER);
  try {
    const [tenant] = await database.select({ id: organization.id }).from(organization).where(eq(organization.id, organizationId)).limit(1);
    if (!tenant) return "tenant_missing";
    const [membership] = await database.select({ id: member.id }).from(member).where(and(eq(member.organizationId, organizationId), eq(member.userId, userId))).limit(1);
    return membership ? "member" : "not_member";
  } finally { await database.$client.end(); }
}

/**
 * How this Worker's sequences reach the database, email, and engines. New runs
 * start on the configured job runtime (TRESTLE_JOB_RUNTIME); a run is always
 * cancelled on the engine it started on.
 */
export function workerSequenceDependencies(): SequenceDependencies<WorkerEnvironment> {
  return {
    tenantData: (environment, organizationId) => createTenantDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER, organizationId),
    closeTenantData: async (data) => { await data.$client.end(); },
    outbox: (environment) => new PostgresOutboxStore(environment.DATABASE_URL, { assumeApplicationRole: true }),
    authority: sequenceAuthority,
    hasEntitlement: hasCurrentEntitlement,
    user: async (environment, userId) => {
      const database = createDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER);
      try { return (await database.select({ id: user.id, email: user.email, name: user.name }).from(user).where(eq(user.id, userId)).limit(1))[0] ?? null; }
      finally { await database.$client.end(); }
    },
    email: (environment) => createEmailService({
      mode: environment.EMAIL_DELIVERY_MODE === "provider" || environment.EMAIL_DELIVERY_MODE === "resend" ? "resend" : "local",
      environment: environment.APP_ENV ?? "local",
      ...(environment.RESEND_API_KEY ? { resendApiKey: environment.RESEND_API_KEY } : {}),
      ...(environment.EMAIL_FROM ? { from: environment.EMAIL_FROM } : {}),
      ...(environment.EMAIL_REPLY_TO ? { replyTo: environment.EMAIL_REPLY_TO } : {}),
      ...(environment.EMAIL_STAGING_REDIRECT ? { stagingRedirect: environment.EMAIL_STAGING_REDIRECT } : {}),
    }),
    unsubscribeUrl: async (environment, input) => {
      const token = await signUnsubscribeToken(environment.BETTER_AUTH_SECRET, { ...input, expiresAt: new Date(Date.now() + unsubscribeLinkDays * 86_400_000) });
      return `${(environment.BETTER_AUTH_URL ?? "http://localhost:8787").replace(/\/$/u, "")}/api/email/unsubscribe?token=${token}`;
    },
    engine: (environment, name) => engines[name ?? environment.TRESTLE_JOB_RUNTIME ?? "cloudflare"],
    logger: (fields, environment) => createLogger(fields, undefined, { secretValues: loggerSecretsFromEnvironment(environment) }),
  };
}
