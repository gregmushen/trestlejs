export interface TenantTransaction {
  readonly organizationId: string;
}

export type WithTenant = <Result>(
  organizationId: string,
  operation: (transaction: TenantTransaction) => Promise<Result>,
) => Promise<Result>;

export * from "./access/access-catalog-loader.js";
export * from "./access/postgres-tenant-access-repository.js";
export * from "./identity/postgres-identity-repository.js";
export * from "./notifications/postgres-notification-repository.js";
export * from "./notifications/stream-loader.js";
export * from "./webhooks/postgres-webhook-repository.js";
export * from "./billing/provider-mappings.js";
