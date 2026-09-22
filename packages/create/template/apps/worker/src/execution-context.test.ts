import { describe, expect, it } from "vitest";

import { ExecutionContextError, resolveExecutionContext } from "./execution-context.js";

const environment = {
  DATABASE_URL: "postgres://user:password@localhost/database",
  DATABASE_DRIVER: "postgres-js" as const,
  BETTER_AUTH_SECRET: "test-secret-at-least-32-characters",
};

const session = { user: { id: "user-1", email: "user@example.test" }, session: { activeOrganizationId: "org-a" } };

describe("execution context", () => {
  it("revalidates membership and scopes the database connection", async () => {
    const seen: string[] = [];
    const context = await resolveExecutionContext(new Headers({ "x-correlation-id": "corr-1" }), environment, {
      getSession: async () => session,
      findMembership: async (userId, organizationId) => { seen.push(userId, organizationId); return { role: "owner" }; },
    });
    expect(seen).toEqual(["user-1", "org-a"]);
    expect(context.tenant).toEqual({ organizationId: "org-a", role: "owner" });
    expect(context.permissions.has("organization:manage")).toBe(true);
    expect(context.correlation.correlationId).toBe("corr-1");
  });

  it("fails closed for revoked membership", async () => {
    await expect(resolveExecutionContext(new Headers(), environment, {
      getSession: async () => session,
      findMembership: async () => null,
    })).rejects.toMatchObject<Partial<ExecutionContextError>>({ code: "not_found", status: 404 });
  });

  it("does not accept a selected tenant without current membership", async () => {
    const selected: string[] = [];
    await expect(resolveExecutionContext(new Headers({ "x-trestle-tenant": "org-b" }), environment, {
      getSession: async () => session,
      findMembership: async (_userId, organizationId) => { selected.push(organizationId); return null; },
    })).rejects.toMatchObject({ code: "not_found" });
    expect(selected).toEqual(["org-b"]);
  });
});
