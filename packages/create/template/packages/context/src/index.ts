export type Principal = Readonly<{ id: string; kind: "user" | "system"; email?: string }>;
export type TenantIdentity = Readonly<{ organizationId: string; role?: string }>;
export type Permissions = ReadonlySet<string>;
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
  permissions: Permissions;
  correlation: CorrelationContext;
  data: Data;
  log: Logger;
  clock: Clock;
  features: Features;
  services: Services;
}>;
