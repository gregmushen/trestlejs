import postgres from "postgres";

import type { SignedApproval } from "../approvals.js";
import { StoreConflictError, type ConsumeResult, type ControlSnapshot, type Generation, type OperationEvent, type OperationRecord, type OperationStore, type Reservation, type ReserveResult } from "../store.js";
import { approvalProblems, assertEffectAllowed, decideReserve, type ApproverRecord } from "./rules.js";

/**
 * Independent PostgreSQL control store (D-02). Every mutating method runs in
 * one transaction with row locks, so competing processes and machines observe
 * a single serialized order.
 */

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

const SCHEMA_NAME = /^[a-z][a-z0-9_]{0,40}$/u;

export function controlStoreMigration(schema: string): string {
  if (!SCHEMA_NAME.test(schema)) throw new Error("control-store schema must be a lowercase identifier");
  return `
create schema if not exists ${schema};
create sequence if not exists ${schema}.fencing;
create table if not exists ${schema}.approvers (
  id text primary key,
  public_key_pem text not null,
  environments text[] not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create table if not exists ${schema}.approvals (
  approval_id text primary key,
  operation_id text not null,
  plan_digest text not null,
  approver_id text not null references ${schema}.approvers(id),
  approval jsonb not null,
  expires_at timestamptz not null,
  consumed_by text,
  consumed_at timestamptz
);
create table if not exists ${schema}.operations (
  id text primary key,
  environment text not null,
  plan_digest text not null,
  approval_id text,
  state text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create table if not exists ${schema}.operation_events (
  seq bigserial primary key,
  operation_id text not null references ${schema}.operations(id),
  at timestamptz not null,
  kind text not null,
  data jsonb not null
);
create or replace function ${schema}.reject_event_change() returns trigger language plpgsql as $$
begin raise exception 'operation_events is append-only'; end $$;
drop trigger if exists operation_events_append_only on ${schema}.operation_events;
create trigger operation_events_append_only before update or delete on ${schema}.operation_events
  for each row execute function ${schema}.reject_event_change();
create table if not exists ${schema}.reservations (
  scope text primary key,
  operation_id text not null,
  holder text not null,
  fencing_token bigint not null,
  lease_expires_at timestamptz not null,
  state text not null check (state in ('active', 'uncertain')),
  inflight_effect text
);
create table if not exists ${schema}.generations (
  scope text primary key,
  generation bigint not null check (generation > 0),
  payload_digest text not null,
  data jsonb not null
);
`;
}

const iso = (value: Date | string | null): string | null => value === null ? null : new Date(value).toISOString();

function reservationFrom(row: Record<string, unknown>): Reservation {
  return { scope: String(row.scope), operationId: String(row.operation_id), holder: String(row.holder), fencingToken: Number(row.fencing_token), leaseExpiresAt: iso(row.lease_expires_at as Date)!, state: row.state as Reservation["state"], inflightEffect: (row.inflight_effect as string | null) ?? null };
}

function operationFrom(row: Record<string, unknown>): OperationRecord {
  return { id: String(row.id), environment: String(row.environment), planDigest: String(row.plan_digest), approvalId: (row.approval_id as string | null) ?? null, state: String(row.state), createdAt: iso(row.created_at as Date)!, updatedAt: iso(row.updated_at as Date)! };
}

export class PostgresOperationStore implements OperationStore {
  readonly kind = "postgres" as const;

  private constructor(private readonly sql: Sql, private readonly schema: string) {}

  static async connect(url: string, options: { schema?: string } = {}): Promise<PostgresOperationStore> {
    const schema = options.schema ?? "trestle_infra";
    if (!SCHEMA_NAME.test(schema)) throw new Error("control-store schema must be a lowercase identifier");
    const sql = postgres(url, { max: 4, onnotice: () => {}, idle_timeout: 5 });
    // Concurrent first connections must not race on DDL.
    await sql.begin(async (tx) => {
      await tx.unsafe("select pg_advisory_xact_lock(hashtext($1))", [`trestle-control-migration:${schema}`]);
      await tx.unsafe(controlStoreMigration(schema));
    });
    return new PostgresOperationStore(sql, schema);
  }

