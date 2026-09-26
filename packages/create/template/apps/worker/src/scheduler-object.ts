import { DurableObject, type DurableObjectState } from "cloudflare:workers";

import { createLogger, loggerSecretsFromEnvironment } from "@__TRESTLE_PROJECT_NAME__/context";
import { safeErrorCategory } from "@__TRESTLE_PROJECT_NAME__/events";

import { DueWorkScheduler, type DueWorkRunner } from "./scheduler.js";
import { runDueWork } from "./scheduler-runtime.js";
import type { WorkerEnvironment } from "./worker-environment.js";

/**
 * The single due-time scheduler object. Its storage holds only keys and due
 * times, never payloads or tenant data; the alarm is the only timer. With
 * nothing pending the alarm is cleared, so an idle project never wakes it.
 */
export class TrestleScheduler extends DurableObject<WorkerEnvironment> {
  private readonly scheduler: DueWorkScheduler;

  constructor(ctx: DurableObjectState, env: WorkerEnvironment, runner: DueWorkRunner = async (key, dueAt) => await runDueWork(key, dueAt, env)) {
    super(ctx, env);
    const log = createLogger({ environment: env.APP_ENV ?? "local" }, undefined, { secretValues: loggerSecretsFromEnvironment(env) });
    this.scheduler = new DueWorkScheduler(ctx.storage, runner, {
      onError: (key, error) => { log.error("scheduler.work.failed", { key, errorCategory: safeErrorCategory(error) }); },
    });
  }

  async schedule(items: Array<{ key: string; dueAt: string }>): Promise<void> {
    await this.scheduler.schedule(items);
  }

  async pending(): Promise<{ alarmAt: string | null; work: Array<{ key: string; dueAt: string }> }> {
    return await this.scheduler.pending();
  }

  async alarm(): Promise<void> {
    const result = await this.scheduler.alarm();
    if (result.ran.length || result.failed.length) {
      createLogger({ environment: this.env.APP_ENV ?? "local" }, undefined, { secretValues: loggerSecretsFromEnvironment(this.env) })
        .info("scheduler.alarm.completed", { ran: result.ran.length, failed: result.failed.length, rearmed: result.alarmAt !== null });
    }
  }
}
