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
      findMembership: async (userId, organizationId) => { seen.push(userId, organizationId); return { role: "owner", applicationRole: "contributor" }; },
      findSubscription: async () => ({ organizationId: "org-a", provider: "local", plan: "pro", planVersion: 1, status: "active", cancelAtPeriodEnd: false, entitlements: ["workflows.advanced"] }),
    });
    expect(seen).toEqual(["user-1", "org-a"]);
    expect(context.tenant).toEqual({ organizationId: "org-a", role: "owner" });
    expect(context.authority.planes.organization?.has("organization:manage")).toBe(true);
    expect(context.authority.planes.organization?.has("organization:webhooks:read")).toBe(true);
    expect(context.authority.planes.organization?.has("organization:webhooks:manage")).toBe(true);
    expect(context.authority.planes.organization?.has("organization:webhooks:deliveries:read")).toBe(true);
    expect(context.authority.planes.application?.has("resource:write")).toBe(true);
    expect(context.entitlements.has("workflows.advanced")).toBe(true);
    expect(context.correlation.correlationId).toBe("corr-1");
    expect(context.events.statement).toBeTypeOf("function");
  });

  it("does not infer application authority from organization ownership", async () => {
    const context = await resolveExecutionContext(new Headers(), environment, {
      getSession: async () => session,
      findMembership: async () => ({ role: "owner", applicationRole: null }),
      findSubscription: async () => null,
    });
    expect(context.access.check({ plane: "organization", permission: "organization:manage" }).allowed).toBe(true);
    expect(context.access.check({ plane: "application", permission: "resource:read" })).toMatchObject({ allowed: false, missing: ["authority_plane"] });
  });

  it("grants a viewer only application reads regardless of organization role", async () => {
    const context = await resolveExecutionContext(new Headers(), environment, {
      getSession: async () => session,
      findMembership: async () => ({ role: "member", applicationRole: "viewer" }),
      findSubscription: async () => null,
    });
    expect(context.access.check({ plane: "application", permission: "resource:read" }).allowed).toBe(true);
    expect(context.access.check({ plane: "application", permission: "resource:write" })).toMatchObject({ allowed: false, missing: ["permission"] });
    expect(context.access.check({ plane: "organization", permission: "organization:manage" })).toMatchObject({ allowed: false, missing: ["permission"] });
    expect(context.access.check({ plane: "organization", permission: "organization:webhooks:read" })).toMatchObject({ allowed: false, missing: ["permission"] });
    expect(context.access.check({ plane: "organization", permission: "organization:webhooks:manage" })).toMatchObject({ allowed: false, missing: ["permission"] });
  });

  it("fails closed for revoked membership", async () => {
    await expect(resolveExecutionContext(new Headers(), environment, {
      getSession: async () => session,
      findMembership: async () => null,
      findSubscription: async () => null,
    })).rejects.toMatchObject<Partial<ExecutionContextError>>({ code: "not_found", status: 404 });
  });

  it("does not accept a selected tenant without current membership", async () => {
    const selected: string[] = [];
    await expect(resolveExecutionContext(new Headers({ "x-trestle-tenant": "org-b" }), environment, {
      getSession: async () => session,
      findMembership: async (_userId, organizationId) => { selected.push(organizationId); return null; },
      findSubscription: async () => null,
    })).rejects.toMatchObject({ code: "not_found" });
    expect(selected).toEqual(["org-b"]);
  });
});
