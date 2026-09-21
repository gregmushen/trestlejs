export type Principal = Readonly<{ id: string; kind: "user" | "system" }>;
export type TenantIdentity = Readonly<{ organizationId: string }>;
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
