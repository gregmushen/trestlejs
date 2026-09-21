import { sql, type SQL } from "drizzle-orm";

export const tenantContextSetting = "app.organization_id" as const;

export type TenantTransaction = {
  execute(query: SQL): Promise<unknown>;
};

export type TransactionalDatabase = {
  transaction<T>(callback: (transaction: TenantTransaction) => Promise<T>): Promise<T>;
};

export async function withTenant<T>(
  database: TransactionalDatabase,
  organizationId: string,
  callback: (transaction: TenantTransaction) => Promise<T>,
): Promise<T> {
  if (!organizationId.trim()) throw new Error("organizationId is required");
  return database.transaction(async (transaction) => {
    await transaction.execute(sql`select set_config(${tenantContextSetting}, ${organizationId}, true)`);
    return callback(transaction);
  });
}
