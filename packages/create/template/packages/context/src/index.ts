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
  info(event: string, context?: Readonly<Record<string, unknown>>): void;
  warn(event: string, context?: Readonly<Record<string, unknown>>): void;
  error(event: string, context?: Readonly<Record<string, unknown>>): void;
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
  level: "info" | "warn" | "error";
  event: string;
}>;

const sensitiveKey = /(?:authorization|cookie|password|secret|token|api[-_]?key|body|html|magic[-_]?link|verification[-_]?url|reset[-_]?url)/iu;

function redact(value: unknown, key = ""): unknown {
  if (sensitiveKey.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  return value;
}

export function createLogger(
  base: Readonly<Record<string, unknown>> = {},
  sink: (record: LogRecord) => void = (record) => console.log(JSON.stringify(record)),
): Logger {
  const write = (level: LogRecord["level"], event: string, context: Readonly<Record<string, unknown>> = {}) => {
    sink({ timestamp: new Date().toISOString(), level, event, ...redact(base) as Record<string, unknown>, ...redact(context) as Record<string, unknown> });
  };
  return {
    info: (event, context) => write("info", event, context),
    warn: (event, context) => write("warn", event, context),
    error: (event, context) => write("error", event, context),
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
