export type Principal = Readonly<{ id: string; kind: "user" | "service_account" | "system"; email?: string; credentialId?: string }>;
/**
 * Authority model 3: a reviewed permission registry, organization roles from
 * membership, and separately stored application-role assignments.
 * `trestle upgrade` and `trestle generate resource` gate on it.
 */
export const AUTHORITY_MODEL_VERSION = 3;
export type TenantIdentity = Readonly<{ organizationId: string; role?: string }>;
export type Permissions = ReadonlySet<string>;
export type EntitlementDecision = Readonly<{
  code: string;
  enabled: boolean;
  values?: Readonly<Record<string, string | number | boolean>>;
  source: "plan" | "override" | "default";
  inheritedFrom?: string;
  effectiveAt: Date;
}>;
export interface Entitlements {
  resolve(code: string): EntitlementDecision;
  has(code: string): boolean;
}

/**
 * Structural view of the application's access evaluator (packages/authz), so
 * this package stays dependency-free. `explain` returns the full decision.
 */
export interface AccessControl<Requirement = Readonly<{ permission?: string; entitlement?: string }>, Decision = unknown> {
  check(requirement: Requirement): boolean;
  require(requirement: Requirement): Decision;
  explain(requirement: Requirement): Decision;
}
export type CorrelationContext = Readonly<{
  correlationId: string;
  causationId?: string;
}>;

export interface Clock {
  now(): Date;
}

export type ClockAdvance = Readonly<{ milliseconds?: number; seconds?: number; minutes?: number; hours?: number; days?: number }>;

export class FixedTestClock implements Clock {
  private current: Date;
  constructor(now: Date | string = "2026-01-01T00:00:00.000Z") { this.current = new Date(now); }
  now(): Date { return new Date(this.current); }
  set(value: Date | string): Date { this.current = new Date(value); return this.now(); }
  advance(duration: ClockAdvance): Date {
    const milliseconds = (duration.milliseconds ?? 0) + (duration.seconds ?? 0) * 1_000 + (duration.minutes ?? 0) * 60_000 + (duration.hours ?? 0) * 3_600_000 + (duration.days ?? 0) * 86_400_000;
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error("clock advance must be a finite non-negative duration");
    this.current = new Date(this.current.getTime() + milliseconds);
    return this.now();
  }
}

export function createTestClock(now?: Date | string): FixedTestClock { return new FixedTestClock(now); }

export interface Logger {
  debug(event: string, context?: Readonly<Record<string, unknown>>): void;
  info(event: string, context?: Readonly<Record<string, unknown>>): void;
  warn(event: string, context?: Readonly<Record<string, unknown>>): void;
  error(event: string, context?: Readonly<Record<string, unknown>>): void;
  child(context: Readonly<Record<string, unknown>>): Logger;
}

export interface Metrics {
  increment(name: string, value?: number, attributes?: Readonly<Record<string, string>>): void;
  observe(name: string, value: number, attributes?: Readonly<Record<string, string>>): void;
}

export function createMetrics(log: Logger): Metrics {
  return {
    increment: (name, value = 1, attributes = {}) => log.info("metric.counter", { metric: name, value, attributes }),
    observe: (name, value, attributes = {}) => log.info("metric.histogram", { metric: name, value, attributes }),
  };
}

export type LogRecord = Readonly<Record<string, unknown> & {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  event: string;
}>;

const sensitiveKey = /(?:authorization|cookie|password|secret|token|api[-_]?key|body|html|magic[-_]?link|verification[-_]?url|reset[-_]?url)/iu;
const reservedFields = new Set(["timestamp", "level", "event", "schemaVersion"]);
const REDACTED = "[REDACTED]";
export type LoggerOptions = Readonly<{ secretValues?: readonly (string | undefined)[] }>;

/** Diagnostic identifiers only: never expose exception messages, stacks, or SQL. */
export function safeErrorDiagnostic(error: unknown): Readonly<{ errorName: string; errorCode?: string; causeName?: string; causeCode?: string }> {
  try {
    const identifier = (value: unknown): string | undefined => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(value) ? value : undefined;
    const code = (value: unknown): string | undefined => typeof value === "string" && /^(?:[0-9A-Z]{5}|E[A-Z0-9_]{2,31}|ERR_[A-Z0-9_]{2,31})$/u.test(value) ? value : undefined;
    const details = (value: unknown): { name: string; code?: string } => {
      if (!(value instanceof Error)) return { name: "UnknownError" };
      const candidate = value as Error & { code?: unknown };
      const safeCode = code(candidate.code);
      return { name: identifier(value.name) ?? "UnknownError", ...(safeCode ? { code: safeCode } : {}) };
    };
    const current = details(error);
    const cause = error instanceof Error ? details(error.cause) : undefined;
    return {
      errorName: current.name,
      ...(current.code ? { errorCode: current.code } : {}),
      ...(cause && cause.name !== "UnknownError" ? { causeName: cause.name, ...(cause.code ? { causeCode: cause.code } : {}) } : {}),
    };
  } catch {
    return { errorName: "UnknownError" };
  }
}

