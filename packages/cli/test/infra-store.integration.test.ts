import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { approvalFor, generateApproverKeys, signApproval } from "../src/infra/approvals.js";
import { PostgresOperationStore } from "../src/infra/stores/postgres.js";
import { PLAN, storeContract } from "./helpers/store-contract.js";

/**
 * Runs against a disposable, independent PostgreSQL named by
 * TRESTLE_INFRA_CONTROL_TEST_DATABASE_URL. `pnpm check:infra-recovery` sets
 * TRESTLE_INFRA_REQUIRE_INTEGRATION=1 so a missing database fails instead of skipping.
 */
const url = process.env.TRESTLE_INFRA_CONTROL_TEST_DATABASE_URL;
const required = process.env.TRESTLE_INFRA_REQUIRE_INTEGRATION === "1";
const schemas: string[] = [];
const schema = () => {
  const name = `t_${randomBytes(6).toString("hex")}`;
  schemas.push(name);
  return name;
};

describe("control-store integration prerequisites", () => {
  it("has a disposable database when integration is required", () => {
    if (required) expect(url, "TRESTLE_INFRA_CONTROL_TEST_DATABASE_URL must name a disposable PostgreSQL").toBeTruthy();
  });
});

describe.skipIf(!url)("PostgreSQL control store", () => {
  afterAll(async () => {
    const sql = postgres(url!, { max: 1, onnotice: () => {} });
    for (const name of schemas) await sql.unsafe(`drop schema if exists ${name} cascade`);
    await sql.end();
  });

  storeContract("postgres", () => PostgresOperationStore.connect(url!, { schema: schema() }));

  it("rejects updates and deletes of journal events at the database level", async () => {
    const name = schema();
    const store = await PostgresOperationStore.connect(url!, { schema: name });
    const sql = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      await store.createOperation({ id: "op-1", environment: "staging", planDigest: "d", approvalId: null, state: "planned" }, new Date());
      await store.appendEvent("op-1", "infra.apply.started", {}, new Date());
      await expect(sql.unsafe(`update ${name}.operation_events set kind = 'tampered'`)).rejects.toThrow(/append-only/u);
      await expect(sql.unsafe(`delete from ${name}.operation_events`)).rejects.toThrow(/append-only/u);
    } finally {
      await sql.end();
      await store.close();
    }
  });

  const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers", "store-worker.mjs");
  const run = async (name: string, command: Record<string, unknown>) => JSON.parse((await promisify(execFile)(process.execPath, [worker, url!, name, JSON.stringify(command)])).stdout) as Record<string, unknown>;

  it("grants a scope to exactly one of many competing processes", async () => {
    const name = schema();
    await (await PostgresOperationStore.connect(url!, { schema: name })).close();
    const now = "2026-10-02T00:00:00.000Z";
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => run(name, { action: "reserve", scope: "neon:staging", operationId: `op-${index}`, holder: `runner-${index}`, leaseMs: 60_000, now })));
    expect(results.filter((result) => result.status === "acquired")).toHaveLength(1);
    expect(results.filter((result) => result.status === "busy")).toHaveLength(7);
  });

  it("commits exactly one of many concurrent generation writers", async () => {
    const name = schema();
    await (await PostgresOperationStore.connect(url!, { schema: name })).close();
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => run(name, { action: "commit", scope: "credentials:staging:db", expected: 0, digest: `sha256:${index}` })));
    expect(results.filter((result) => result.status === "committed")).toHaveLength(1);
    expect(results.filter((result) => result.status === "error" && String(result.message).includes("generation conflict"))).toHaveLength(7);
  });

  it("consumes one approval in exactly one of many concurrent processes", async () => {
    const name = schema();
    const store = await PostgresOperationStore.connect(url!, { schema: name });
    const keys = generateApproverKeys();
    const now = new Date("2026-10-02T00:00:00.000Z");
    await store.registerApprover("alice", keys.publicKeyPem, ["staging"], now);
    const approval = signApproval(approvalFor(PLAN, { operationId: "op-1", approverId: "alice", now }), keys.privateKeyPem);
    await store.recordApproval(approval, now);
    await store.close();
    const results = await Promise.all(Array.from({ length: 6 }, () => run(name, { action: "consume", approvalId: approval.payload.approvalId, operationId: "op-1", planDigest: PLAN.digest, now: "2026-10-02T00:00:01.000Z" })));
    expect(results.filter((result) => result.status === "consumed")).toHaveLength(1);
    expect(results.filter((result) => result.status === "already_consumed_by_operation")).toHaveLength(5);
  });

  it("keeps a delayed in-flight effect uncertain across processes after lease loss (AR-02)", async () => {
    const name = schema();
    await (await PostgresOperationStore.connect(url!, { schema: name })).close();
    const acquired = await run(name, { action: "reserve", scope: "neon:staging", operationId: "op-a", holder: "runner-a", leaseMs: 10_000, now: "2026-10-02T00:00:00.000Z" });
    const token = (acquired.reservation as { fencingToken: number }).fencingToken;
    expect(await run(name, { action: "begin", scope: "neon:staging", token, effectId: "create-db", now: "2026-10-02T00:00:01.000Z" })).toEqual({ status: "begun" });
    const takeover = await run(name, { action: "reserve", scope: "neon:staging", operationId: "op-b", holder: "runner-b", leaseMs: 10_000, now: "2026-10-02T00:05:00.000Z" });
    expect(takeover.status).toBe("uncertain");
    const late = await run(name, { action: "complete", scope: "neon:staging", token, effectId: "create-db", now: "2026-10-02T00:05:01.000Z" });
    expect(late).toMatchObject({ state: "uncertain", inflightEffect: null });
    expect(await run(name, { action: "begin", scope: "neon:staging", token, effectId: "retry", now: "2026-10-02T00:05:02.000Z" })).toMatchObject({ status: "error", message: expect.stringMatching(/uncertain/u) });
    expect((await run(name, { action: "reserve", scope: "neon:staging", operationId: "op-b", holder: "runner-b", leaseMs: 10_000, now: "2026-10-02T01:00:00.000Z" })).status).toBe("uncertain");
  });
});
