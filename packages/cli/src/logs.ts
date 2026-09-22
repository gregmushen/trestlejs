import type { EnvironmentName } from "@trestlejs/core";

export type LogOptions = Readonly<{
  environment: EnvironmentName;
  workerName?: string;
  format?: "pretty" | "json";
  status?: "ok" | "error" | "canceled";
  search?: string;
  samplingRate?: number;
}>;

export function buildLogTailArguments(options: LogOptions): string[] {
  if (options.environment === "local") throw new Error("remote log tailing requires preview, staging, or production");
  if (options.search && /(?:authorization|cookie|password|secret|token|api[-_]?key|body|magic[-_]?link)/iu.test(options.search)) throw new Error("log search cannot target sensitive fields or request bodies");
  if (options.samplingRate !== undefined && (options.samplingRate <= 0 || options.samplingRate > 1)) throw new Error("sampling rate must be greater than 0 and at most 1");
  return ["tail", ...(options.workerName ? [options.workerName] : []), "--env", options.environment, "--format", options.format ?? "pretty", ...(options.status ? ["--status", options.status] : []), ...(options.search ? ["--search", options.search] : []), ...(options.samplingRate !== undefined ? ["--sampling-rate", String(options.samplingRate)] : [])];
}
