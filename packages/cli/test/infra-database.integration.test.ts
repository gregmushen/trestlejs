import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { commitSnapshot, readCommittedSnapshot } from "../src/infra/credentials.js";
import { setupDatabase, type ScriptRunner } from "../src/infra/database-setup.js";
import { retiredGenerations } from "../src/infra/deployment.js";
import { rotateRuntimeCredential } from "../src/infra/runtime-rotation.js";
import { PostgresOperationStore } from "../src/infra/stores/postgres.js";

/**
 * Database setup and runtime rotation against the PostgreSQL control store
 * (TRESTLE_INFRA_CONTROL_TEST_DATABASE_URL), including resume from the sealed
 * recovery envelope after a crash between issuance and commit.
 */
const url = process.env.TRESTLE_INFRA_CONTROL_TEST_DATABASE_URL;
const masterKey = randomBytes(32).toString("hex");
const HOST = "ep-int-1.us-east-1.aws.neon.tech";
const schemas: string[] = [];
let tick = Date.parse("2026-10-02T06:00:00.000Z");
const now = () => new Date(tick++);

describe.skipIf(!url)("database setup and runtime rotation against PostgreSQL", () => {
  afterAll(async () => {
    const sql = postgres(url!, { max: 1, onnotice: () => {} });
    for (const schema of schemas) await sql.unsafe(`drop schema if exists ${schema} cascade`);
    await sql.end();
  });

  it("commits only the runtime credential, rotates, survives a crash and retires the old generation", async () => {
    const schema = `d_${randomBytes(6).toString("hex")}`;
    schemas.push(schema);
    const store = await PostgresOperationStore.connect(url!, { schema });
    try {
      await commitSnapshot(store, { projectId: "p1", environment: "staging", purpose: "operator" }, 0, { APPDB_CONNECTION_STRING: `postgres://neondb_owner:owner-pw@${HOST}/neondb?sslmode=require` }, [{ name: "APPDB_CONNECTION_STRING", classification: "operator-only", binding: "owner", provider: "neon", resource: "fres_1", consumers: [], importedAt: now().toISOString(), override: false }], masterKey);
      const passwords: string[] = [];
      let crash = true;
      const run: ScriptRunner = async (_command, args, { env }) => {
        const operation = args.at(-1)!;
        if (operation === "bootstrap-managed") await writeFile(env.TRESTLE_RUNTIME_OUTPUT!, `runtime_url=postgres://trestle_runtime:first-pw@${HOST}/neondb?sslmode=require\n`, { mode: 0o600 });
        if (operation === "bootstrap") {
          passwords.push(new URL(env.DATABASE_URL!).password);
          if (crash) { crash = false; throw new Error("killed after issuance"); }
        }
      };
      await setupDatabase({ root: "/app", store, masterKey, projectId: "p1", environment: "staging", resource: "appdb", externalId: "fres_1", runtimeRole: "trestle_runtime", consumers: ["worker"], run, path: "/usr/bin:/bin", now });
      const deployment = { projectId: "p1", environment: "staging", purpose: "deployment" as const };
      expect((await readCommittedSnapshot(store, deployment, masterKey)).values).toEqual({ DATABASE_URL: `postgres://trestle_runtime:first-pw@${HOST}/neondb?sslmode=require` });

      let deployed = "";
      let marker = "";
      const input = {
        root: "/app", store, masterKey, projectId: "p1", environment: "staging", resource: "appdb", runtimeRole: "trestle_runtime", run, path: "/usr/bin:/bin",
        consumers: [{ id: "worker" as const, requiresNewConnection: true, plane: "application" as const }], expectedTargets: { worker: "app-worker-staging" },
        deployer: { target: async () => "app-worker-staging", project: async (_c: string, _t: string, values: Readonly<Record<string, string>>, m: string) => { deployed = values.DATABASE_URL!; marker = m; return { revision: m }; } },
        probes: { probe: async () => ({ status: "ok" as const, revision: marker, credentialGeneration: marker, newConnection: true }) },
        artifactDigest: `sha256:${"cd".repeat(32)}`, configDigest: "cfg", oldCredentialRejected: async () => "rejected" as const,
        acceptInterruption: { actor: "ci", reason: "integration test" }, now, sleep: async () => {},
      };
      await expect(rotateRuntimeCredential(input)).rejects.toThrow("killed");
      const operationId = (await store.exportState()).operations.find((operation) => operation.id.startsWith("op-runtime-rotate"))!.id;
      const resumed = await rotateRuntimeCredential({ ...input, resumeOperationId: operationId });
      expect(resumed).toMatchObject({ state: "completed", generations: [1, 2] });
      expect(passwords[1]).toBe(passwords[0]);
      expect(new URL(deployed).password).toBe(passwords[0]);
      expect((await retiredGenerations(store, "p1", "staging")).retired).toEqual([1]);
      const dump = JSON.stringify(await store.exportState());
      expect(dump).not.toMatch(/owner-pw|first-pw/u);
      expect(dump).not.toContain(passwords[0]!);
    } finally {
      await store.close();
    }
  });
});