  close(): Promise<void> { return this.sql.end({ timeout: 5 }); }

  private table(name: string): string { return `${this.schema}.${name}`; }

  private async approver(tx: Tx | Sql, id: string): Promise<ApproverRecord | undefined> {
    const [row] = await tx.unsafe(`select id, public_key_pem, environments, revoked_at from ${this.table("approvers")} where id = $1`, [id]);
    return row ? { id: row.id, publicKeyPem: row.public_key_pem, environments: row.environments, revokedAt: iso(row.revoked_at) } : undefined;
  }

  async registerApprover(id: string, publicKeyPem: string, environments: readonly string[], now: Date): Promise<void> {
    await this.sql.unsafe(`insert into ${this.table("approvers")} (id, public_key_pem, environments, created_at) values ($1, $2, $3, $4)`, [id, publicKeyPem, [...environments], now]);
  }

  async revokeApprover(id: string, now: Date): Promise<void> {
    await this.sql.unsafe(`update ${this.table("approvers")} set revoked_at = $2 where id = $1`, [id, now]);
  }

  async recordApproval(approval: SignedApproval, now: Date): Promise<void> {
    await this.sql.begin(async (tx) => {
      const [recorded] = await tx.unsafe(`select approval from ${this.table("approvals")} where approval_id = $1`, [approval.payload.approvalId]);
      // Re-recording the identical approval is a no-op; consumption is the authoritative check.
      if (recorded && (recorded.approval as SignedApproval).signature === approval.signature) return;
      const problem = approvalProblems(approval, await this.approver(tx, approval.payload.approverId), now);
      if (problem) throw new StoreConflictError(problem);
      try {
        await tx.unsafe(`insert into ${this.table("approvals")} (approval_id, operation_id, plan_digest, approver_id, approval, expires_at) values ($1, $2, $3, $4, $5, $6)`,
          [approval.payload.approvalId, approval.payload.operationId, approval.payload.planDigest, approval.payload.approverId, approval as never, approval.payload.expiresAt]);
      } catch (error) {
        if ((error as { code?: string }).code === "23505") throw new StoreConflictError("approval is already recorded");
        throw error;
      }
    });
  }

  async consumeApproval(approvalId: string, operationId: string, planDigest: string, now: Date): Promise<ConsumeResult> {
    return this.sql.begin(async (tx) => {
      const [row] = await tx.unsafe(`select approval, consumed_by from ${this.table("approvals")} where approval_id = $1 for update`, [approvalId]);
      if (!row) return { status: "rejected", reason: "approval is not recorded" } as const;
      const approval = row.approval as SignedApproval;
      if (row.consumed_by && row.consumed_by !== operationId) return { status: "rejected", reason: "approval was already consumed by another operation" } as const;
      if (approval.payload.operationId !== operationId) return { status: "rejected", reason: "approval is bound to a different operation" } as const;
      if (approval.payload.planDigest !== planDigest) return { status: "rejected", reason: "approval is bound to a different plan digest" } as const;
      const problem = approvalProblems(approval, await this.approver(tx, approval.payload.approverId), now);
      if (problem) return { status: "rejected", reason: problem } as const;
      if (row.consumed_by === operationId) return { status: "already_consumed_by_operation" } as const;
      await tx.unsafe(`update ${this.table("approvals")} set consumed_by = $2, consumed_at = $3 where approval_id = $1`, [approvalId, operationId, now]);
      return { status: "consumed" } as const;
    });
  }

  async createOperation(record: Omit<OperationRecord, "createdAt" | "updatedAt">, now: Date): Promise<OperationRecord> {
    try {
      const [row] = await this.sql.unsafe(`insert into ${this.table("operations")} (id, environment, plan_digest, approval_id, state, created_at, updated_at) values ($1, $2, $3, $4, $5, $6, $6) returning *`, [record.id, record.environment, record.planDigest, record.approvalId, record.state, now]);
      return operationFrom(row!);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new StoreConflictError(`operation ${record.id} already exists`);
      throw error;
    }
  }

  async getOperation(id: string): Promise<OperationRecord | undefined> {
    const [row] = await this.sql.unsafe(`select * from ${this.table("operations")} where id = $1`, [id]);
    return row ? operationFrom(row) : undefined;
  }

