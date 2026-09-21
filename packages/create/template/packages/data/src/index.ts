export interface TenantTransaction {
  readonly organizationId: string;
}

export type WithTenant = <Result>(
  organizationId: string,
  operation: (transaction: TenantTransaction) => Promise<Result>,
) => Promise<Result>;
