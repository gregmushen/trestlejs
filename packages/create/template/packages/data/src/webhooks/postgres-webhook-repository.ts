import { createSqlRunner, tenantConnectionString, type DatabaseDriver, type SqlRow, type SqlRunner } from "@__TRESTLE_PROJECT_NAME__/db";
import type { EncryptedSecrets, Mutation, NewDelivery, WebhookAttempt, WebhookDelivery, WebhookEndpoint, WebhookRepository } from "@__TRESTLE_PROJECT_NAME__/domain";
import { sql, type SQL } from "drizzle-orm";

import { mutationRecords } from "../access/postgres-tenant-access-repository.js";

const date = (value: unknown): Date | null => value === null || value === undefined ? null : value instanceof Date ? value : new Date(String(value));
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : typeof value === "string" && value.startsWith("{") ? value.slice(1, -1).split(",").filter(Boolean).map((item) => item.replace(/^"|"$/gu, "")) : [];
const textArray = (values: readonly string[]) => sql`${`{${values.map((value) => `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`).join(",")}}`}::text[]`;
const json = (value: unknown) => sql`${JSON.stringify(value)}::text::jsonb`;

const endpointColumns = sql`id, name, url, url_display, events, state, disabled_reason, disabled_by, consecutive_failures, secret_fingerprint, secret_created_at, previous_secret_expires_at, verified_at, last_success_at, last_failure_at, created_by, created_at, description, timeout_ms, deleted_at`;

function endpoint(row: SqlRow): WebhookEndpoint {
  return {
    id: String(row.id), name: String(row.name), url: String(row.url), urlDisplay: String(row.url_display), events: strings(row.events), state: String(row.state) as WebhookEndpoint["state"],
    disabledReason: row.disabled_reason ? String(row.disabled_reason) : null, disabledBy: row.disabled_by ? String(row.disabled_by) : null, consecutiveFailures: Number(row.consecutive_failures),
    secretFingerprint: String(row.secret_fingerprint), secretCreatedAt: date(row.secret_created_at)!, previousSecretExpiresAt: date(row.previous_secret_expires_at), verifiedAt: date(row.verified_at),
    lastSuccessAt: date(row.last_success_at), lastFailureAt: date(row.last_failure_at), createdBy: String(row.created_by), createdAt: date(row.created_at)!,
    description: row.description ? String(row.description) : null, timeoutMs: row.timeout_ms === null || row.timeout_ms === undefined ? 10_000 : Number(row.timeout_ms), deletedAt: date(row.deleted_at),
  };
}

export function webhookDelivery(row: SqlRow): WebhookDelivery {
  return {
    id: String(row.id), endpointId: String(row.endpoint_id), eventId: String(row.event_id), eventName: String(row.event_name), eventVersion: Number(row.event_version), status: String(row.status) as WebhookDelivery["status"],
    attempts: Number(row.attempts), nextAttemptAt: date(row.next_attempt_at)!, lastResponseCode: row.last_response_code === null || row.last_response_code === undefined ? null : Number(row.last_response_code),
    failureCategory: row.failure_category ? String(row.failure_category) : null, correlationId: String(row.correlation_id), test: row.test === true, replayOf: row.replay_of ? String(row.replay_of) : null,
    createdAt: date(row.created_at)!, completedAt: date(row.completed_at),
  };
}

const deliveryColumns = sql`id, endpoint_id, event_id, event_name, event_version, status, attempts, next_attempt_at, last_response_code, failure_category, correlation_id, test, replay_of, created_at, completed_at`;

/** Tenant webhook repository on a connection bound to the restricted role and the organization (forced RLS). */
export class PostgresWebhookRepository implements WebhookRepository {
  private readonly tenant: SqlRunner;

  constructor(databaseUrl: string, driver: DatabaseDriver | undefined, private readonly organizationId: string) {
    this.tenant = createSqlRunner(tenantConnectionString(databaseUrl, organizationId), driver);
  }

  private async write(statements: SQL[], mutation?: Mutation): Promise<void> {
    if (mutation && mutation.context.organizationId !== this.organizationId) throw new Error("Mutation context does not match the repository tenant");
    await this.tenant.atomic([...statements, ...(mutation ? mutationRecords(mutation) : [])]);
  }

  async listEndpoints(): Promise<WebhookEndpoint[]> {
    return (await this.tenant.query(sql`select ${endpointColumns} from webhook_endpoint where organization_id = ${this.organizationId} and deleted_at is null order by created_at`)).map(endpoint);
  }