  async setOperationState(id: string, state: string, now: Date): Promise<void> {
    const result = await this.sql.unsafe(`update ${this.table("operations")} set state = $2, updated_at = $3 where id = $1`, [id, state, now]);
    if (result.count === 0) throw new StoreConflictError(`operation ${id} does not exist`);
  }

  async appendEvent(operationId: string, kind: string, data: Record<string, unknown>, now: Date): Promise<OperationEvent> {
    try {
      const [row] = await this.sql.unsafe(`insert into ${this.table("operation_events")} (operation_id, at, kind, data) values ($1, $2, $3, $4) returning seq, operation_id, at, kind, data`, [operationId, now, kind, data as never]);
      return { seq: Number(row!.seq), operationId: row!.operation_id, at: iso(row!.at)!, kind: row!.kind, data: row!.data };
    } catch (error) {
      if ((error as { code?: string }).code === "23503") throw new StoreConflictError(`operation ${operationId} does not exist`);
      throw error;
    }
  }

  async events(operationId: string): Promise<OperationEvent[]> {
    const rows = await this.sql.unsafe(`select seq, operation_id, at, kind, data from ${this.table("operation_events")} where operation_id = $1 order by seq`, [operationId]);
    return rows.map((row) => ({ seq: Number(row.seq), operationId: row.operation_id, at: iso(row.at)!, kind: row.kind, data: row.data }));
  }

  private async lockedReservation(tx: Tx, scope: string): Promise<Reservation | undefined> {
    const [row] = await tx.unsafe(`select * from ${this.table("reservations")} where scope = $1 for update`, [scope]);
    return row ? reservationFrom(row) : undefined;
  }

  async reserve(scope: string, operationId: string, holder: string, leaseMs: number, now: Date): Promise<ReserveResult> {
    return this.sql.begin(async (tx) => {
      // Serialize first acquisition of a scope that has no row yet.
      await tx.unsafe("select pg_advisory_xact_lock(hashtext($1))", [`${this.schema}:${scope}`]);
      const existing = await this.lockedReservation(tx, scope);
      const decision = decideReserve(existing, operationId, holder, now);
      const lease = new Date(now.getTime() + leaseMs);
      if (decision.action === "busy") return { status: "busy", holder: existing!.holder, leaseExpiresAt: existing!.leaseExpiresAt } as const;
      if (decision.action === "uncertain") {
        if (decision.mark) await tx.unsafe(`update ${this.table("reservations")} set state = 'uncertain' where scope = $1`, [scope]);
        return { status: "uncertain", reservation: { ...existing!, state: "uncertain" } } as const;
      }
      if (decision.action === "renew") {
        const [row] = await tx.unsafe(`update ${this.table("reservations")} set lease_expires_at = $2 where scope = $1 returning *`, [scope, lease]);
        return { status: "acquired", reservation: reservationFrom(row!) } as const;
      }
      const [{ token }] = await tx.unsafe(`select nextval('${this.schema}.fencing') as token`) as unknown as [{ token: string }];
      const [row] = await tx.unsafe(
        `insert into ${this.table("reservations")} (scope, operation_id, holder, fencing_token, lease_expires_at, state, inflight_effect) values ($1, $2, $3, $4, $5, 'active', null)
         on conflict (scope) do update set operation_id = excluded.operation_id, holder = excluded.holder, fencing_token = excluded.fencing_token, lease_expires_at = excluded.lease_expires_at, state = 'active', inflight_effect = null returning *`,
        [scope, operationId, holder, token, lease]);
      return { status: "acquired", reservation: reservationFrom(row!) } as const;
    });
  }

  async beginEffect(scope: string, fencingToken: number, effectId: string, now: Date): Promise<void> {
    await this.sql.begin(async (tx) => {
      const problem = assertEffectAllowed(await this.lockedReservation(tx, scope), fencingToken, now);
      if (problem) throw new StoreConflictError(problem);
      await tx.unsafe(`update ${this.table("reservations")} set inflight_effect = $2 where scope = $1`, [scope, effectId]);
    });
  }

