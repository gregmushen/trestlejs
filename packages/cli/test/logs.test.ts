import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLogTailArguments, createTailLineConsumer, safeTailRecords, tailSemanticLogs } from "../src/logs.js";

const timestamp = "2026-09-24T17:00:00.000Z";
const correlationId = "01234567-89ab-4cde-8f01-23456789abcd";
const causationId = "fedcba98-7654-4abc-8def-0123456789ab";
const semantic = (fields: Record<string, unknown> = {}) => ({ timestamp, level: "info", event: "billing.checkout.created", ...fields });

describe("safe log tail arguments", () => {
  it("builds an environment-scoped Wrangler tail", () => {
    expect(buildLogTailArguments({ environment: "staging", status: "error", format: "json", samplingRate: 0.25 })).toEqual(["tail", "--env", "staging", "--format", "json", "--status", "error", "--sampling-rate", "0.25"]);
    expect(buildLogTailArguments({ environment: "preview", format: "pretty", search: "billing", workerName: "safe-preview" })).toEqual(["tail", "safe-preview", "--env", "preview", "--format", "json"]);
  });

  it("rejects filters that could turn logs into a sensitive-payload escape hatch", () => {
    expect(() => buildLogTailArguments({ environment: "production", search: "authorization token" })).toThrow("sensitive");
    expect(() => buildLogTailArguments({ environment: "production", search: "sk_test_abcd" })).toThrow("semantic event-name");
    expect(() => buildLogTailArguments({ environment: "preview", workerName: "--header" })).toThrow("Worker name");
    expect(() => buildLogTailArguments({ environment: "staging", samplingRate: Number.NaN })).toThrow("sampling rate");
    expect(() => buildLogTailArguments({ environment: "local" })).toThrow("remote log tailing");
  });

  it("projects only validated semantic fields, never raw requests, exceptions, or unknown metadata", () => {
    const secret = "sk_test_DO_NOT_EXPOSE";
    const trace = {
      event: { request: { url: `https://example.test/?token=${secret}`, headers: { authorization: secret } } },
      exceptions: [{ message: secret, stack: secret }],
      logs: [
        { message: [JSON.stringify(semantic({ correlationId, durationMs: 12, status: 201, apiKey: secret, body: secret, nested: { password: secret } }))] },
        { message: [`raw console ${secret}`] },
      ],
    };
    const records = safeTailRecords(trace);
    expect(records).toEqual([{ timestamp, level: "info", event: "billing.checkout.created", correlationId, durationMs: 12, status: 201 }]);
    expect(JSON.stringify(records)).not.toContain(secret);
  });

  it("rejects malformed records and searches only semantic event names", () => {
    const logs = [
      semantic({ timestamp: "bad" }), semantic({ level: "trace" }), semantic({ event: "secret value" }), semantic({ event: "billing.sk_test_credential" }),
      semantic({ event: "billing.checkout.failed", correlationId: "sk_test_DO_NOT_EXPOSE", status: 999, durationMs: -1 }),
      semantic({ event: "email.send.accepted" }),
    ].map((record) => ({ message: [JSON.stringify(record)] }));
    expect(safeTailRecords({ logs }, "billing")).toEqual([{ timestamp, level: "info", event: "billing.checkout.failed" }]);
    expect(safeTailRecords({ logs }, "email")).toEqual([{ timestamp, level: "info", event: "email.send.accepted" }]);
  });

  it("shows debug and UUID causation safely without forwarding free-form identifiers", () => {
    const trace = { logs: [
      { message: [JSON.stringify(semantic({ level: "debug", event: "queue.event.acknowledged", correlationId, causationId, payload: "private" }))] },
      { message: [JSON.stringify(semantic({ event: "queue.event.retried", causationId: "sk_test_DO_NOT_EXPOSE" }))] },
    ] };
    const records = safeTailRecords(trace);
    expect(records).toEqual([
      { timestamp, level: "debug", event: "queue.event.acknowledged", correlationId, causationId },
      { timestamp, level: "info", event: "queue.event.retried" },
    ]);
    const output: string[] = [];
    const consume = createTailLineConsumer({ environment: "staging", format: "pretty" }, (line) => output.push(line));
    consume(`${JSON.stringify(trace)}\n`);
    expect(output[0]).toContain(`DEBUG queue.event.acknowledged correlation=${correlationId} causation=${causationId}`);
    expect(output.join("")).not.toContain("DO_NOT_EXPOSE");
    expect(output.join("")).not.toContain("private");
  });

  it("streams split JSON lines and withholds malformed, oversized, and raw tail content", () => {
    const output: string[] = [];
    const consume = createTailLineConsumer({ environment: "staging", format: "json" }, (line) => output.push(line));
    const trace = JSON.stringify({ logs: [{ message: [JSON.stringify(semantic({ correlationId, authorization: "Bearer SECRET" }))] }] });
    consume(`Wrangler raw banner SECRET\n${trace.slice(0, 20)}`);
    consume(`${trace.slice(20)}\n${JSON.stringify({ event: { request: { headers: { cookie: "SECRET" } } }, exceptions: [{ message: "SECRET" }] })}\n`);
    consume("x".repeat(1_000_001));
    consume(`tail of oversized record SECRET\n${trace}\n`);
    expect(output).toEqual(Array(2).fill(`${JSON.stringify({ timestamp, level: "info", event: "billing.checkout.created", correlationId })}\n`));
    expect(output.join("")).not.toContain("SECRET");
  });

  it("never forwards raw Wrangler stdout or stderr from the spawned tail", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trestle-tail-"));
    try {
      const secret = "whsec_DO_NOT_PRINT";
      const trace = { event: { request: { url: `https://example.test/?code=${secret}` } }, exceptions: [{ message: secret }], logs: [{ message: [JSON.stringify(semantic({ correlationId, apiKey: secret }))] }] };
      const fake = join(directory, "pnpm");
      await writeFile(fake, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`${JSON.stringify(trace)}\n`)});\nprocess.stderr.write(${JSON.stringify(`raw diagnostic ${secret}\n`)});\n`);
      await chmod(fake, 0o755);
      const output: string[] = [];
      await tailSemanticLogs({ environment: "staging", format: "pretty" }, { cwd: directory, environment: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}` }, projectName: "fixture", output: (line) => output.push(line) });
      expect(output).toEqual([`${timestamp} INFO billing.checkout.created correlation=${correlationId}\n`]);
      expect(output.join("")).not.toContain(secret);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
