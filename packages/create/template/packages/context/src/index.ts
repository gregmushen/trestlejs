export type Principal = Readonly<{ id: string; kind: "user" | "system"; email?: string }>;
export type TenantIdentity = Readonly<{ organizationId: string; role?: string }>;
export type Permissions = ReadonlySet<string>;
export type AuthorityPlane = "organization" | "application" | "platform";
export type AuthorityContext = Readonly<{
  plane: AuthorityPlane;
  permissions: Permissions;
}>;
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
export type AccessRequirement = Readonly<{
  plane: AuthorityPlane;
  permission?: string;
  entitlement?: string;
}>;
export type AccessDecision = Readonly<{
  allowed: boolean;
  missing: readonly ("permission" | "entitlement" | "authority_plane")[];
  entitlement?: EntitlementDecision;
}>;

export class AccessDeniedError extends Error {
  constructor(readonly decision: AccessDecision) {
    super(`Access denied: ${decision.missing.join(", ")}`);
    this.name = "AccessDeniedError";
  }
}

export interface AccessController {
  check(requirement: AccessRequirement): AccessDecision;
  require(requirement: AccessRequirement): void;
}

export function createAccessController(authority: AuthorityContext, entitlements: Entitlements): AccessController {
  const check = (requirement: AccessRequirement): AccessDecision => {
    const missing: ("permission" | "entitlement" | "authority_plane")[] = [];
    if (authority.plane !== requirement.plane) missing.push("authority_plane");
    if (requirement.permission && !authority.permissions.has(requirement.permission)) missing.push("permission");
    const entitlement = requirement.entitlement ? entitlements.resolve(requirement.entitlement) : undefined;
    if (entitlement && !entitlement.enabled) missing.push("entitlement");
    return { allowed: missing.length === 0, missing, ...(entitlement ? { entitlement } : {}) };
  };
  return {
    check,
    require(requirement) {
      const decision = check(requirement);
      if (!decision.allowed) throw new AccessDeniedError(decision);
    },
  };
}
export type CorrelationContext = Readonly<{
  correlationId: string;
  causationId?: string;
}>;

export interface Clock {
  now(): Date;
}

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

export type ExecutionContext<Data, Services> = Readonly<{
  principal: Principal;
  tenant: TenantIdentity;
  authority: AuthorityContext;
  entitlements: Entitlements;
  access: AccessController;
  correlation: CorrelationContext;
  data: Data;
  log: Logger;
  metrics: Metrics;
  clock: Clock;
  features: Features;
  services: Services;
}>;