  async completeEffect(scope: string, fencingToken: number, effectId: string): Promise<Reservation> {
    return this.sql.begin(async (tx) => {
      const existing = await this.lockedReservation(tx, scope);
      if (!existing || existing.fencingToken !== fencingToken) throw new StoreConflictError("fencing token is stale");
      if (existing.inflightEffect !== effectId) throw new StoreConflictError(`effect ${effectId} is not in flight`);
      const [row] = await tx.unsafe(`update ${this.table("reservations")} set inflight_effect = null where scope = $1 returning *`, [scope]);
      return reservationFrom(row!);
    });
  }

  async markUncertain(scope: string, fencingToken: number): Promise<void> {
    const result = await this.sql.unsafe(`update ${this.table("reservations")} set state = 'uncertain' where scope = $1 and fencing_token = $2`, [scope, fencingToken]);
    if (result.count === 0) throw new StoreConflictError("fencing token is stale");
  }

  async release(scope: string, fencingToken: number): Promise<void> {
    await this.sql.begin(async (tx) => {
      const existing = await this.lockedReservation(tx, scope);
      if (!existing) return;
      if (existing.fencingToken !== fencingToken) throw new StoreConflictError("fencing token is stale");
      if (existing.state !== "active" || existing.inflightEffect) throw new StoreConflictError("an uncertain or in-flight reservation can only be reconciled");
      await tx.unsafe(`delete from ${this.table("reservations")} where scope = $1`, [scope]);
    });
  }

  async reconcile(scope: string, resolution: string, actor: string, now: Date): Promise<void> {
    await this.sql.begin(async (tx) => {
      const existing = await this.lockedReservation(tx, scope);
      if (!existing) return;
      const [operation] = await tx.unsafe(`select id from ${this.table("operations")} where id = $1`, [existing.operationId]);
      if (operation) await tx.unsafe(`insert into ${this.table("operation_events")} (operation_id, at, kind, data) values ($1, $2, 'infra.operation.reconciled', $3)`, [existing.operationId, now, { scope, resolution, actor } as never]);
      await tx.unsafe(`delete from ${this.table("reservations")} where scope = $1`, [scope]);
    });
  }

  async getReservation(scope: string): Promise<Reservation | undefined> {
    const [row] = await this.sql.unsafe(`select * from ${this.table("reservations")} where scope = $1`, [scope]);
    return row ? reservationFrom(row) : undefined;
  }

  async readGeneration(scope: string): Promise<Generation | undefined> {
    const [row] = await this.sql.unsafe(`select * from ${this.table("generations")} where scope = $1`, [scope]);
    return row ? { scope: row.scope, generation: Number(row.generation), payloadDigest: row.payload_digest, data: row.data } : undefined;
  }

  async commitGeneration(scope: string, expected: number, payloadDigest: string, data: Record<string, unknown>): Promise<Generation> {
    return this.sql.begin(async (tx) => {
      await tx.unsafe("select pg_advisory_xact_lock(hashtext($1))", [`${this.schema}:generation:${scope}`]);
      const [current] = await tx.unsafe(`select generation from ${this.table("generations")} where scope = $1 for update`, [scope]);
      const actual = current ? Number(current.generation) : 0;
      if (actual !== expected) throw new StoreConflictError(`generation conflict for ${scope}: expected ${expected}, current ${actual}`);
      const [row] = await tx.unsafe(
        `insert into ${this.table("generations")} (scope, generation, payload_digest, data) values ($1, $2, $3, $4)
         on conflict (scope) do update set generation = excluded.generation, payload_digest = excluded.payload_digest, data = excluded.data returning *`,
        [scope, actual + 1, payloadDigest, data as never]);
      return { scope: row!.scope, generation: Number(row!.generation), payloadDigest: row!.payload_digest, data: row!.data };
    });
  }

