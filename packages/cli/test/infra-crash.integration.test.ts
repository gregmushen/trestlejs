import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { readCommittedSnapshot } from "../src/infra/credentials.js";
import { bindingScope, type Boundary } from "../src/infra/runner.js";
import { PostgresOperationStore } from "../src/infra/stores/postgres.js";
import { createHarness, type Harness } from "./helpers/infra-harness.js";

/**
 * Kills a real runner process at each persistence boundary and recovers with a
 * second process against the PostgreSQL control store. Requires
 * TRESTLE_INFRA_CONTROL_TEST_DATABASE_URL (see infra-store.integration.test.ts).
 */
const url = process.env.TRESTLE_INFRA_CONTROL_TEST_DATABASE_URL;
const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers", "runner-worker.mjs");
const schemas: string[] = [];
let harness: Harness | undefined;
let store: PostgresOperationStore | undefined;

afterEach(async () => {
  await store?.close();
  await harness?.cleanup();
  store = undefined;
  harness = undefined;
});

describe.skipIf(!url)("runner process termination against PostgreSQL", () => {
  afterAll(async () => {
    const sql = postgres(url!, { max: 1, onnotice: () => {} });
    for (const schema of schemas) await sql.unsafe(`drop schema if exists ${schema} cascade`);
    await sql.end();
  });

  async function run(h: Harness, schema: string, extra: Record<string, unknown>): Promise<{ code: number | null; signal: string | null; stdout: string }> {
    const plan = await h.plan();
    const config = path.join(h.root, `worker-${randomBytes(4).toString("hex")}.json`);
    await writeFile(config, JSON.stringify({ url, schema, stripePath: h.fake.stripePath, pluginRoot: h.fake.pluginRoot, home: h.fake.home, pluginSha256: h.fake.pluginSha256, workspace: h.workspace, root: h.root, masterKey: h.masterKey, now: h.clock.now().toISOString(), intent: h.intent, bindings: h.bindings, ...extra, plan: extra.plan ?? plan }), { mode: 0o600 });
    return new Promise((resolve) => {
      execFile(process.execPath, [worker, config], (error, stdout) => resolve({ code: error ? (error as { code?: number }).code ?? null : 0, signal: error ? (error as { signal?: string }).signal ?? null : null, stdout }));
    });
  }

  const boundaries: Boundary[] = ["after_intent", "after_begin", "after_effect", "after_binding_commit", "after_snapshot_commit", "after_cleanup"];
  for (const boundary of boundaries) {
    it(`recovers after SIGKILL at ${boundary}`, async () => {
      const schema = `c_${randomBytes(6).toString("hex")}`;
      schemas.push(schema);
      store = await PostgresOperationStore.connect(url!, { schema });
      harness = await createHarness({ store });
      const plan = await harness.plan();
      const approval = harness.approve(plan);
      const killed = await run(harness, schema, { plan, approval, holder: "runner-a", killAt: boundary, killResource: "database" });
      expect(killed.signal).toBe("SIGKILL");
      harness.clock.advance(120_000);
      const confirmAbsent = boundary === "after_begin" ? { actor: "operator", reason: "runner-a was killed before its provider request" } : undefined;
      const resumed = await run(harness, schema, { plan, approval, holder: "runner-b", ...(confirmAbsent ? { confirmAbsent } : {}) });
      expect(JSON.parse(resumed.stdout)).toMatchObject({ outcome: "succeeded" });
      const remote = await harness.fake.remote();
      expect(remote.effects.add).toBe(2);
      const committed = await store.readGeneration(bindingScope("trestle-proj-1", "staging"));
      expect(Object.keys((committed!.data.binding as { resources: object }).resources).sort()).toEqual(["database", "email"]);
      const operator = await readCommittedSnapshot(store, { projectId: "trestle-proj-1", environment: "staging", purpose: "operator" }, harness.masterKey);
      expect(Object.keys(operator.values)).toEqual(["DATABASE_URL"]);
      expect((await readdir(harness.workspace)).filter((file) => file.startsWith(".env"))).toEqual([]);
    });
  }
});
