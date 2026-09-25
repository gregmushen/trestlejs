import { spawn } from "node:child_process";

import type { EnvironmentName } from "@trestlejs/core";

export type LogOptions = Readonly<{
  environment: EnvironmentName;
  workerName?: string;
  format?: "pretty" | "json";
  status?: "ok" | "error" | "canceled";
  search?: string;
  samplingRate?: number;
}>;

export type SafeLogRecord = Readonly<{
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  event: string;
  correlationId?: string;
  causationId?: string;
  durationMs?: number;
  status?: number;
}>;

const eventPattern = /^[a-z][a-z0-9_]{0,31}(?:\.[a-z][a-z0-9_]{0,31})+$/u;
const credentialPattern = /(?:sk|rk|pk)_(?:test|live)_[a-z0-9]+|whsec_[a-z0-9]+|re_[a-z0-9]{20,}/iu;
// The Worker generates UUID correlation IDs. A free-form inbound header might
// contain a credential, so never repeat it through this diagnostic surface.
const traceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function buildLogTailArguments(options: LogOptions): string[] {
  if (options.environment === "local") throw new Error("remote log tailing requires preview, staging, or production");
  if (options.workerName && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(options.workerName)) throw new Error("Worker name must be a Cloudflare-compatible identifier");
  if (options.search && (!/^[a-z][a-z0-9.]{0,79}$/u.test(options.search) || /(?:secret|token|password|cookie|key|body)/iu.test(options.search))) {
    throw new Error("log search accepts only semantic event-name fragments, not sensitive fields or values");
  }
  if (options.samplingRate !== undefined && (!Number.isFinite(options.samplingRate) || options.samplingRate <= 0 || options.samplingRate > 1)) throw new Error("sampling rate must be greater than 0 and at most 1");
  // Wrangler's pretty output includes raw requests and exception text. Parse
  // JSON internally and project only safe semantic records to either format.
  return ["tail", ...(options.workerName ? [options.workerName] : []), "--env", options.environment, "--format", "json", ...(options.status ? ["--status", options.status] : []), ...(options.samplingRate !== undefined ? ["--sampling-rate", String(options.samplingRate)] : [])];
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Discard request metadata, exceptions, arbitrary console output, and unknown fields. */
export function safeTailRecords(value: unknown, search?: string): SafeLogRecord[] {
  if (!plainObject(value) || !Array.isArray(value.logs)) return [];
  const records: SafeLogRecord[] = [];
  for (const log of value.logs) {
    if (!plainObject(log) || !Array.isArray(log.message) || log.message.length !== 1 || typeof log.message[0] !== "string") continue;
    let source: unknown;
    try { source = JSON.parse(log.message[0]); } catch { continue; }
    if (!plainObject(source)) continue;
    const { timestamp, level, event } = source;
    if (typeof timestamp !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(timestamp) || Number.isNaN(Date.parse(timestamp))) continue;
    if (level !== "debug" && level !== "info" && level !== "warn" && level !== "error") continue;
    if (typeof event !== "string" || event.length > 120 || !eventPattern.test(event) || credentialPattern.test(event) || (search && !event.includes(search))) continue;
    const record: { timestamp: string; level: "debug" | "info" | "warn" | "error"; event: string; correlationId?: string; causationId?: string; durationMs?: number; status?: number } = { timestamp, level, event };
    if (typeof source.correlationId === "string" && traceIdPattern.test(source.correlationId)) record.correlationId = source.correlationId;
    if (typeof source.causationId === "string" && traceIdPattern.test(source.causationId)) record.causationId = source.causationId;
    if (typeof source.durationMs === "number" && Number.isFinite(source.durationMs) && source.durationMs >= 0 && source.durationMs <= 1_000_000_000) record.durationMs = source.durationMs;
    if (typeof source.status === "number" && Number.isInteger(source.status) && source.status >= 100 && source.status <= 599) record.status = source.status;
    records.push(record);
  }
  return records;
}

export function formatSafeLog(record: SafeLogRecord, format: "pretty" | "json"): string {
  if (format === "json") return `${JSON.stringify(record)}\n`;
  return `${record.timestamp} ${record.level.toUpperCase()} ${record.event}${record.correlationId ? ` correlation=${record.correlationId}` : ""}${record.causationId ? ` causation=${record.causationId}` : ""}${record.status !== undefined ? ` status=${record.status}` : ""}${record.durationMs !== undefined ? ` duration=${record.durationMs}ms` : ""}\n`;
}

export function createTailLineConsumer(options: LogOptions, output: (line: string) => void): (chunk: string) => void {
  let pending = "";
  let discarding = false;
  return (chunk) => {
    const parts = chunk.split("\n");
    for (let index = 0; index < parts.length; index += 1) {
      const complete = index < parts.length - 1;
      if (!discarding) {
        if (pending.length + parts[index]!.length > 1_000_000) { pending = ""; discarding = true; }
        else pending += parts[index];
      }
      if (!complete) break;
      if (!discarding) {
        try {
          for (const record of safeTailRecords(JSON.parse(pending), options.search)) output(formatSafeLog(record, options.format ?? "pretty"));
        } catch { /* Ignore Wrangler banners and malformed trace events. */ }
      }
      pending = "";
      discarding = false;
    }
  };
}

export async function tailSemanticLogs(options: LogOptions, input: { cwd: string; environment: NodeJS.ProcessEnv; projectName: string; output: (line: string) => void }): Promise<void> {
  const arguments_ = buildLogTailArguments(options);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pnpm", ["--filter", `@${input.projectName}/worker`, "exec", "wrangler", ...arguments_], {
      cwd: input.cwd, env: input.environment, stdio: ["ignore", "pipe", "pipe"],
    });
    const consume = createTailLineConsumer(options, input.output);
    child.stdout?.setEncoding("utf8").on("data", consume);
    // Do not forward stderr: Wrangler diagnostics may contain raw request data.
    child.stderr?.resume();
    let interrupted = false;
    const forwardInterrupt = () => { interrupted = true; child.kill("SIGINT"); };
    const forwardTerminate = () => { interrupted = true; child.kill("SIGTERM"); };
    process.once("SIGINT", forwardInterrupt);
    process.once("SIGTERM", forwardTerminate);
    const cleanup = () => { process.off("SIGINT", forwardInterrupt); process.off("SIGTERM", forwardTerminate); };
    child.once("error", () => { cleanup(); reject(new Error("Unable to start Wrangler log tail")); });
    child.once("close", (code, signal) => {
      cleanup();
      if (code === 0 || interrupted || signal === "SIGINT" || signal === "SIGTERM") resolve();
      else reject(new Error("Wrangler log tail failed; raw diagnostics were withheld"));
    });
  });
}