  async exportState(): Promise<ControlSnapshot> {
    return this.sql.begin("isolation level repeatable read", async (tx) => {
      const approvers = await tx.unsafe(`select * from ${this.table("approvers")} order by id`);
      const approvals = await tx.unsafe(`select * from ${this.table("approvals")} order by approval_id`);
      const operations = await tx.unsafe(`select * from ${this.table("operations")} order by id`);
      const events = await tx.unsafe(`select * from ${this.table("operation_events")} order by seq`);
      const reservations = await tx.unsafe(`select * from ${this.table("reservations")} order by scope`);
      const generations = await tx.unsafe(`select * from ${this.table("generations")} order by scope`);
      const [fencing] = await tx.unsafe(`select last_value, is_called from ${this.schema}.fencing`);
      return {
        approvers: approvers.map((row) => ({ id: row.id, publicKeyPem: row.public_key_pem, environments: row.environments, revokedAt: iso(row.revoked_at) })),
        approvals: approvals.map((row) => ({ approval: row.approval, consumedBy: row.consumed_by, consumedAt: iso(row.consumed_at) })),
        operations: operations.map(operationFrom),
        events: events.map((row) => ({ seq: Number(row.seq), operationId: row.operation_id, at: iso(row.at)!, kind: row.kind, data: row.data })),
        reservations: reservations.map(reservationFrom),
        generations: generations.map((row) => ({ scope: row.scope, generation: Number(row.generation), payloadDigest: row.payload_digest, data: row.data })),
        fencingHighWater: fencing?.is_called ? Number(fencing.last_value) : 0,
      };
    }) as unknown as ControlSnapshot;
  }

  /** Restores into an empty store. Refuses to merge into existing state. */
  async importState(snapshot: ControlSnapshot): Promise<void> {
    await this.sql.begin(async (tx) => {
      const [{ count }] = await tx.unsafe(`select (select count(*) from ${this.table("operations")}) + (select count(*) from ${this.table("approvals")}) + (select count(*) from ${this.table("generations")}) as count`) as unknown as [{ count: string }];
      if (Number(count) > 0) throw new StoreConflictError("restore target control store is not empty");
      for (const approver of snapshot.approvers) await tx.unsafe(`insert into ${this.table("approvers")} (id, public_key_pem, environments, revoked_at) values ($1, $2, $3, $4)`, [approver.id, approver.publicKeyPem, [...approver.environments], approver.revokedAt]);
      for (const entry of snapshot.approvals) await tx.unsafe(`insert into ${this.table("approvals")} (approval_id, operation_id, plan_digest, approver_id, approval, expires_at, consumed_by, consumed_at) values ($1, $2, $3, $4, $5, $6, $7, $8)`, [entry.approval.payload.approvalId, entry.approval.payload.operationId, entry.approval.payload.planDigest, entry.approval.payload.approverId, entry.approval as never, entry.approval.payload.expiresAt, entry.consumedBy, entry.consumedAt]);
      for (const operation of snapshot.operations) await tx.unsafe(`insert into ${this.table("operations")} (id, environment, plan_digest, approval_id, state, created_at, updated_at) values ($1, $2, $3, $4, $5, $6, $7)`, [operation.id, operation.environment, operation.planDigest, operation.approvalId, operation.state, operation.createdAt, operation.updatedAt]);
      for (const event of snapshot.events) await tx.unsafe(`insert into ${this.table("operation_events")} (seq, operation_id, at, kind, data) values ($1, $2, $3, $4, $5)`, [event.seq, event.operationId, event.at, event.kind, event.data as never]);
      await tx.unsafe(`select setval(pg_get_serial_sequence('${this.table("operation_events")}', 'seq'), greatest((select coalesce(max(seq), 0) from ${this.table("operation_events")}), 1))`);
      for (const reservation of snapshot.reservations) await tx.unsafe(`insert into ${this.table("reservations")} (scope, operation_id, holder, fencing_token, lease_expires_at, state, inflight_effect) values ($1, $2, $3, $4, $5, $6, $7)`, [reservation.scope, reservation.operationId, reservation.holder, reservation.fencingToken, reservation.leaseExpiresAt, reservation.state, reservation.inflightEffect]);
      for (const generation of snapshot.generations) await tx.unsafe(`insert into ${this.table("generations")} (scope, generation, payload_digest, data) values ($1, $2, $3, $4)`, [generation.scope, generation.generation, generation.payloadDigest, generation.data as never]);
      const high = Math.max(snapshot.fencingHighWater, ...snapshot.reservations.map((reservation) => reservation.fencingToken));
      if (high > 0) await tx.unsafe(`select setval('${this.schema}.fencing', $1)`, [high]);
    });
  }
}