  async getEndpoint(id: string): Promise<WebhookEndpoint | null> {
    const [row] = await this.tenant.query(sql`select ${endpointColumns} from webhook_endpoint where organization_id = ${this.organizationId} and id = ${id}`);
    return row ? endpoint(row) : null;
  }

  async encryptedSecrets(id: string): Promise<EncryptedSecrets | null> {
    const [row] = await this.tenant.query(sql`select secret_ciphertext, previous_secret_ciphertext, previous_secret_expires_at from webhook_endpoint where organization_id = ${this.organizationId} and id = ${id}`);
    return row ? { current: String(row.secret_ciphertext), previous: row.previous_secret_ciphertext ? String(row.previous_secret_ciphertext) : null, previousExpiresAt: date(row.previous_secret_expires_at) } : null;
  }

  async createEndpoint(value: WebhookEndpoint, secretCiphertext: string, mutation: Mutation): Promise<void> {
    await this.write([sql`insert into webhook_endpoint (id, organization_id, name, url, url_display, events, state, secret_ciphertext, secret_fingerprint, secret_created_at, created_by, created_at, description, timeout_ms)
      values (${value.id}, ${this.organizationId}, ${value.name}, ${value.url}, ${value.urlDisplay}, ${textArray(value.events)}, 'active', ${secretCiphertext}, ${value.secretFingerprint}, ${value.secretCreatedAt}, ${value.createdBy}, ${value.createdAt}, ${value.description ?? null}, ${value.timeoutMs ?? 10_000})`], mutation);
  }

  async updateEndpoint(id: string, changes: Readonly<{ name: string; url: string; urlDisplay: string; events: readonly string[]; description: string | null; timeoutMs: number }>, mutation: Mutation): Promise<void> {
    await this.write([sql`update webhook_endpoint set name = ${changes.name}, url = ${changes.url}, url_display = ${changes.urlDisplay}, events = ${textArray(changes.events)}, description = ${changes.description}, timeout_ms = ${changes.timeoutMs}, updated_at = now()
      where organization_id = ${this.organizationId} and id = ${id} and deleted_at is null`], mutation);
  }

  async setEndpointState(id: string, state: WebhookEndpoint["state"], reason: string | null, mutation: Mutation): Promise<void> {
    await this.write([sql`update webhook_endpoint set state = ${state}, disabled_reason = ${reason}, disabled_by = ${state === "disabled" ? mutation.context.actor.id : null}, disabled_at = ${state === "disabled" ? mutation.context.now : null},
      consecutive_failures = case when ${state} = 'active' then 0 else consecutive_failures end, updated_at = now() where organization_id = ${this.organizationId} and id = ${id}`], mutation);
  }

  async deleteEndpoint(id: string, reason: string, mutation: Mutation): Promise<void> {
    const { now, actor } = mutation.context;
    await this.write([
      sql`update webhook_endpoint set state = 'disabled', disabled_reason = ${`deleted: ${reason}`}, disabled_by = ${actor.id}, disabled_at = ${now}, deleted_at = ${now}, deleted_by = ${actor.id}, deletion_reason = ${reason}, updated_at = now()
        where organization_id = ${this.organizationId} and id = ${id} and deleted_at is null`,
      sql`update webhook_delivery set status = 'cancelled', completed_at = now() where organization_id = ${this.organizationId} and endpoint_id = ${id} and status = 'pending'`,
    ], mutation);
  }

  async rotateSecret(id: string, secretCiphertext: string, fingerprint: string, previousExpiresAt: Date, mutation: Mutation): Promise<void> {
    await this.write([sql`update webhook_endpoint set previous_secret_ciphertext = secret_ciphertext, previous_secret_expires_at = ${previousExpiresAt}, secret_ciphertext = ${secretCiphertext}, secret_fingerprint = ${fingerprint}, secret_created_at = ${mutation.context.now}, updated_at = now()
      where organization_id = ${this.organizationId} and id = ${id}`], mutation);
  }

  async listDeliveries(endpointId: string, limit: number): Promise<WebhookDelivery[]> {
    return (await this.tenant.query(sql`select ${deliveryColumns} from webhook_delivery where organization_id = ${this.organizationId} and endpoint_id = ${endpointId} order by created_at desc limit ${Math.min(Math.max(limit, 1), 200)}`)).map(webhookDelivery);
  }

