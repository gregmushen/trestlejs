import { describe, expect, it, vi } from "vitest";

import { withTenant, type TenantTransaction } from "./tenancy.js";

describe("withTenant", () => {
  it("sets tenant context inside the same transaction before application work", async () => {
    const events: string[] = [];
    const transaction: TenantTransaction = {
      execute: vi.fn(async () => { events.push("context"); }),
    };
    const database = {
      transaction: async <T>(callback: (tx: TenantTransaction) => Promise<T>) => callback(transaction),
    };
    const result = await withTenant(database, "org-a", async (tx) => {
      expect(tx).toBe(transaction);
      events.push("work");
      return 42;
    });
    expect(result).toBe(42);
    expect(events).toEqual(["context", "work"]);
  });

  it("rejects missing tenant context", async () => {
    const database = { transaction: vi.fn() };
    await expect(withTenant(database, "", async () => undefined)).rejects.toThrow("organizationId is required");
    expect(database.transaction).not.toHaveBeenCalled();
  });
});