/** Collect only declared runtime credentials, never arbitrary environment values. */
export function loggerSecretsFromEnvironment(environment: object): string[] {
  const names = ["DATABASE_URL", "DATABASE_ADMIN_URL", "DATABASE_PLATFORM_URL", "BETTER_AUTH_SECRET", "WEBHOOK_SECRET_KEY", "RESEND_API_KEY", "RESEND_WEBHOOK_SECRET", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "ARTIFACT_SIGNING_SECRET"];
  const values = environment as Readonly<Record<string, unknown>>;
  return names.flatMap((name) => typeof values[name] === "string" && values[name] ? [values[name] as string] : []);
}

function safeText(value: string, secrets: readonly string[], max = 1024): string {
  let result = value;
  for (const secret of secrets) result = result.split(secret).join(REDACTED);
  return result.length > max ? `${result.slice(0, max)}[TRUNCATED]` : result;
}

function safeValue(value: unknown, key: string, secrets: readonly string[], seen: WeakSet<object>, depth: number, budget: { nodes: number }): unknown {
  if (sensitiveKey.test(key)) return REDACTED;
  if (++budget.nodes > 200) return "[TRUNCATED]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return safeText(value, secrets);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return safeText(value.toString(), secrets);
  if (typeof value !== "object") return `[${typeof value}]`;
  if (seen.has(value)) return "[CIRCULAR]";
  if (depth >= 5) return "[DEPTH_LIMIT]";
  seen.add(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "[INVALID_DATE]" : value.toISOString();
  if (value instanceof Error) return { name: safeText(value.name, secrets, 120), message: safeText(value.message, secrets) };
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => safeValue(item, "", secrets, seen, depth + 1, budget)).concat(value.length > 30 ? ["[TRUNCATED]"] : []);
  const result: Record<string, unknown> = Object.create(null);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [name, descriptor] of Object.entries(descriptors).slice(0, 30)) {
    const safeName = safeText(name, secrets, 120);
    result[safeName] = "value" in descriptor ? safeValue(descriptor.value, name, secrets, seen, depth + 1, budget) : "[ACCESSOR]";
  }
  if (Object.keys(descriptors).length > 30) result._truncated = true;
  return result;
}

function safeFields(fields: Readonly<Record<string, unknown>>, secrets: readonly string[]): Record<string, unknown> {
  const result = safeValue(fields, "", secrets, new WeakSet(), 0, { nodes: 0 });
  return result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : {};
}

export function createLogger(
  base: Readonly<Record<string, unknown>> = {},
  sink: (record: LogRecord) => void = (record) => console.log(JSON.stringify(record)),
  options: LoggerOptions = {},
): Logger {
  const secrets = [...new Set((options.secretValues ?? []).filter((value): value is string => typeof value === "string" && value.length > 0))].sort((left, right) => right.length - left.length);
  const baseFields = safeFields(base, secrets);
  const write = (level: LogRecord["level"], event: string, context: Readonly<Record<string, unknown>> = {}) => {
    try {
      const fields = safeFields(context, secrets);
      for (const name of [...reservedFields, ...Object.keys(baseFields)]) delete fields[name];
      const record: LogRecord = { ...baseFields, ...fields, timestamp: new Date().toISOString(), level, event: safeText(event, secrets, 160), schemaVersion: 1 };
      // A pathological record must not flood the log sink or interrupt application work.
      sink(JSON.stringify(record).length <= 16_384 ? record : { timestamp: record.timestamp, level, event: record.event, schemaVersion: 1, truncated: true });
    } catch { /* Logging is best-effort; never break a request or workflow. */ }
  };
  return {
    debug: (event, context) => write("debug", event, context),
    info: (event, context) => write("info", event, context),
    warn: (event, context) => write("warn", event, context),
    error: (event, context) => write("error", event, context),
    child: (context) => createLogger({ ...baseFields, ...Object.fromEntries(Object.entries(safeFields(context, secrets)).filter(([name]) => !reservedFields.has(name) && !(name in baseFields))) }, sink, options),
  };
}

export interface Features {
  enabled(name: string, context?: Readonly<Record<string, unknown>>): boolean | Promise<boolean>;
}

export type ExecutionContext<Data, Services, Access extends AccessControl = AccessControl> = Readonly<{
  principal: Principal;
  tenant: TenantIdentity;
  /** Effective permission codes across the organization and application planes. */
  permissions: Permissions;
  entitlements: Entitlements;
  access: Access;
  correlation: CorrelationContext;
  data: Data;
  log: Logger;
  metrics: Metrics;
  clock: Clock;
  features: Features;
  services: Services;
}>;