  async getDelivery(id: string) {
    const [row] = await this.tenant.query(sql`select ${deliveryColumns}, payload from webhook_delivery where organization_id = ${this.organizationId} and id = ${id}`);
    return row ? { ...webhookDelivery(row), payload: (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as Record<string, unknown> } : null;
  }

  async listAttempts(deliveryId: string): Promise<WebhookAttempt[]> {
    return (await this.tenant.query(sql`select id, attempted_at, response_code, failure_category, duration_ms, provider_reference from webhook_attempt where organization_id = ${this.organizationId} and delivery_id = ${deliveryId} order by attempted_at`))
      .map((row) => ({ id: String(row.id), attemptedAt: date(row.attempted_at)!, responseCode: row.response_code === null ? null : Number(row.response_code), failureCategory: row.failure_category ? String(row.failure_category) : null, durationMs: Number(row.duration_ms), providerReference: row.provider_reference ? String(row.provider_reference) : null }));
  }

  async insertDelivery(delivery: NewDelivery, mutation?: Mutation): Promise<void> {
    await this.write([sql`insert into webhook_delivery (id, organization_id, endpoint_id, event_id, event_name, event_version, payload, correlation_id, test, replay_of)
      values (${delivery.id}, ${this.organizationId}, ${delivery.endpointId}, ${delivery.eventId}, ${delivery.eventName}, ${delivery.eventVersion}, ${json(delivery.payload)}, ${delivery.correlationId}, ${delivery.test}, ${delivery.replayOf})`], mutation);
  }

  async enqueueEvent(event: Readonly<{ eventId: string; name: string; version: number; payload: Readonly<Record<string, unknown>>; correlationId: string }>): Promise<number> {
    const rows = await this.tenant.query(sql`insert into webhook_delivery (id, organization_id, endpoint_id, event_id, event_name, event_version, payload, correlation_id)
      select 'whd_' || substr(md5(e.id || ${event.eventId}), 1, 20), ${this.organizationId}, e.id, ${event.eventId}, ${event.name}, ${event.version}, ${json(event.payload)}, ${event.correlationId}
        from webhook_endpoint e where e.organization_id = ${this.organizationId} and e.state <> 'disabled' and e.deleted_at is null and ${event.name} = any(e.events)
      on conflict (endpoint_id, event_id) where replay_of is null and test = false do nothing returning id`);
    return rows.length;
  }

  async recordAttempt(deliveryId: string, attempt: Omit<WebhookAttempt, "id">, next: Readonly<{ status: WebhookDelivery["status"]; nextAttemptAt: Date | null }>, crossedFailingThreshold?: Mutation): Promise<void> {
    const succeeded = attempt.failureCategory === null;
    await this.write([
      sql`insert into webhook_attempt (organization_id, delivery_id, attempted_at, response_code, failure_category, duration_ms, provider_reference) values (${this.organizationId}, ${deliveryId}, ${attempt.attemptedAt}, ${attempt.responseCode}, ${attempt.failureCategory}, ${attempt.durationMs}, ${attempt.providerReference ?? null})`,
      sql`update webhook_delivery set attempts = attempts + 1, status = ${next.status}, next_attempt_at = coalesce(${next.nextAttemptAt}, next_attempt_at), last_response_code = ${attempt.responseCode}, failure_category = ${attempt.failureCategory},
        completed_at = ${next.status === "pending" ? null : attempt.attemptedAt} where organization_id = ${this.organizationId} and id = ${deliveryId}`,
      sql`update webhook_endpoint e set consecutive_failures = ${succeeded ? sql`0` : sql`e.consecutive_failures + 1`},
        ${succeeded ? sql`last_success_at` : sql`last_failure_at`} = ${attempt.attemptedAt},
        verified_at = case when ${succeeded} and d.test then ${attempt.attemptedAt} else e.verified_at end
        from webhook_delivery d where d.id = ${deliveryId} and d.organization_id = ${this.organizationId} and e.id = d.endpoint_id and e.organization_id = ${this.organizationId}`,
    ], crossedFailingThreshold);
  }

  async cancelPending(endpointId: string): Promise<void> {
    await this.write([sql`update webhook_delivery set status = 'cancelled', completed_at = now() where organization_id = ${this.organizationId} and endpoint_id = ${endpointId} and status = 'pending'`]);
  }
}
