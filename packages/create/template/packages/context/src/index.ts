export type PrincipalKind = "user" | "service_account" | "platform_operator" | "system";
export type Principal = Readonly<{ id: string; kind: PrincipalKind; email?: string; label?: string; credentialId?: string }>;
/** Bumped when the authority model changes shape; `trestle upgrade` gates on it. */
export const AUTHORITY_MODEL_VERSION = 3;
export type TenantIdentity = Readonly<{ organizationId: string; role?: string }>;
export type Permissions = ReadonlySet<string>;
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

/**
 * Emits registered application events (packages/events/src/catalog.ts) to the
 * transactional outbox. Use `statement` to commit an event atomically with a
 * repository write; `emit` appends it on its own.
 */
export interface EventPublisher<Statement = unknown> {
  emit(name: string, payload: Readonly<Record<string, unknown>>, resource: Readonly<{ type: string; id: string }>): Promise<void>;
  statement(name: string, payload: Readonly<Record<string, unknown>>, resource: Readonly<{ type: string; id: string }>): Statement;
}

/** Present only while a platform operator acts inside an audited support session. */
export type SupportAttribution = Readonly<{ sessionId: string; operatorId: string; reason: string }>;

export interface Features {
  enabled(name: string, context?: Readonly<Record<string, unknown>>): boolean | Promise<boolean>;
}

/** Structural view of the application's access evaluator (packages/authz). */
export interface AccessControl<Requirement = Readonly<{ permission?: string; entitlement?: string }>, Decision = unknown> {
  require(requirement: Requirement): Decision;
  check(requirement: Requirement): boolean;
  explain(requirement: Requirement): Decision;
}

/** Structural view of the local effective-entitlement projection (packages/billing). */
export interface EntitlementReader {
  has(code: string): boolean;
  require(code: string): void;
  list(): string[];
}

export type ExecutionContext<Data, Services, Access extends AccessControl = AccessControl, Entitlements extends EntitlementReader = EntitlementReader> = Readonly<{
  principal: Principal;
  tenant: TenantIdentity;
  permissions: Permissions;
  access: Access;
  entitlements: Entitlements;
  environment: "local" | "preview" | "staging" | "production";
  correlation: CorrelationContext;
  data: Data;
  log: Logger;
  metrics: Metrics;
  clock: Clock;
  features: Features;
  services: Services;
  events: EventPublisher;
  support?: SupportAttribution;
}>;
